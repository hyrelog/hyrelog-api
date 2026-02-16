/**
 * Export API Endpoints
 * 
 * Phase 3: Streaming exports for HOT and ARCHIVED data
 * Plan-enforced: uses Company.plan + planOverrides from database
 */

import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireCompanyFeature, getCompanyPlanConfig, PlanRestrictionError } from '../../lib/plans.js';
import { getObjectStream, getObjectBuffer } from '../../lib/objectStore.js';
import { createGunzip, gunzipSync } from 'zlib';
import { Readable, PassThrough } from 'stream';
import { getLogger } from '../../lib/logger.js';
import { getTraceId } from '../../lib/trace.js';

const logger = getLogger();

// Request schemas
const CreateExportSchema = z.object({
  source: z.enum(['HOT', 'ARCHIVED', 'HOT_AND_ARCHIVED']),
  format: z.enum(['JSONL', 'CSV']),
  filters: z
    .object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      category: z.string().optional(),
      action: z.string().optional(),
      workspaceId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    })
    .optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const createExportBodySchema = {
  type: 'object' as const,
  required: ['source', 'format'],
  properties: {
    source: { type: 'string', enum: ['HOT', 'ARCHIVED', 'HOT_AND_ARCHIVED'], description: 'Data source for export' },
    format: { type: 'string', enum: ['JSONL', 'CSV'], description: 'Output format' },
    filters: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        category: { type: 'string' },
        action: { type: 'string' },
        workspaceId: { type: 'string', format: 'uuid' },
        projectId: { type: 'string', format: 'uuid' },
      },
      description: 'Optional filters; from/to required for ARCHIVED',
    },
    limit: { type: 'integer', description: 'Max rows (plan-limited)' },
  },
};

const exportsRoutesImpl: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/exports
   * Create an export job
   */
  fastify.post<{ Body: z.infer<typeof CreateExportSchema> }>(
    '/v1/exports',
    {
      schema: {
        tags: ['Exports'],
        summary: 'Create export job',
        description: 'Create a streaming export job. Requires Starter plan or higher. ARCHIVED/HOT_AND_ARCHIVED require from/to filters and may require archive restoration.',
        body: createExportBodySchema,
        response: {
          201: {
            type: 'object',
            properties: { jobId: { type: 'string' }, status: { type: 'string' } },
            required: ['jobId', 'status'],
          },
        },
      },
      handler: async (request, reply) => {
      // Auth plugin sets request.apiKey and request.prisma
      if (!request.apiKey || !request.prisma) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      // Create authContext from apiKey for consistency with exports route structure
      const authContext = {
        apiKeyId: request.apiKey.id,
        region: request.apiKey.region,
        scope: request.apiKey.scope,
        companyId: request.apiKey.companyId,
        workspaceId: request.apiKey.workspaceId,
      };

      // Validate request body
      const bodyResult = CreateExportSchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({
          error: 'Validation error',
          code: 'VALIDATION_ERROR',
          details: bodyResult.error.errors,
        });
      }

      const { source, format, filters, limit } = bodyResult.data;

      // Use Prisma client from request (already set by auth plugin)
      const prisma = request.prisma!;

      const company = await prisma.company.findUnique({
        where: { id: authContext.companyId },
        include: {
          plan: true,
        },
      });

      if (!company) {
        return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
      }

      // Enforce streaming exports feature
      try {
        requireCompanyFeature(
          {
            planTier: company.planTier,
            planOverrides: company.planOverrides as any,
          },
          'streamingExportsEnabled',
          'STARTER'
        );
      } catch (error: any) {
        if (error instanceof PlanRestrictionError) {
          return reply.code(403).send({
            error: error.message || 'Streaming exports require a Starter plan or higher',
            code: 'PLAN_RESTRICTED',
          });
        }
        throw error;
      }

      // Get effective plan config (plan + overrides)
      const effectiveConfig = getCompanyPlanConfig({
        planTier: company.planTier,
        planOverrides: company.planOverrides as any,
      });
      const maxRowsBigInt = effectiveConfig.maxExportRows;

      // Determine requested limit
      const requestedLimit = limit ? BigInt(limit) : maxRowsBigInt;

      // Enforce limit
      if (requestedLimit > maxRowsBigInt) {
        return reply.code(403).send({
          error: `Export limit exceeded. Your plan allows ${maxRowsBigInt} rows but you requested ${requestedLimit}`,
          code: 'PLAN_LIMIT_EXCEEDED',
        });
      }

      // For ARCHIVED source, require from/to filters
      if (source === 'ARCHIVED' || source === 'HOT_AND_ARCHIVED') {
        if (!filters?.from || !filters?.to) {
          return reply.code(400).send({
            error: 'from and to filters are required for ARCHIVED exports',
            code: 'VALIDATION_ERROR',
          });
        }

        // Enforce archive retention using effective plan config
        const effectiveConfig = getCompanyPlanConfig({
          planTier: company.planTier,
          planOverrides: company.planOverrides as any,
        });

        // Check if archiveRetentionDays is set
        if (!effectiveConfig.archiveRetentionDays) {
          return reply.code(403).send({
            error: 'Archived exports are not available for your plan',
            code: 'PLAN_RESTRICTED',
          });
        }

        // Check date range doesn't exceed retention
        // Allow bypass in development mode for testing
        const bypassRetentionCheck = process.env.NODE_ENV === 'development' && process.env.BYPASS_ARCHIVE_RETENTION === 'true';
        
        if (!bypassRetentionCheck) {
          const fromDate = new Date(filters.from!);
          const now = new Date();
          const retentionCutoff = new Date(now);
          retentionCutoff.setDate(retentionCutoff.getDate() - effectiveConfig.archiveRetentionDays);

          if (fromDate < retentionCutoff) {
            return reply.code(403).send({
              error: `Requested archive data is older than your plan's retention policy (${effectiveConfig.archiveRetentionDays} days). Oldest allowed date is ${retentionCutoff.toISOString().split('T')[0]}.`,
              code: 'RETENTION_WINDOW_EXCEEDED',
            });
          }
        } else {
          const traceId = getTraceId(request);
          logger.warn({ traceId }, 'Archive retention check bypassed (development mode)');
        }
      }

      // Determine workspace/project scope
      let workspaceId: string | undefined = authContext.workspaceId ?? undefined;
      let projectId: string | undefined = filters?.projectId;

      // Enforce scope: workspace keys cannot specify workspaceId filter
      if (authContext.scope === 'WORKSPACE' && filters?.workspaceId) {
        return reply.code(400).send({
          error: 'Workspace keys cannot specify workspaceId filter. Export is scoped to the workspace of the key.',
          code: 'VALIDATION_ERROR',
        });
      }

      // Company key can specify workspaceId
      if (authContext.scope === 'COMPANY' && filters?.workspaceId) {
        workspaceId = filters.workspaceId;
      }

      // Validate project belongs to workspace
      if (projectId && workspaceId) {
        const project = await prisma.project.findFirst({
          where: {
            id: projectId,
            workspaceId: workspaceId,
          },
        });

        if (!project) {
          return reply.code(400).send({
            error: 'Project not found or does not belong to workspace',
            code: 'VALIDATION_ERROR',
          });
        }
      }

      // Create export job
      const exportJob = await prisma.exportJob.create({
        data: {
          companyId: authContext.companyId,
          workspaceId: workspaceId,
          projectId: projectId,
          requestedByType: 'API_KEY',
          requestedById: authContext.apiKeyId,
          source: source as any,
          format: format as any,
          status: 'PENDING',
          filters: filters || {},
          rowLimit: requestedLimit,
        },
      });

      return reply.code(201).send({
        jobId: exportJob.id,
        status: exportJob.status,
      });
    },
    }
  );

  /**
   * GET /v1/exports/:jobId
   * Get export job status
   */
  fastify.get<{ Params: { jobId: string } }>('/v1/exports/:jobId', {
    schema: {
      tags: ['Exports'],
      summary: 'Get export job status',
      description: 'Get status and metadata for an export job.',
      params: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            source: { type: 'string' },
            format: { type: 'string' },
            rowLimit: { type: 'string' },
            rowsExported: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            startedAt: { type: ['string', 'null'], format: 'date-time' },
            finishedAt: { type: ['string', 'null'], format: 'date-time' },
            errorCode: { type: ['string', 'null'] },
            errorMessage: { type: ['string', 'null'] },
          },
          required: ['id', 'status', 'source', 'format', 'rowsExported', 'createdAt'],
        },
      },
    },
    handler: async (request, reply) => {
    // Auth plugin sets request.apiKey and request.prisma
    if (!request.apiKey || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { jobId } = request.params;

    // Create authContext from apiKey
    const authContext = {
      apiKeyId: request.apiKey.id,
      region: request.apiKey.region,
      scope: request.apiKey.scope,
      companyId: request.apiKey.companyId,
      workspaceId: request.apiKey.workspaceId,
    };

    // Use Prisma client from request (already set by auth plugin)
    const prisma = request.prisma!;

    // Find export job (scope enforced)
    const exportJob = await prisma.exportJob.findFirst({
      where: {
        id: jobId,
        companyId: authContext.companyId,
        ...(authContext.scope === 'WORKSPACE' && {
          workspaceId: authContext.workspaceId,
        }),
      },
    });

    if (!exportJob) {
      return reply.code(404).send({ error: 'Export job not found', code: 'NOT_FOUND' });
    }

    return reply.send({
      id: exportJob.id,
      status: exportJob.status,
      source: exportJob.source,
      format: exportJob.format,
      rowLimit: exportJob.rowLimit.toString(),
      rowsExported: exportJob.rowsExported.toString(),
      createdAt: exportJob.createdAt.toISOString(),
      startedAt: exportJob.startedAt?.toISOString(),
      finishedAt: exportJob.finishedAt?.toISOString(),
      errorCode: exportJob.errorCode,
      errorMessage: exportJob.errorMessage,
    });
  },
  });

  /**
   * GET /v1/exports/:jobId/download
   * Stream export data
   */
  fastify.get<{ Params: { jobId: string } }>(
    '/v1/exports/:jobId/download',
    {
      schema: {
        tags: ['Exports'],
        summary: 'Download export',
        description: 'Stream export data (JSONL or CSV). Content-Type and Content-Disposition set on response. Job must be in PENDING or RUNNING state.',
        params: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
        response: {
          200: {
            description: 'Stream of export data (application/x-ndjson or text/csv). Use GET after job is created; response is streamed.',
            type: 'string',
          },
        },
      },
      handler: async (request, reply) => {
      // Auth plugin sets request.apiKey and request.prisma
      if (!request.apiKey || !request.prisma) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      const { jobId } = request.params;

      // Create authContext from apiKey
      const authContext = {
        apiKeyId: request.apiKey.id,
        region: request.apiKey.region,
        scope: request.apiKey.scope,
        companyId: request.apiKey.companyId,
        workspaceId: request.apiKey.workspaceId,
      };

      // Use Prisma client from request (already set by auth plugin)
      const prisma = request.prisma!;

      // Find export job (scope enforced)
      const exportJob = await prisma.exportJob.findFirst({
        where: {
          id: jobId,
          companyId: authContext.companyId,
          ...(authContext.scope === 'WORKSPACE' && {
            workspaceId: authContext.workspaceId,
          }),
        },
      });

      if (!exportJob) {
        return reply.code(404).send({ error: 'Export job not found', code: 'NOT_FOUND' });
      }

      // Update job status to RUNNING
      await prisma.exportJob.update({
        where: { id: exportJob.id },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      // Track if job was canceled due to client disconnect
      let canceledByClient = false;

      // Handle client disconnect
      request.raw.on('close', async () => {
        if (!request.raw.destroyed && !canceledByClient) {
          canceledByClient = true;
          try {
            await prisma.exportJob.update({
              where: { id: exportJob.id },
              data: {
                status: 'CANCELED',
                finishedAt: new Date(),
                errorCode: 'CLIENT_DISCONNECTED',
                errorMessage: 'Client disconnected during export stream',
              },
            });
            logger.info({ jobId: exportJob.id }, 'Export job canceled due to client disconnect');
          } catch (updateError: any) {
            logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to mark export job as canceled');
          }
        }
      });

      try {
        // Stream data based on source
        let stream: Readable;

        if (exportJob.source === 'HOT') {
          // Stream HOT data only
          stream = await streamHotData(prisma, exportJob, authContext);
        } else if (exportJob.source === 'ARCHIVED') {
          // Stream ARCHIVED data only
          stream = await streamArchivedData(prisma, exportJob, authContext);
        } else if (exportJob.source === 'HOT_AND_ARCHIVED') {
          // Stream both HOT and ARCHIVED data (HOT first, then ARCHIVED)
          stream = await streamHotAndArchivedData(prisma, exportJob, authContext);
        } else {
          throw new Error(`Unknown export source: ${exportJob.source}`);
        }

        // Set response headers BEFORE streaming
        const filename = `export-${exportJob.id}.${exportJob.format.toLowerCase()}`;
        reply.header('Content-Type', exportJob.format === 'CSV' ? 'text/csv' : 'application/x-ndjson');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);

        // Handle stream completion
        stream.on('end', async () => {
          if (!canceledByClient) {
            try {
              await prisma.exportJob.update({
                where: { id: exportJob.id },
                data: {
                  status: 'SUCCEEDED',
                  finishedAt: new Date(),
                },
              });
            } catch (updateError: any) {
              logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to mark export job as succeeded');
            }
          }
        });

        stream.on('error', async (streamError: any) => {
          if (!canceledByClient) {
            try {
              await prisma.exportJob.update({
                where: { id: exportJob.id },
                data: {
                  status: 'FAILED',
                  finishedAt: new Date(),
                  errorCode: 'STREAM_ERROR',
                  errorMessage: streamError.message,
                },
              });
            } catch (updateError: any) {
              logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to mark export job as failed');
            }
          }
        });

        // Use reply.send() which Fastify handles properly for streams
        // The stream will be automatically piped to the response
        reply.send(stream);
        
        // Return undefined to indicate we've handled the response
        return;
      } catch (error: any) {
        // Handle RESTORE_REQUIRED error
        if (error.code === 'RESTORE_REQUIRED') {
          if (!canceledByClient) {
            await prisma.exportJob.update({
              where: { id: exportJob.id },
              data: {
                status: 'FAILED',
                finishedAt: new Date(),
                errorCode: 'RESTORE_REQUIRED',
                errorMessage: error.message,
              },
            });
          }

          return reply.code(400).send({
            error: error.message || 'Cold archived data requires restoration before export',
            code: 'RESTORE_REQUIRED',
            archiveIds: error.archiveIds || [],
          });
        }

        // Mark job as FAILED for other errors
        if (!canceledByClient) {
          await prisma.exportJob.update({
            where: { id: exportJob.id },
            data: {
              status: 'FAILED',
              finishedAt: new Date(),
              errorCode: 'STREAM_ERROR',
              errorMessage: error.message,
            },
          });
        }

        return reply.code(500).send({
          error: 'Export stream failed',
          code: 'STREAM_ERROR',
          message: error.message,
        });
      }
    },
    }
  );
};

export const exportsRoutes = fp(exportsRoutesImpl, { name: 'v1-exports-routes' });

/**
 * Stream HOT data from Postgres
 */
async function streamHotData(
  prisma: any,
  exportJob: any,
  authContext: any
): Promise<Readable> {
  const filters = (exportJob.filters || {}) as any;
  const format = exportJob.format;
  // Keep BigInt throughout to avoid precision loss
  const rowLimit = typeof exportJob.rowLimit === 'bigint' ? exportJob.rowLimit : BigInt(exportJob.rowLimit);

  // Build query conditions
  const where: any = {
    companyId: authContext.companyId,
    ...(authContext.scope === 'WORKSPACE' && {
      workspaceId: authContext.workspaceId,
    }),
    ...(filters.projectId && { projectId: filters.projectId }),
    // Combine timestamp filters properly (don't overwrite each other)
    ...((filters.from || filters.to) && {
      timestamp: {
        ...(filters.from && { gte: new Date(filters.from) }),
        ...(filters.to && { lte: new Date(filters.to) }),
      },
    }),
    ...(filters.category && { category: filters.category }),
    ...(filters.action && { action: filters.action }),
  };

  logger.info(
    {
      companyId: authContext.companyId,
      filters,
      where,
      jobId: exportJob.id,
    },
    'HOT export: Querying events'
  );

  // Track state for cursor pagination
  let lastCursor: string | undefined = undefined;
  // Keep BigInt throughout to avoid precision loss
  let rowsExported = typeof exportJob.rowsExported === 'bigint' ? exportJob.rowsExported : BigInt(exportJob.rowsExported || 0);
  let headerSent = false;

  // Create readable stream
  const stream = new Readable({
    objectMode: false, // Always use string mode for consistency
    async read() {
      try {
        // Fetch events in batches (cursor pagination)
        const events = await prisma.auditEvent.findMany({
          where: {
            ...where,
            ...(lastCursor && { id: { gt: lastCursor } }),
          },
          take: 1000, // Batch size
          orderBy: { timestamp: 'asc' },
        });

        if (events.length === 0) {
          logger.info({ jobId: exportJob.id, lastCursor }, 'HOT export: No more events found, ending stream');
          this.push(null); // End stream
          return;
        }

        logger.debug({ jobId: exportJob.id, eventCount: events.length, lastCursor }, 'HOT export: Fetched batch of events');

        // Process events

        for (const event of events) {
          // Compare BigInt values
          if (rowsExported >= rowLimit) {
            this.push(null); // End stream
            break;
          }

          if (format === 'JSONL') {
            const line = JSON.stringify({
              id: event.id,
              timestamp: event.timestamp.toISOString(),
              category: event.category,
              action: event.action,
              actorId: event.actorId,
              actorEmail: event.actorEmail,
              actorRole: event.actorRole,
              resourceType: event.resourceType,
              resourceId: event.resourceId,
              metadata: event.metadata,
              traceId: event.traceId,
              ipAddress: event.ipAddress,
              geo: event.geo,
              userAgent: event.userAgent,
            });
            this.push(line + '\n');
          } else {
            // CSV format
            if (!headerSent) {
              // Header row (only once)
              this.push('id,timestamp,category,action,actorId,actorEmail,actorRole,resourceType,resourceId,metadata,traceId,ipAddress,geo,userAgent\n');
              headerSent = true;
            }
            const row = [
              event.id,
              event.timestamp.toISOString(),
              event.category,
              event.action,
              event.actorId || '',
              event.actorEmail || '',
              event.actorRole || '',
              event.resourceType || '',
              event.resourceId || '',
              JSON.stringify(event.metadata),
              event.traceId,
              event.ipAddress || '',
              event.geo || '',
              event.userAgent || '',
            ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
            this.push(row + '\n');
          }

          rowsExported = rowsExported + BigInt(1);
          lastCursor = event.id;
        }

        // Update rowsExported periodically (every 1000 rows)
        if (rowsExported % BigInt(1000) === BigInt(0)) {
          await prisma.exportJob.update({
            where: { id: exportJob.id },
            data: { rowsExported: rowsExported },
          });
        }
      } catch (error: any) {
        this.destroy(error);
      }
    },
  });

  // Start the stream by calling read() once
  // This ensures Fastify can properly handle the stream
  process.nextTick(() => {
    stream.read();
  });

  return stream;
}

/**
 * Stream ARCHIVED data from S3
 */
async function streamArchivedData(
  prisma: any,
  exportJob: any,
  authContext: any
): Promise<Readable> {
  const filters = (exportJob.filters || {}) as any;
  const format = exportJob.format;
  const region = authContext.region;

  // Find ArchiveObjects in date range
  const fromDate = filters.from ? new Date(filters.from).toISOString().split('T')[0] : null;
  const toDate = filters.to ? new Date(filters.to).toISOString().split('T')[0] : null;

  if (!fromDate || !toDate) {
    throw new Error('from and to dates are required for ARCHIVED exports');
  }

  logger.info(
    {
      companyId: authContext.companyId,
      region,
      fromDate,
      toDate,
      jobId: exportJob.id,
    },
    'ARCHIVED export: Querying archive objects'
  );

  const archiveObjects = await prisma.archiveObject.findMany({
    where: {
      companyId: authContext.companyId,
      region: region,
      date: {
        gte: fromDate,
        lte: toDate,
      },
      // Exclude cold archived objects (they require restoration from Glacier)
      isColdArchived: false,
    },
    orderBy: { date: 'asc' },
  });

  logger.info(
    {
      companyId: authContext.companyId,
      region,
      fromDate,
      toDate,
      archiveCount: archiveObjects.length,
      jobId: exportJob.id,
    },
    'ARCHIVED export: Found archive objects'
  );

      // Check for cold archived objects that need restoration
      const coldArchivedObjects = await prisma.archiveObject.findMany({
        where: {
          companyId: authContext.companyId,
          region: region,
          date: {
            gte: fromDate,
            lte: toDate,
          },
          isColdArchived: true,
        },
        select: { id: true, restoredUntil: true },
      });

      // Filter out objects that are currently restored (restoredUntil > now)
      const now = new Date();
      const coldArchivedNeedingRestore = coldArchivedObjects.filter(
        (obj: { id: string; restoredUntil: Date | null }) => !obj.restoredUntil || obj.restoredUntil < now
      );

      if (coldArchivedNeedingRestore.length > 0) {
        // Check if any have active restore requests
        const archiveIds = coldArchivedNeedingRestore.map((a: { id: string }) => a.id);
        const activeRestores = await prisma.glacierRestoreRequest.findMany({
          where: {
            companyId: authContext.companyId,
            archiveId: { in: archiveIds },
            status: 'COMPLETED',
            expiresAt: { gt: now },
          },
          select: { archiveId: true },
        });

        const activeRestoreArchiveIds = new Set(activeRestores.map((r: { archiveId: string }) => r.archiveId));
        const archivesRequiringRestore = archiveIds.filter((id: string) => !activeRestoreArchiveIds.has(id));

        if (archivesRequiringRestore.length > 0) {
          logger.warn(
            {
              companyId: authContext.companyId,
              region,
              fromDate,
              toDate,
              archiveIds: archivesRequiringRestore,
              jobId: exportJob.id,
            },
            'ARCHIVED export: Cold archived objects require restoration'
          );

          // Throw error that will be caught by export route handler
          const error: any = new Error('Cold archived data requires restoration before export');
          error.code = 'RESTORE_REQUIRED';
          error.archiveIds = archivesRequiringRestore;
          throw error;
        }
      }

  // If no archives found, return empty stream
  const coldArchivedCount = coldArchivedObjects.length;
  if (archiveObjects.length === 0) {
    logger.info(
      {
        companyId: authContext.companyId,
        region,
        fromDate,
        toDate,
        coldArchivedCount,
      },
      'No archive objects found for export date range'
    );

    // Return empty stream with appropriate format
    const emptyStream = new Readable({
      objectMode: false,
      read() {
        // Send CSV header if CSV format, then end
        if (format === 'CSV') {
          this.push('id,timestamp,category,action,actorId,actorEmail,actorRole,resourceType,resourceId,metadata,traceId,ipAddress,geo,userAgent\n');
        }
        this.push(null); // End stream
      },
    });

    // Start the stream immediately
    process.nextTick(() => {
      emptyStream.read();
    });

    return emptyStream;
  }

  // Use a PassThrough stream to output data
  const outputStream = new PassThrough({ objectMode: false });
  let headerSent = false;

  // Process all archives and push to stream
  // Do this in background but ensure it starts immediately
  const processArchives = async () => {
    try {
      logger.info({ archiveCount: archiveObjects.length, jobId: exportJob.id }, 'ARCHIVED export: Starting to process archives');
      
      for (const archive of archiveObjects) {
        // Skip cold archived objects
        if (archive.isColdArchived) {
          logger.warn({ archiveId: archive.id, jobId: exportJob.id }, 'ARCHIVED export: Skipping cold archived object');
          continue;
        }

        const s3Key = archive.s3Key;
        if (!s3Key) {
          logger.error({ archiveId: archive.id, jobId: exportJob.id }, 'ARCHIVED export: Archive missing s3Key');
          continue;
        }

        logger.info({ archiveId: archive.id, s3Key, rowCount: archive.rowCount, gzSizeBytes: archive.gzSizeBytes, jobId: exportJob.id }, 'ARCHIVED export: Processing archive');

        try {
          // Read entire archive into memory (small files, so this is fine)
          const gzippedBuffer = await getObjectBuffer(region, s3Key);
          logger.info({ archiveId: archive.id, gzippedSize: gzippedBuffer.length, jobId: exportJob.id }, 'ARCHIVED export: Read archive from S3');
          
          // Gunzip the buffer
          const decompressedBuffer = gunzipSync(gzippedBuffer);
          const content = decompressedBuffer.toString('utf-8');
          logger.info({ archiveId: archive.id, decompressedSize: decompressedBuffer.length, contentLength: content.length, jobId: exportJob.id }, 'ARCHIVED export: Decompressed archive');
          
          // Process each line
          const lines = content.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const event = JSON.parse(line);

              // Best-effort filtering
              if (filters.category && event.category !== filters.category) continue;
              if (filters.action && event.action !== filters.action) continue;

              if (format === 'JSONL') {
                logger.info({ archiveId: archive.id, lineLength: line.length, jobId: exportJob.id }, 'ARCHIVED export: Pushing JSONL line to stream');
                outputStream.push(line + '\n');
              } else {
                // CSV format
                if (!headerSent) {
                  outputStream.push('id,timestamp,category,action,actorId,actorEmail,actorRole,resourceType,resourceId,metadata,traceId,ipAddress,geo,userAgent\n');
                  headerSent = true;
                }
                const row = [
                  event.id,
                  event.timestamp,
                  event.category,
                  event.action,
                  event.actorId || '',
                  event.actorEmail || '',
                  event.actorRole || '',
                  event.resourceType || '',
                  event.resourceId || '',
                  JSON.stringify(event.metadata),
                  event.traceId,
                  event.ipAddress || '',
                  event.geo || '',
                  event.userAgent || '',
                ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
                outputStream.push(row + '\n');
              }
            } catch (error: any) {
              logger.debug({ err: error, line: line.substring(0, 100), jobId: exportJob.id }, 'ARCHIVED export: Skipping invalid JSON line');
              continue;
            }
          }

          logger.info({ archiveId: archive.id, linesProcessed: lines.length, jobId: exportJob.id }, 'ARCHIVED export: Finished processing archive');
        } catch (error: any) {
          logger.error({ err: error, archiveId: archive.id, s3Key, jobId: exportJob.id }, 'ARCHIVED export: Failed to process archive');
          // Continue to next archive
        }
      }

      // All archives processed, end the stream
      logger.info({ jobId: exportJob.id }, 'ARCHIVED export: All archives processed, ending stream');
      outputStream.push(null);
    } catch (error: any) {
      logger.error({ err: error, jobId: exportJob.id }, 'ARCHIVED export: Error processing archives');
      outputStream.destroy(error);
    }
  };

  // Start processing immediately - don't await, let it run in background
  processArchives().catch((err) => {
    logger.error({ err, jobId: exportJob.id }, 'ARCHIVED export: Unhandled error in processArchives');
    outputStream.destroy(err);
  });

  return outputStream;
}


/**
 * Stream HOT and ARCHIVED data combined
 * Streams HOT data first, then ARCHIVED data
 */
async function streamHotAndArchivedData(
  prisma: any,
  exportJob: any,
  authContext: any
): Promise<Readable> {
  const format = exportJob.format;

  // Create a PassThrough stream to combine both sources
  const combinedStream = new PassThrough({ objectMode: false });
  
  // CRITICAL: Ensure stream is in flowing mode so it stays open
  combinedStream.resume();

  let headerSent = false;
  let hotStreamEnded = false;
  let archivedStreamEnded = false;

  // Helper to end combined stream when both are done
  const checkComplete = () => {
    if (hotStreamEnded && archivedStreamEnded) {
      logger.info({ jobId: exportJob.id }, 'HOT_AND_ARCHIVED: Both streams complete, ending combined stream');
      combinedStream.push(null); // End stream
    }
  };

  // Helper to send CSV header once
  const sendHeader = () => {
    if (format === 'CSV' && !headerSent) {
      combinedStream.push('id,timestamp,category,action,actorId,actorEmail,actorRole,resourceType,resourceId,metadata,traceId,ipAddress,geo,userAgent\n');
      headerSent = true;
    }
  };

  // Stream HOT data first
  const hotStream = await streamHotData(prisma, exportJob, authContext);
  
  logger.info({ jobId: exportJob.id }, 'HOT_AND_ARCHIVED: Created HOT stream');
  
  hotStream.on('data', (chunk: Buffer) => {
    sendHeader();
    combinedStream.push(chunk);
  });

  hotStream.on('end', () => {
    logger.info({ jobId: exportJob.id }, 'HOT_AND_ARCHIVED: HOT stream ended');
    hotStreamEnded = true;
    // Don't check complete yet - wait for archived stream
  });

  hotStream.on('error', (error: Error) => {
    logger.error({ err: error, jobId: exportJob.id }, 'Error in HOT stream for HOT_AND_ARCHIVED export');
    // Continue with archived data even if HOT fails
    hotStreamEnded = true;
    // Don't check complete yet - wait for archived stream
  });

  // Start the HOT stream immediately
  process.nextTick(() => {
    hotStream.read();
  });

  // Stream ARCHIVED data after HOT completes
  // Use 'end' (not 'once') to handle case where HOT ends immediately
  hotStream.on('end', async () => {
    // Only start archived stream once
    if (archivedStreamEnded) return;
    
    logger.info({ jobId: exportJob.id }, 'HOT_AND_ARCHIVED: Starting ARCHIVED stream');
    try {
      const archivedStream = await streamArchivedData(prisma, exportJob, authContext);
      
      archivedStream.on('data', (chunk: Buffer) => {
        sendHeader();
        combinedStream.push(chunk);
      });

      archivedStream.on('end', () => {
        logger.info({ jobId: exportJob.id }, 'HOT_AND_ARCHIVED: ARCHIVED stream ended');
        archivedStreamEnded = true;
        checkComplete();
      });

      archivedStream.on('error', (error: Error) => {
        logger.error({ err: error, jobId: exportJob.id }, 'Error in ARCHIVED stream for HOT_AND_ARCHIVED export');
        archivedStreamEnded = true;
        checkComplete();
      });

      // Start the archived stream immediately
      process.nextTick(() => {
        archivedStream.read();
      });
    } catch (error: any) {
      logger.error({ err: error, jobId: exportJob.id }, 'Failed to create archived stream for HOT_AND_ARCHIVED export');
      archivedStreamEnded = true;
      checkComplete();
    }
  });

  return combinedStream;
}

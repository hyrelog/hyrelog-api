/**
 * Dashboard Company Routes
 *
 * Contract: docs/DASHBOARD_API_CONTRACT.md
 * Idempotent upserts by dashboardCompanyId; region from body or lookup.
 */

import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { z } from 'zod';
import { getLogger } from '../../lib/logger.js';
import { logDashboardAction } from '../../lib/auditLog.js';
import {
  getCompanyLimit,
  getCompanyPlanConfig,
  requireCompanyFeature,
  requireCompanyLimit,
  PlanRestrictionError,
} from '../../lib/plans.js';
import { generateWebhookSecret, hashWebhookSecret } from '../../lib/webhookSigning.js';
import { encryptWebhookSecret } from '../../lib/webhookEncryption.js';
import { getRegionRouter } from '../../lib/regionRouter.js';
import { loadConfig } from '../../lib/config.js';
import {
  streamHotData,
  streamArchivedData,
  streamHotAndArchivedData,
} from '../v1/exports.js';
import {
  QueryEventHistogramSchema,
  computeDashboardEventHistogram,
} from '../../lib/dashboardEventHistogram.js';
import {
  DashboardCreateExportBodySchema,
  buildDashboardExportListWhere,
  buildDashboardExportTemplateListWhere,
  canDashboardUserViewExportJob,
  canDashboardUserViewExportTemplate,
  createDashboardExportJob,
  filtersJsonForExportTemplate,
  sanitizeDashboardFilters,
} from '../../lib/dashboardExportJobs.js';
import { publicExportFailureSummary } from '../../lib/exportJobPublicMessages.js';
import { sanitizeEventQueryForPersistence, eventQueryToExportFilters } from '../../lib/eventQuery.js';
import {
  buildSavedExplorerViewListWhere,
  canDashboardUserViewSavedExplorerView,
  CreateSavedExplorerViewBodySchema,
  PatchSavedExplorerViewBodySchema,
} from '../../lib/savedExplorerViews.js';
import { isPrismaTableMissingForModel } from '../../lib/prismaKnownErrors.js';

const logger = getLogger();
const regionRouter = getRegionRouter();

const DASHBOARD_ELEVATED_ROLES = new Set(['OWNER', 'ADMIN', 'BILLING', 'HYRELOG_ADMIN']);

function canMutateSavedExplorerView(
  userRole: string | undefined,
  userId: string,
  view: { createdByUserId: string }
): boolean {
  if (DASHBOARD_ELEVATED_ROLES.has(userRole ?? '')) return true;
  return view.createdByUserId === userId;
}

/** Resolve dashboard (Prisma) workspace UUID or API workspace PK to API `Workspace.id`. */
async function resolveWorkspaceIdForSavedView(
  prisma: NonNullable<FastifyRequest['prisma']>,
  companyId: string,
  dashboardOrApiWorkspaceId: string
): Promise<string | null> {
  const row = await prisma.workspace.findFirst({
    where: {
      companyId,
      OR: [{ id: dashboardOrApiWorkspaceId }, { dashboardWorkspaceId: dashboardOrApiWorkspaceId }],
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

const QueryEventsSchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
  sort: z.enum(['timestamp', 'category', 'action', 'id']).default('timestamp'),
  order: z.enum(['asc', 'desc']).default('desc'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  category: z.string().optional(),
  action: z.string().optional(),
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
});

const QueryEventFilterOptionsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  workspaceId: z.string().uuid().optional(),
});

const QueryWebhookDeliveriesSchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(20),
  status: z.enum(['PENDING', 'SENDING', 'SUCCEEDED', 'FAILED', 'RETRY_SCHEDULED']).optional(),
});

/** Must stay in sync with Prisma `WebhookEventType`. */
const DASHBOARD_WEBHOOK_EVENT_NAMES = ['AUDIT_EVENT_CREATED'] as const;
const dashboardWebhookEventNameSet = new Set<string>(DASHBOARD_WEBHOOK_EVENT_NAMES);

const CreateDashboardWebhookSchema = z
  .object({
    workspaceId: z.string().uuid(),
    url: z.string().url(),
    events: z.array(z.string().min(1)).min(1).default(['AUDIT_EVENT_CREATED']),
    projectId: z.string().uuid().nullable().optional(),
    customSecret: z.string().min(8).max(256).optional(),
  })
  .superRefine((data, ctx) => {
    const unknown = [...new Set(data.events.filter((e) => !dashboardWebhookEventNameSet.has(e)))];
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events'],
        message: `Unknown event type(s): ${unknown.join(', ')}. Allowed: ${DASHBOARD_WEBHOOK_EVENT_NAMES.join(', ')}`,
      });
    }
  });

function validateDashboardWebhookUrl(url: string): { valid: boolean; error?: string } {
  const urlObj = new URL(url);
  const isLocalhost = urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1';
  const isHttps = urlObj.protocol === 'https:';
  const isHttp = urlObj.protocol === 'http:';

  if (process.env.NODE_ENV === 'production' && !isHttps) {
    return { valid: false, error: 'Webhook URLs must use HTTPS in production' };
  }
  if (isLocalhost && isHttp) return { valid: true };
  if (!isHttps) {
    return {
      valid: false,
      error: 'Webhook URLs must use HTTPS (http://localhost allowed in development only)',
    };
  }
  return { valid: true };
}

function buildDashboardEventsWhere(
  companyId: string,
  filters: {
    from?: string;
    to?: string;
    category?: string;
    action?: string;
    projectId?: string;
    workspaceId?: string;
  }
): Record<string, unknown> {
  const where: Record<string, unknown> = { companyId };
  if (filters.category) where.category = filters.category;
  if (filters.action) where.action = filters.action;
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.workspaceId) where.workspaceId = filters.workspaceId;
  if (filters.from || filters.to) {
    (where as { timestamp: { gte?: Date; lte?: Date } }).timestamp = {};
    if (filters.from) {
      (where as { timestamp: { gte?: Date; lte?: Date } }).timestamp.gte = new Date(filters.from);
    }
    if (filters.to) {
      (where as { timestamp: { gte?: Date; lte?: Date } }).timestamp.lte = new Date(filters.to);
    }
  }
  return where;
}

function buildEventListOrderBy(
  sort: 'timestamp' | 'category' | 'action' | 'id',
  order: 'asc' | 'desc'
): Array<Record<string, 'asc' | 'desc'>> {
  if (sort === 'id') return [{ id: order }];
  if (sort === 'timestamp') return [{ timestamp: order }, { id: order }];
  if (sort === 'category') return [{ category: order }, { timestamp: order }, { id: order }];
  return [{ action: order }, { timestamp: order }, { id: order }];
}

const DEFAULT_HOT_EXPORT_BUFFER_CAP_BYTES = 512 * 1024 * 1024;

async function bufferNodeReadableToEnd(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error('HOT export exceeded in-memory buffer cap') as Error & { code: string; maxBytes: number };
      err.code = 'EXPORT_BUFFER_CAP_EXCEEDED';
      err.maxBytes = maxBytes;
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function pipeDashboardExportStream(
  reply: FastifyReply,
  prisma: any,
  exportJob: any,
  authContext: { companyId: string; scope: 'COMPANY' | 'WORKSPACE'; workspaceId?: string; region: string; apiKeyId?: string }
): Promise<void> {
  await prisma.exportJob.update({
    where: { id: exportJob.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  let canceledByClient = false;
  let jobFinalized = false;
  const finalizeJob = async (data: {
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELED';
    errorCode?: string;
    errorMessage?: string;
  }) => {
    if (jobFinalized) return;
    jobFinalized = true;
    await prisma.exportJob.update({
      where: { id: exportJob.id },
      data: {
        status: data.status,
        finishedAt: new Date(),
        ...(data.errorCode && { errorCode: data.errorCode }),
        ...(data.errorMessage && { errorMessage: data.errorMessage }),
      },
    });
  };

  try {
    let stream: Readable;
    if (exportJob.source === 'HOT') {
      stream = await streamHotData(prisma, exportJob, authContext);
    } else if (exportJob.source === 'ARCHIVED') {
      stream = await streamArchivedData(prisma, exportJob, authContext);
    } else if (exportJob.source === 'HOT_AND_ARCHIVED') {
      stream = await streamHotAndArchivedData(prisma, exportJob, authContext);
    } else {
      throw new Error(`Unknown export source: ${exportJob.source}`);
    }

    const filename = `export-${exportJob.id}.${String(exportJob.format).toLowerCase()}`;
    reply.header('Content-Type', exportJob.format === 'CSV' ? 'text/csv' : 'application/x-ndjson');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    /**
     * HOT dashboard exports: buffer the full payload before sending.
     * Relying on reply.send(PassThrough) + stream 'close' vs 'end' vs reply.raw.writableFinished
     * has produced empty HTTP bodies for small CSVs while the job still showed rows exported.
     * Buffering guarantees Content-Length and a complete response for the dashboard proxy.
     */
    if (exportJob.source === 'HOT') {
      const capRaw = process.env.DASHBOARD_HOT_EXPORT_MAX_BUFFER_BYTES;
      const cap =
        capRaw && Number.isFinite(Number(capRaw)) && Number(capRaw) > 0
          ? Number(capRaw)
          : DEFAULT_HOT_EXPORT_BUFFER_CAP_BYTES;
      let body: Buffer;
      try {
        body = await bufferNodeReadableToEnd(stream, cap);
      } catch (bufErr: any) {
        if (bufErr?.code === 'EXPORT_BUFFER_CAP_EXCEEDED') {
          if (!canceledByClient) {
            await finalizeJob({
              status: 'FAILED',
              errorCode: 'EXPORT_TOO_LARGE',
              errorMessage: 'Export exceeded dashboard buffer limit.',
            });
          }
          return reply.code(413).send({
            error: 'Export too large for this dashboard download path.',
            code: 'EXPORT_TOO_LARGE',
            maxBytes: bufErr.maxBytes,
          });
        }
        throw bufErr;
      }
      reply.header('Content-Length', String(body.length));
      reply.send(body);
      if (!canceledByClient) {
        await finalizeJob({ status: 'SUCCEEDED' });
      }
      return;
    }

    stream.on('end', async () => {
      if (!canceledByClient) {
        try {
          await finalizeJob({ status: 'SUCCEEDED' });
        } catch (updateError: any) {
          logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to mark export job as succeeded');
        }
      }
    });

    stream.on('error', async (streamError: any) => {
      if (!canceledByClient) {
        try {
          await finalizeJob({
            status: 'FAILED',
            errorCode: 'STREAM_ERROR',
            errorMessage: 'Export stream failed.',
          });
        } catch (updateError: any) {
          logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to mark export job as failed');
        }
      }
    });

    stream.on('close', async () => {
      if (jobFinalized) return;
      try {
        if (reply.raw.writableFinished) {
          await finalizeJob({ status: 'SUCCEEDED' });
        } else {
          canceledByClient = true;
          await finalizeJob({
            status: 'CANCELED',
            errorCode: 'CLIENT_DISCONNECTED',
            errorMessage: 'Export stream closed before completion',
          });
        }
      } catch (updateError: any) {
        logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to finalize export job on stream close');
      }
    });

    reply.raw.on('close', async () => {
      if (jobFinalized) return;
      if (reply.raw.writableFinished) return;
      canceledByClient = true;
      try {
        await finalizeJob({
          status: 'CANCELED',
          errorCode: 'CLIENT_DISCONNECTED',
          errorMessage: 'Client disconnected before export stream completed',
        });
        logger.info({ jobId: exportJob.id }, 'Export job canceled due to client disconnect');
      } catch (updateError: any) {
        logger.error({ err: updateError, jobId: exportJob.id }, 'Failed to mark export job as canceled');
      }
    });

    reply.send(stream);
    return;
  } catch (error: any) {
    if (error.code === 'RESTORE_REQUIRED') {
      if (!canceledByClient) {
        await finalizeJob({
          status: 'FAILED',
          errorCode: 'RESTORE_REQUIRED',
          errorMessage: 'Cold archive restoration required before export.',
        });
      }
      void reply.code(400).send({
        error: 'Cold archived data requires restoration before export',
        code: 'RESTORE_REQUIRED',
        archiveIds: error.archiveIds || [],
      });
      return;
    }
    if (!canceledByClient) {
      await finalizeJob({
        status: 'FAILED',
        errorCode: 'STREAM_ERROR',
        errorMessage: 'Export stream failed.',
      });
    }
    void reply.code(500).send({ error: 'Export stream failed', code: 'STREAM_ERROR' });
  }
}

const ProvisionCompanySchema = z.object({
  dashboardCompanyId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  dataRegion: z.enum(['US', 'EU', 'UK', 'AU']),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  createdAt: z.string().datetime().optional(),
});

const CreateCompanySchema = z.object({
  name: z.string().min(1).max(100),
  dataRegion: z.enum(['US', 'EU', 'APAC']).default('US'),
  companySize: z.string().optional(),
  industry: z.string().optional(),
  useCase: z.string().optional(),
});

export const companyRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /dashboard/companies
   * Idempotent company provisioning (contract). Body: dashboardCompanyId, slug, name, dataRegion.
   */
  fastify.post('/companies', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({
        error:
          'Dashboard auth not set on request. The dashboard auth plugin may not have run (check token and actor headers).',
        code: 'UNAUTHORIZED',
        reason: 'dashboard_auth_not_set',
      });
    }

    const bodyResult = ProvisionCompanySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { dashboardCompanyId, slug, name, dataRegion } = bodyResult.data;
    const prisma = regionRouter.getPrisma(dataRegion);
    const { userId, userEmail, userRole } = request.dashboardAuth;

    try {
      const existing = await prisma.company.findUnique({
        where: { dashboardCompanyId },
        select: { id: true, name: true, dataRegion: true, createdAt: true },
      });

      if (existing) {
        await logDashboardAction(prisma, request, {
          action: 'COMPANY_PROVISION_IDEMPOTENT',
          actorUserId: userId,
          actorEmail: userEmail,
          actorRole: userRole,
          targetCompanyId: existing.id,
          metadata: { dashboardCompanyId },
        });
        return reply.code(200).send({
          apiCompanyId: existing.id,
          dashboardCompanyId,
          dataRegion: existing.dataRegion,
          status: 'PROVISIONED',
          created: false,
          updatedAt: existing.createdAt.toISOString(),
        });
      }

      const provisionTier = loadConfig().defaultDashboardProvisionPlanTier;

      const provisionPlan = await prisma.plan.findFirst({
        where: { planTier: provisionTier, planType: 'STANDARD', isActive: true },
      });
      if (!provisionPlan) {
        logger.error({ dataRegion, provisionTier }, 'Dashboard: No plan row for provisioning tier');
        return reply.code(500).send({ error: 'Plan configuration missing', code: 'INTERNAL_ERROR' });
      }

      const company = await prisma.company.create({
        data: {
          dashboardCompanyId,
          slug,
          name,
          dataRegion,
          planId: provisionPlan.id,
          planTier: provisionTier,
          billingStatus: 'ACTIVE',
        },
      });

      await logDashboardAction(prisma, request, {
        action: 'COMPANY_CREATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: company.id,
        metadata: { name, dataRegion, dashboardCompanyId },
      });

      return reply.code(201).send({
        apiCompanyId: company.id,
        dashboardCompanyId,
        dataRegion: company.dataRegion,
        status: 'PROVISIONED',
        created: true,
        createdAt: company.createdAt.toISOString(),
      });
    } catch (error: any) {
      logger.error({ err: error, dashboardCompanyId, dataRegion }, 'Dashboard: Failed to provision company');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/companies/:dashboardCompanyId
   * Reconciliation: exists, apiCompanyId, dataRegion, updatedAt
   */
  fastify.get<{ Params: { dashboardCompanyId: string } }>('/companies/:dashboardCompanyId', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { dashboardCompanyId } = request.params;
    if (!dashboardCompanyId) {
      return reply.code(400).send({ error: 'Missing dashboardCompanyId', code: 'VALIDATION_ERROR' });
    }

    const regions = regionRouter.getAllRegions();
    for (const region of regions) {
      const prisma = regionRouter.getPrisma(region);
      const company = await prisma.company.findUnique({
        where: { dashboardCompanyId },
        select: { id: true, dataRegion: true, createdAt: true },
      });
      if (company) {
        return reply.send({
          exists: true,
          apiCompanyId: company.id,
          dataRegion: company.dataRegion,
          updatedAt: company.createdAt.toISOString(),
        });
      }
    }

    return reply.send({ exists: false });
  });

  /**
   * GET /dashboard/company
   * Get company summary with plan and region
   */
  fastify.get('/company', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        include: {
          plan: true,
        },
      });

      if (!company) {
        return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
      }

      const planConfig = getCompanyPlanConfig({
        planTier: company.planTier,
        planOverrides: company.planOverrides as any,
      });

      // Log audit action
      await logDashboardAction(prisma, request, {
        action: 'COMPANY_VIEWED',
        actorUserId: request.dashboardAuth.userId,
        actorEmail: request.dashboardAuth.userEmail,
        actorRole: request.dashboardAuth.userRole,
        targetCompanyId: companyId,
      });

      return reply.send({
        id: company.id,
        name: company.name,
        dataRegion: company.dataRegion,
        plan: {
          id: company.plan.id,
          name: company.plan.name,
          tier: company.planTier,
          config: planConfig,
        },
        createdAt: company.createdAt.toISOString(),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to get company');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/events/filter-options
   * Distinct category and action values for the company, scoped by optional workspace and date range.
   * (Does not use category/action filters so the dropdowns can list all values in scope.)
   */
  fastify.get('/events/filter-options', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;
    const q = QueryEventFilterOptionsSchema.safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: q.error.errors,
      });
    }

    const { from, to, workspaceId } = q.data;
    const where = buildDashboardEventsWhere(companyId, { from, to, workspaceId });

    try {
      const [catGroups, actGroups] = await Promise.all([
        prisma.auditEvent.groupBy({
          by: ['category'],
          where: where as any,
        }),
        prisma.auditEvent.groupBy({
          by: ['action'],
          where: where as any,
        }),
      ]);
      const categories = catGroups
        .map((r) => r.category)
        .sort((a, b) => a.localeCompare(b));
      const actions = actGroups
        .map((r) => r.action)
        .sort((a, b) => a.localeCompare(b));
      return reply.send({ categories, actions });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to load event filter options');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/events/metrics/histogram
   *
   * Native time-bucket aggregation over `AuditEvent.timestamp` (same column as list date filters).
   * Auth/scoping matches GET /dashboard/events: `companyId` from dashboard auth, optional
   * `workspaceId` / `projectId` / `category` / `action` query filters — callers must pass the
   * same workspace filter the dashboard uses for MEMBER views (API does not load membership rows).
   */
  fastify.get('/events/metrics/histogram', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;
    const parsed = QueryEventHistogramSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: parsed.error.errors,
      });
    }

    try {
      const body = await computeDashboardEventHistogram(prisma, companyId, parsed.data);

      await logDashboardAction(prisma, request, {
        action: 'EVENTS_HISTOGRAM_QUERIED',
        actorUserId: request.dashboardAuth.userId,
        actorEmail: request.dashboardAuth.userEmail,
        actorRole: request.dashboardAuth.userRole,
        targetCompanyId: companyId,
        metadata: {
          interval: parsed.data.interval,
          groupBy: parsed.data.groupBy,
          filters: {
            workspaceId: parsed.data.workspaceId,
            projectId: parsed.data.projectId,
            category: parsed.data.category,
            action: parsed.data.action,
            from: parsed.data.from,
            to: parsed.data.to,
          },
        },
      });

      return reply.send(body);
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to compute event histogram');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/events
   * Company-scoped events: offset/limit pagination, total count, sort.
   */
  fastify.get('/events', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    const queryResult = QueryEventsSchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: queryResult.error.errors,
      });
    }

    const { limit, offset, sort, order, from, to, category, action, projectId, workspaceId } =
      queryResult.data;

    try {
      const where = buildDashboardEventsWhere(companyId, {
        from,
        to,
        category,
        action,
        projectId,
        workspaceId,
      });

      const [total, events] = await Promise.all([
        prisma.auditEvent.count({ where: where as any }),
        prisma.auditEvent.findMany({
          where: where as any,
          skip: offset,
          take: limit,
          orderBy: buildEventListOrderBy(sort, order) as any,
          select: {
            id: true,
            timestamp: true,
            category: true,
            action: true,
            actorId: true,
            actorEmail: true,
            actorRole: true,
            resourceType: true,
            resourceId: true,
            metadata: true,
            traceId: true,
            ipAddress: true,
            geo: true,
            userAgent: true,
          },
        }),
      ]);

      await logDashboardAction(prisma, request, {
        action: 'EVENTS_QUERIED',
        actorUserId: request.dashboardAuth.userId,
        actorEmail: request.dashboardAuth.userEmail,
        actorRole: request.dashboardAuth.userRole,
        targetCompanyId: companyId,
        metadata: {
          limit,
          offset,
          sort,
          order,
          filters: { category, action, projectId, workspaceId, from, to },
        },
      });

      return reply.send({
        events,
        total,
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to query events');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/explorer/views
   * List saved explorer views for the company (MEMBER workspace scoped).
   */
  fastify.get('/explorer/views', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userRole, exportWorkspaceIds } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const prisma = request.prisma;
    try {
      const listWhere = buildSavedExplorerViewListWhere(companyId, userRole ?? '', exportWorkspaceIds);
      const rows = await prisma.savedExplorerView.findMany({
        where: listWhere,
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          name: true,
          description: true,
          workspaceId: true,
          isDefault: true,
          createdByUserId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return reply.send({
        views: rows.map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
          workspaceId: v.workspaceId,
          isDefault: v.isDefault,
          createdByUserId: v.createdByUserId,
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        })),
      });
    } catch (error: unknown) {
      if (isPrismaTableMissingForModel(error, 'SavedExplorerView')) {
        logger.warn(
          { err: error, companyId, dataRegion: request.dashboardAuth?.companyDataRegion },
          'Dashboard: saved_explorer_views missing (apply migrations); returning empty views list'
        );
        void reply.header('x-hyrelog-schema-drift', 'saved_explorer_views');
        return reply.send({ views: [] });
      }
      logger.error({ err: error, companyId }, 'Dashboard: Failed to list saved explorer views');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/explorer/views
   * Create a saved explorer view.
   */
  fastify.post('/explorer/views', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const prisma = request.prisma;
    const parsed = CreateSavedExplorerViewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: parsed.error.errors,
      });
    }
    const { name, description, query: rawQuery, workspaceId: bodyWorkspaceId, isDefault } = parsed.data;

    let workspaceId: string | null = bodyWorkspaceId ?? null;
    if (userRole === 'MEMBER') {
      if (!workspaceId) {
        return reply.code(400).send({
          error: 'workspaceId is required for members when saving a view.',
          code: 'WORKSPACE_REQUIRED',
        });
      }
      const resolvedWs = await resolveWorkspaceIdForSavedView(prisma, companyId, workspaceId);
      if (!resolvedWs) {
        return reply.code(400).send({ error: 'Workspace not found for this company.', code: 'VALIDATION_ERROR' });
      }
      const ids = exportWorkspaceIds ?? [];
      if (!ids.includes(resolvedWs)) {
        return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
      workspaceId = resolvedWs;
    } else if (workspaceId) {
      const resolvedWs = await resolveWorkspaceIdForSavedView(prisma, companyId, workspaceId);
      if (!resolvedWs) {
        return reply.code(400).send({ error: 'Workspace not found for this company.', code: 'VALIDATION_ERROR' });
      }
      workspaceId = resolvedWs;
    }

    const safeQuery = sanitizeEventQueryForPersistence(rawQuery);

    try {
      const row = await prisma.savedExplorerView.create({
        data: {
          companyId,
          workspaceId,
          createdByUserId: userId,
          name,
          description: description ?? null,
          query: safeQuery as object,
          isDefault: Boolean(isDefault),
        },
      });
      await logDashboardAction(prisma, request, {
        action: 'SAVED_VIEW_CREATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { viewId: row.id, name: row.name },
      });
      return reply.code(201).send({
        view: {
          id: row.id,
          name: row.name,
          description: row.description,
          workspaceId: row.workspaceId,
          query: safeQuery,
          isDefault: row.isDefault,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to create saved explorer view');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/explorer/views/:viewId
   */
  fastify.get('/explorer/views/:viewId', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { viewId } = request.params as { viewId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const prisma = request.prisma;
    try {
      const row = await prisma.savedExplorerView.findFirst({
        where: { id: viewId, companyId },
      });
      if (
        !row ||
        !canDashboardUserViewSavedExplorerView({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          viewWorkspaceId: row.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Saved explorer view not found', code: 'NOT_FOUND' });
      }
      return reply.send({
        view: {
          id: row.id,
          name: row.name,
          description: row.description,
          workspaceId: row.workspaceId,
          query: sanitizeEventQueryForPersistence(row.query),
          isDefault: row.isDefault,
          createdByUserId: row.createdByUserId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, viewId }, 'Dashboard: Failed to get saved explorer view');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * PATCH /dashboard/explorer/views/:viewId
   */
  fastify.patch('/explorer/views/:viewId', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { viewId } = request.params as { viewId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const prisma = request.prisma;
    const parsed = PatchSavedExplorerViewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: parsed.error.errors,
      });
    }

    try {
      const existing = await prisma.savedExplorerView.findFirst({
        where: { id: viewId, companyId },
      });
      if (
        !existing ||
        !canDashboardUserViewSavedExplorerView({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          viewWorkspaceId: existing.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Saved explorer view not found', code: 'NOT_FOUND' });
      }
      if (!canMutateSavedExplorerView(userRole, userId, existing)) {
        return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }

      const data: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.description !== undefined) data.description = parsed.data.description;
      if (parsed.data.query !== undefined) data.query = sanitizeEventQueryForPersistence(parsed.data.query) as object;
      if (parsed.data.workspaceId !== undefined) {
        const nextWs = parsed.data.workspaceId;
        if (userRole === 'MEMBER') {
          if (!nextWs) {
            return reply.code(400).send({
              error: 'Members cannot clear workspace scope from a saved view.',
              code: 'VALIDATION_ERROR',
            });
          }
          const resolvedWs = await resolveWorkspaceIdForSavedView(prisma, companyId, nextWs);
          if (!resolvedWs) {
            return reply.code(400).send({ error: 'Workspace not found for this company.', code: 'VALIDATION_ERROR' });
          }
          const ids = exportWorkspaceIds ?? [];
          if (!ids.includes(resolvedWs)) {
            return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
          }
          data.workspaceId = resolvedWs;
        } else if (nextWs) {
          const resolvedWs = await resolveWorkspaceIdForSavedView(prisma, companyId, nextWs);
          if (!resolvedWs) {
            return reply.code(400).send({ error: 'Workspace not found for this company.', code: 'VALIDATION_ERROR' });
          }
          data.workspaceId = resolvedWs;
        } else {
          data.workspaceId = null;
        }
      }
      if (parsed.data.isDefault !== undefined) data.isDefault = parsed.data.isDefault;

      const row = await prisma.savedExplorerView.update({
        where: { id: viewId },
        data: data as any,
      });
      await logDashboardAction(prisma, request, {
        action: 'SAVED_VIEW_UPDATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { viewId: row.id },
      });
      return reply.send({
        view: {
          id: row.id,
          name: row.name,
          description: row.description,
          workspaceId: row.workspaceId,
          query: sanitizeEventQueryForPersistence(row.query),
          isDefault: row.isDefault,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, viewId }, 'Dashboard: Failed to update saved explorer view');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * DELETE /dashboard/explorer/views/:viewId
   */
  fastify.delete('/explorer/views/:viewId', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { viewId } = request.params as { viewId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const prisma = request.prisma;
    try {
      const existing = await prisma.savedExplorerView.findFirst({
        where: { id: viewId, companyId },
      });
      if (
        !existing ||
        !canDashboardUserViewSavedExplorerView({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          viewWorkspaceId: existing.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Saved explorer view not found', code: 'NOT_FOUND' });
      }
      if (!canMutateSavedExplorerView(userRole, userId, existing)) {
        return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
      await prisma.savedExplorerView.delete({ where: { id: viewId } });
      await logDashboardAction(prisma, request, {
        action: 'SAVED_VIEW_DELETED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { viewId },
      });
      return reply.code(204).send();
    } catch (error: any) {
      logger.error({ err: error, companyId, viewId }, 'Dashboard: Failed to delete saved explorer view');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/explorer/views/:viewId/run
   * Returns canonical query for applying to Explorer URL (no server-side event fetch).
   */
  fastify.post('/explorer/views/:viewId/run', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { viewId } = request.params as { viewId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const prisma = request.prisma;
    try {
      const existing = await prisma.savedExplorerView.findFirst({
        where: { id: viewId, companyId },
      });
      if (
        !existing ||
        !canDashboardUserViewSavedExplorerView({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          viewWorkspaceId: existing.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Saved explorer view not found', code: 'NOT_FOUND' });
      }
      const query = sanitizeEventQueryForPersistence(existing.query);
      await logDashboardAction(prisma, request, {
        action: 'SAVED_VIEW_RUN',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { viewId: existing.id },
      });
      return reply.send({
        view: {
          id: existing.id,
          name: existing.name,
          description: existing.description,
          workspaceId: existing.workspaceId,
          isDefault: existing.isDefault,
        },
        query,
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, viewId }, 'Dashboard: Failed to run saved explorer view');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  // Re-use existing export routes (they already enforce company scope via API key)
  // We'll wrap them to add dashboard auth and audit logging
  // For now, we'll create wrapper endpoints that call the existing logic

  /**
   * GET /dashboard/exports
   * List export jobs for the company
   */
  fastify.get('/exports', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userRole, exportWorkspaceIds } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const listWhere = buildDashboardExportListWhere(companyId, userRole ?? '', exportWorkspaceIds);
      const jobs = await prisma.exportJob.findMany({
        where: listWhere,
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          status: true,
          source: true,
          format: true,
          rowLimit: true,
          rowsExported: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          errorCode: true,
          requestedByType: true,
          requestedById: true,
          workspaceId: true,
          filters: true,
          workspace: { select: { dashboardWorkspaceId: true, name: true } },
        },
      });

      const needDashFromFilters = new Set<string>();
      for (const j of jobs) {
        const fj = j.filters as Record<string, unknown> | null;
        const wid = typeof fj?.workspaceId === 'string' ? fj.workspaceId : null;
        if (wid && !j.workspace?.dashboardWorkspaceId) {
          needDashFromFilters.add(wid);
        }
      }
      const dashByHyrelogWsId = new Map<string, string | null>();
      if (needDashFromFilters.size > 0) {
        const rows = await prisma.workspace.findMany({
          where: { companyId, id: { in: [...needDashFromFilters] } },
          select: { id: true, dashboardWorkspaceId: true },
        });
        for (const r of rows) dashByHyrelogWsId.set(r.id, r.dashboardWorkspaceId ?? null);
      }

      return reply.send({
        jobs: jobs.map((j) => {
          const fj = j.filters as Record<string, unknown> | null;
          const filterWorkspaceId = typeof fj?.workspaceId === 'string' ? fj.workspaceId : null;
          const explorerDashboardWorkspaceId =
            j.workspace?.dashboardWorkspaceId ??
            (filterWorkspaceId ? dashByHyrelogWsId.get(filterWorkspaceId) ?? null : null);
          const filtersSummary = {
            from: typeof fj?.from === 'string' ? fj.from : undefined,
            to: typeof fj?.to === 'string' ? fj.to : undefined,
            category: typeof fj?.category === 'string' ? fj.category : undefined,
            action: typeof fj?.action === 'string' ? fj.action : undefined,
            workspaceId: filterWorkspaceId ?? undefined,
          };
          return {
            id: j.id,
            status: j.status,
            source: j.source,
            format: j.format,
            rowLimit: j.rowLimit.toString(),
            rowsExported: j.rowsExported.toString(),
            createdAt: j.createdAt.toISOString(),
            startedAt: j.startedAt?.toISOString(),
            finishedAt: j.finishedAt?.toISOString(),
            errorCode: j.errorCode,
            failureSummary: publicExportFailureSummary(j.status, j.errorCode),
            requestedByType: j.requestedByType,
            requestedById: j.requestedById,
            workspaceId: j.workspaceId,
            workspaceName: j.workspace?.name ?? null,
            explorerDashboardWorkspaceId,
            filtersSummary,
          };
        }),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to list export jobs');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/exports/capabilities
   * Dashboard-safe probe for filtered export create (no side effects).
   * Register before GET /exports/:jobId so "capabilities" is not captured as a job id.
   *
   * Deployment: ship hyrelog-api with POST /dashboard/exports and this route before or
   * alongside hyrelog-dashboard filtered export UI; the dashboard disables export when
   * this route is missing (404) or createFilteredExport is false.
   */
  fastify.get('/exports/capabilities', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    return reply.send({
      createFilteredExport: true,
    });
  });

  /**
   * POST /dashboard/exports
   * Create HOT export job (same job row as /v1/exports) with dashboard auth + plan limits.
   *
   * Deployment: deploy hyrelog-api with this route before or alongside hyrelog-dashboard
   * so filtered event exports stay compatible (dashboard probes GET /dashboard/exports/capabilities).
   */
  fastify.post('/exports', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    const bodyResult = DashboardCreateExportBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { format, filters: rawFilters, limit, savedExplorerViewId } = bodyResult.data;

    let filters = rawFilters
      ? (Object.fromEntries(
          Object.entries(rawFilters).filter(([, v]) => v !== undefined && v !== '') as [string, string][]
        ) as Record<string, string>)
      : undefined;

    if (savedExplorerViewId) {
      const savedView = await prisma.savedExplorerView.findFirst({
        where: { id: savedExplorerViewId, companyId },
      });
      if (
        !savedView ||
        !canDashboardUserViewSavedExplorerView({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          viewWorkspaceId: savedView.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Saved explorer view not found', code: 'NOT_FOUND' });
      }
      const q = sanitizeEventQueryForPersistence(savedView.query);
      let fromView = eventQueryToExportFilters(q);
      if (!fromView.workspaceId && savedView.workspaceId) {
        fromView = { ...fromView, workspaceId: savedView.workspaceId };
      }
      filters = { ...fromView, ...(filters ?? {}) };
    }

    const created = await createDashboardExportJob(prisma, {
      companyId,
      userRole: userRole ?? '',
      exportWorkspaceIds,
      format,
      filters,
      limit,
      source: 'HOT',
      requestedByType: 'DASHBOARD_USER',
      requestedById: userId,
    });

    if (!('jobId' in created)) {
      return reply.code(created.statusCode).send(created.body);
    }

    await logDashboardAction(prisma, request, {
      action: 'EXPORT_REQUESTED',
      actorUserId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      targetCompanyId: companyId,
      metadata: {
        jobId: created.jobId,
        format,
        filters: filters ?? {},
        ...(savedExplorerViewId ? { savedExplorerViewId } : {}),
      },
    });

    return reply.code(201).send({
      jobId: created.jobId,
      status: created.status,
    });
  });

  const SaveExportTemplateFromJobSchema = z.object({
    sourceJobId: z.string().uuid(),
    name: z.string().min(1).max(128),
    description: z.string().max(500).optional(),
  });

  /**
   * POST /dashboard/exports/:jobId/rerun
   * Clone a finished or failed export into a new streaming job (never reuses prior stream bytes).
   */
  fastify.post('/exports/:jobId/rerun', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { jobId } = request.params as { jobId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const exportJob = await prisma.exportJob.findFirst({
        where: { id: jobId, companyId },
      });

      if (
        !exportJob ||
        !canDashboardUserViewExportJob({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          jobWorkspaceId: exportJob.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Export job not found', code: 'NOT_FOUND' });
      }

      if (!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(exportJob.status)) {
        return reply.code(400).send({
          error: 'Only completed, failed, or cancelled exports can be re-run.',
          code: 'EXPORT_RERUN_NOT_ALLOWED',
        });
      }

      let filters = sanitizeDashboardFilters(exportJob.filters as Record<string, unknown>);
      if ((userRole === 'MEMBER' || !filters?.workspaceId) && exportJob.workspaceId) {
        filters = { ...(filters ?? {}), workspaceId: exportJob.workspaceId };
      }

      const limitNum = Number(exportJob.rowLimit);
      const safeLimit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined;

      const created = await createDashboardExportJob(prisma, {
        companyId,
        userRole: userRole ?? '',
        exportWorkspaceIds,
        format: exportJob.format as 'JSONL' | 'CSV',
        filters,
        limit: safeLimit,
        source: exportJob.source as 'HOT' | 'ARCHIVED' | 'HOT_AND_ARCHIVED',
        requestedByType: 'DASHBOARD_USER',
        requestedById: userId,
      });

      if (!('jobId' in created)) {
        return reply.code(created.statusCode).send(created.body);
      }

      await logDashboardAction(prisma, request, {
        action: 'EXPORT_RERUN',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { priorJobId: jobId, newJobId: created.jobId },
      });

      return reply.code(201).send({
        jobId: created.jobId,
        status: created.status,
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, jobId }, 'Dashboard: Failed to rerun export');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/export-templates
   */
  fastify.get('/export-templates', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userRole, exportWorkspaceIds } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const listWhere = buildDashboardExportTemplateListWhere(companyId, userRole ?? '', exportWorkspaceIds);
      const rows = await prisma.exportTemplate.findMany({
        where: listWhere,
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          name: true,
          description: true,
          format: true,
          source: true,
          workspaceId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return reply.send({
        templates: rows.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          format: t.format,
          source: t.source,
          workspaceId: t.workspaceId,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
      });
    } catch (error: unknown) {
      if (isPrismaTableMissingForModel(error, 'ExportTemplate')) {
        logger.warn(
          { err: error, companyId, dataRegion: request.dashboardAuth?.companyDataRegion },
          'Dashboard: export_templates missing (apply migrations); returning empty templates list'
        );
        void reply.header('x-hyrelog-schema-drift', 'export_templates');
        return reply.send({ templates: [] });
      }
      logger.error({ err: error, companyId }, 'Dashboard: Failed to list export templates');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/export-templates
   * Save a reusable template from an existing export job (filters/format/source only).
   */
  fastify.post('/export-templates', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    const parsed = SaveExportTemplateFromJobSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: parsed.error.errors,
      });
    }

    const { sourceJobId, name, description } = parsed.data;

    try {
      const exportJob = await prisma.exportJob.findFirst({
        where: { id: sourceJobId, companyId },
      });

      if (
        !exportJob ||
        !canDashboardUserViewExportJob({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          jobWorkspaceId: exportJob.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Export job not found', code: 'NOT_FOUND' });
      }

      if (userRole === 'MEMBER' && !exportJob.workspaceId) {
        return reply.code(403).send({
          error: 'Company-wide exports cannot be saved as templates with your role.',
          code: 'FORBIDDEN',
        });
      }

      const tpl = await prisma.exportTemplate.create({
        data: {
          companyId,
          workspaceId: exportJob.workspaceId,
          name,
          description: description ?? null,
          createdByUserId: userId,
          filters: filtersJsonForExportTemplate(exportJob.filters as Record<string, unknown>) as object,
          format: exportJob.format,
          source: exportJob.source,
        },
      });

      await logDashboardAction(prisma, request, {
        action: 'EXPORT_TEMPLATE_SAVED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { templateId: tpl.id, sourceJobId },
      });

      return reply.code(201).send({
        template: {
          id: tpl.id,
          name: tpl.name,
          description: tpl.description,
          format: tpl.format,
          source: tpl.source,
          workspaceId: tpl.workspaceId,
          createdAt: tpl.createdAt.toISOString(),
          updatedAt: tpl.updatedAt.toISOString(),
        },
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to save export template');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/export-templates/:templateId/run
   * Queue a new export job from a saved template.
   */
  fastify.post('/export-templates/:templateId/run', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { templateId } = request.params as { templateId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const template = await prisma.exportTemplate.findFirst({
        where: { id: templateId, companyId },
      });

      if (
        !template ||
        !canDashboardUserViewExportTemplate({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          templateWorkspaceId: template.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Export template not found', code: 'NOT_FOUND' });
      }

      let filters = sanitizeDashboardFilters(template.filters as Record<string, unknown>);
      if ((userRole === 'MEMBER' || !filters?.workspaceId) && template.workspaceId) {
        filters = { ...(filters ?? {}), workspaceId: template.workspaceId };
      }

      const created = await createDashboardExportJob(prisma, {
        companyId,
        userRole: userRole ?? '',
        exportWorkspaceIds,
        format: template.format as 'JSONL' | 'CSV',
        filters,
        limit: undefined,
        source: template.source as 'HOT' | 'ARCHIVED' | 'HOT_AND_ARCHIVED',
        requestedByType: 'DASHBOARD_USER',
        requestedById: userId,
      });

      if (!('jobId' in created)) {
        return reply.code(created.statusCode).send(created.body);
      }

      await logDashboardAction(prisma, request, {
        action: 'EXPORT_TEMPLATE_RUN',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { templateId: template.id, jobId: created.jobId },
      });

      return reply.code(201).send({
        jobId: created.jobId,
        status: created.status,
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, templateId }, 'Dashboard: Failed to run export template');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/exports/:jobId/download
   * Stream export for dashboard users (same semantics as /v1/exports/:id/download with dashboard auth).
   * MEMBER scope uses x-export-workspace-ids; company-wide jobs (no workspaceId) are hidden from members.
   */
  fastify.get('/exports/:jobId/download', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { jobId } = request.params as { jobId: string };

    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const exportJob = await prisma.exportJob.findFirst({
        where: { id: jobId, companyId },
      });

      if (
        !exportJob ||
        !canDashboardUserViewExportJob({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          jobWorkspaceId: exportJob.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Export job not found', code: 'NOT_FOUND' });
      }

      if (exportJob.status === 'SUCCEEDED') {
        return reply.code(410).send({
          error: 'This export has already finished. Create a new export to download fresh data.',
          code: 'EXPORT_ALREADY_COMPLETED',
        });
      }
      if (exportJob.status === 'RUNNING') {
        return reply.code(409).send({
          error: 'This export is still being generated. Try again shortly.',
          code: 'EXPORT_IN_PROGRESS',
        });
      }
      if (exportJob.status === 'FAILED' || exportJob.status === 'CANCELED') {
        return reply.code(400).send({
          error: 'This export cannot be downloaded.',
          code: 'EXPORT_NOT_DOWNLOADABLE',
        });
      }

      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { dataRegion: true },
      });
      if (!company?.dataRegion) {
        return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }

      const authContext = {
        companyId,
        scope: 'COMPANY' as const,
        region: company.dataRegion,
        apiKeyId: 'DASHBOARD',
      };

      await pipeDashboardExportStream(reply, prisma, exportJob, authContext);
      return;
    } catch (error: any) {
      logger.error({ err: error, companyId, jobId }, 'Dashboard: Failed to stream export download');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/exports/:jobId
   * Get export job status (dashboard-safe fields; no raw internal error strings).
   */
  fastify.get('/exports/:jobId', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userRole, exportWorkspaceIds } = request.dashboardAuth;
    const { jobId } = request.params as { jobId: string };

    const prisma = request.prisma;

    try {
      const exportJob = await prisma.exportJob.findFirst({
        where: {
          id: jobId,
          companyId,
        },
        include: {
          workspace: { select: { dashboardWorkspaceId: true, name: true } },
        },
      });

      if (
        !exportJob ||
        !canDashboardUserViewExportJob({
          userRole: userRole ?? '',
          exportWorkspaceIds,
          jobWorkspaceId: exportJob.workspaceId,
        })
      ) {
        return reply.code(404).send({ error: 'Export job not found', code: 'NOT_FOUND' });
      }

      const fj = exportJob.filters as Record<string, unknown> | null;
      const filterWorkspaceId = typeof fj?.workspaceId === 'string' ? fj.workspaceId : null;
      let explorerDashboardWorkspaceId = exportJob.workspace?.dashboardWorkspaceId ?? null;
      if (!explorerDashboardWorkspaceId && filterWorkspaceId) {
        const w = await prisma.workspace.findFirst({
          where: { id: filterWorkspaceId, companyId },
          select: { dashboardWorkspaceId: true },
        });
        explorerDashboardWorkspaceId = w?.dashboardWorkspaceId ?? null;
      }

      const filtersSummary = {
        from: typeof fj?.from === 'string' ? fj.from : undefined,
        to: typeof fj?.to === 'string' ? fj.to : undefined,
        category: typeof fj?.category === 'string' ? fj.category : undefined,
        action: typeof fj?.action === 'string' ? fj.action : undefined,
        workspaceId: filterWorkspaceId ?? undefined,
      };

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
        failureSummary: publicExportFailureSummary(exportJob.status, exportJob.errorCode),
        requestedByType: exportJob.requestedByType,
        requestedById: exportJob.requestedById,
        workspaceId: exportJob.workspaceId,
        workspaceName: exportJob.workspace?.name ?? null,
        explorerDashboardWorkspaceId,
        filtersSummary,
        downloadHint:
          exportJob.status === 'PENDING'
            ? 'ready_to_stream'
            : exportJob.status === 'RUNNING'
              ? 'in_progress'
              : exportJob.status === 'SUCCEEDED'
                ? 'completed_no_repeat_download'
                : 'unavailable',
        evidence: {
          jobId: exportJob.id,
          companyScoped: true,
          requestedVia: exportJob.requestedByType === 'DASHBOARD_USER' ? 'dashboard' : 'api',
        },
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, jobId }, 'Dashboard: Failed to get export job');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/webhooks
   * List webhooks for company (across all workspaces)
   */
  fastify.get('/webhooks', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const webhooks = await prisma.webhookEndpoint.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      });

      await logDashboardAction(prisma, request, {
        action: 'WEBHOOKS_LISTED',
        actorUserId: request.dashboardAuth.userId,
        actorEmail: request.dashboardAuth.userEmail,
        actorRole: request.dashboardAuth.userRole,
        targetCompanyId: companyId,
      });

      return reply.send({
        webhooks: webhooks.map((w) => ({
          id: w.id,
          url: w.url,
          status: w.status,
          events: w.events,
          workspaceId: w.workspaceId,
          projectId: w.projectId,
          createdAt: w.createdAt.toISOString(),
        })),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to list webhooks');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  fastify.post('/webhooks', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const bodyResult = CreateDashboardWebhookSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { companyId, userId, userEmail, userRole } = request.dashboardAuth;
    const prisma = request.prisma;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const { workspaceId, url, events, projectId, customSecret } = bodyResult.data;
    const uniqueEvents = [...new Set(events)] as Array<(typeof DASHBOARD_WEBHOOK_EVENT_NAMES)[number]>;

    const urlValidation = validateDashboardWebhookUrl(url);
    if (!urlValidation.valid) {
      return reply.code(400).send({ error: urlValidation.error || 'Invalid webhook URL', code: 'VALIDATION_ERROR' });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { planTier: true, planOverrides: true },
    });
    if (!company) {
      return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
    }
    try {
      requireCompanyFeature(
        { planTier: company.planTier, planOverrides: company.planOverrides as any },
        'webhooksEnabled',
        'PRO'
      );
    } catch (error: any) {
      if (error instanceof PlanRestrictionError) {
        return reply.code(403).send({
          error: error.message || 'Webhooks require a Pro plan or higher',
          code: 'PLAN_RESTRICTED',
        });
      }
      throw error;
    }

    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, companyId },
      select: { id: true },
    });
    if (!workspace) {
      return reply.code(404).send({ error: 'Workspace not found', code: 'NOT_FOUND' });
    }

    if (projectId) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId },
        select: { id: true },
      });
      if (!project) {
        return reply.code(404).send({ error: 'Project not found or does not belong to workspace', code: 'NOT_FOUND' });
      }
    }

    const existingWebhooks = await prisma.webhookEndpoint.count({
      where: { workspaceId, companyId, status: 'ACTIVE' },
    });
    const newCount = existingWebhooks + 1;
    try {
      requireCompanyLimit(company, 'maxWebhooks', newCount, 'PRO');
    } catch (error: any) {
      if (error instanceof PlanRestrictionError) {
        const limit = getCompanyLimit(company, 'maxWebhooks');
        return reply.code(403).send({
          error: `Webhook limit exceeded. Current plan allows ${limit} active webhooks (you have ${existingWebhooks}).`,
          code: 'PLAN_RESTRICTED',
        });
      }
      throw error;
    }

    const plaintextSecret = customSecret?.trim() ? customSecret.trim() : generateWebhookSecret();
    const hashedSecret = hashWebhookSecret(plaintextSecret);
    const encryptedSecret = encryptWebhookSecret(plaintextSecret);

    const webhook = await prisma.webhookEndpoint.create({
      data: {
        url,
        events: uniqueEvents,
        status: 'ACTIVE',
        companyId,
        workspaceId,
        projectId: projectId ?? null,
        secretHashed: hashedSecret,
        secretEncrypted: encryptedSecret,
      },
    });

    await logDashboardAction(prisma, request, {
      action: 'WEBHOOK_CREATED',
      actorUserId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      targetCompanyId: companyId,
      metadata: { webhookId: webhook.id, workspaceId, projectId: projectId ?? null },
    });

    return reply.code(201).send({
      id: webhook.id,
      url: webhook.url,
      status: webhook.status,
      events: webhook.events,
      workspaceId: webhook.workspaceId,
      projectId: webhook.projectId,
      secret: plaintextSecret,
      createdAt: webhook.createdAt.toISOString(),
    });
  });

  fastify.post<{ Params: { webhookId: string } }>('/webhooks/:webhookId/enable', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userId, userEmail, userRole } = request.dashboardAuth;
    const { webhookId } = request.params;
    const prisma = request.prisma;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const webhook = await prisma.webhookEndpoint.findFirst({
      where: { id: webhookId, companyId },
      select: { id: true, status: true },
    });
    if (!webhook) {
      return reply.code(404).send({ error: 'Webhook not found', code: 'NOT_FOUND' });
    }
    if (webhook.status === 'ACTIVE') {
      return reply.send({ id: webhook.id, status: webhook.status });
    }
    const updated = await prisma.webhookEndpoint.update({
      where: { id: webhook.id },
      data: { status: 'ACTIVE' },
      select: { id: true, status: true },
    });
    await logDashboardAction(prisma, request, {
      action: 'WEBHOOK_ENABLED',
      actorUserId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      targetCompanyId: companyId,
      metadata: { webhookId: webhook.id },
    });
    return reply.send(updated);
  });

  fastify.post<{ Params: { webhookId: string } }>('/webhooks/:webhookId/disable', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    const { companyId, userId, userEmail, userRole } = request.dashboardAuth;
    const { webhookId } = request.params;
    const prisma = request.prisma;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }
    const webhook = await prisma.webhookEndpoint.findFirst({
      where: { id: webhookId, companyId },
      select: { id: true, status: true },
    });
    if (!webhook) {
      return reply.code(404).send({ error: 'Webhook not found', code: 'NOT_FOUND' });
    }
    if (webhook.status === 'DISABLED') {
      return reply.send({ id: webhook.id, status: webhook.status });
    }
    const updated = await prisma.webhookEndpoint.update({
      where: { id: webhook.id },
      data: { status: 'DISABLED' },
      select: { id: true, status: true },
    });
    await logDashboardAction(prisma, request, {
      action: 'WEBHOOK_DISABLED',
      actorUserId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      targetCompanyId: companyId,
      metadata: { webhookId: webhook.id },
    });
    return reply.send(updated);
  });

  /**
   * GET /dashboard/webhooks/:webhookId/deliveries
   * List delivery attempts for a webhook owned by the authenticated company.
   */
  fastify.get('/webhooks/:webhookId/deliveries', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    const { webhookId } = request.params as { webhookId: string };
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const q = QueryWebhookDeliveriesSchema.safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: q.error.errors,
      });
    }
    const { limit, status } = q.data;
    const prisma = request.prisma;

    try {
      const webhook = await prisma.webhookEndpoint.findFirst({
        where: { id: webhookId, companyId },
        select: { id: true },
      });
      if (!webhook) {
        return reply.code(404).send({ error: 'Webhook not found', code: 'NOT_FOUND' });
      }

      const attempts = await prisma.webhookDeliveryAttempt.findMany({
        where: {
          webhookId,
          ...(status ? { status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          eventId: true,
          attempt: true,
          status: true,
          responseStatus: true,
          errorCode: true,
          errorMessage: true,
          durationMs: true,
          createdAt: true,
        },
      });

      return reply.send({
        deliveries: attempts.map((a) => ({
          id: a.id,
          eventId: a.eventId,
          attempt: a.attempt,
          status: a.status,
          responseStatus: a.responseStatus,
          errorCode: a.errorCode,
          errorMessage: a.errorMessage,
          durationMs: a.durationMs,
          createdAt: a.createdAt.toISOString(),
        })),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, webhookId }, 'Dashboard: Failed to list webhook deliveries');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });
};

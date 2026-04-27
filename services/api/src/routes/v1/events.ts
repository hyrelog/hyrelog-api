import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createHash } from 'crypto';
import { canonicalJson } from '../../lib/canonicalJson.js';
import { getTraceId } from '../../lib/trace.js';
import { enqueueWebhookJobs } from '../../lib/webhookEnqueue.js';
import { getUsageForCompany, incrementUsage } from '../../lib/usageService.js';
import { getCompanyPlanConfig } from '../../lib/plans.js';

const IngestEventSchema = z.object({
  timestamp: z.string().datetime().optional(),
  projectId: z.string().uuid().optional(),
  category: z.string().min(1), // TODO Phase 3: Enforce allowCustomCategories per plan
  action: z.string().min(1),
  actor: z.object({
    id: z.string().optional(),
    email: z.string().email().optional(),
    role: z.string().optional(),
  }).optional(),
  resource: z.object({
    type: z.string(),
    id: z.string().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});

const QueryEventsSchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  cursor: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  category: z.string().optional(),
  action: z.string().optional(),
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
});

/** OpenAPI body schema for POST /v1/events (matches IngestEventSchema) */
const ingestEventBodySchema = {
  type: 'object' as const,
  required: ['category', 'action'],
  properties: {
    timestamp: { type: 'string', format: 'date-time', description: 'Event time (ISO 8601). Defaults to server time.' },
    projectId: { type: 'string', format: 'uuid', description: 'Project ID if scoped to a project' },
    category: { type: 'string', minLength: 1, description: 'Event category' },
    action: { type: 'string', minLength: 1, description: 'Event action' },
    actor: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string', format: 'email' },
        role: { type: 'string' },
      },
    },
    resource: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        id: { type: 'string' },
      },
    },
    metadata: { type: 'object', additionalProperties: true, description: 'Arbitrary key-value data' },
    idempotencyKey: { type: 'string', description: 'Key for idempotent ingestion; duplicate requests return 200 with existing event' },
  },
};

const eventsRoutesImpl: FastifyPluginAsync = async (fastify) => {
  // POST /v1/events - Ingest event
  fastify.post('/v1/events', {
    schema: {
      tags: ['Events'],
      summary: 'Ingest event',
      description: 'Ingest an audit event. Requires Bearer API key (workspace scope). Idempotent when idempotencyKey is provided.',
      body: ingestEventBodySchema,
      response: {
        201: {
          type: 'object',
          description: 'Created event',
          properties: { id: { type: 'string', description: 'Event ID' } },
          required: ['id'],
        },
        200: {
          type: 'object',
          description: 'Idempotent replay – existing event returned',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    handler: async (request, reply) => {
    if (!request.apiKey || !request.prisma) {
      return reply.code(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    }

    // Only workspace keys can ingest
    if (request.apiKey.scope !== 'WORKSPACE') {
      return reply.code(403).send({
        error: 'Only workspace keys can ingest events',
        code: 'FORBIDDEN',
      });
    }

    // Contract: reject writes for archived workspaces
    if (request.apiKey.workspaceId && request.apiKey.workspaceStatus === 'ARCHIVED') {
      return reply.code(403).send({
        error: 'Workspace is archived; ingestion is disabled',
        code: 'WORKSPACE_ARCHIVED',
      });
    }

    const prisma = request.prisma;
    const apiKeyRef = request.apiKey;

    const company = await prisma.company.findUnique({
      where: { id: apiKeyRef.companyId },
      select: { planTier: true, planOverrides: true, billingStatus: true, trialEndsAt: true },
    });

    if (!company) {
      return reply.code(401).send({
        error: 'Company not found',
        code: 'UNAUTHORIZED',
      });
    }

    if (company.billingStatus === 'TRIALING' && company.trialEndsAt && new Date(company.trialEndsAt) < new Date()) {
      return reply.code(403).send({
        error: 'Trial has ended. Upgrade to continue ingesting events.',
        code: 'TRIAL_EXPIRED',
      });
    }

    const usage = await getUsageForCompany(apiKeyRef.companyId);
    if (usage) {
      const planConfig = getCompanyPlanConfig({
        planTier: company.planTier,
        planOverrides: company.planOverrides as any,
      });
      if (usage.eventsIngested >= planConfig.monthlyEventLimit) {
        return reply.code(403).send({
          error: `Monthly event limit (${planConfig.monthlyEventLimit}) exceeded. Upgrade your plan or wait for the next billing period.`,
          code: 'PLAN_LIMIT_EXCEEDED',
        });
      }
    }

    // Validate request body
    const bodyResult = IngestEventSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const data = bodyResult.data;

    // Determine timestamp
    const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();

    // Verify project belongs to workspace if provided
    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: {
          id: data.projectId,
        },
        select: {
          id: true,
          workspaceId: true,
        },
      });

      if (!project) {
        return reply.code(404).send({
          error: 'Project not found',
          code: 'NOT_FOUND',
        });
      }

      if (project.workspaceId !== apiKeyRef.workspaceId) {
        return reply.code(403).send({
          error: 'Project does not belong to this workspace',
          code: 'FORBIDDEN',
        });
      }
    }

    // Check idempotency
    if (data.idempotencyKey) {
      const idempotencyHash = createHash('sha256')
        .update(`${apiKeyRef.companyId}${apiKeyRef.workspaceId}${data.projectId || ''}${data.idempotencyKey}${canonicalJson(data)}`)
        .digest('hex');

      const existing = await prisma.auditEvent.findFirst({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: { idempotencyHash } as any,
      });

      if (existing) {
        // Return existing event - no new webhook jobs will be created
        // This is expected behavior for idempotent requests
        return reply.code(200).send(existing);
      }
    }

    // Find latest event for hash chain
    const latestEvent = await prisma.auditEvent.findFirst({
      where: {
        companyId: apiKeyRef.companyId,
        workspaceId: apiKeyRef.workspaceId!,
        projectId: data.projectId || null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const prevHash = latestEvent?.hash || null;

    // Build event object for hashing
    const eventForHash = {
      companyId: apiKeyRef.companyId,
      workspaceId: apiKeyRef.workspaceId!,
      projectId: data.projectId || null,
      timestamp: timestamp.toISOString(),
      category: data.category,
      action: data.action,
      actorId: data.actor?.id || null,
      actorEmail: data.actor?.email || null,
      actorRole: data.actor?.role || null,
      resourceType: data.resource?.type || null,
      resourceId: data.resource?.id || null,
      metadata: data.metadata || {},
      prevHash,
    };

    // Calculate hash
    const hash = createHash('sha256')
      .update(canonicalJson(eventForHash))
      .digest('hex');

    // Calculate idempotency hash if provided
    const idempotencyHash = data.idempotencyKey
      ? createHash('sha256')
          .update(`${apiKeyRef.companyId}${apiKeyRef.workspaceId}${data.projectId || ''}${data.idempotencyKey}${canonicalJson(data)}`)
          .digest('hex')
      : null;

    // Get request context
    const traceId = getTraceId(request);
    const clientIp = request.ip || request.headers['x-forwarded-for'] || undefined;
    const ip = Array.isArray(clientIp) ? clientIp[0] : (typeof clientIp === 'string' ? clientIp.split(',')[0].trim() : undefined);
    const userAgent = request.headers['user-agent'] || undefined;

    // Create event
    let event;
    try {
      event = await prisma.auditEvent.create({
        data: {
          companyId: apiKeyRef.companyId,
          workspaceId: apiKeyRef.workspaceId!,
          projectId: data.projectId || null,
          timestamp,
          category: data.category,
          action: data.action,
          actorId: data.actor?.id,
          actorEmail: data.actor?.email,
          actorRole: data.actor?.role,
          resourceType: data.resource?.type,
          resourceId: data.resource?.id,
          metadata: data.metadata || {},
          traceId,
          ipAddress: ip,
          userAgent,
          prevHash,
          hash,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          idempotencyHash: idempotencyHash as any,
          dataRegion: apiKeyRef.region,
        } as any,
      });
      incrementUsage(apiKeyRef.companyId, 'event').catch(() => {});
      const logger = (await import('../../lib/logger.js')).getLogger();
      logger.info({ eventId: event.id, companyId: apiKeyRef.companyId, workspaceId: apiKeyRef.workspaceId, traceId }, 'Event created successfully');
    } catch (createError: any) {
      const logger = (await import('../../lib/logger.js')).getLogger();
      logger.error({ err: createError, traceId, companyId: apiKeyRef.companyId, workspaceId: apiKeyRef.workspaceId }, 'Failed to create event');
      throw createError; // Re-throw to let error handler deal with it
    }

    // Enqueue webhook jobs (non-blocking)
    enqueueWebhookJobs(
      prisma,
      event.id,
      apiKeyRef.companyId,
      apiKeyRef.workspaceId!,
      data.projectId || null,
      traceId
    ).catch(async (err) => {
      // Already logged in enqueueWebhookJobs, but log here too for visibility
      const logger = (await import('../../lib/logger.js')).getLogger();
      logger.error({ err, traceId, eventId: event.id }, 'Webhook enqueue error (non-blocking)');
    });

    return reply.code(201).send(event);
  },
  });

  // GET /v1/events - Query events
  fastify.get('/v1/events', {
    schema: {
      tags: ['Events'],
      summary: 'Query events',
      description: 'List audit events with optional filters and cursor pagination. Requires Bearer API key (workspace or company scope).',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Max events per page' },
          cursor: { type: 'string', description: 'Opaque cursor for next page' },
          from: { type: 'string', format: 'date-time', description: 'Filter events from this time (ISO 8601)' },
          to: { type: 'string', format: 'date-time', description: 'Filter events until this time (ISO 8601)' },
          category: { type: 'string', description: 'Filter by category' },
          action: { type: 'string', description: 'Filter by action' },
          projectId: { type: 'string', format: 'uuid', description: 'Filter by project' },
          workspaceId: { type: 'string', format: 'uuid', description: 'Filter by workspace (company keys only)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'List of audit events'
            },
            nextCursor: { type: ['string', 'null'], description: 'Cursor for next page, or null' },
          },
          required: ['data', 'nextCursor'],
        },
      },
    },
    handler: async (request, reply) => {
    // Auth plugin should have set request.apiKey and request.prisma
    // If not set, it means auth failed (but auth plugin should have returned 401)
    if (!request.apiKey || !request.prisma) {
      const logger = (await import('../../lib/logger.js')).getLogger();
      logger.error({ url: request.url, hasApiKey: !!request.apiKey, hasPrisma: !!request.prisma }, 'Route handler: API key or Prisma not set');
      return reply.code(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    }

    // Validate query parameters
    const queryResult = QueryEventsSchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: queryResult.error.errors,
      });
    }

    const query = queryResult.data;
    const prisma = request.prisma;
    const apiKey = request.apiKey;

    // Build where clause
    const where: any = {
      companyId: apiKey.companyId,
    };

    // Scope filtering
    if (apiKey.scope === 'WORKSPACE') {
      where.workspaceId = apiKey.workspaceId!;
      // Ignore workspaceId filter if provided
    } else {
      // COMPANY scope - can filter by workspaceId
      if (query.workspaceId) {
        where.workspaceId = query.workspaceId;
      }
    }

    // Additional filters
    if (query.projectId) {
      where.projectId = query.projectId;
    }

    if (query.category) {
      where.category = query.category;
    }

    if (query.action) {
      where.action = query.action;
    }

    if (query.from || query.to) {
      where.timestamp = {};
      if (query.from) {
        where.timestamp.gte = new Date(query.from);
      }
      if (query.to) {
        where.timestamp.lte = new Date(query.to);
      }
    }

    // Handle cursor pagination
    if (query.cursor) {
      try {
        const cursorData = JSON.parse(Buffer.from(query.cursor, 'base64').toString());
        // Add cursor condition to existing where clause (don't replace it)
        where.AND = [
          ...(where.AND || []),
          {
            OR: [
              { timestamp: { lt: new Date(cursorData.timestamp) } },
              {
                timestamp: new Date(cursorData.timestamp),
                id: { lt: cursorData.id },
              },
            ],
          },
        ];
      } catch {
        return reply.code(400).send({
          error: 'Invalid cursor',
          code: 'VALIDATION_ERROR',
        });
      }
    }

    // Fetch events
    const events = await prisma.auditEvent.findMany({
      where,
      take: query.limit + 1, // Fetch one extra to check if there's more
      orderBy: [
        { timestamp: 'desc' },
        { id: 'desc' },
      ],
    });

    // Check if there's a next page
    const hasMore = events.length > query.limit;
    const data = hasMore ? events.slice(0, query.limit) : events;

    // Generate next cursor
    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({
          timestamp: last.timestamp.toISOString(),
          id: last.id,
        })
      ).toString('base64');
    }

    return reply.send({
      data,
      nextCursor,
    });
  },
  });
};

export const eventsRoutes = fp(eventsRoutesImpl, { name: 'v1-events-routes' });


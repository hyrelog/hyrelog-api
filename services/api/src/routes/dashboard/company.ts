/**
 * Dashboard Company Routes
 *
 * Contract: docs/DASHBOARD_API_CONTRACT.md
 * Idempotent upserts by dashboardCompanyId; region from body or lookup.
 */

import { FastifyPluginAsync } from 'fastify';
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
import { exportsRoutes } from '../v1/exports.js';
import { webhooksRoutes } from '../v1/webhooks.js';
import { eventsRoutes } from '../v1/events.js';

const logger = getLogger();
const regionRouter = getRegionRouter();

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

      const freePlan = await prisma.plan.findFirst({
        where: { planTier: 'FREE', planType: 'STANDARD', isActive: true },
      });
      if (!freePlan) {
        logger.error({ dataRegion }, 'Dashboard: No FREE plan found in region');
        return reply.code(500).send({ error: 'Plan configuration missing', code: 'INTERNAL_ERROR' });
      }

      const company = await prisma.company.create({
        data: {
          dashboardCompanyId,
          slug,
          name,
          dataRegion,
          planId: freePlan.id,
          planTier: 'FREE',
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

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const jobs = await prisma.exportJob.findMany({
        where: { companyId },
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
          finishedAt: true,
          errorCode: true,
        },
      });

      return reply.send({
        jobs: jobs.map((j) => ({
          id: j.id,
          status: j.status,
          source: j.source,
          format: j.format,
          rowLimit: j.rowLimit.toString(),
          rowsExported: j.rowsExported.toString(),
          createdAt: j.createdAt.toISOString(),
          finishedAt: j.finishedAt?.toISOString(),
          errorCode: j.errorCode,
        })),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to list export jobs');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/exports
   * Create export (wraps /v1/exports logic with dashboard auth)
   */
  fastify.post('/exports', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    // Import export creation logic from v1/exports
    // For now, delegate to existing logic by creating a mock API key context
    // In production, you'd refactor exportsRoutes to accept both API key and dashboard auth
    await logDashboardAction(prisma, request, {
      action: 'EXPORT_REQUESTED',
      actorUserId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      targetCompanyId: companyId,
      metadata: (request.body as Record<string, unknown>) ?? {},
    });

    // Note: Full implementation would call the export creation logic from exportsRoutes
    // For now, return a message directing to use /v1/exports with API key
    return reply.code(501).send({
      error: 'Dashboard export creation not yet fully implemented - use /v1/exports with API key for now',
      code: 'NOT_IMPLEMENTED',
    });
  });

  /**
   * GET /dashboard/exports/:jobId
   * Get export job status
   */
  fastify.get('/exports/:jobId', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    const { jobId } = request.params as { jobId: string };

    const prisma = request.prisma;

    try {
      const exportJob = await prisma.exportJob.findFirst({
        where: {
          id: jobId,
          companyId,
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
    const { workspaceId, url, events, projectId } = bodyResult.data;
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
        'GROWTH'
      );
    } catch (error: any) {
      if (error instanceof PlanRestrictionError) {
        return reply.code(403).send({
          error: error.message || 'Webhooks require Growth plan or higher',
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
      requireCompanyLimit(company, 'maxWebhooks', newCount, 'GROWTH');
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

    const plaintextSecret = generateWebhookSecret();
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

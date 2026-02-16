/**
 * Dashboard Workspace Routes
 *
 * Contract: docs/DASHBOARD_API_CONTRACT.md
 * Idempotent upserts by dashboardWorkspaceId; region from company.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getLogger } from '../../lib/logger.js';
import { logDashboardAction } from '../../lib/auditLog.js';
import { getRegionRouter, type PrismaClientType } from '../../lib/regionRouter.js';
import { getApiKeyCache } from '../../lib/apiKeyCache.js';

const logger = getLogger();
const regionRouter = getRegionRouter();

const ProvisionWorkspaceSchema = z.object({
  dashboardWorkspaceId: z.string().uuid(),
  dashboardCompanyId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  preferredRegion: z.enum(['US', 'EU', 'UK', 'AU']).optional(),
});

const ArchiveWorkspaceSchema = z.object({
  archivedAt: z.string().datetime(),
  revokeAllKeys: z.boolean().default(true),
});

const RestoreWorkspaceSchema = z.object({
  restoredAt: z.string().datetime(),
});

type Region = 'US' | 'EU' | 'UK' | 'AU';

async function findCompanyByDashboardId(dashboardCompanyId: string): Promise<{ region: Region; apiCompanyId: string; prisma: PrismaClientType } | null> {
  const regions = regionRouter.getAllRegions() as Region[];
  for (const region of regions) {
    const prisma = regionRouter.getPrisma(region);
    const company = await prisma.company.findUnique({
      where: { dashboardCompanyId },
      select: { id: true, dataRegion: true },
    });
    if (company) {
      return { region: company.dataRegion, apiCompanyId: company.id, prisma };
    }
  }
  return null;
}

async function findWorkspaceByDashboardId(dashboardWorkspaceId: string): Promise<{ apiWorkspaceId: string; apiCompanyId: string; status: string; region: Region; prisma: PrismaClientType } | null> {
  const regions = regionRouter.getAllRegions() as Region[];
  for (const region of regions) {
    const prisma = regionRouter.getPrisma(region);
    const workspace = await prisma.workspace.findUnique({
      where: { dashboardWorkspaceId },
      select: { id: true, companyId: true, status: true },
    });
    if (workspace) {
      return {
        apiWorkspaceId: workspace.id,
        apiCompanyId: workspace.companyId,
        status: workspace.status,
        region,
        prisma,
      };
    }
  }
  return null;
}

export const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /dashboard/workspaces
   * Idempotent workspace provisioning. Company must exist; workspace created in company's region.
   */
  fastify.post('/workspaces', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const bodyResult = ProvisionWorkspaceSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { dashboardWorkspaceId, dashboardCompanyId, slug, name, status, preferredRegion } = bodyResult.data;
    const { userId, userEmail, userRole } = request.dashboardAuth;

    const companyContext = await findCompanyByDashboardId(dashboardCompanyId);
    if (!companyContext) {
      return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
    }
    const { prisma, apiCompanyId } = companyContext;
    if (preferredRegion && preferredRegion !== companyContext.region) {
      return reply.code(400).send({
        error: 'preferredRegion must match company dataRegion or be omitted',
        code: 'REGION_MISMATCH',
      });
    }

    try {
      const existing = await prisma.workspace.findUnique({
        where: { dashboardWorkspaceId },
        select: { id: true, companyId: true, status: true, createdAt: true },
      });

      if (existing) {
        await logDashboardAction(prisma, request, {
          action: 'WORKSPACE_PROVISION_IDEMPOTENT',
          actorUserId: userId,
          actorEmail: userEmail,
          actorRole: userRole,
          targetCompanyId: apiCompanyId,
          metadata: { dashboardWorkspaceId },
        });
        return reply.code(200).send({
          apiWorkspaceId: existing.id,
          dashboardWorkspaceId,
          apiCompanyId: existing.companyId,
          created: false,
          status: existing.status,
        });
      }

      const workspace = await prisma.workspace.create({
        data: {
          dashboardWorkspaceId,
          companyId: apiCompanyId,
          slug,
          name,
          status: status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
        },
      });

      await logDashboardAction(prisma, request, {
        action: 'WORKSPACE_CREATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: apiCompanyId,
        metadata: { dashboardWorkspaceId, name },
      });

      return reply.code(201).send({
        apiWorkspaceId: workspace.id,
        dashboardWorkspaceId,
        apiCompanyId: workspace.companyId,
        created: true,
        status: workspace.status,
      });
    } catch (error: unknown) {
      logger.error({ err: error, dashboardWorkspaceId, dashboardCompanyId }, 'Dashboard: Failed to provision workspace');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/workspaces/:dashboardWorkspaceId
   * Reconciliation: exists, apiWorkspaceId, apiCompanyId, status
   */
  fastify.get<{ Params: { dashboardWorkspaceId: string } }>('/workspaces/:dashboardWorkspaceId', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { dashboardWorkspaceId } = request.params;
    if (!dashboardWorkspaceId) {
      return reply.code(400).send({ error: 'Missing dashboardWorkspaceId', code: 'VALIDATION_ERROR' });
    }

    const found = await findWorkspaceByDashboardId(dashboardWorkspaceId);
    if (!found) {
      return reply.send({ exists: false });
    }
    return reply.send({
      exists: true,
      apiWorkspaceId: found.apiWorkspaceId,
      apiCompanyId: found.apiCompanyId,
      status: found.status,
    });
  });

  /**
   * POST /dashboard/workspaces/:dashboardWorkspaceId/archive
   * Set workspace ARCHIVED; optionally revoke all workspace keys.
   */
  fastify.post<{ Params: { dashboardWorkspaceId: string } }>('/workspaces/:dashboardWorkspaceId/archive', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { dashboardWorkspaceId } = request.params;
    const bodyResult = ArchiveWorkspaceSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { archivedAt, revokeAllKeys } = bodyResult.data;
    const found = await findWorkspaceByDashboardId(dashboardWorkspaceId);
    if (!found) {
      return reply.code(404).send({ error: 'Workspace not found', code: 'NOT_FOUND' });
    }

    const { prisma, apiWorkspaceId, apiCompanyId } = found;
    const archivedAtDate = new Date(archivedAt);
    const { userId, userEmail, userRole } = request.dashboardAuth;

    try {
      await prisma.workspace.update({
        where: { id: apiWorkspaceId },
        data: { status: 'ARCHIVED' },
      });

      let keysRevokedCount = 0;
      if (revokeAllKeys) {
        const toRevoke = await prisma.apiKey.findMany({
          where: { workspaceId: apiWorkspaceId, revokedAt: null },
          select: { id: true },
        });
        if (toRevoke.length > 0) {
          await prisma.apiKey.updateMany({
            where: { workspaceId: apiWorkspaceId, revokedAt: null },
            data: { revokedAt: archivedAtDate, status: 'REVOKED' },
          });
          const cache = getApiKeyCache();
          toRevoke.forEach((k) => cache.deleteByKeyId(k.id));
        }
        keysRevokedCount = toRevoke.length;
      }

      await logDashboardAction(prisma, request, {
        action: 'WORKSPACE_ARCHIVED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: apiCompanyId,
        metadata: { dashboardWorkspaceId, archivedAt, keysRevokedCount },
      });

      return reply.send({ ok: true, keysRevokedCount });
    } catch (error: unknown) {
      logger.error({ err: error, dashboardWorkspaceId }, 'Dashboard: Failed to archive workspace');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/workspaces/:dashboardWorkspaceId/restore
   * Set workspace ACTIVE. Does NOT un-revoke keys.
   */
  fastify.post<{ Params: { dashboardWorkspaceId: string } }>('/workspaces/:dashboardWorkspaceId/restore', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { dashboardWorkspaceId } = request.params;
    const bodyResult = RestoreWorkspaceSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const found = await findWorkspaceByDashboardId(dashboardWorkspaceId);
    if (!found) {
      return reply.code(404).send({ error: 'Workspace not found', code: 'NOT_FOUND' });
    }

    const { prisma, apiWorkspaceId, apiCompanyId } = found;
    const { userId, userEmail, userRole } = request.dashboardAuth;

    try {
      await prisma.workspace.update({
        where: { id: apiWorkspaceId },
        data: { status: 'ACTIVE' },
      });

      await logDashboardAction(prisma, request, {
        action: 'WORKSPACE_RESTORED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: apiCompanyId,
        metadata: { dashboardWorkspaceId },
      });

      return reply.send({ ok: true });
    } catch (error: unknown) {
      logger.error({ err: error, dashboardWorkspaceId }, 'Dashboard: Failed to restore workspace');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });
};

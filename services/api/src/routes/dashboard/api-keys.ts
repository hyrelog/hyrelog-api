/**
 * Dashboard API Keys Routes
 *
 * Contract: docs/DASHBOARD_API_CONTRACT.md
 * - Sync (upsert by dashboardKeyId): prefix/hash from dashboard; validate region+scope.
 * - Revoke: idempotent set revokedAt.
 * Legacy: POST create (generates key) when request has x-company-id / request.prisma.
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getLogger } from '../../lib/logger.js';
import { logDashboardAction } from '../../lib/auditLog.js';
import { generateApiKey, hashApiKey, parseKeyPrefix } from '../../lib/apiKey.js';
import { getRegionRouter } from '../../lib/regionRouter.js';
import { getApiKeyCache } from '../../lib/apiKeyCache.js';

const logger = getLogger();
const regionRouter = getRegionRouter();

const CreateApiKeySchema = z.object({
  name: z.string().max(100).optional(),
  scope: z.enum(['COMPANY', 'WORKSPACE']).default('COMPANY'),
  workspaceId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
});

const SyncApiKeySchema = z.object({
  dashboardKeyId: z.string().uuid(),
  scope: z.enum(['co', 'ws']),
  dashboardCompanyId: z.string().uuid(),
  dashboardWorkspaceId: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  prefix: z.string().min(1).max(50),
  hash: z.string().min(1),
  revokedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().optional(),
});

const RevokeKeySchema = z.object({
  revokedAt: z.string().datetime(),
});

async function findCompanyByDashboardId(dashboardCompanyId: string): Promise<{ region: string; apiCompanyId: string; prisma: import('../../lib/regionRouter.js').PrismaClientType } | null> {
  const regions = regionRouter.getAllRegions();
  for (const region of regions) {
    const prisma = regionRouter.getPrisma(region as 'US' | 'EU' | 'UK' | 'AU');
    const company = await prisma.company.findUnique({
      where: { dashboardCompanyId },
      select: { id: true, dataRegion: true },
    });
    if (company) return { region: company.dataRegion, apiCompanyId: company.id, prisma };
  }
  return null;
}

export const apiKeysRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /dashboard/api-keys
   * Contract: if body has dashboardKeyId + prefix + hash → sync (upsert). Else legacy create (requires x-company-id).
   */
  fastify.post('/api-keys', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const body = request.body as Record<string, unknown>;
    const isSync = typeof body?.dashboardKeyId === 'string' && typeof body?.prefix === 'string' && typeof body?.hash === 'string';

    if (isSync) {
      const bodyResult = SyncApiKeySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({
          error: 'Validation error',
          code: 'VALIDATION_ERROR',
          details: bodyResult.error.errors,
        });
      }

      const { dashboardKeyId, scope: scopeBody, dashboardCompanyId, dashboardWorkspaceId, name, prefix, hash, revokedAt, createdAt } = bodyResult.data;

      const parsed = parseKeyPrefix(prefix);
      if (!parsed) {
        return reply.code(400).send({
          error: 'prefix must match hlk_{region}_{scope}_... (region: us|eu|uk|au, scope: co|ws)',
          code: 'VALIDATION_ERROR',
        });
      }
      const scopeExpected = scopeBody === 'co' ? 'COMPANY' : 'WORKSPACE';
      if (parsed.scope !== scopeExpected) {
        return reply.code(400).send({ error: 'prefix scope does not match body scope', code: 'SCOPE_MISMATCH' });
      }
      if (scopeBody === 'ws' && !dashboardWorkspaceId) {
        return reply.code(400).send({ error: 'dashboardWorkspaceId required for workspace scope', code: 'VALIDATION_ERROR' });
      }

      const companyContext = await findCompanyByDashboardId(dashboardCompanyId);
      if (!companyContext) {
        return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
      }
      if (companyContext.region !== parsed.region) {
        return reply.code(400).send({
          error: 'prefix region does not match company dataRegion',
          code: 'REGION_MISMATCH',
        });
      }

      const { prisma, apiCompanyId } = companyContext;
      let apiWorkspaceId: string | null = null;
      if (scopeBody === 'ws' && dashboardWorkspaceId) {
        const workspace = await prisma.workspace.findFirst({
          where: { dashboardWorkspaceId, companyId: apiCompanyId },
          select: { id: true },
        });
        if (!workspace) {
          return reply.code(404).send({ error: 'Workspace not found in company', code: 'NOT_FOUND' });
        }
        apiWorkspaceId = workspace.id;
      }

      const { userId, userEmail, userRole } = request.dashboardAuth;
      const revokedAtDate = revokedAt ? new Date(revokedAt) : null;
      const createdAtDate = createdAt ? new Date(createdAt) : undefined;

      try {
        const existing = await prisma.apiKey.findUnique({
          where: { dashboardKeyId },
          select: { id: true },
        });

        if (existing) {
          await prisma.apiKey.update({
            where: { id: existing.id },
            data: {
              prefix,
              hashedKey: hash,
              labels: [name],
              revokedAt: revokedAtDate,
              status: revokedAtDate ? 'REVOKED' : 'ACTIVE',
            },
          });
          await logDashboardAction(prisma, request, {
            action: 'API_KEY_SYNC_UPDATED',
            actorUserId: userId,
            actorEmail: userEmail,
            actorRole: userRole,
            targetCompanyId: apiCompanyId,
            metadata: { dashboardKeyId },
          });
          return reply.code(200).send({
            apiKeyId: existing.id,
            created: false,
            scopeValidated: true,
          });
        }

        const apiKey = await prisma.apiKey.create({
          data: {
            dashboardKeyId,
            prefix,
            hashedKey: hash,
            scope: scopeExpected,
            status: revokedAtDate ? 'REVOKED' : 'ACTIVE',
            companyId: apiCompanyId,
            workspaceId: apiWorkspaceId ?? undefined,
            revokedAt: revokedAtDate,
            ipAllowlist: [],
            labels: [name],
            ...(createdAtDate && { createdAt: createdAtDate }),
          },
        });
        await logDashboardAction(prisma, request, {
          action: 'API_KEY_SYNC_CREATED',
          actorUserId: userId,
          actorEmail: userEmail,
          actorRole: userRole,
          targetCompanyId: apiCompanyId,
          metadata: { dashboardKeyId },
        });
        return reply.code(201).send({
          apiKeyId: apiKey.id,
          created: true,
          scopeValidated: true,
        });
      } catch (error: unknown) {
        logger.error({ err: error, dashboardKeyId }, 'Dashboard: API key sync failed');
        return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }

    // Legacy: create key (generate secret); requires x-company-id
    if (!request.prisma) {
      return reply.code(400).send({
        error: 'Legacy create requires x-company-id header, or use sync body (dashboardKeyId, prefix, hash)',
        code: 'VALIDATION_ERROR',
      });
    }

    const bodyResult = CreateApiKeySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { name, scope, workspaceId, expiresAt } = bodyResult.data;
    const { userId, userEmail, userRole, companyId } = request.dashboardAuth;
    const prisma = request.prisma;

    try {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { dataRegion: true },
      });
      if (!company) {
        return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
      }
      const region = company.dataRegion;

      if (scope === 'WORKSPACE') {
        if (!workspaceId) {
          return reply.code(400).send({
            error: 'workspaceId is required for WORKSPACE scope',
            code: 'VALIDATION_ERROR',
          });
        }
        const workspace = await prisma.workspace.findFirst({
          where: { id: workspaceId, companyId },
        });
        if (!workspace) {
          return reply.code(404).send({ error: 'Workspace not found', code: 'NOT_FOUND' });
        }
      }

      const plaintextKey = generateApiKey(scope, region as 'US' | 'EU' | 'UK' | 'AU');
      const hashedKey = hashApiKey(plaintextKey);

      const apiKey = await prisma.apiKey.create({
        data: {
          prefix: plaintextKey.substring(0, 20),
          hashedKey,
          scope,
          status: 'ACTIVE',
          companyId,
          workspaceId: scope === 'WORKSPACE' ? workspaceId : undefined,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          ipAllowlist: [],
          labels: name ? [name] : [],
        },
      });

      await logDashboardAction(prisma, request, {
        action: 'API_KEY_CREATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { apiKeyId: apiKey.id, scope, workspaceId: apiKey.workspaceId },
      });

      return reply.code(201).send({
        id: apiKey.id,
        apiKey: plaintextKey,
        prefix: apiKey.prefix,
        scope: apiKey.scope,
        workspaceId: apiKey.workspaceId,
        expiresAt: apiKey.expiresAt?.toISOString(),
        createdAt: apiKey.createdAt.toISOString(),
      });
    } catch (error: unknown) {
      logger.error({ err: error, userId }, 'Dashboard: Failed to create API key');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * POST /dashboard/api-keys/:dashboardKeyId/revoke
   * Idempotent revoke; revokedAt already set → return ok.
   */
  fastify.post<{ Params: { dashboardKeyId: string } }>('/api-keys/:dashboardKeyId/revoke', async (request, reply) => {
    if (!request.dashboardAuth) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { dashboardKeyId } = request.params;
    const bodyResult = RevokeKeySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const revokedAt = new Date(bodyResult.data.revokedAt);
    const regions = regionRouter.getAllRegions();
    for (const region of regions) {
      const prisma = regionRouter.getPrisma(region as 'US' | 'EU' | 'UK' | 'AU');
      const key = await prisma.apiKey.findUnique({
        where: { dashboardKeyId },
        select: { id: true, companyId: true, revokedAt: true },
      });
      if (key) {
        if (key.revokedAt) {
          return reply.send({ ok: true });
        }
        await prisma.apiKey.update({
          where: { id: key.id },
          data: { revokedAt, status: 'REVOKED' },
        });
        getApiKeyCache().deleteByKeyId(key.id);
        await logDashboardAction(prisma, request, {
          action: 'API_KEY_REVOKED',
          actorUserId: request.dashboardAuth.userId,
          actorEmail: request.dashboardAuth.userEmail,
          actorRole: request.dashboardAuth.userRole,
          targetCompanyId: key.companyId ?? undefined,
          metadata: { dashboardKeyId },
        });
        return reply.send({ ok: true });
      }
    }
    return reply.code(404).send({ error: 'API key not found', code: 'NOT_FOUND' });
  });
};

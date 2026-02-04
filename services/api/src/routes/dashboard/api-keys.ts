/**
 * Dashboard API Keys Routes
 * 
 * Creates API keys via dashboard authentication
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getLogger } from '../../lib/logger.js';
import { logDashboardAction } from '../../lib/auditLog.js';
import { generateApiKey, hashApiKey } from '../../lib/apiKey.js';

const logger = getLogger();

const CreateApiKeySchema = z.object({
  name: z.string().max(100).optional(),
  scope: z.enum(['COMPANY', 'WORKSPACE']).default('COMPANY'),
  workspaceId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const apiKeysRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /dashboard/api-keys
   * Create a new API key
   */
  fastify.post('/api-keys', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { userId, userEmail, userRole, companyId } = request.dashboardAuth;

    // Validate request body
    const bodyResult = CreateApiKeySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { name, scope, workspaceId, expiresAt } = bodyResult.data;
    const prisma = request.prisma;

    try {
      // Validate workspace if WORKSPACE scope
      if (scope === 'WORKSPACE') {
        if (!workspaceId) {
          return reply.code(400).send({
            error: 'workspaceId is required for WORKSPACE scope',
            code: 'VALIDATION_ERROR',
          });
        }

        // Verify workspace belongs to company
        const workspace = await prisma.workspace.findFirst({
          where: {
            id: workspaceId,
            companyId,
          },
        });

        if (!workspace) {
          return reply.code(404).send({
            error: 'Workspace not found',
            code: 'NOT_FOUND',
          });
        }
      }

      // Generate API key
      const plaintextKey = generateApiKey(scope);
      const hashedKey = hashApiKey(plaintextKey);

      // Create API key in database
      const apiKey = await prisma.apiKey.create({
        data: {
          prefix: plaintextKey.substring(0, 20), // First 20 chars as prefix
          hashedKey,
          scope,
          status: 'ACTIVE',
          companyId,
          workspaceId: scope === 'WORKSPACE' ? workspaceId : undefined,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          ipAllowlist: [], // Empty = all IPs allowed (can be configured later)
          labels: name ? [name] : [],
        },
      });

      // Log audit action
      await logDashboardAction(prisma, request, {
        action: 'API_KEY_CREATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: {
          apiKeyId: apiKey.id,
          scope,
          workspaceId: apiKey.workspaceId,
        },
      });

      logger.info(
        {
          apiKeyId: apiKey.id,
          companyId,
          scope,
          workspaceId: apiKey.workspaceId,
          userId,
        },
        'Dashboard: API key created'
      );

      return reply.code(201).send({
        id: apiKey.id,
        apiKey: plaintextKey, // Only returned once!
        prefix: apiKey.prefix,
        scope: apiKey.scope,
        workspaceId: apiKey.workspaceId,
        expiresAt: apiKey.expiresAt?.toISOString(),
        createdAt: apiKey.createdAt.toISOString(),
      });
    } catch (error: any) {
      logger.error({ err: error, userId, userEmail }, 'Dashboard: Failed to create API key');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });
};

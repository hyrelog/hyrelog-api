import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { logKeyManagementOperation } from '../../lib/keyManagementSecurity.js';

const keysRoutesImpl: FastifyPluginAsync = async (fastify) => {
  // POST /v1/workspaces/:workspaceId/keys - Create workspace key
  // Key management is dashboard-only; dashboard is source of truth and syncs to API (see docs/ARCHITECTURE.md)
  fastify.post('/v1/workspaces/:workspaceId/keys', {
    schema: {
      tags: ['API Keys'],
      summary: 'Create API key (dashboard only)',
      description: 'Key creation is only available via the dashboard. Use the dashboard to create and copy API keys.',
      params: { type: 'object', properties: { workspaceId: { type: 'string', format: 'uuid' } }, required: ['workspaceId'] },
      response: { 403: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' } } } },
    },
    handler: async (request, reply) => {
    if (!request.apiKey || !request.prisma) {
      return reply.code(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    }

    return reply.code(403).send({
      error: 'Key creation is only available via the dashboard. Use the dashboard to create and copy API keys.',
      code: 'FORBIDDEN',
    });
  },
  });

  // NOTE: Revoke endpoint removed - key revocation is now dashboard-only
  // This prevents accidental or malicious revocation via API
  // Use the dashboard for key revocation with proper confirmation dialogs

  // POST /v1/keys/:keyId/rotate - Rotate key
  // Key management is dashboard-only (see docs/ARCHITECTURE.md)
  fastify.post('/v1/keys/:keyId/rotate', {
    schema: {
      tags: ['API Keys'],
      summary: 'Rotate API key (dashboard only)',
      description: 'Key rotation is only available via the dashboard. Use the dashboard to rotate keys and update your app with the new key.',
      params: { type: 'object', properties: { keyId: { type: 'string' } }, required: ['keyId'] },
      response: { 403: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' } } } },
    },
    handler: async (request, reply) => {
    if (!request.apiKey || !request.prisma) {
      return reply.code(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    }

    return reply.code(403).send({
      error: 'Key rotation is only available via the dashboard. Use the dashboard to rotate keys and update your app with the new key.',
      code: 'FORBIDDEN',
    });
  },
  });

  // GET /v1/keys/status - Get key status
  // Read-only operation, less restrictive
  fastify.get('/v1/keys/status', {
    schema: {
      tags: ['API Keys'],
      summary: 'Get API key status',
      description: 'Returns the status and metadata of the API key used for this request.',
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            prefix: { type: 'string' },
            scope: { type: 'string', enum: ['COMPANY', 'WORKSPACE'] },
            status: { type: 'string' },
            expiresAt: { type: ['string', 'null'], format: 'date-time' },
            lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
            lastUsedIp: { type: ['string', 'null'] },
            lastUsedEndpoint: { type: ['string', 'null'] },
            healthScore: { type: 'integer' },
          },
          required: ['id', 'prefix', 'scope', 'status', 'healthScore'],
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

    const prisma = request.prisma;

    // Find key
    const key = await prisma.apiKey.findUnique({
      where: { id: request.apiKey.id },
    });

    if (!key) {
      return reply.code(404).send({
        error: 'API key not found',
        code: 'NOT_FOUND',
      });
    }

    // AUDIT: Log status check (lower priority, but still logged)
    logKeyManagementOperation('status', request, request.apiKey);

    return reply.send({
      id: key.id,
      prefix: key.prefix,
      scope: key.scope,
      status: key.status,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      lastUsedIp: key.lastUsedIp,
      lastUsedEndpoint: key.lastUsedEndpoint,
      // Health score placeholder
      healthScore: key.status === 'ACTIVE' && (!key.expiresAt || key.expiresAt > new Date()) ? 100 : 0,
    });
  },
  });
};

export const keysRoutes = fp(keysRoutesImpl, { name: 'v1-keys-routes' });

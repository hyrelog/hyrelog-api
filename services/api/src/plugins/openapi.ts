/**
 * OpenAPI v3 public spec and CORS for docs.
 *
 * - Registers @fastify/cors (narrow: only allow dashboard + localhost to fetch /openapi.json).
 * - Registers @fastify/swagger in OpenAPI v3 mode.
 * - Public spec: ONLY routes that explicitly set schema.tags (non-empty array) appear.
 *   Use hideUntagged + transform to exclude untagged routes (internal/dashboard-only).
 * - GET /health: public health check (tagged "System") for docs and probes.
 * - GET /openapi.json: returns the filtered spec (no auth).
 */

import { FastifyPluginAsync } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';

const OPENAPI_ORIGINS = [
  'https://app.hyrelog.com',
  'http://localhost:4000',
  'http://localhost:3000',
];

export const openapiPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (OPENAPI_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'OPTIONS'],
    credentials: false,
    allowedHeaders: ['Content-Type', 'Accept'],
  });

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'HyreLog API',
        version: '1.0.0',
        description: 'HyreLog API reference. Authenticate with Bearer API key for /v1/* routes.',
      },
      servers: [{ url: 'https://api.hyrelog.com', description: 'Production' }],
    },
    // Public spec: show end-user API only. Hide internal, dashboard, and the spec URL itself.
    // Path-based filtering works for prefixed routes; hideUntagged can miss schema on child contexts.
    hideUntagged: false,
    transform: ({ schema, url }) => {
      const path = url.split('?')[0];
      if (path.startsWith('/internal') || path.startsWith('/dashboard') || path === '/openapi.json') {
        return { schema: { ...schema, hide: true }, url };
      }
      return { schema, url };
    },
  });

  // Public health check (tagged so it appears in public docs)
  fastify.get('/health', {
    schema: {
      tags: ['System'],
      summary: 'Health check',
      description: 'Returns service health. No authentication required.',
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: 'Service is healthy' },
          },
          required: ['ok'],
        },
      },
    },
    handler: async (_request, reply) => {
      return reply.send({ ok: true });
    },
  });

  // Public OpenAPI spec (no auth). Must be registered after all other routes so the spec is complete.
  fastify.get('/openapi.json', {
    schema: { hide: true },
    handler: async (_request, reply) => {
      const spec = fastify.swagger();
      reply.header('Cache-Control', 'public, max-age=300');
      reply.header('Content-Type', 'application/json; charset=utf-8');
      return reply.send(spec);
    },
  });
};

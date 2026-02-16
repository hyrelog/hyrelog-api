import fp from 'fastify-plugin';
import { eventsRoutes } from './events.js';
import { keysRoutes } from './keys.js';
import { webhooksRoutes } from './webhooks.js';
import { exportsRoutes } from './exports.js';

/**
 * V1 API Routes — wrapped with fastify-plugin so routes are registered on the
 * root server. That allows @fastify/swagger’s onRoute hook (on the root) to
 * see them and include /v1/* in the OpenAPI spec.
 */
import type { FastifyInstance } from 'fastify';

async function v1RoutesImpl(fastify: FastifyInstance) {
  await fastify.register(eventsRoutes);
  await fastify.register(keysRoutes);
  await fastify.register(webhooksRoutes);
  await fastify.register(exportsRoutes);
}

export const v1Routes = fp(v1RoutesImpl, { name: 'v1-routes' });


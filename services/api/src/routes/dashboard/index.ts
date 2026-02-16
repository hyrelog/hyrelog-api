/**
 * Dashboard Routes
 * 
 * Phase 4: Protected dashboard endpoints with service token authentication
 * All routes require x-dashboard-token header and actor headers
 */

import { FastifyPluginAsync } from 'fastify';
import { companyRoutes } from './company.js';
import { workspaceRoutes } from './workspace.js';
import { apiKeysRoutes } from './api-keys.js';
import { restoreRoutes } from './restore.js';
import { adminRoutes } from './admin.js';

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(companyRoutes);
  await fastify.register(workspaceRoutes);
  await fastify.register(apiKeysRoutes);
  await fastify.register(restoreRoutes);
  await fastify.register(adminRoutes);
};

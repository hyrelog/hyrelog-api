/**
 * Dashboard Authentication Plugin
 * 
 * Authenticates requests from the dashboard service using a service token
 * and actor headers (user-id, user-email, user-role).
 * For company-scoped routes, requires x-company-id header.
 */

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { loadConfig } from '../lib/config.js';
import { getRegionRouter } from '../lib/regionRouter.js';
import { getLogger } from '../lib/logger.js';
import { getTraceId } from '../lib/trace.js';

import type { PrismaClientType } from '../lib/regionRouter.js';

export interface DashboardAuthInfo {
  userId: string;
  userEmail: string;
  userRole: string;
  companyId?: string; // Required for company-scoped routes
  isHyrelogAdmin: boolean; // true if userRole === 'HYRELOG_ADMIN'
}

declare module 'fastify' {
  interface FastifyRequest {
    dashboardAuth?: DashboardAuthInfo;
    prisma?: PrismaClientType;
  }
}

export const dashboardAuthPlugin: FastifyPluginAsync = async (fastify) => {
  const logger = getLogger();
  const config = loadConfig();
  const regionRouter = getRegionRouter();

  logger.info('Dashboard auth plugin: Starting registration');

  // Verify DASHBOARD_SERVICE_TOKEN is configured
  if (!config.dashboardServiceToken) {
    logger.warn('Dashboard auth plugin: DASHBOARD_SERVICE_TOKEN not configured - dashboard routes will be disabled');
    return;
  }

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // Only apply to /dashboard routes
    if (!request.url.startsWith('/dashboard')) {
      return;
    }

    try {
      // Verify service token
      const token = request.headers['x-dashboard-token'] as string | undefined;
      if (!token || token !== config.dashboardServiceToken) {
        logger.warn({ url: request.url }, 'Dashboard auth: Missing or invalid service token');
        return reply.code(401).send({
          error: 'Missing or invalid dashboard service token',
          code: 'UNAUTHORIZED',
        });
      }

      // Require actor headers
      const userId = request.headers['x-user-id'] as string | undefined;
      const userEmail = request.headers['x-user-email'] as string | undefined;
      const userRole = request.headers['x-user-role'] as string | undefined;

      if (!userId || !userEmail || !userRole) {
        logger.warn({ url: request.url }, 'Dashboard auth: Missing required actor headers');
        return reply.code(400).send({
          error: 'Missing required headers: x-user-id, x-user-email, x-user-role',
          code: 'VALIDATION_ERROR',
        });
      }

      // Routes that do not require x-company-id (they get company from body or path)
      const path = request.url.split('?')[0];
      const postCompanies = request.method === 'POST' && path === '/dashboard/companies';
      const getCompanyByParam = request.method === 'GET' && /^\/dashboard\/companies\/[^/]+$/.test(path);
      const isCompanyScoped = !request.url.startsWith('/dashboard/admin') && !postCompanies && !getCompanyByParam;
      let companyId: string | undefined;

      if (isCompanyScoped) {
        companyId = request.headers['x-company-id'] as string | undefined;
        if (!companyId) {
          logger.warn({ url: request.url }, 'Dashboard auth: Missing x-company-id for company-scoped route');
          return reply.code(400).send({
            error: 'Missing required header: x-company-id',
            code: 'VALIDATION_ERROR',
          });
        }

        // Resolve company and region: x-company-id may be dashboardCompanyId or api company id (id).
        // Prefer lookup by dashboardCompanyId (spec: dashboard is source of truth).
        const regions = regionRouter.getAllRegions();
        let found = false;
        let companyRegion: string | null = null;
        let resolvedCompanyId: string | null = null;

        for (const region of regions) {
          const prisma = regionRouter.getPrisma(region);
          const byDashboardId = await prisma.company.findUnique({
            where: { dashboardCompanyId: companyId },
            select: { id: true, dataRegion: true },
          });
          const company = byDashboardId ?? await prisma.company.findUnique({
            where: { id: companyId },
            select: { id: true, dataRegion: true },
          });

          if (company) {
            found = true;
            companyRegion = company.dataRegion;
            resolvedCompanyId = company.id;
            break;
          }
        }

        if (!found) {
          logger.warn({ url: request.url, companyId }, 'Dashboard auth: Company not found');
          return reply.code(404).send({
            error: 'Company not found',
            code: 'NOT_FOUND',
          });
        }

        companyId = resolvedCompanyId ?? companyId;

        // Attach region-specific Prisma client
        request.prisma = regionRouter.getPrisma(companyRegion as any);
      } else if (postCompanies || getCompanyByParam) {
        // POST /dashboard/companies or GET /dashboard/companies/:id – route will resolve region
        request.prisma = undefined;
      } else {
        // Admin routes - use US region as default
        request.prisma = regionRouter.getPrisma('US');
      }

      // Attach dashboard auth info
      request.dashboardAuth = {
        userId,
        userEmail,
        userRole,
        companyId,
        isHyrelogAdmin: userRole === 'HYRELOG_ADMIN',
      };

      logger.debug(
        {
          url: request.url,
          userId,
          userEmail,
          userRole,
          companyId,
        },
        'Dashboard auth: Request authenticated'
      );
    } catch (error) {
      logger.error({ err: error, url: request.url }, 'Dashboard auth: Error in hook');
      return reply.code(500).send({
        error: 'Internal server error during authentication',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  logger.info('Dashboard auth plugin: Registered successfully');
};

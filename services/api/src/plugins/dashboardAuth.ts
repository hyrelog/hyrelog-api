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
    logger.warn(
      'Dashboard auth plugin: DASHBOARD_SERVICE_TOKEN not set - dashboard routes will return 401. ' +
        'Set DASHBOARD_SERVICE_TOKEN in the API .env to match the dashboard .env.'
    );
    return;
  }

  logger.info('Dashboard auth plugin: DASHBOARD_SERVICE_TOKEN is set - dashboard routes enabled');

  fastify.addHook('preValidation', async (request: FastifyRequest, reply) => {
    // When registered under prefix /dashboard, request.url may be e.g. /companies (no prefix).
    // Run auth for every request that reaches this plugin.

    try {
      // Token is already validated by setupAuthHook in auth.ts; do not check again
      // (avoids duplicate check that could disagree due to timing/config).

      // Require actor headers
      const userId = request.headers['x-user-id'] as string | undefined;
      const userEmail = request.headers['x-user-email'] as string | undefined;
      const userRole = request.headers['x-user-role'] as string | undefined;

      if (!userId || !userEmail || !userRole) {
        return reply.code(400).send({
          error:
            'Dashboard auth: missing required headers x-user-id, x-user-email, x-user-role. Pass actor when calling the API.',
          code: 'VALIDATION_ERROR',
          reason: 'missing_actor_headers',
        });
      }

      // Routes that do not require x-company-id (they get company from body or path)
      const path = request.url.split('?')[0];
      const pathNorm = path.startsWith('/dashboard') ? path : `/dashboard${path === '/' ? '' : path}`;
      const postCompanies = request.method === 'POST' && (pathNorm === '/dashboard/companies' || path === '/companies');
      const getCompanyByParam =
        request.method === 'GET' &&
        (/^\/dashboard\/companies\/[^/]+$/.test(pathNorm) || /^\/companies\/[^/]+$/.test(path));
      const isCompanyScoped =
        !pathNorm.startsWith('/dashboard/admin') && !postCompanies && !getCompanyByParam;
      let companyId: string | undefined;

      if (isCompanyScoped) {
        companyId = request.headers['x-company-id'] as string | undefined;
        if (!companyId) {
          return reply.code(400).send({
            error: 'Dashboard auth: x-company-id header required for this route.',
            code: 'VALIDATION_ERROR',
            reason: 'missing_company_id',
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
          return reply.code(404).send({
            error: 'Company not found for x-company-id.',
            code: 'NOT_FOUND',
            reason: 'company_not_found',
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
      return reply.code(500).send({
        error: 'Dashboard auth: internal error during authentication.',
        code: 'INTERNAL_ERROR',
        reason: 'auth_error',
      });
    }
  });

  logger.info('Dashboard auth plugin: Registered successfully');
};

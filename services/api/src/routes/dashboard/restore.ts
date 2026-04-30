/**
 * Dashboard Restore Routes
 * 
 * Glacier restore request workflow endpoints
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getLogger } from '../../lib/logger.js';
import { logDashboardAction } from '../../lib/auditLog.js';
import {
  estimateRestoreCost,
  estimateCompletionTime,
  getDefaultRestoreDays,
} from '../../lib/glacierRestore.js';

const logger = getLogger();

const CreateRestoreRequestSchema = z.object({
  archiveId: z.string().uuid(),
  tier: z.enum(['EXPEDITED', 'STANDARD', 'BULK']),
  days: z.coerce.number().int().positive().max(30).optional(),
});

export const restoreRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /dashboard/restore-requests
   * Create a restore request
   */
  fastify.post('/restore-requests', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    // Validate request body
    const bodyResult = CreateRestoreRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: bodyResult.error.errors,
      });
    }

    const { archiveId, tier, days } = bodyResult.data;

    try {
      // Get company and check plan restrictions
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, planTier: true, planOverrides: true },
      });

      if (!company) {
        return reply.code(404).send({ error: 'Company not found', code: 'NOT_FOUND' });
      }

      // Check plan restrictions
      if (company.planTier === 'FREE' || company.planTier === 'STARTER') {
        return reply.code(403).send({
          error: 'Restore requests require a Pro, Business, or Enterprise plan',
          code: 'PLAN_RESTRICTED',
        });
      }

      if (tier === 'EXPEDITED' && company.planTier !== 'ENTERPRISE') {
        return reply.code(403).send({
          error: 'EXPEDITED restore tier requires ENTERPRISE plan',
          code: 'PLAN_RESTRICTED',
        });
      }

      // Verify archive exists and belongs to company
      const archive = await prisma.archiveObject.findFirst({
        where: {
          id: archiveId,
          companyId,
          isColdArchived: true,
        },
      });

      if (!archive) {
        return reply.code(404).send({
          error: 'Archive not found or not cold archived',
          code: 'NOT_FOUND',
        });
      }

      // Calculate cost estimate
      const restoreDays = days || getDefaultRestoreDays(tier);
      const estimatedCost = estimateRestoreCost(archive.gzSizeBytes, tier, restoreDays);
      const estimatedCompletionMinutes = estimateCompletionTime(tier);

      // Create restore request
      const restoreRequest = await prisma.glacierRestoreRequest.create({
        data: {
          companyId,
          region: archive.region,
          archiveId,
          requestedByType: 'DASHBOARD_USER',
          requestedById: userId,
          tier,
          days: restoreDays,
          status: 'PENDING',
          estimatedCostUsd: estimatedCost,
        },
      });

      // Log audit action
      await logDashboardAction(prisma, request, {
        action: 'RESTORE_REQUEST_CREATED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: {
          restoreRequestId: restoreRequest.id,
          archiveId,
          tier,
          days: restoreDays,
          estimatedCost,
        },
      });

      return reply.send({
        id: restoreRequest.id,
        status: restoreRequest.status,
        archiveId,
        tier,
        days: restoreDays,
        estimatedCostUsd: estimatedCost,
        estimatedCompletionMinutes,
        requestedAt: restoreRequest.requestedAt.toISOString(),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, archiveId }, 'Dashboard: Failed to create restore request');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/restore-requests
   * List restore requests for company
   */
  fastify.get('/restore-requests', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    if (!companyId) {
      return reply.code(400).send({ error: 'Missing company ID', code: 'VALIDATION_ERROR' });
    }

    const prisma = request.prisma;

    try {
      const requests = await prisma.glacierRestoreRequest.findMany({
        where: { companyId },
        include: {
          archive: {
            select: {
              id: true,
              date: true,
              gzSizeBytes: true,
              rowCount: true,
            },
          },
        },
        orderBy: { requestedAt: 'desc' },
        take: 100,
      });

      return reply.send({
        requests: requests.map((req) => ({
          id: req.id,
          status: req.status,
          archiveId: req.archiveId,
          tier: req.tier,
          days: req.days,
          estimatedCostUsd: req.estimatedCostUsd?.toString(),
          actualCostUsd: req.actualCostUsd?.toString(),
          requestedAt: req.requestedAt.toISOString(),
          approvedAt: req.approvedAt?.toISOString(),
          completedAt: req.completedAt?.toISOString(),
          expiresAt: req.expiresAt?.toISOString(),
          errorMessage: req.errorMessage,
          archive: req.archive,
        })),
      });
    } catch (error: any) {
      logger.error({ err: error, companyId }, 'Dashboard: Failed to list restore requests');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * GET /dashboard/restore-requests/:id
   * Get restore request details
   */
  fastify.get('/restore-requests/:id', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId } = request.dashboardAuth;
    const { id } = request.params as { id: string };

    const prisma = request.prisma;

    try {
      const restoreRequest = await prisma.glacierRestoreRequest.findFirst({
        where: {
          id,
          companyId,
        },
        include: {
          archive: true,
        },
      });

      if (!restoreRequest) {
        return reply.code(404).send({ error: 'Restore request not found', code: 'NOT_FOUND' });
      }

      return reply.send({
        id: restoreRequest.id,
        status: restoreRequest.status,
        archiveId: restoreRequest.archiveId,
        tier: restoreRequest.tier,
        days: restoreRequest.days,
        estimatedCostUsd: restoreRequest.estimatedCostUsd?.toString(),
        actualCostUsd: restoreRequest.actualCostUsd?.toString(),
        requestedAt: restoreRequest.requestedAt.toISOString(),
        approvedAt: restoreRequest.approvedAt?.toISOString(),
        completedAt: restoreRequest.completedAt?.toISOString(),
        expiresAt: restoreRequest.expiresAt?.toISOString(),
        errorMessage: restoreRequest.errorMessage,
        archive: restoreRequest.archive,
      });
    } catch (error: any) {
      logger.error({ err: error, companyId, id }, 'Dashboard: Failed to get restore request');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  /**
   * DELETE /dashboard/restore-requests/:id
   * Cancel restore request (only if PENDING)
   */
  fastify.delete('/restore-requests/:id', async (request, reply) => {
    if (!request.dashboardAuth || !request.prisma) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const { companyId, userId, userEmail, userRole } = request.dashboardAuth;
    const { id } = request.params as { id: string };

    const prisma = request.prisma;

    try {
      const restoreRequest = await prisma.glacierRestoreRequest.findFirst({
        where: {
          id,
          companyId,
        },
      });

      if (!restoreRequest) {
        return reply.code(404).send({ error: 'Restore request not found', code: 'NOT_FOUND' });
      }

      if (restoreRequest.status !== 'PENDING') {
        return reply.code(400).send({
          error: 'Can only cancel PENDING restore requests',
          code: 'VALIDATION_ERROR',
        });
      }

      await prisma.glacierRestoreRequest.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: userId,
        },
      });

      // Log audit action
      await logDashboardAction(prisma, request, {
        action: 'RESTORE_REQUEST_CANCELLED',
        actorUserId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        targetCompanyId: companyId,
        metadata: { restoreRequestId: id },
      });

      return reply.send({ success: true });
    } catch (error: any) {
      logger.error({ err: error, companyId, id }, 'Dashboard: Failed to cancel restore request');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });
};

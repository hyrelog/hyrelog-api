/**
 * Audit Logging Helper
 * 
 * Logs all dashboard actions to the AuditLog table for compliance and audit trails.
 */

import type { PrismaClientType } from './regionRouter.js';
import { getTraceId } from './trace.js';
import { getLogger } from './logger.js';
import type { FastifyRequest } from 'fastify';

const logger = getLogger();

export interface AuditLogContext {
  action: string;
  actorUserId: string;
  actorEmail: string;
  actorRole: string;
  targetCompanyId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a dashboard action to the audit log
 * 
 * @param prisma - Prisma client
 * @param request - Fastify request (for IP, userAgent, traceId)
 * @param context - Audit log context
 */
export async function logDashboardAction(
  prisma: PrismaClientType,
  request: FastifyRequest,
  context: AuditLogContext
): Promise<void> {
  try {
    const traceId = getTraceId(request);
    const ip = request.ip || request.headers['x-forwarded-for'] || undefined;
    const userAgent = request.headers['user-agent'] || undefined;

    await prisma.auditLog.create({
      data: {
        action: context.action,
        actorUserId: context.actorUserId,
        actorEmail: context.actorEmail,
        actorRole: context.actorRole,
        targetCompanyId: context.targetCompanyId,
        ip: typeof ip === 'string' ? ip : Array.isArray(ip) ? ip[0] : ip,
        userAgent,
        traceId,
        // Prisma Json type accepts object; ensure serializable and type-compatible
        metadata: JSON.parse(JSON.stringify(context.metadata ?? {})) as Parameters<PrismaClientType['auditLog']['create']>[0]['data']['metadata'],
      },
    });

    logger.debug(
      {
        action: context.action,
        actorUserId: context.actorUserId,
        targetCompanyId: context.targetCompanyId,
        traceId,
      },
      'Audit log: Dashboard action logged'
    );
  } catch (error: any) {
    // Don't fail the request if audit logging fails
    logger.error(
      { err: error, action: context.action, actorUserId: context.actorUserId },
      'Audit log: Failed to log dashboard action'
    );
  }
}

import { z } from 'zod';
import type { PrismaClientType } from './regionRouter.js';
import { getCompanyPlanConfig, requireCompanyFeature, PlanRestrictionError } from './plans.js';

export const DashboardExportFiltersSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    category: z.string().max(256).optional(),
    action: z.string().max(256).optional(),
    workspaceId: z.string().uuid().optional(),
  })
  .optional();

export const DashboardCreateExportBodySchema = z.object({
  format: z.enum(['JSONL', 'CSV']),
  filters: DashboardExportFiltersSchema,
  limit: z.coerce.number().int().positive().optional(),
  /** When set, merge export filters with this saved explorer view's canonical query (body filters override). */
  savedExplorerViewId: z.string().uuid().optional(),
});

export type DashboardCreateExportError = { statusCode: number; body: Record<string, unknown> };
export type DashboardCreateExportOk = { jobId: string; status: string };

export function sanitizeDashboardFilters(
  raw: Record<string, unknown> | null | undefined
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const k of ['from', 'to', 'category', 'action', 'workspaceId']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Persist only dashboard-export filter keys (no arbitrary JSON blobs from legacy rows). */
export function filtersJsonForExportTemplate(
  raw: Record<string, unknown> | null | undefined
): Record<string, string> {
  return sanitizeDashboardFilters(raw) ?? {};
}

export function buildDashboardExportListWhere(
  companyId: string,
  userRole: string,
  exportWorkspaceIds: string[] | undefined
): { companyId: string; workspaceId?: { in: string[] } } {
  const where: { companyId: string; workspaceId?: { in: string[] } } = { companyId };
  if (userRole === 'MEMBER') {
    const ids = exportWorkspaceIds ?? [];
    where.workspaceId = { in: ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'] };
  }
  return where;
}

export function canDashboardUserViewExportJob(params: {
  userRole: string;
  exportWorkspaceIds: string[] | undefined;
  jobWorkspaceId: string | null;
}): boolean {
  const { userRole, exportWorkspaceIds, jobWorkspaceId } = params;
  if (userRole !== 'MEMBER') return true;
  const ids = exportWorkspaceIds ?? [];
  if (!jobWorkspaceId || ids.length === 0) return false;
  return ids.includes(jobWorkspaceId);
}

export function buildDashboardExportTemplateListWhere(
  companyId: string,
  userRole: string,
  exportWorkspaceIds: string[] | undefined
): { companyId: string; workspaceId?: { in: string[] } } {
  return buildDashboardExportListWhere(companyId, userRole, exportWorkspaceIds);
}

export function canDashboardUserViewExportTemplate(params: {
  userRole: string;
  exportWorkspaceIds: string[] | undefined;
  templateWorkspaceId: string | null;
}): boolean {
  const { userRole, exportWorkspaceIds, templateWorkspaceId } = params;
  if (userRole !== 'MEMBER') return true;
  if (!templateWorkspaceId) return false;
  const ids = exportWorkspaceIds ?? [];
  return ids.includes(templateWorkspaceId);
}

export async function createDashboardExportJob(
  prisma: PrismaClientType,
  params: {
    companyId: string;
    userRole: string;
    exportWorkspaceIds: string[] | undefined;
    format: 'JSONL' | 'CSV';
    filters?: Record<string, string>;
    limit?: number;
    source: 'HOT' | 'ARCHIVED' | 'HOT_AND_ARCHIVED';
    requestedByType: string;
    requestedById: string | null;
  }
): Promise<DashboardCreateExportOk | DashboardCreateExportError> {
  const { companyId, userRole, exportWorkspaceIds, format, filters: rawFilters, limit, source, requestedByType, requestedById } =
    params;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { plan: true },
  });
  if (!company) {
    return { statusCode: 404, body: { error: 'Company not found', code: 'NOT_FOUND' } };
  }

  try {
    requireCompanyFeature(
      {
        planTier: company.planTier,
        planOverrides: company.planOverrides as any,
      },
      'streamingExportsEnabled',
      'STARTER'
    );
  } catch (error: any) {
    if (error instanceof PlanRestrictionError) {
      return {
        statusCode: 403,
        body: {
          error: error.message || 'Streaming exports require a Starter plan or higher',
          code: 'PLAN_RESTRICTED',
        },
      };
    }
    throw error;
  }

  const effectiveConfig = getCompanyPlanConfig({
    planTier: company.planTier,
    planOverrides: company.planOverrides as any,
  });
  const maxRowsBigInt = effectiveConfig.maxExportRows;
  const requestedLimit = limit != null ? BigInt(limit) : maxRowsBigInt;
  if (requestedLimit > maxRowsBigInt) {
    return {
      statusCode: 403,
      body: {
        error: `Export limit exceeded. Your plan allows ${maxRowsBigInt} rows but you requested ${requestedLimit}`,
        code: 'PLAN_LIMIT_EXCEEDED',
      },
    };
  }

  const filters = rawFilters
    ? (Object.fromEntries(
        Object.entries(rawFilters).filter(([, v]) => v !== undefined && v !== '') as [string, string][]
      ) as Record<string, string>)
    : undefined;

  if (userRole === 'MEMBER') {
    if (!filters?.workspaceId) {
      return {
        statusCode: 400,
        body: {
          error: 'Workspace scope is required for export with your role.',
          code: 'WORKSPACE_REQUIRED',
        },
      };
    }
    const ids = exportWorkspaceIds ?? [];
    if (!ids.includes(filters.workspaceId)) {
      return {
        statusCode: 403,
        body: {
          error: 'You do not have access to export that workspace.',
          code: 'FORBIDDEN',
        },
      };
    }
  }

  if (filters?.workspaceId) {
    const ws = await prisma.workspace.findFirst({
      where: { id: filters.workspaceId, companyId },
      select: { id: true },
    });
    if (!ws) {
      return {
        statusCode: 400,
        body: { error: 'Workspace not found for this company.', code: 'VALIDATION_ERROR' },
      };
    }
  }

  const workspaceIdForJob: string | undefined = filters?.workspaceId;

  const exportJob = await prisma.exportJob.create({
    data: {
      companyId,
      workspaceId: workspaceIdForJob,
      projectId: undefined,
      requestedByType,
      requestedById,
      source,
      format: format as any,
      status: 'PENDING',
      filters: filters || {},
      rowLimit: requestedLimit,
    },
  });

  return { jobId: exportJob.id, status: exportJob.status };
}

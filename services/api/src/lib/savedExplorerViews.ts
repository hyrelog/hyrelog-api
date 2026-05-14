import {
  buildDashboardExportListWhere,
  canDashboardUserViewExportJob,
} from './dashboardExportJobs.js';
import { z } from 'zod';

export const CreateSavedExplorerViewBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  query: z.unknown(),
  workspaceId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const PatchSavedExplorerViewBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  query: z.unknown().optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});

/** List scope for saved explorer views (same MEMBER workspace scoping as export templates). */
export function buildSavedExplorerViewListWhere(
  companyId: string,
  userRole: string,
  exportWorkspaceIds: string[] | undefined
): { companyId: string; workspaceId?: { in: string[] } } {
  return buildDashboardExportListWhere(companyId, userRole, exportWorkspaceIds);
}

export function canDashboardUserViewSavedExplorerView(params: {
  userRole: string;
  exportWorkspaceIds: string[] | undefined;
  viewWorkspaceId: string | null;
}): boolean {
  return canDashboardUserViewExportJob({
    userRole: params.userRole,
    exportWorkspaceIds: params.exportWorkspaceIds,
    jobWorkspaceId: params.viewWorkspaceId,
  });
}

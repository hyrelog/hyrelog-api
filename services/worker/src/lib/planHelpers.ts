/**
 * Plan Helpers for Worker
 * 
 * Provides helpers to load Company with plan and resolve effective plan config.
 * Uses database-driven plans (Company.plan + Company.planOverrides).
 */

import type { PrismaClient } from '../../../api/node_modules/.prisma/client/index.js';

/**
 * Local worker copy of plan config shape.
 * Keep aligned with services/api/src/lib/plans.ts.
 */
export interface PlanConfig {
  webhooksEnabled: boolean;
  maxWebhooks: number;
  streamingExportsEnabled: boolean;
  maxExportRows: bigint;
  hotRetentionDays: number;
  archiveRetentionDays?: number;
  coldArchiveAfterDays?: number;
  allowCustomCategories: boolean;
  monthlyEventLimit: number;
  monthlyExportLimit: number;
}

type WorkerPlanTier = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';

const PLAN_CONFIGS: Record<WorkerPlanTier, PlanConfig> = {
  FREE: {
    webhooksEnabled: false,
    maxWebhooks: 0,
    streamingExportsEnabled: false,
    maxExportRows: BigInt(10_000),
    hotRetentionDays: 7,
    allowCustomCategories: false,
    monthlyEventLimit: 1_000,
    monthlyExportLimit: 0,
  },
  STARTER: {
    webhooksEnabled: false,
    maxWebhooks: 0,
    streamingExportsEnabled: true,
    maxExportRows: BigInt(250_000),
    hotRetentionDays: 30,
    archiveRetentionDays: 180,
    allowCustomCategories: true,
    monthlyEventLimit: 100_000,
    monthlyExportLimit: 10,
  },
  GROWTH: {
    webhooksEnabled: true,
    maxWebhooks: 3,
    streamingExportsEnabled: true,
    maxExportRows: BigInt(1_000_000),
    hotRetentionDays: 90,
    archiveRetentionDays: 365,
    coldArchiveAfterDays: 365,
    allowCustomCategories: true,
    monthlyEventLimit: 1_000_000,
    monthlyExportLimit: 50,
  },
  ENTERPRISE: {
    webhooksEnabled: true,
    maxWebhooks: 20,
    streamingExportsEnabled: true,
    maxExportRows: BigInt('999999999999'),
    hotRetentionDays: 180,
    archiveRetentionDays: 2555,
    coldArchiveAfterDays: 365,
    allowCustomCategories: true,
    monthlyEventLimit: Number.MAX_SAFE_INTEGER,
    monthlyExportLimit: Number.MAX_SAFE_INTEGER,
  },
};

function getCompanyPlanConfig(company: { planTier: string; planOverrides?: any }): PlanConfig {
  const tier = (company.planTier || 'FREE').toUpperCase() as WorkerPlanTier;
  const base = PLAN_CONFIGS[tier] ?? PLAN_CONFIGS.FREE;
  const overrides = company.planOverrides && typeof company.planOverrides === 'object'
    ? company.planOverrides
    : {};

  const merged: any = { ...base, ...overrides };

  // Normalize maxExportRows override type from JSON.
  if (typeof merged.maxExportRows === 'string' || typeof merged.maxExportRows === 'number') {
    merged.maxExportRows = BigInt(merged.maxExportRows);
  }

  return merged as PlanConfig;
}

/**
 * Load company with plan relation
 */
export async function loadCompanyWithPlan(
  prisma: PrismaClient,
  companyId: string
): Promise<{
  id: string;
  name: string;
  dataRegion: string;
  planTier: string;
  planId: string;
  planOverrides: any;
  plan: {
    id: string;
    name: string;
    planTier: string;
    webhooksEnabled: boolean;
    maxWebhooks: number;
    streamingExportsEnabled: boolean;
    maxExportRows: bigint;
    hotRetentionDays: number;
    archiveRetentionDays: number | null;
    coldArchiveAfterDays: number | null;
    allowCustomCategories: boolean;
  };
} | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      plan: true,
    },
  });

  if (!company) {
    return null;
  }

  return company as any;
}

/**
 * Get effective plan config for a company
 * Merges plan + planOverrides
 */
export function getEffectivePlanConfig(company: {
  planTier: string;
  planOverrides: any;
}): PlanConfig {
  // Use the plan engine helper which handles merging
  return getCompanyPlanConfig(company as any);
}


/**
 * Central Plan Engine
 * 
 * This is the ONLY place plan rules and configurations live.
 * All plan-related logic should flow through this module.
 * 
 * Supports:
 * - Base plan configurations (FREE, STARTER, GROWTH, ENTERPRISE)
 * - Custom enterprise plans via planOverrides (JSON field on Company)
 * - Runtime plan limit changes (edit PLAN_CONFIGS and restart server)
 */

import type { Company, PlanTier } from '../../node_modules/.prisma/client/index.js';

// Re-export PlanTier for convenience
export type { PlanTier };

/**
 * Plan configuration interface
 * Defines features and limits for each plan tier
 * 
 * Note: maxExportRows is bigint to support values exceeding Number.MAX_SAFE_INTEGER
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
  /** Max events per billing period (monthly). */
  monthlyEventLimit: number;
  /** Max export jobs per billing period (monthly). */
  monthlyExportLimit: number;
}

/**
 * Plan configurations for each tier
 */
const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
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

/**
 * Get plan configuration for a plan tier
 * Optionally merges with planOverrides from Company model
 * 
 * Note: Converts maxExportRows from database BigInt or JSON number/string to BigInt
 */
export function getPlanConfig(planTier: PlanTier, planOverrides?: any): PlanConfig {
  const baseConfig = PLAN_CONFIGS[planTier];
  
  // If no overrides, return base config
  if (!planOverrides || typeof planOverrides !== 'object') {
    return baseConfig;
  }
  
  // Merge base config with overrides (shallow merge)
  const merged = {
    ...baseConfig,
    ...planOverrides,
  };
  
  // Ensure maxExportRows is always BigInt (handles JSON number/string from planOverrides)
  if ('maxExportRows' in merged) {
    if (typeof merged.maxExportRows === 'bigint') {
      // Already BigInt, keep as is
    } else if (typeof merged.maxExportRows === 'string') {
      merged.maxExportRows = BigInt(merged.maxExportRows);
    } else if (typeof merged.maxExportRows === 'number') {
      merged.maxExportRows = BigInt(merged.maxExportRows);
    }
    // If it's already the correct type, leave it
  }
  
  return merged;
}

/**
 * Get plan configuration from a Company object
 * Automatically applies planOverrides if present
 */
export function getCompanyPlanConfig(company: Pick<Company, 'planTier' | 'planOverrides'>): PlanConfig {
  return getPlanConfig(company.planTier, company.planOverrides as any);
}

/**
 * Check if a plan tier has a specific feature enabled
 */
export function hasFeature(planTier: PlanTier, featureName: keyof PlanConfig, planOverrides?: any): boolean {
  const config = getPlanConfig(planTier, planOverrides);
  return config[featureName] === true;
}

/**
 * Check if a company has a specific feature enabled
 * Automatically applies planOverrides if present
 */
export function companyHasFeature(company: Pick<Company, 'planTier' | 'planOverrides'>, featureName: keyof PlanConfig): boolean {
  const config = getCompanyPlanConfig(company);
  return config[featureName] === true;
}

/**
 * Get a limit value for a plan tier
 * Returns bigint for maxExportRows, number for other limits
 */
export function getLimit(planTier: PlanTier, limitName: keyof PlanConfig, planOverrides?: any): number | bigint {
  const config = getPlanConfig(planTier, planOverrides);
  const value = config[limitName];
  
  // maxExportRows is bigint, others are number
  if (limitName === 'maxExportRows') {
    if (typeof value === 'bigint') {
      return value;
    }
    // Handle case where value might come from JSON (planOverrides) as string or number
    if (typeof value === 'string') {
      return BigInt(value);
    }
    if (typeof value === 'number') {
      return BigInt(value);
    }
    throw new Error(`Limit ${limitName} is not a valid bigint for plan ${planTier}`);
  }
  
  if (typeof value !== 'number') {
    throw new Error(`Limit ${limitName} is not a number for plan ${planTier}`);
  }
  return value;
}

/**
 * Get a limit value from a Company object
 * Automatically applies planOverrides if present
 * Returns bigint for maxExportRows, number for other limits
 */
export function getCompanyLimit(company: Pick<Company, 'planTier' | 'planOverrides'>, limitName: keyof PlanConfig): number | bigint {
  return getLimit(company.planTier, limitName, company.planOverrides as any);
}

/**
 * Require a feature to be enabled for a plan tier
 * Throws PlanRestrictionError if feature is not enabled
 */
export class PlanRestrictionError extends Error {
  constructor(
    public readonly planTier: PlanTier,
    public readonly featureName: string,
    public readonly requiredPlan?: PlanTier
  ) {
    const requiredPlanMsg = requiredPlan
      ? ` Requires ${requiredPlan} plan or higher.`
      : '';
    super(`Feature '${featureName}' is not available for ${planTier} plan.${requiredPlanMsg}`);
    this.name = 'PlanRestrictionError';
  }
}

export function requireFeature(
  planTier: PlanTier,
  featureName: keyof PlanConfig,
  requiredPlan?: PlanTier,
  planOverrides?: any
): void {
  if (!hasFeature(planTier, featureName, planOverrides)) {
    throw new PlanRestrictionError(planTier, featureName as string, requiredPlan);
  }
}

/**
 * Require a feature from a Company object
 * Automatically applies planOverrides if present
 */
export function requireCompanyFeature(company: Pick<Company, 'planTier' | 'planOverrides'>, featureName: keyof PlanConfig, requiredPlan?: PlanTier): void {
  if (!companyHasFeature(company, featureName)) {
    throw new PlanRestrictionError(company.planTier, featureName as string, requiredPlan);
  }
}

/**
 * Require a limit to not be exceeded
 * Throws PlanRestrictionError if limit is exceeded
 */
export function requireLimit(
  planTier: PlanTier,
  limitName: keyof PlanConfig,
  currentValue: number | bigint,
  requiredPlan?: PlanTier,
  planOverrides?: any
): void {
  const limit = getLimit(planTier, limitName, planOverrides);
  
  // Handle bigint comparison for maxExportRows
  if (limitName === 'maxExportRows') {
    const limitBigInt = typeof limit === 'bigint' ? limit : BigInt(limit);
    const currentBigInt = typeof currentValue === 'bigint' ? currentValue : BigInt(currentValue);
    
    // Use > instead of >= to allow creating up to the limit
    if (currentBigInt > limitBigInt) {
      const requiredPlanMsg = requiredPlan
        ? ` Requires ${requiredPlan} plan or higher.`
        : '';
      throw new PlanRestrictionError(
        planTier,
        `${limitName} limit exceeded (${currentBigInt}/${limitBigInt})`,
        requiredPlan
      );
    }
    return;
  }
  
  // Handle number comparison for other limits
  const limitNum = typeof limit === 'number' ? limit : Number(limit);
  const currentNum = typeof currentValue === 'number' ? currentValue : Number(currentValue);
  
  // Use > instead of >= to allow creating up to the limit
  if (currentNum > limitNum) {
    const requiredPlanMsg = requiredPlan
      ? ` Requires ${requiredPlan} plan or higher.`
      : '';
    throw new PlanRestrictionError(
      planTier,
      `${limitName} limit exceeded (${currentNum}/${limitNum})`,
      requiredPlan
    );
  }
}

/**
 * Require a limit from a Company object
 * Automatically applies planOverrides if present
 * Handles both number and bigint limits (for maxExportRows)
 */
export function requireCompanyLimit(company: Pick<Company, 'planTier' | 'planOverrides'>, limitName: keyof PlanConfig, currentValue: number | bigint, requiredPlan?: PlanTier): void {
  const limit = getCompanyLimit(company, limitName);
  
  // Handle bigint comparison for maxExportRows
  if (limitName === 'maxExportRows') {
    const limitBigInt = typeof limit === 'bigint' ? limit : BigInt(limit);
    const currentBigInt = typeof currentValue === 'bigint' ? currentValue : BigInt(currentValue);
    
    if (currentBigInt > limitBigInt) {
      const requiredPlanMsg = requiredPlan
        ? ` Requires ${requiredPlan} plan or higher.`
        : '';
      throw new PlanRestrictionError(
        company.planTier,
        `${limitName} limit exceeded (${currentBigInt}/${limitBigInt})`,
        requiredPlan
      );
    }
    return;
  }
  
  // Handle number comparison for other limits
  const limitNum = typeof limit === 'number' ? limit : Number(limit);
  const currentNum = typeof currentValue === 'number' ? currentValue : Number(currentValue);
  
  if (currentNum > limitNum) {
    const requiredPlanMsg = requiredPlan
      ? ` Requires ${requiredPlan} plan or higher.`
      : '';
    throw new PlanRestrictionError(
      company.planTier,
      `${limitName} limit exceeded (${currentNum}/${limitNum})`,
      requiredPlan
    );
  }
}

/**
 * Get human-readable plan name
 */
export function getPlanName(planTier: PlanTier): string {
  return planTier.charAt(0) + planTier.slice(1).toLowerCase();
}

/**
 * Check if a plan tier is a paid plan
 */
export function isPaidPlan(planTier: PlanTier): boolean {
  return planTier !== 'FREE';
}


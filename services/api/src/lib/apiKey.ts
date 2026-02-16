import { createHmac, randomBytes } from 'crypto';
import { loadConfig } from './config.js';
import type { Region } from './config.js';

export type ApiKeyScope = 'COMPANY' | 'WORKSPACE';

/** Region code used in key prefix: us, eu, uk, au */
const REGION_PREFIX_CODES: Record<Region, string> = {
  US: 'us',
  EU: 'eu',
  UK: 'uk',
  AU: 'au',
};

export interface ApiKeyInfo {
  id: string;
  region: Region;
  scope: ApiKeyScope;
  companyId: string;
  workspaceId: string | null;
  /** When scope is WORKSPACE, status of the workspace (for write enforcement). */
  workspaceStatus?: 'ACTIVE' | 'ARCHIVED';
  status: 'ACTIVE' | 'REVOKED';
  expiresAt: Date | null;
  ipAllowlist: string[];
}

/**
 * Hash an API key using HMAC-SHA256
 */
export function hashApiKey(plaintextKey: string): string {
  const config = loadConfig();
  const hmac = createHmac('sha256', config.apiKeySecret);
  hmac.update(plaintextKey);
  return hmac.digest('hex');
}

/**
 * Generate a random API key prefix including region.
 * Format: hlk_{region}_{scope}_ + 8 hex (e.g. hlk_us_co_a1b2c3d4, hlk_au_ws_...).
 * Enables key lookup to target a single region first.
 */
export function generateKeyPrefix(scope: ApiKeyScope, region: Region): string {
  const regionCode = REGION_PREFIX_CODES[region];
  const scopeCode = scope === 'COMPANY' ? 'co' : 'ws';
  const random = randomBytes(8).toString('hex');
  return `hlk_${regionCode}_${scopeCode}_${random}`;
}

/**
 * Generate a full API key (prefix + random suffix).
 * Prefix includes region for efficient lookup.
 */
export function generateApiKey(scope: ApiKeyScope, region: Region): string {
  const prefix = generateKeyPrefix(scope, region);
  const suffix = randomBytes(16).toString('hex');
  return `${prefix}${suffix}`;
}

/**
 * Parse region (and optionally scope) from a key prefix.
 * Handles: hlk_us_co_..., hlk_eu_ws_... (region-prefixed) and legacy hlk_co_..., hlk_ws_...
 * Returns null if prefix format is unrecognized.
 */
export function parseKeyPrefix(plaintextKey: string): { region: Region; scope: ApiKeyScope } | null {
  const match = plaintextKey.match(/^hlk_(us|eu|uk|au)_(co|ws)_/);
  if (match) {
    const [, regionCode, scopeCode] = match;
    const regionByCode: Record<string, Region> = { us: 'US', eu: 'EU', uk: 'UK', au: 'AU' };
    const scope: ApiKeyScope = scopeCode === 'co' ? 'COMPANY' : 'WORKSPACE';
    const region = regionByCode[regionCode];
    if (region) return { region, scope };
  }
  // Legacy: hlk_co_... or hlk_ws_... (no region in prefix) – return null so auth searches all regions
  return null;
}

/**
 * Parse API key from Authorization header
 * Format: "Bearer <key>"
 */
export function parseApiKeyFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}


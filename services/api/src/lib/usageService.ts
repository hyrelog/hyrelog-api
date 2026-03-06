/**
 * Usage service: get usage from Dashboard and increment after ingest/export/webhook.
 * Dashboard stores usage per company per billing period; API calls Dashboard internal API.
 */

import { loadConfig } from './config.js';
import { getLogger } from './logger.js';

const logger = getLogger();

export interface UsageSummary {
  eventsIngested: number;
  exportsCreated: number;
  webhooksActive: number;
  periodStart: string;
  periodEnd: string;
  planCode: string;
}

export async function getUsageForCompany(apiCompanyId: string): Promise<UsageSummary | null> {
  const config = loadConfig();
  const baseUrl = config.dashboardUsageUrl;
  const token = config.dashboardServiceToken;
  if (!baseUrl || !token) {
    return null;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/internal/usage?apiCompanyId=${encodeURIComponent(apiCompanyId)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-dashboard-token': token },
    });
    if (!res.ok) {
      logger.warn({ apiCompanyId, status: res.status }, 'Usage API returned non-OK');
      return null;
    }
    const data = (await res.json()) as UsageSummary;
    return data;
  } catch (err) {
    logger.warn({ err, apiCompanyId }, 'Failed to fetch usage from Dashboard');
    return null;
  }
}

export async function incrementUsage(
  apiCompanyId: string,
  type: 'event' | 'export' | 'webhook',
  amount?: number
): Promise<void> {
  const config = loadConfig();
  const baseUrl = config.dashboardUsageUrl;
  const token = config.dashboardServiceToken;
  if (!baseUrl || !token) {
    return;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/internal/usage`;
  try {
    const body = JSON.stringify({ apiCompanyId, type, amount });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dashboard-token': token },
      body,
    });
    if (!res.ok) {
      logger.warn({ apiCompanyId, type, status: res.status }, 'Usage increment returned non-OK');
    }
  } catch (err) {
    logger.warn({ err, apiCompanyId, type }, 'Failed to increment usage in Dashboard');
  }
}

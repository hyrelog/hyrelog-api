/**
 * Dashboard event histogram (native SQL aggregation).
 *
 * Security: callers must pass the same `companyId` and optional dimension filters as
 * GET /dashboard/events — this module does not re-check workspace membership; the dashboard
 * service supplies `workspaceId` / `projectId` the same way as the list endpoint (company
 * scope is enforced by `companyId` + dashboard service token + actor headers on the route).
 */

/** Use generated client (same as db.ts); avoid `import from '@prisma/client'` which can resolve a stale hoisted `node_modules/.prisma` at the repo root. */
import { Prisma } from '../../node_modules/.prisma/client/index.js';
import type { PrismaClientType } from './regionRouter.js';
import {
  type ParsedHistogramQuery,
  addIntervalUtc,
  floorToIntervalUtc,
} from './dashboardEventHistogramQuery.js';

export { QueryEventHistogramSchema, countExpectedBuckets, MAX_HISTOGRAM_BUCKETS } from './dashboardEventHistogramQuery.js';
export type { ParsedHistogramQuery } from './dashboardEventHistogramQuery.js';

export const MAX_HISTOGRAM_GROUP_ROWS = 20_000;

export type HistogramGroup = { key: string; count: number };
export type HistogramBucket = {
  start: string;
  end: string;
  count: number;
  groups?: HistogramGroup[];
};

export type EventHistogramResponse = {
  buckets: HistogramBucket[];
  meta: {
    from: string;
    to: string;
    interval: 'minute' | 'hour' | 'day';
    groupBy: ParsedHistogramQuery['groupBy'];
    partial: boolean;
  };
};

function groupKeySelectSql(groupBy: ParsedHistogramQuery['groupBy']): Prisma.Sql {
  switch (groupBy) {
    case 'none':
      return Prisma.sql`CAST(NULL AS text)`;
    case 'category':
      return Prisma.sql`ae."category"`;
    case 'action':
      return Prisma.sql`ae."action"`;
    case 'workspace':
      return Prisma.sql`ae."workspaceId"::text`;
    case 'region':
      return Prisma.sql`COALESCE(ae."geo", '')`;
    default:
      return Prisma.sql`CAST(NULL AS text)`;
  }
}

function buildWhereSql(
  companyId: string,
  from: Date,
  to: Date,
  filters: Pick<ParsedHistogramQuery, 'workspaceId' | 'projectId' | 'category' | 'action'>
): Prisma.Sql {
  let w = Prisma.sql`ae."companyId" = ${companyId}::uuid AND ae."timestamp" >= ${from}::timestamptz AND ae."timestamp" <= ${to}::timestamptz`;
  if (filters.workspaceId) {
    w = Prisma.sql`${w} AND ae."workspaceId" = ${filters.workspaceId}::uuid`;
  }
  if (filters.projectId) {
    w = Prisma.sql`${w} AND ae."projectId" = ${filters.projectId}::uuid`;
  }
  if (filters.category) {
    w = Prisma.sql`${w} AND ae."category" = ${filters.category}`;
  }
  if (filters.action) {
    w = Prisma.sql`${w} AND ae."action" = ${filters.action}`;
  }
  return w;
}

type AggRow = { bucket_start: Date; gkey: string | null; cnt: bigint };

export async function computeDashboardEventHistogram(
  prisma: PrismaClientType,
  companyId: string,
  query: ParsedHistogramQuery
): Promise<EventHistogramResponse> {
  const from = new Date(query.from);
  const to = new Date(query.to);
  const whereSql = buildWhereSql(companyId, from, to, query);
  const interval = query.interval;

  const rows =
    query.groupBy === 'none'
      ? await prisma.$queryRaw<AggRow[]>(Prisma.sql`
          SELECT date_trunc(${interval}::text, ae."timestamp" AT TIME ZONE 'UTC') AS bucket_start,
                 CAST(NULL AS text) AS gkey,
                 COUNT(*)::bigint AS cnt
          FROM "AuditEvent" ae
          WHERE ${whereSql}
          GROUP BY 1
          ORDER BY 1
        `)
      : await prisma.$queryRaw<AggRow[]>(Prisma.sql`
          SELECT date_trunc(${interval}::text, ae."timestamp" AT TIME ZONE 'UTC') AS bucket_start,
                 ${groupKeySelectSql(query.groupBy)} AS gkey,
                 COUNT(*)::bigint AS cnt
          FROM "AuditEvent" ae
          WHERE ${whereSql}
          GROUP BY 1, 2
          ORDER BY 1, 2
        `);

  let partial = false;
  if (rows.length > MAX_HISTOGRAM_GROUP_ROWS) {
    partial = true;
  }

  const effectiveRows = rows.slice(0, MAX_HISTOGRAM_GROUP_ROWS);

  const bucketStarts: Date[] = [];
  const first = floorToIntervalUtc(from, query.interval);
  const last = floorToIntervalUtc(to, query.interval);
  for (let cur = first; cur <= last; cur = addIntervalUtc(cur, query.interval)) {
    bucketStarts.push(new Date(cur));
  }

  const rowMap = new Map<string, Map<string, number>>();
  for (const r of effectiveRows) {
    const bs =
      r.bucket_start instanceof Date ? r.bucket_start : new Date(r.bucket_start as unknown as string);
    const key = bs.toISOString();
    const gk = r.gkey ?? '';
    const sub = rowMap.get(key) ?? new Map<string, number>();
    sub.set(gk, Number(r.cnt));
    rowMap.set(key, sub);
  }

  const buckets: HistogramBucket[] = bucketStarts.map((start) => {
    const startIso = start.toISOString();
    const end = addIntervalUtc(start, query.interval);
    const endIso = end.toISOString();
    const perKey = rowMap.get(startIso);

    if (query.groupBy === 'none') {
      let count = 0;
      if (perKey) {
        for (const v of perKey.values()) count += v;
      }
      return { start: startIso, end: endIso, count };
    }

    const groups: HistogramGroup[] = [];
    let count = 0;
    if (perKey) {
      const keys = [...perKey.keys()].sort((a, b) => a.localeCompare(b));
      for (const k of keys) {
        const c = perKey.get(k) ?? 0;
        count += c;
        groups.push({ key: k === '' ? '—' : k, count: c });
      }
    }
    return { start: startIso, end: endIso, count, groups };
  });

  return {
    buckets,
    meta: {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: query.interval,
      groupBy: query.groupBy,
      partial,
    },
  };
}

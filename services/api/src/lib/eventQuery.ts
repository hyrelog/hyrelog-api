import { z } from 'zod';

const uuidList = z.array(z.string().uuid()).max(50).optional();
const stringList = (maxLen: number, maxItems: number) =>
  z.array(z.string().max(maxLen)).max(maxItems).optional();

/**
 * Canonical persisted explorer/event filter shape (serializable, DB-safe, URL-friendly subset).
 * Extend over time; unknown keys are stripped at parse.
 */
export const EventQuerySchema = z
  .object({
    dashboardWorkspaceId: z.string().uuid().optional(),
    workspaceIds: uuidList,
    projectIds: uuidList,
    categories: stringList(256, 50),
    actions: stringList(256, 50),
    actorIds: stringList(128, 50),
    actorTypes: stringList(64, 20),
    resourceIds: stringList(128, 50),
    resourceTypes: stringList(128, 50),
    search: z.string().max(512).optional(),
    severity: stringList(64, 20),
    from: z.string().max(80).optional(),
    to: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    sort: z.enum(['timestamp', 'category', 'action', 'id']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().min(1).max(1_000_000).optional(),
    pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100), z.literal(200)]).optional(),
    ref: z.enum(['', 'dashboard']).optional(),
    tags: stringList(64, 50),
    metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
    traceId: z.string().max(128).optional(),
    correlationId: z.string().max(128).optional(),
  })
  .strip();

export type EventQuery = z.infer<typeof EventQuerySchema>;

function sortStringArray(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Strip empties, trim strings, sort string arrays for stable JSON. */
export function sanitizeEventQueryForPersistence(raw: unknown): EventQuery {
  const parsed = EventQuerySchema.safeParse(raw);
  const base = parsed.success ? parsed.data : {};
  const out: Record<string, unknown> = {};

  const str = (k: keyof EventQuery, max: number) => {
    const v = base[k];
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (!t) return;
    out[k as string] = t.length > max ? t.slice(0, max) : t;
  };

  str('dashboardWorkspaceId', 36);
  str('search', 512);
  str('from', 80);
  str('to', 80);
  str('traceId', 128);
  str('correlationId', 128);

  const arr = (k: keyof EventQuery, maxLen: number) => {
    const v = base[k];
    if (!Array.isArray(v)) return;
    const cleaned = [...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))]
      .map((s) => (s.length > maxLen ? s.slice(0, maxLen) : s))
      .sort(sortStringArray);
    if (cleaned.length) out[k as string] = cleaned;
  };

  arr('workspaceIds', 36);
  arr('projectIds', 36);
  arr('categories', 256);
  arr('actions', 256);
  arr('actorIds', 128);
  arr('actorTypes', 64);
  arr('resourceIds', 128);
  arr('resourceTypes', 128);
  arr('severity', 64);
  arr('tags', 64);

  if (typeof base.limit === 'number' && Number.isFinite(base.limit)) {
    const n = Math.min(500, Math.max(1, Math.floor(base.limit)));
    out.limit = n;
  }
  if (base.sort) out.sort = base.sort;
  if (base.order) out.order = base.order;
  if (typeof base.page === 'number' && Number.isFinite(base.page)) {
    out.page = Math.min(1_000_000, Math.max(1, Math.floor(base.page)));
  }
  if (base.pageSize != null) out.pageSize = base.pageSize;
  if (base.ref !== undefined && base.ref !== '') out.ref = base.ref;

  if (base.metadata && typeof base.metadata === 'object' && !Array.isArray(base.metadata)) {
    const meta: Record<string, string> = {};
    for (const [key, val] of Object.entries(base.metadata)) {
      const kk = key.trim().slice(0, 64);
      if (!kk) continue;
      if (typeof val !== 'string') continue;
      const vv = val.trim().slice(0, 512);
      if (vv) meta[kk] = vv;
    }
    if (Object.keys(meta).length) {
      const sortedKeys = Object.keys(meta).sort(sortStringArray);
      const stable: Record<string, string> = {};
      for (const k of sortedKeys) stable[k] = meta[k]!;
      out.metadata = stable;
    }
  }

  return EventQuerySchema.parse(out);
}

/** Stable JSON string for tests / optional dedupe (sorted top-level keys). */
export function stableEventQueryJson(query: EventQuery): string {
  const keys = Object.keys(query as object).sort(sortStringArray);
  const stable: Record<string, unknown> = {};
  for (const k of keys) {
    stable[k] = (query as Record<string, unknown>)[k];
  }
  return JSON.stringify(stable);
}

/**
 * Map canonical event query to HOT export filter fields (single workspace/category/action).
 */
export function eventQueryToExportFilters(query: EventQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.from?.trim()) {
    const raw = query.from.trim();
    const d = new Date(raw);
    out.from = Number.isNaN(d.getTime()) ? raw.slice(0, 80) : d.toISOString();
  }
  if (query.to?.trim()) {
    const raw = query.to.trim();
    const d = new Date(raw);
    out.to = Number.isNaN(d.getTime()) ? raw.slice(0, 80) : d.toISOString();
  }
  const cat = query.categories?.[0]?.trim();
  if (cat) out.category = cat;
  const act = query.actions?.[0]?.trim();
  if (act) out.action = act;
  const ws = query.workspaceIds?.[0]?.trim();
  if (ws) out.workspaceId = ws;
  return out;
}

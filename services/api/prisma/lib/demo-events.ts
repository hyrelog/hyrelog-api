import { createHash, randomUUID } from 'node:crypto';
import type { Region } from '../../node_modules/.prisma/client/index.js';
import { canonicalJson } from '../../src/lib/canonicalJson.js';

export type DemoEventTemplate = {
  category: string;
  action: string;
  weight: number;
  resourceType?: string;
  actorRole?: string;
  integrity?: boolean;
};

export const DEMO_EVENT_TEMPLATES: DemoEventTemplate[] = [
  { category: 'auth', action: 'user.login', weight: 14, resourceType: 'session', actorRole: 'member' },
  { category: 'auth', action: 'user.logout', weight: 8, resourceType: 'session', actorRole: 'member' },
  { category: 'auth', action: 'user.mfa.verified', weight: 5, resourceType: 'mfa', actorRole: 'member', integrity: true },
  { category: 'auth', action: 'user.password.changed', weight: 3, resourceType: 'user', actorRole: 'member' },
  { category: 'security', action: 'api_key.created', weight: 4, resourceType: 'api_key', actorRole: 'admin' },
  { category: 'security', action: 'api_key.revoked', weight: 2, resourceType: 'api_key', actorRole: 'admin' },
  { category: 'security', action: 'policy.access_denied', weight: 6, resourceType: 'policy', actorRole: 'member' },
  { category: 'security', action: 'ip.allowlist.updated', weight: 2, resourceType: 'network', actorRole: 'admin' },
  { category: 'billing', action: 'invoice.paid', weight: 4, resourceType: 'invoice', actorRole: 'billing' },
  { category: 'billing', action: 'subscription.updated', weight: 3, resourceType: 'subscription', actorRole: 'billing' },
  { category: 'billing', action: 'usage.threshold.warning', weight: 2, resourceType: 'usage', actorRole: 'system' },
  { category: 'data', action: 'record.created', weight: 10, resourceType: 'record', actorRole: 'member' },
  { category: 'data', action: 'record.updated', weight: 12, resourceType: 'record', actorRole: 'member' },
  { category: 'data', action: 'record.deleted', weight: 4, resourceType: 'record', actorRole: 'admin' },
  { category: 'data', action: 'export.requested', weight: 5, resourceType: 'export', actorRole: 'admin' },
  { category: 'admin', action: 'member.invited', weight: 3, resourceType: 'invite', actorRole: 'admin' },
  { category: 'admin', action: 'workspace.settings.updated', weight: 2, resourceType: 'workspace', actorRole: 'admin' },
  { category: 'integration', action: 'webhook.delivered', weight: 7, resourceType: 'webhook', actorRole: 'system' },
  { category: 'integration', action: 'webhook.failed', weight: 4, resourceType: 'webhook', actorRole: 'system' },
  { category: 'integration', action: 'webhook.retry.scheduled', weight: 3, resourceType: 'webhook', actorRole: 'system' },
  { category: 'compliance', action: 'audit.chain.verified', weight: 2, resourceType: 'chain', actorRole: 'system', integrity: true },
];

const ACTORS = [
  { id: 'usr_alex', email: 'alex.morgan@northwind.io', role: 'admin' },
  { id: 'usr_jordan', email: 'jordan.lee@northwind.io', role: 'member' },
  { id: 'usr_sam', email: 'sam.patel@northwind.io', role: 'member' },
  { id: 'usr_riley', email: 'riley.chen@northwind.io', role: 'billing' },
  { id: 'usr_casey', email: 'casey.nguyen@northwind.io', role: 'member' },
  { id: 'usr_system', email: 'system@northwind.io', role: 'system' },
];

const GEOS = ['US', 'US', 'US', 'GB', 'DE', 'AU', 'CA', 'SG'];

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

function hashEvent(eventForHash: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(eventForHash)).digest('hex');
}

export type GeneratedAuditEvent = {
  id: string;
  companyId: string;
  workspaceId: string;
  projectId: string | null;
  timestamp: Date;
  category: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  traceId: string;
  ipAddress: string | null;
  geo: string | null;
  userAgent: string | null;
  prevHash: string | null;
  hash: string;
  idempotencyHash: null;
  dataRegion: Region;
  archivalCandidate: boolean;
  archived: boolean;
  isColdArchived: boolean;
  createdAt: Date;
};

export function generateAuditEventsForChain(options: {
  companyId: string;
  workspaceId: string;
  projectId: string | null;
  count: number;
  dataRegion: Region;
  /** Bias timestamps toward `now` (more events in last 7 days). */
  now?: Date;
}): GeneratedAuditEvent[] {
  const now = options.now ?? new Date();
  const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const out: GeneratedAuditEvent[] = [];
  let prevHash: string | null = null;

  for (let i = 0; i < options.count; i++) {
    const tpl = pickWeighted(DEMO_EVENT_TEMPLATES);
    const actor = ACTORS[Math.floor(Math.random() * ACTORS.length)]!;
    const geo = GEOS[Math.floor(Math.random() * GEOS.length)]!;

    // Skew: 50% in last 7d, 30% in prior 23d, 20% in first 60d
    const roll = Math.random();
    let ts: Date;
    if (roll < 0.5) {
      ts = new Date(now.getTime() - Math.random() * 7 * 24 * 60 * 60 * 1000);
    } else if (roll < 0.8) {
      ts = new Date(now.getTime() - (7 + Math.random() * 23) * 24 * 60 * 60 * 1000);
    } else {
      ts = new Date(start.getTime() + Math.random() * (now.getTime() - start.getTime() - 30 * 24 * 60 * 60 * 1000));
    }

    const metadata: Record<string, unknown> = {
      source: 'screenshot-demo-seed',
      environment: options.projectId ? 'production' : 'mixed',
      requestId: randomUUID(),
    };
    if (tpl.integrity) {
      metadata.integrityStatus = 'verified';
      metadata.integrityHash = createHash('sha256').update(`${i}-${tpl.action}`).digest('hex').slice(0, 16);
    }

    const eventForHash = {
      companyId: options.companyId,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      timestamp: ts.toISOString(),
      category: tpl.category,
      action: tpl.action,
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: tpl.actorRole ?? actor.role,
      resourceType: tpl.resourceType ?? null,
      resourceId: tpl.resourceType ? `${tpl.resourceType}_${10000 + i}` : null,
      metadata,
      prevHash,
    };

    const hash = hashEvent(eventForHash);
    const createdAt = new Date(ts.getTime() + Math.floor(Math.random() * 120_000));

    out.push({
      id: randomUUID(),
      companyId: options.companyId,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      timestamp: ts,
      category: tpl.category,
      action: tpl.action,
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: tpl.actorRole ?? actor.role,
      resourceType: tpl.resourceType ?? null,
      resourceId: tpl.resourceType ? `${tpl.resourceType}_${10000 + i}` : null,
      metadata,
      traceId: randomUUID(),
      ipAddress: `203.0.113.${Math.floor(Math.random() * 200) + 10}`,
      geo,
      userAgent: 'HyreLog-DemoSeed/1.0',
      prevHash,
      hash,
      idempotencyHash: null,
      dataRegion: options.dataRegion,
      archivalCandidate: false,
      archived: false,
      isColdArchived: false,
      createdAt,
    });

    prevHash = hash;
  }

  return out;
}

export async function insertEventsInBatches(
  prisma: { auditEvent: { createMany: (args: { data: GeneratedAuditEvent[]; skipDuplicates?: boolean }) => Promise<{ count: number }> } },
  events: GeneratedAuditEvent[],
  batchSize = 500
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < events.length; i += batchSize) {
    const chunk = events.slice(i, i + batchSize);
    const res = await prisma.auditEvent.createMany({ data: chunk, skipDuplicates: true });
    inserted += res.count;
  }
  return inserted;
}

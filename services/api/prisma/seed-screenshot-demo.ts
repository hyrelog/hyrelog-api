/**
 * Screenshot / local demo seed — Northwind Systems with thousands of audit events.
 *
 * Prereq: migrations applied on the default region DB.
 *
 * Usage (from services/api):
 *   npm run prisma:seed:screenshot
 *
 * Env:
 *   DEMO_EVENT_COUNT=8000   (default 6000 total across workspaces)
 *   DEMO_SKIP_CLEAR=1       (append without deleting prior demo company)
 */

import { PrismaClient, type Region } from '../node_modules/.prisma/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { loadConfig, getDatabaseUrl } from '../src/lib/config.js';
import {
  DEMO_API_COMPANY_ID,
  DEMO_DASHBOARD_COMPANY_ID,
  DEMO_ADMIN_USER_ID,
  DEMO_PROJECTS,
  DEMO_WORKSPACES,
} from './demo-ids.js';
import { generateAuditEventsForChain, insertEventsInBatches } from './lib/demo-events.js';

const TOTAL_EVENTS = Math.max(
  500,
  Math.min(50_000, Number.parseInt(process.env.DEMO_EVENT_COUNT ?? '6000', 10) || 6000)
);

async function ensureBusinessPlan(prisma: PrismaClient) {
  let plan = await prisma.plan.findFirst({
    where: { planTier: 'BUSINESS', planType: 'STANDARD', isActive: true },
  });
  if (plan) return plan;

  plan = await prisma.plan.create({
    data: {
      name: 'Business',
      planTier: 'BUSINESS',
      planType: 'STANDARD',
      webhooksEnabled: true,
      maxWebhooks: 15,
      streamingExportsEnabled: true,
      maxExportRows: BigInt(12_000_000),
      hotRetentionDays: 365,
      archiveRetentionDays: 1825,
      allowCustomCategories: true,
      description: 'Business plan (demo seed)',
    },
  });
  return plan;
}

async function clearDemoCompany(prisma: PrismaClient) {
  const existing = await prisma.company.findUnique({
    where: { id: DEMO_API_COMPANY_ID },
    select: { id: true },
  });
  if (!existing) return;

  console.log('🧹 Removing previous Northwind demo data from API DB...');
  await prisma.auditEvent.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  await prisma.exportJob.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  try {
    await prisma.savedExplorerView.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  } catch {
    /* table may be missing */
  }
  try {
    await prisma.exportTemplate.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  } catch {
    /* */
  }
  await prisma.apiKey.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  const wsIds = DEMO_WORKSPACES.map((w) => w.apiId);
  await prisma.project.deleteMany({ where: { workspaceId: { in: wsIds } } });
  await prisma.workspace.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  await prisma.companyMember.deleteMany({ where: { companyId: DEMO_API_COMPANY_ID } });
  await prisma.company.delete({ where: { id: DEMO_API_COMPANY_ID } });
}

async function seed() {
  const config = loadConfig();
  const region = config.defaultDataRegion as Region;
  const pool = new Pool({ connectionString: getDatabaseUrl(region) });
  const adapter = new PrismaPg(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = new PrismaClient({ adapter } as any);

  try {
    console.log(`\n📸 HyreLog screenshot demo seed (region ${region})\n`);

    if (process.env.DEMO_SKIP_CLEAR !== '1') {
      await clearDemoCompany(prisma);
    }

    const plan = await ensureBusinessPlan(prisma);

    const company = await prisma.company.create({
      data: {
        id: DEMO_API_COMPANY_ID,
        name: 'Northwind Systems',
        slug: 'northwind-systems',
        dataRegion: region,
        dashboardCompanyId: DEMO_DASHBOARD_COMPANY_ID,
        planId: plan.id,
        planTier: 'BUSINESS',
        billingStatus: 'ACTIVE',
        trialEndsAt: null,
      },
    });
    console.log(`✅ Company: ${company.name} (${company.id})`);

    await prisma.companyMember.createMany({
      data: [
        { companyId: company.id, email: 'alex.morgan@northwind.io', role: 'ADMIN' },
        { companyId: company.id, email: 'jordan.lee@northwind.io', role: 'MEMBER' },
        { companyId: company.id, email: 'sam.patel@northwind.io', role: 'MEMBER' },
        { companyId: company.id, email: 'riley.chen@northwind.io', role: 'MEMBER' },
      ],
    });

    const apiWorkspaces: { id: string; name: string; dashboardId: string }[] = [];
    for (const ws of DEMO_WORKSPACES) {
      const row = await prisma.workspace.create({
        data: {
          id: ws.apiId,
          companyId: company.id,
          name: ws.name,
          slug: ws.slug,
          dashboardWorkspaceId: ws.dashboardId,
          status: 'ACTIVE',
        },
      });
      apiWorkspaces.push({ id: row.id, name: row.name, dashboardId: ws.dashboardId });
      console.log(`   Workspace: ${row.name}`);
    }

    for (const p of DEMO_PROJECTS) {
      await prisma.project.create({
        data: {
          id: p.apiId,
          workspaceId: p.workspaceApiId,
          name: p.name,
          slug: p.slug,
          dashboardProjectId: p.dashboardId,
        },
      });
    }
    console.log(`✅ ${DEMO_PROJECTS.length} projects`);

    console.log(`\n⏳ Generating ~${TOTAL_EVENTS} audit events...`);
    const weights = DEMO_WORKSPACES.map((w) => w.weight);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    let totalInserted = 0;

    for (let wi = 0; wi < DEMO_WORKSPACES.length; wi++) {
      const ws = DEMO_WORKSPACES[wi]!;
      const count = Math.max(50, Math.round((TOTAL_EVENTS * weights[wi]!) / weightSum));
      const projectId = wi === 0 ? DEMO_PROJECTS[0]!.apiId : null;
      const events = generateAuditEventsForChain({
        companyId: company.id,
        workspaceId: ws.apiId,
        projectId,
        count,
        dataRegion: region,
      });
      const inserted = await insertEventsInBatches(prisma, events);
      totalInserted += inserted;
      console.log(`   ${ws.name}: ${inserted.toLocaleString()} events`);
    }

    const adminWs = DEMO_WORKSPACES[0]!.apiId;
    try {
      await prisma.savedExplorerView.createMany({
        data: [
          {
            companyId: company.id,
            workspaceId: null,
            createdByUserId: DEMO_ADMIN_USER_ID,
            name: 'Failed logins (7d)',
            description: 'Auth failures across all workspaces',
            query: {
              categories: ['auth'],
              actions: ['user.login', 'policy.access_denied'],
              from: new Date(Date.now() - 7 * 86400000).toISOString(),
              sort: 'timestamp',
              order: 'desc',
              pageSize: 50,
            },
            isDefault: false,
          },
          {
            companyId: company.id,
            workspaceId: adminWs,
            createdByUserId: DEMO_ADMIN_USER_ID,
            name: 'Production — security review',
            description: 'Security category in production workspace',
            query: {
              dashboardWorkspaceId: DEMO_WORKSPACES[0]!.dashboardId,
              categories: ['security'],
              from: new Date(Date.now() - 30 * 86400000).toISOString(),
              sort: 'timestamp',
              order: 'desc',
            },
            isDefault: true,
          },
          {
            companyId: company.id,
            workspaceId: adminWs,
            createdByUserId: DEMO_ADMIN_USER_ID,
            name: 'Webhook failures',
            query: {
              categories: ['integration'],
              actions: ['webhook.failed', 'webhook.retry.scheduled'],
              sort: 'timestamp',
              order: 'desc',
            },
            isDefault: false,
          },
        ],
      });
      console.log('✅ Saved explorer views');
    } catch (e) {
      console.warn('⚠️  Skipped saved explorer views (migration missing?)', e);
    }

    try {
      await prisma.exportTemplate.create({
        data: {
          companyId: company.id,
          workspaceId: adminWs,
          name: 'Monthly compliance export',
          description: 'Last 30 days, production workspace',
          createdByUserId: DEMO_ADMIN_USER_ID,
          format: 'JSONL',
          source: 'HOT',
          filters: {
            from: new Date(Date.now() - 30 * 86400000).toISOString(),
            to: new Date().toISOString(),
          },
        },
      });
      console.log('✅ Export template');
    } catch {
      console.warn('⚠️  Skipped export templates');
    }

    const finished = new Date();
    const started = new Date(finished.getTime() - 45_000);
    await prisma.exportJob.create({
      data: {
        companyId: company.id,
        workspaceId: adminWs,
        requestedByType: 'DASHBOARD_USER',
        requestedById: DEMO_ADMIN_USER_ID,
        source: 'HOT',
        format: 'CSV',
        status: 'SUCCEEDED',
        filters: {
          category: 'auth',
          from: new Date(Date.now() - 7 * 86400000).toISOString(),
        },
        rowLimit: BigInt(500_000),
        rowsExported: BigInt(12847),
        createdAt: started,
        startedAt: started,
        finishedAt: finished,
      },
    });
    console.log('✅ Sample export job (SUCCEEDED)');

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 Inserted ${totalInserted.toLocaleString()} audit events`);
    console.log(`   API company id:    ${DEMO_API_COMPANY_ID}`);
    console.log(`   Dashboard co id:   ${DEMO_DASHBOARD_COMPANY_ID}`);
    console.log('   Next: npm run db:seed:screenshot  (hyrelog-dashboard)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});

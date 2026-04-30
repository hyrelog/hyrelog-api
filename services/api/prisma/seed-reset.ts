/**
 * Reset API database to default state for testing.
 * Deletes all companies, workspaces, events, exports, webhooks, etc.,
 * then re-seeds only standard plans. No companies or API keys remain.
 *
 * Target database:
 * - If DATABASE_URL is set (e.g. by reset-all-regions.ps1), uses that.
 * - Otherwise uses default region from config (DATABASE_URL_* / DEFAULT_DATA_REGION).
 *
 * Usage:
 *   npm run prisma:seed:reset          (default region only)
 *   DATABASE_URL=... npm run prisma:seed:reset   (specific URL, e.g. for all-regions script)
 */

import { PrismaClient } from '../node_modules/.prisma/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { loadConfig, getDatabaseUrl } from '../src/lib/config.js';

function getDatabaseUrlToUse(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const config = loadConfig();
  return getDatabaseUrl(config.defaultDataRegion);
}

async function reset() {
  const databaseUrl = getDatabaseUrlToUse();
  const regionLabel = process.env.SEED_RESET_REGION_LABEL || 'default region';

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = new PrismaClient({ adapter } as any);

  try {
    console.log(`Resetting API database (${regionLabel})...\n`);

    try {
      await prisma.$queryRaw`SELECT "planTier" FROM companies LIMIT 1`;
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code === '42703' || err.code === 'P2021') {
        console.error('Database migrations have not been run. Run prisma:migrate first.');
        process.exit(1);
      }
      throw error;
    }

    console.log('Clearing existing data...');

    try {
      await prisma.webhookDeliveryAttempt.deleteMany({});
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code !== 'P2021') throw error;
    }
    try {
      await prisma.webhookJob.deleteMany({});
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code !== 'P2021') throw error;
    }
    try {
      await prisma.webhookEndpoint.deleteMany({});
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code !== 'P2021') throw error;
    }

    await prisma.auditEvent.deleteMany({});
    await prisma.gdprApproval.deleteMany({});
    await prisma.gdprRequest.deleteMany({});
    await prisma.archiveObject.deleteMany({});
    await prisma.exportJob.deleteMany({});
    await prisma.apiKey.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.workspace.deleteMany({});
    await prisma.companyMember.deleteMany({});
    await prisma.company.deleteMany({});
    await prisma.plan.deleteMany({});

    console.log('Creating standard plans...\n');

    await prisma.plan.create({
      data: {
        name: 'Free',
        planTier: 'FREE',
        planType: 'STANDARD',
        webhooksEnabled: false,
        maxWebhooks: 0,
        streamingExportsEnabled: false,
        maxExportRows: BigInt(10000),
        hotRetentionDays: 7,
        allowCustomCategories: false,
        isDefault: true, // API catalog default row; provisioning uses BUSINESS via env
        description: 'Free plan with basic features',
      },
    });
    await prisma.plan.create({
      data: {
        name: 'Starter',
        planTier: 'STARTER',
        planType: 'STANDARD',
        webhooksEnabled: false,
        maxWebhooks: 0,
        streamingExportsEnabled: true,
        maxExportRows: BigInt(250000),
        hotRetentionDays: 30,
        archiveRetentionDays: 180,
        allowCustomCategories: true,
        description: 'Starter plan with streaming exports',
      },
    });
    await prisma.plan.create({
      data: {
        name: 'Pro',
        planTier: 'PRO',
        planType: 'STANDARD',
        webhooksEnabled: true,
        maxWebhooks: 5,
        streamingExportsEnabled: true,
        maxExportRows: BigInt(3_000_000),
        hotRetentionDays: 90,
        archiveRetentionDays: 365,
        coldArchiveAfterDays: 365,
        allowCustomCategories: true,
        description: 'Pro plan — webhooks, exports, extended retention',
      },
    });
    await prisma.plan.create({
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
        coldArchiveAfterDays: 365,
        allowCustomCategories: true,
        description: 'Business plan — higher limits and retention',
      },
    });
    await prisma.plan.create({
      data: {
        name: 'Enterprise',
        planTier: 'ENTERPRISE',
        planType: 'STANDARD',
        webhooksEnabled: true,
        maxWebhooks: 50,
        streamingExportsEnabled: true,
        maxExportRows: BigInt('999999999999'),
        hotRetentionDays: 180,
        archiveRetentionDays: 2555,
        coldArchiveAfterDays: 365,
        allowCustomCategories: true,
        description: 'Enterprise plan with maximum limits',
      },
    });

    console.log('Reset complete. Database has no companies; plans only.\n');
  } catch (error) {
    console.error('Reset failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

reset()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));

/**
 * Repair API DB drift per **region**: `_prisma_migrations` records a migration but the table is missing.
 * The API uses `getDatabaseUrl(company.dataRegion)` for dashboard routes — not only US.
 *
 * Run from `services/api`: `npm run db:repair:schema-drift`
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { getDatabaseUrl, loadConfig, type Region } from '../src/lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..');

void loadConfig();

const REGIONS: Region[] = ['US', 'EU', 'UK', 'AU'];

function redactConnectionString(u: string): string {
  try {
    const parsed = new URL(u);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable URL)';
  }
}

async function tableExists(client: pg.PoolClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return Boolean(rows[0]?.exists);
}

async function migrationAppliedExact(client: pg.PoolClient, migrationName: string): Promise<boolean> {
  const { rows } = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM "_prisma_migrations" WHERE migration_name = $1`,
    [migrationName]
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

async function migrationAppliedLike(client: pg.PoolClient, slug: string): Promise<boolean> {
  const { rows } = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM "_prisma_migrations" WHERE migration_name ~ $1`,
    [`${slug}$`]
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

async function applySqlFile(client: pg.PoolClient, relPath: string) {
  const sql = readFileSync(join(apiRoot, relPath), 'utf8');
  await client.query(sql);
}

async function repairOneRegion(region: Region): Promise<void> {
  const url = getDatabaseUrl(region);
  const u = new URL(url);
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const exportTemplatesMigration = '20260514120000_export_templates';
    const savedViewsMigration = '20260216120000_saved_explorer_views';

    const hasEt = await tableExists(client, 'export_templates');
    const hasSv = await tableExists(client, 'saved_explorer_views');
    const etMig =
      (await migrationAppliedExact(client, exportTemplatesMigration)) ||
      (await migrationAppliedLike(client, 'export_templates'));
    const svMig =
      (await migrationAppliedExact(client, savedViewsMigration)) ||
      (await migrationAppliedLike(client, 'saved_explorer_views'));

    console.log(`\n=== Region ${region} ===`);
    console.log({
      datasource: redactConnectionString(url),
      host: u.host,
      database: u.pathname.replace(/^\//, '') || '(default)',
      export_templates_exists: hasEt,
      saved_explorer_views_exists: hasSv,
      migration_export_templates_recorded: etMig,
      migration_saved_explorer_views_recorded: svMig,
    });

    if (!hasEt && etMig) {
      console.log(`[${region}] Repair: creating export_templates...`);
      await applySqlFile(client, 'prisma/migrations/20260514120000_export_templates/migration.sql');
      console.log(`[${region}] export_templates OK.`);
    } else if (!hasEt && !etMig) {
      console.error(
        `[${region}] export_templates missing and migration not in history — run: npm run prisma:migrate:deploy (use DATABASE_URL_${region} if not default datasource)`
      );
    } else {
      console.log(`[${region}] export_templates already present.`);
    }

    if (!hasSv && svMig) {
      console.log(`[${region}] Repair: creating saved_explorer_views...`);
      await applySqlFile(client, 'prisma/migrations/20260216120000_saved_explorer_views/migration.sql');
      console.log(`[${region}] saved_explorer_views OK.`);
    } else if (!hasSv && !svMig) {
      console.error(
        `[${region}] saved_explorer_views missing and migration not in history — run migrate deploy against this region's DATABASE_URL`
      );
    } else {
      console.log(`[${region}] saved_explorer_views already present.`);
    }

    console.log(`[${region}] Final:`, {
      export_templates: await tableExists(client, 'export_templates'),
      saved_explorer_views: await tableExists(client, 'saved_explorer_views'),
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  for (const r of REGIONS) {
    await repairOneRegion(r);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

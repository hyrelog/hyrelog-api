/**
 * Prisma 7 Configuration File
 *
 * Provides the datasource URL for Prisma Migrate and Prisma Studio.
 * Loads .env from the hyrelog-api repo root (`../..` from this file).
 *
 * **Important:** The API runtime uses `getDatabaseUrl('US')` → `DATABASE_URL_US` for US data
 * (`regionRouter`, dashboard auth). If `DATABASE_URL` is also set (e.g. another Postgres),
 * preferring it here caused migrations to run against the wrong DB while the server used
 * `DATABASE_URL_US` — symptoms: `_prisma_migrations` / “no pending migrations” on one DB,
 * `P2021` missing `export_templates` at runtime on another.
 *
 * Resolution order:
 * 1. `PRISMA_MIGRATE_DATASOURCE_URL` — explicit target (e.g. `scripts/migrate-all-regions.ps1` per region).
 * 2. `DATABASE_URL_US` — matches `getDatabaseUrl('US')` for the running API.
 * 3. `DATABASE_URL` — legacy / tooling override when US URL is not set.
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
// prisma.config.ts is in services/api/ -> root is 2 levels up
const rootDir = resolve(currentDir, '..', '..');
loadDotenv({ path: resolve(rootDir, '.env') });

const url =
  process.env.PRISMA_MIGRATE_DATASOURCE_URL ||
  process.env.DATABASE_URL_US ||
  process.env.DATABASE_URL ||
  '';

export default {
  datasource: {
    url,
  },
};


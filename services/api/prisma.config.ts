/**
 * Prisma 7 Configuration File
 *
 * Provides the datasource URL for Prisma Migrate and Prisma Studio.
 * Loads .env from the monorepo root. Uses DATABASE_URL if set, otherwise
 * DATABASE_URL_US so that `npx prisma studio` works without setting env in the shell.
 *
 * For a specific region, set DATABASE_URL before running, e.g. (PowerShell):
 *   $env:DATABASE_URL=$env:DATABASE_URL_US; npx prisma studio
 * Or from repo root: npm run prisma:studio:us
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
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_US ||
  '';

export default {
  datasource: {
    url,
  },
};


/**
 * Prisma 7 Configuration File
 *
 * Provides the datasource URL for Prisma Migrate. You must set DATABASE_URL
 * before running migrate (e.g. to one region's URL). Example (PowerShell, US):
 *   $env:DATABASE_URL="postgresql://hyrelog:hyrelog@localhost:54321/hyrelog_us"
 *   npx prisma migrate dev --name add_dashboard_tenant_ids
 * Then run the same migration for other regions via npm run prisma:migrate:all
 * or by setting DATABASE_URL to each region's URL and running migrate deploy.
 */
export default {
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
};


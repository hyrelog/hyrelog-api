import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

// Load environment variables from .env file in the repo root
// config.ts is at: services/api/src/lib/config.ts
// .env is at: .env (repo root)
// Path: lib -> src -> api -> services -> root (4 levels up)
const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const rootDir = resolve(currentDir, '..', '..', '..', '..');
loadDotenv({ path: resolve(rootDir, '.env') });

const RegionSchema = z.enum(['US', 'EU', 'UK', 'AU']);

const ConfigSchema = z
  .object({
  // Server
  port: z.coerce.number().default(3000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Internal auth
  internalToken: z.string().min(1),

  // Default region
  defaultDataRegion: RegionSchema.default('US'),

  // Database URLs per region
  databaseUrlUs: z.string().url(),
  databaseUrlEu: z.string().url(),
  databaseUrlUk: z.string().url(),
  databaseUrlAu: z.string().url(),

  // S3 / MinIO
  // For AWS IAM task roles, keys are optional (SDK default credential chain).
  // For MinIO/custom endpoint mode, keys are required.
  s3Endpoint: z.string().url().optional(),
  s3AccessKeyId: z.string().min(1).optional(),
  s3SecretAccessKey: z.string().min(1).optional(),
  s3Region: z.string().default('us-east-1'),
  s3ForcePathStyle: z.coerce.boolean().default(false),

  // S3 Buckets per region
  s3BucketUs: z.string().min(1),
  s3BucketEu: z.string().min(1),
  s3BucketUk: z.string().min(1),
  s3BucketAu: z.string().min(1),

  // Archival
  coldArchiveAfterDays: z.coerce.number().default(365),

  // Rate limits
  rateLimitApiKeyPerMin: z.coerce.number().default(1200),
  rateLimitIpPerMin: z.coerce.number().default(600),
  rateLimitEventsPerMin: z.coerce.number().default(1000),

  // API Key secret for hashing
  apiKeySecret: z.string().min(1),

  // Dashboard service token (optional - dashboard routes disabled if not set)
  dashboardServiceToken: z.string().optional(),

  // Dashboard URL for usage callback (API calls Dashboard to get/increment usage)
  dashboardUsageUrl: z.string().url().optional(),
})
  .superRefine((cfg, ctx) => {
    if (cfg.s3Endpoint) {
      if (!cfg.s3AccessKeyId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['s3AccessKeyId'],
          message: 'Required when S3_ENDPOINT is set',
        });
      }
      if (!cfg.s3SecretAccessKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['s3SecretAccessKey'],
          message: 'Required when S3_ENDPOINT is set',
        });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Region = z.infer<typeof RegionSchema>;

let config: Config | null = null;

export function loadConfig(): Config {
  if (config) {
    return config;
  }

  const raw = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    internalToken: process.env.INTERNAL_TOKEN,
    defaultDataRegion: process.env.DEFAULT_DATA_REGION,
    databaseUrlUs: process.env.DATABASE_URL_US,
    databaseUrlEu: process.env.DATABASE_URL_EU,
    databaseUrlUk: process.env.DATABASE_URL_UK,
    databaseUrlAu: process.env.DATABASE_URL_AU,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    s3Region: process.env.S3_REGION,
    s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE,
    s3BucketUs: process.env.S3_BUCKET_US,
    s3BucketEu: process.env.S3_BUCKET_EU,
    s3BucketUk: process.env.S3_BUCKET_UK,
    s3BucketAu: process.env.S3_BUCKET_AU,
    coldArchiveAfterDays: process.env.COLD_ARCHIVE_AFTER_DAYS,
    rateLimitApiKeyPerMin: process.env.RATE_LIMIT_API_KEY_PER_MIN,
    rateLimitIpPerMin: process.env.RATE_LIMIT_IP_PER_MIN,
    rateLimitEventsPerMin: process.env.RATE_LIMIT_EVENTS_PER_MIN,
    apiKeySecret: process.env.API_KEY_SECRET,
    dashboardServiceToken: process.env.DASHBOARD_SERVICE_TOKEN,
    dashboardUsageUrl: process.env.HYRELOG_DASHBOARD_URL || process.env.DASHBOARD_USAGE_URL,
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  config = result.data;
  return config;
}

export function getDatabaseUrl(region: Region): string {
  const cfg = loadConfig();
  switch (region) {
    case 'US':
      return cfg.databaseUrlUs;
    case 'EU':
      return cfg.databaseUrlEu;
    case 'UK':
      return cfg.databaseUrlUk;
    case 'AU':
      return cfg.databaseUrlAu;
  }
}

export function getS3Bucket(region: Region): string {
  const cfg = loadConfig();
  switch (region) {
    case 'US':
      return cfg.s3BucketUs;
    case 'EU':
      return cfg.s3BucketEu;
    case 'UK':
      return cfg.s3BucketUk;
    case 'AU':
      return cfg.s3BucketAu;
  }
}


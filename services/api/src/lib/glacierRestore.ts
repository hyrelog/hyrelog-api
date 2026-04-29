/**
 * Glacier Restore Service
 * 
 * Handles AWS S3 Glacier restoration operations:
 * - Cost estimation
 * - Completion time estimation
 * - Initiate restore requests
 * - Check restore status
 * 
 * In development (MinIO), simulates restore operations.
 */

import { S3Client, RestoreObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig, getS3Bucket, type Region } from './config.js';
import { getLogger } from './logger.js';

const logger = getLogger();

// Cost constants (per GB) - from AWS Glacier pricing
const COST_PER_GB = {
  EXPEDITED: 0.03, // $0.03/GB retrieval + $0.01/GB/month storage
  STANDARD: 0.01, // $0.01/GB retrieval + $0.004/GB/month storage
  BULK: 0.0025, // $0.0025/GB retrieval + $0.004/GB/month storage
};

// Storage cost per GB per month (for restored copy)
const STORAGE_COST_PER_GB_MONTH = 0.004;

// Completion time estimates (in minutes)
const COMPLETION_TIME_MINUTES = {
  EXPEDITED: 5, // 1-5 minutes
  STANDARD: 240, // 3-5 hours (average 4 hours)
  BULK: 510, // 5-12 hours (average 8.5 hours)
};

// Default restore duration (days)
const DEFAULT_RESTORE_DAYS = {
  EXPEDITED: 1,
  STANDARD: 7,
  BULK: 7,
};

export type GlacierRestoreTier = 'EXPEDITED' | 'STANDARD' | 'BULK';

/**
 * Get S3 client configured for the environment
 */
function getS3Client(): S3Client {
  const config = loadConfig();

  const clientConfig: any = {
    region: config.s3Region,
  };

  if (config.s3AccessKeyId && config.s3SecretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    };
  }

  // MinIO configuration
  if (config.s3Endpoint) {
    clientConfig.endpoint = config.s3Endpoint;
    clientConfig.forcePathStyle = config.s3ForcePathStyle;
  }

  return new S3Client(clientConfig);
}

/**
 * Estimate restore cost in USD
 * 
 * @param bytes - Size of archive in bytes
 * @param tier - Restore tier
 * @param days - Days to keep restored (default based on tier)
 * @returns Estimated cost in USD
 */
export function estimateRestoreCost(
  bytes: number,
  tier: GlacierRestoreTier,
  days?: number
): number {
  const gb = bytes / (1024 * 1024 * 1024);
  const retrievalCost = gb * COST_PER_GB[tier];
  
  // Storage cost for restored copy
  const restoreDays = days || DEFAULT_RESTORE_DAYS[tier];
  const storageMonths = restoreDays / 30;
  const storageCost = gb * STORAGE_COST_PER_GB_MONTH * storageMonths;
  
  return retrievalCost + storageCost;
}

/**
 * Estimate completion time in minutes
 * 
 * @param tier - Restore tier
 * @returns Estimated completion time in minutes
 */
export function estimateCompletionTime(tier: GlacierRestoreTier): number {
  return COMPLETION_TIME_MINUTES[tier];
}

/**
 * Get default restore duration in days
 * 
 * @param tier - Restore tier
 * @returns Default duration in days
 */
export function getDefaultRestoreDays(tier: GlacierRestoreTier): number {
  return DEFAULT_RESTORE_DAYS[tier];
}

/**
 * Initiate restore request
 * 
 * In production: Uses AWS SDK RestoreObjectCommand
 * In development (MinIO): Simulates restore and returns fake restore ID
 * 
 * @param region - Region
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param tier - Restore tier
 * @param days - Days to keep restored (default based on tier)
 * @returns Restore request ID (or fake ID in dev)
 */
export async function initiateRestore(
  region: Region,
  bucket: string,
  key: string,
  tier: GlacierRestoreTier,
  days?: number
): Promise<string> {
  const config = loadConfig();
  const client = getS3Client();
  const restoreDays = days || DEFAULT_RESTORE_DAYS[tier];

  // Map tier to AWS Glacier tier
  const glacierTier = tier === 'EXPEDITED' ? 'Expedited' : tier === 'STANDARD' ? 'Standard' : 'Bulk';

  // In development (MinIO), simulate restore
  if (config.s3Endpoint) {
    logger.info(
      { region, bucket, key, tier, days: restoreDays },
      'Glacier restore: Simulating restore (MinIO development mode)'
    );
    
    // Return fake restore ID (format: "fake-restore-{timestamp}-{random}")
    const fakeId = `fake-restore-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Store simulation state (in-memory for dev)
    // In a real implementation, you might want to store this in Redis or a DB
    // For now, we'll just return the ID and checkRestoreStatus will simulate completion
    
    return fakeId;
  }

  // Production: Use AWS SDK
  try {
    const command = new RestoreObjectCommand({
      Bucket: bucket,
      Key: key,
      RestoreRequest: {
        Days: restoreDays,
        GlacierJobParameters: {
          Tier: glacierTier,
        },
      },
    });

    await client.send(command);

    // AWS doesn't return a restore ID directly, but we can construct one
    // The restore status is tracked via HeadObject Restore header
    // For tracking purposes, we'll use a combination of bucket/key/timestamp
    const restoreId = `restore-${bucket}-${key.replace(/\//g, '-')}-${Date.now()}`;

    logger.info(
      { region, bucket, key, tier, days: restoreDays, restoreId },
      'Glacier restore: Initiated restore request'
    );

    return restoreId;
  } catch (error: any) {
    logger.error({ err: error, region, bucket, key, tier }, 'Glacier restore: Failed to initiate restore');
    throw new Error(`Failed to initiate restore: ${error.message}`);
  }
}

/**
 * Check restore status
 * 
 * In production: Uses HeadObjectCommand and parses Restore header
 * In development (MinIO): Simulates completion after ~2 minutes
 * 
 * @param region - Region
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param restoreId - Restore request ID (for tracking)
 * @returns Status: 'in-progress' | 'completed' | 'not-restored'
 */
export async function checkRestoreStatus(
  region: Region,
  bucket: string,
  key: string,
  restoreId: string
): Promise<'in-progress' | 'completed' | 'not-restored'> {
  const config = loadConfig();
  const client = getS3Client();

  // In development (MinIO), simulate restore completion
  if (config.s3Endpoint) {
    // Extract timestamp from fake restore ID
    const match = restoreId.match(/fake-restore-(\d+)-/);
    if (match) {
      const initiatedAt = parseInt(match[1], 10);
      const elapsedMinutes = (Date.now() - initiatedAt) / (1000 * 60);
      
      // Simulate completion after 2 minutes
      if (elapsedMinutes >= 2) {
        logger.debug(
          { region, bucket, key, restoreId, elapsedMinutes },
          'Glacier restore: Simulated restore completed (MinIO)'
        );
        return 'completed';
      } else {
        logger.debug(
          { region, bucket, key, restoreId, elapsedMinutes },
          'Glacier restore: Simulated restore in progress (MinIO)'
        );
        return 'in-progress';
      }
    }
    
    // If we can't parse the fake ID, assume not restored
    return 'not-restored';
  }

  // Production: Check AWS restore status via HeadObject
  try {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command);
    const restoreHeader = response.Restore;

    if (!restoreHeader) {
      return 'not-restored';
    }

    // Parse Restore header format: "ongoing-request=\"true\"" or "ongoing-request=\"false\", expiry-date=\"...\""
    if (restoreHeader.includes('ongoing-request="true"')) {
      return 'in-progress';
    }

    if (restoreHeader.includes('ongoing-request="false"')) {
      return 'completed';
    }

    // Default to not restored if we can't parse
    return 'not-restored';
  } catch (error: any) {
    logger.error({ err: error, region, bucket, key }, 'Glacier restore: Failed to check restore status');
    
    // If object doesn't exist, return not-restored
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return 'not-restored';
    }
    
    throw new Error(`Failed to check restore status: ${error.message}`);
  }
}

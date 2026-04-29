/**
 * Restore Initiator Job
 * 
 * Runs every 5 minutes to process APPROVED restore requests.
 * Initiates AWS S3 restore operations and updates status to INITIATING -> IN_PROGRESS.
 */

import { getLogger } from '../lib/logger.js';
import { getRegionRouter } from '../lib/regionRouter.js';
import { getS3Bucket, type Region, loadConfig } from '../lib/config.js';
import { S3Client, RestoreObjectCommand } from '@aws-sdk/client-s3';

const logger = getLogger();

// Default restore duration (days)
const DEFAULT_RESTORE_DAYS: Record<string, number> = {
  EXPEDITED: 1,
  STANDARD: 7,
  BULK: 7,
};

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

  if (config.s3Endpoint) {
    clientConfig.endpoint = config.s3Endpoint;
    clientConfig.forcePathStyle = config.s3ForcePathStyle;
  }

  return new S3Client(clientConfig);
}

async function initiateRestore(
  region: Region,
  bucket: string,
  key: string,
  tier: string,
  days?: number
): Promise<string> {
  const config = loadConfig();
  const client = getS3Client();
  const restoreDays = days || DEFAULT_RESTORE_DAYS[tier] || 7;
  const glacierTier = tier === 'EXPEDITED' ? 'Expedited' : tier === 'STANDARD' ? 'Standard' : 'Bulk';

  // In development (MinIO), simulate restore
  if (config.s3Endpoint) {
    logger.info({ region, bucket, key, tier, days: restoreDays }, 'Glacier restore: Simulating restore (MinIO)');
    return `fake-restore-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  // Production: Use AWS SDK
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
  return `restore-${bucket}-${key.replace(/\//g, '-')}-${Date.now()}`;
}

export const restoreInitiatorJob = {
  name: 'restore-initiator',
  description: 'Initiate approved Glacier restore requests',

  async processRegion(region: Region): Promise<void> {
    const prisma = getRegionRouter().getPrisma(region);
    const bucket = getS3Bucket(region);

    logger.info({ region }, 'Restore initiator job: Starting');

    // Get APPROVED restore requests
    const approvedRequests = await prisma.glacierRestoreRequest.findMany({
      where: {
        status: 'APPROVED',
        region,
      },
      include: {
        archive: true,
      },
      take: 10, // Process up to 10 at a time
    });

    logger.info({ region, count: approvedRequests.length }, 'Restore initiator job: Found approved requests');

    for (const request of approvedRequests) {
      try {
        // Update status to INITIATING
        await prisma.glacierRestoreRequest.update({
          where: { id: request.id },
          data: {
            status: 'INITIATING',
            initiatedAt: new Date(),
            initiatedBy: 'SYSTEM',
          },
        });

        // Initiate restore
        const restoreId = await initiateRestore(
          region,
          bucket,
          request.archive.s3Key,
          request.tier,
          request.days || undefined
        );

        // Update status to IN_PROGRESS with restore ID
        await prisma.glacierRestoreRequest.update({
          where: { id: request.id },
          data: {
            status: 'IN_PROGRESS',
            s3RestoreId: restoreId,
          },
        });

        logger.info(
          { region, requestId: request.id, restoreId, archiveId: request.archiveId },
          'Restore initiator job: Initiated restore'
        );
      } catch (error: any) {
        logger.error(
          { err: error, region, requestId: request.id },
          'Restore initiator job: Failed to initiate restore'
        );

        // Mark as FAILED
        await prisma.glacierRestoreRequest.update({
          where: { id: request.id },
          data: {
            status: 'FAILED',
            errorMessage: error.message,
          },
        });
      }
    }
  },
};

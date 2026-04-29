/**
 * Restore Status Checker Job
 * 
 * Runs every 15 minutes to check status of IN_PROGRESS restore requests.
 * Updates status to COMPLETED when restore is ready, sets expiresAt, and updates ArchiveObject.
 */

import { getLogger } from '../lib/logger.js';
import { getRegionRouter } from '../lib/regionRouter.js';
import { getS3Bucket, type Region, loadConfig } from '../lib/config.js';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const logger = getLogger();

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

async function checkRestoreStatus(
  region: Region,
  bucket: string,
  key: string,
  restoreId: string
): Promise<'in-progress' | 'completed' | 'not-restored'> {
  const config = loadConfig();
  const client = getS3Client();

  // In development (MinIO), simulate restore completion
  if (config.s3Endpoint) {
    const match = restoreId.match(/fake-restore-(\d+)-/);
    if (match) {
      const initiatedAt = parseInt(match[1], 10);
      const elapsedMinutes = (Date.now() - initiatedAt) / (1000 * 60);
      if (elapsedMinutes >= 2) {
        return 'completed';
      }
      return 'in-progress';
    }
    return 'not-restored';
  }

  // Production: Check AWS restore status
  try {
    const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
    const response = await client.send(command);
    const restoreHeader = response.Restore;

    if (!restoreHeader) return 'not-restored';
    if (restoreHeader.includes('ongoing-request="true"')) return 'in-progress';
    if (restoreHeader.includes('ongoing-request="false"')) return 'completed';
    return 'not-restored';
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return 'not-restored';
    }
    throw error;
  }
}

export const restoreStatusCheckerJob = {
  name: 'restore-status-checker',
  description: 'Check status of in-progress Glacier restore requests',

  async processRegion(region: Region): Promise<void> {
    const prisma = getRegionRouter().getPrisma(region);
    const bucket = getS3Bucket(region);

    logger.info({ region }, 'Restore status checker job: Starting');

    // Get IN_PROGRESS restore requests
    const inProgressRequests = await prisma.glacierRestoreRequest.findMany({
      where: {
        status: 'IN_PROGRESS',
        region,
      },
      include: {
        archive: true,
      },
    });

    logger.info({ region, count: inProgressRequests.length }, 'Restore status checker job: Found in-progress requests');

    for (const request of inProgressRequests) {
      try {
        if (!request.s3RestoreId) {
          logger.warn({ region, requestId: request.id }, 'Restore status checker: Missing s3RestoreId');
          continue;
        }

        // Check restore status
        const status = await checkRestoreStatus(
          region,
          bucket,
          request.archive.s3Key,
          request.s3RestoreId
        );

        if (status === 'completed') {
          // Calculate expiration date (days after completion)
          const restoreDays = request.days || 7;
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + restoreDays);

          // Update restore request
          await prisma.glacierRestoreRequest.update({
            where: { id: request.id },
            data: {
              status: 'COMPLETED',
              completedAt: new Date(),
              expiresAt,
            },
          });

          // Update ArchiveObject to mark as restored
          await prisma.archiveObject.update({
            where: { id: request.archiveId },
            data: {
              isColdArchived: false,
              restoredUntil: expiresAt,
            },
          });

          logger.info(
            { region, requestId: request.id, archiveId: request.archiveId, expiresAt },
            'Restore status checker job: Restore completed'
          );
        } else if (status === 'not-restored') {
          // This shouldn't happen for IN_PROGRESS requests, but handle it
          logger.warn(
            { region, requestId: request.id },
            'Restore status checker: Restore not found (may have failed)'
          );

          await prisma.glacierRestoreRequest.update({
            where: { id: request.id },
            data: {
              status: 'FAILED',
              errorMessage: 'Restore not found in S3',
            },
          });
        }
        // If status is 'in-progress', do nothing (still waiting)
      } catch (error: any) {
        logger.error(
          { err: error, region, requestId: request.id },
          'Restore status checker job: Failed to check restore status'
        );
      }
    }
  },
};

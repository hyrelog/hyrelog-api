/**
 * Archival Job
 * 
 * Daily job that archives events marked as archivalCandidate=true.
 * Groups events by UTC day, creates gzipped JSONL files, uploads to S3.
 * Plan-based: uses Company.plan configuration.
 */

import { getLogger } from '../lib/logger.js';
import { getRegionRouter } from '../lib/regionRouter.js';
import { loadCompanyWithPlan, getEffectivePlanConfig } from '../lib/planHelpers.js';
import { getS3Bucket } from '../lib/config.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { createGzip } from 'zlib';
import { loadConfig, type Region } from '../lib/config.js';

const logger = getLogger();

export const archivalJob = {
  name: 'archival',
  description: 'Archive events to S3 as gzipped JSONL files',

  async processRegion(region: Region): Promise<void> {
    const prisma = getRegionRouter().getPrisma(region);
    const now = new Date();

    logger.info({ region }, 'Archival job: Starting');

    // Get all companies in this region
    const companies = await prisma.company.findMany({
      where: { dataRegion: region },
      include: {
        plan: true,
      },
    });

    logger.info({ region, companyCount: companies.length }, 'Archival job: Found companies');

    for (const company of companies) {
      try {
        // Get events ready for archival (grouped by UTC day)
        const eventsToArchive = await prisma.auditEvent.findMany({
          where: {
            companyId: company.id,
            archivalCandidate: true,
            archived: false,
          },
          orderBy: { timestamp: 'asc' },
        });

        if (eventsToArchive.length === 0) {
          continue;
        }

        // Group events by UTC date (YYYY-MM-DD)
        const eventsByDate = new Map<string, typeof eventsToArchive>();

        for (const event of eventsToArchive) {
          const dateStr = event.timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
          if (!eventsByDate.has(dateStr)) {
            eventsByDate.set(dateStr, []);
          }
          eventsByDate.get(dateStr)!.push(event);
        }

        // Process each date group
        for (const [dateStr, events] of eventsByDate.entries()) {
          try {
            // Create JSONL content (one event per line)
            const jsonlLines: string[] = [];
            for (const event of events) {
              const eventJson = JSON.stringify({
                id: event.id,
                companyId: event.companyId,
                workspaceId: event.workspaceId,
                projectId: event.projectId,
                timestamp: event.timestamp.toISOString(),
                category: event.category,
                action: event.action,
                actorId: event.actorId,
                actorEmail: event.actorEmail,
                actorRole: event.actorRole,
                resourceType: event.resourceType,
                resourceId: event.resourceId,
                metadata: event.metadata,
                traceId: event.traceId,
                ipAddress: event.ipAddress,
                geo: event.geo,
                userAgent: event.userAgent,
                prevHash: event.prevHash,
                hash: event.hash,
                idempotencyHash: event.idempotencyHash,
              });
              jsonlLines.push(eventJson);
            }

            const jsonlContent = jsonlLines.join('\n');
            const jsonlBytes = Buffer.from(jsonlContent, 'utf-8');

            // Compress bytes to get gzipped version (for SHA-256 computation)
            const gzip = createGzip();
            const gzipChunks: Buffer[] = [];
            
            await new Promise<void>((resolve, reject) => {
              gzip.on('data', (chunk) => gzipChunks.push(chunk));
              gzip.on('end', resolve);
              gzip.on('error', reject);
              gzip.write(jsonlBytes);
              gzip.end();
            });

            const gzippedBytes = Buffer.concat(gzipChunks);

            // Compute SHA-256 of gzipped file (must match what's stored in S3)
            const sha256 = createHash('sha256').update(gzippedBytes).digest('hex');

            // Upload gzipped bytes directly to S3 (already compressed)
            const s3Key = `archives/${company.id}/${dateStr.split('-')[0]}/${dateStr.split('-')[1]}/${dateStr.split('-')[2]}/events.jsonl.gz`;
            const config = loadConfig();
            const bucket = getS3Bucket(region);
            
            // Create S3 client
            const clientConfig: any = {
              region: config.s3Region,
              ...(config.s3Endpoint && {
                endpoint: config.s3Endpoint,
                forcePathStyle: config.s3ForcePathStyle,
              }),
            };
            if (config.s3AccessKeyId && config.s3SecretAccessKey) {
              clientConfig.credentials = {
                accessKeyId: config.s3AccessKeyId,
                secretAccessKey: config.s3SecretAccessKey,
              };
            }
            const s3Client = new S3Client(clientConfig);

            // Upload gzipped bytes
            await s3Client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: s3Key,
                Body: gzippedBytes,
                ContentType: 'application/gzip',
                ContentEncoding: 'gzip',
              })
            );

            // Create ArchiveObject record (only after successful upload)
            // Note: gzSizeBytes and rowCount are Int in Prisma schema, not BigInt
            const archiveObject = await prisma.archiveObject.create({
              data: {
                companyId: company.id,
                workspaceId: null, // Could be workspace-specific later
                region: region,
                date: dateStr,
                s3Key,
                gzSizeBytes: Number(gzippedBytes.length), // Convert to Int
                sha256,
                rowCount: events.length, // Already a number
              },
            });

            // Mark events as archived
            const eventIds = events.map((e) => e.id);
            await prisma.auditEvent.updateMany({
              where: {
                id: { in: eventIds },
              },
              data: {
                archived: true,
                archivedAt: now,
                archivalCandidate: false, // Clear flag
              },
            });

            logger.info(
              {
                region,
                companyId: company.id,
                date: dateStr,
                archiveObjectId: archiveObject.id,
                eventCount: events.length,
                s3Key,
                sizeBytes: gzippedBytes.length,
              },
              'Archival job: Archived events for date'
            );
          } catch (error: any) {
            logger.error(
              { err: error, region, companyId: company.id, date: dateStr },
              'Archival job: Error archiving date group'
            );
          }
        }
      } catch (error: any) {
        logger.error(
          { err: error, region, companyId: company.id },
          'Archival job: Error processing company'
        );
      }
    }

    logger.info({ region }, 'Archival job: Completed');
  },
};

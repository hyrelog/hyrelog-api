/**
 * Object Store Client (S3/MinIO)
 * 
 * Provides typed helpers for S3/MinIO operations with region-aware bucket resolution.
 * Supports both AWS S3 and MinIO (local development).
 */

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { createGzip } from 'zlib';
import { loadConfig, getS3Bucket, type Region } from './config.js';

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
 * Put gzipped bytes to object store
 * 
 * @param region - Region to determine bucket
 * @param key - S3 key (path)
 * @param bytes - Raw bytes to compress and upload
 * @param contentType - Content type (default: application/gzip)
 * @returns S3 key and size
 */
export async function putGzipBytes(
  region: Region,
  key: string,
  bytes: Buffer | Uint8Array,
  contentType: string = 'application/gzip'
): Promise<{ key: string; sizeBytes: number }> {
  const client = getS3Client();
  const bucket = getS3Bucket(region);
  const config = loadConfig();

  // Compress bytes using gzip
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  
  await new Promise<void>((resolve, reject) => {
    gzip.on('data', (chunk) => chunks.push(chunk));
    gzip.on('end', resolve);
    gzip.on('error', reject);
    
    gzip.write(Buffer.from(bytes));
    gzip.end();
  });

  const gzippedBytes = Buffer.concat(chunks);

  // Upload to S3
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: gzippedBytes,
    ContentType: contentType,
    ContentEncoding: 'gzip',
  });

  await client.send(command);

  return {
    key,
    sizeBytes: gzippedBytes.length,
  };
}

/**
 * Get object stream from object store
 * 
 * @param region - Region to determine bucket
 * @param key - S3 key (path)
 * @returns Readable stream
 */
export async function getObjectStream(region: Region, key: string): Promise<Readable> {
  const client = getS3Client();
  const bucket = getS3Bucket(region);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw new Error(`Object not found: ${key} in bucket ${bucket}`);
  }

  // Convert AWS SDK stream to Node.js Readable stream
  if (response.Body instanceof Readable) {
    return response.Body;
  }

  // Handle ReadableStream (from fetch API)
  if (response.Body && typeof (response.Body as any).getReader === 'function') {
    const reader = (response.Body as ReadableStream).getReader();
    const stream = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
          } else {
            this.push(Buffer.from(value));
          }
        } catch (error) {
          this.destroy(error as Error);
        }
      },
    });
    return stream;
  }

  // Fallback: convert to buffer then stream
  const chunks: Uint8Array[] = [];
  if (response.Body && typeof (response.Body as any)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return Readable.from(buffer);
  }

  throw new Error(`Unsupported stream type for key: ${key}`);
}

/**
 * Get entire object as buffer from object store
 * 
 * @param region - Region to determine bucket
 * @param key - S3 key (path)
 * @returns Buffer with object contents
 */
export async function getObjectBuffer(region: Region, key: string): Promise<Buffer> {
  const client = getS3Client();
  const bucket = getS3Bucket(region);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw new Error(`Object not found: ${key} in bucket ${bucket}`);
  }

  // Collect all chunks into a buffer
  const chunks: Uint8Array[] = [];
  
  if (response.Body instanceof Readable) {
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
  } else if (response.Body && typeof (response.Body as any).getReader === 'function') {
    const reader = (response.Body as ReadableStream).getReader();
    let done = false;
    while (!done) {
      const readResult = await reader.read();
      done = readResult.done;
      if (!done) {
        chunks.push(readResult.value);
      }
    }
  } else if (response.Body && typeof (response.Body as any)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
  } else {
    throw new Error(`Unsupported stream type for key: ${key}`);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Head object (get metadata without downloading)
 * 
 * @param region - Region to determine bucket
 * @param key - S3 key (path)
 * @returns Object metadata or null if not found
 */
export async function headObject(
  region: Region,
  key: string
): Promise<{ size: number; lastModified: Date; etag?: string } | null> {
  const client = getS3Client();
  const bucket = getS3Bucket(region);

  try {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command);

    return {
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
      etag: response.ETag,
    };
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}


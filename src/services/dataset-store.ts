import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DIMENSION_PROBE_BYTES, readImageDimensions, type ImageDimensions } from '../models/image-dimensions';

/**
 * S3 access for the `datasets/` and `org-models/` prefixes (the impure side
 * of src/models/keys.ts). One client per process; the bucket comes from the
 * handler's environment.
 */

const s3 = new S3Client({});

export function datasetS3(): S3Client {
  return s3;
}

export const DATASET_URL_EXPIRES_SECONDS = 15 * 60;

export interface ProbedImage extends ImageDimensions {
  bytes: number;
  sha256: string;
  contentType: string | null;
}

/**
 * One GET: the whole object streams through sha256 while the first
 * `DIMENSION_PROBE_BYTES` are kept for the header parse. Returns null when the
 * object is missing or is not a JPEG or PNG (the caller deletes it).
 */
export async function probeImageObject(bucket: string, key: string): Promise<ProbedImage | null> {
  let res;
  try {
    res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
  if (!res.Body) return null;
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headBytes = 0;
  let bytes = 0;
  for await (const chunk of res.Body as Readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    bytes += buf.length;
    if (headBytes < DIMENSION_PROBE_BYTES) {
      head.push(buf);
      headBytes += buf.length;
    }
  }
  const dims = readImageDimensions(Buffer.concat(head).subarray(0, DIMENSION_PROBE_BYTES));
  if (!dims) return null;
  return { ...dims, bytes, sha256: hash.digest('hex'), contentType: res.ContentType ?? null };
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return false;
    throw err;
  }
}

export async function putJsonObject(bucket: string, key: string, value: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: 'application/json',
    }),
  );
}

export async function getJsonObject(bucket: string, key: string): Promise<unknown | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

export async function putBytesObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function copyObject(bucket: string, fromKey: string, toKey: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `/${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
      Key: toKey,
    }),
  );
}

/** Runs `fn` over `items` with at most `limit` in flight (S3 fan-out, never the DB). */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function deleteObjects(bucket: string, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

/**
 * Deletes everything under `prefix`, at most `maxObjects` objects (a handler
 * budget; the caller reports `drained: false` past it and the bucket
 * lifecycle never touches these prefixes, so what remains is visible in the
 * response and can be re-run).
 */
export async function deletePrefix(bucket: string, prefix: string, maxObjects = 10_000): Promise<{ deleted: number; drained: boolean }> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
    );
    const keys = (res.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
    if (keys.length > 0) {
      await deleteObjects(bucket, keys);
      deleted += keys.length;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    if (deleted >= maxObjects && token) return { deleted, drained: false };
  } while (token);
  return { deleted, drained: true };
}

export async function presignGet(
  bucket: string,
  key: string,
  opts: { expiresIn?: number; downloadName?: string } = {},
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(opts.downloadName ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName}"` } : {}),
    }),
    { expiresIn: opts.expiresIn ?? DATASET_URL_EXPIRES_SECONDS },
  );
}

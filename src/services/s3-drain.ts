import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

/**
 * Delete every object under a prefix, one ListObjectsV2 page (1000 keys) per
 * round trip. Shared by the device teardown (bounded by a page budget so a
 * DELETE stays inside its Lambda timeout), the device purge job (unbounded,
 * it has a 15-minute budget and a cursor) and the workflow-run finalizer (a
 * run whose row is gone must not leave its artifacts behind).
 *
 * `olderThan` keeps objects the device wrote after a purge was requested: a
 * recorder still uploading into the same prefix is not the history the caller
 * asked to remove. `token` resumes a listing across invocations.
 */
export interface DrainOptions {
  /** Pages this call may consume; decremented in place. Omit for unbounded. */
  budget?: { pages: number };
  /** Delete only objects whose LastModified is strictly before this instant. */
  olderThan?: Date;
  /** ListObjectsV2 continuation token from a previous, unfinished drain. */
  token?: string;
}

export interface DrainResult {
  /** True when the listing reached its end (nothing left under the prefix, or nothing older). */
  complete: boolean;
  /** Objects handed to DeleteObjects (best-effort; per-key errors are logged). */
  deleted: number;
  /** Where to resume when `complete` is false. */
  token?: string;
}

const s3 = new S3Client({});

export async function drainPrefix(
  bucket: string,
  prefix: string,
  options: DrainOptions = {},
): Promise<DrainResult> {
  let token = options.token;
  let deleted = 0;
  const budget = options.budget;
  while (!budget || budget.pages > 0) {
    if (budget) budget.pages -= 1;
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).flatMap((o) => {
      if (!o.Key) return [];
      if (options.olderThan && o.LastModified && o.LastModified >= options.olderThan) return [];
      return [o.Key];
    });
    if (keys.length) {
      const out = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      deleted += keys.length - (out.Errors?.length ?? 0);
      for (const e of out.Errors ?? []) {
        console.error('s3-drain: delete object failed', { key: e.Key, code: e.Code });
      }
    }
    if (!page.IsTruncated) return { complete: true, deleted };
    token = page.NextContinuationToken;
  }
  return { complete: false, deleted, token };
}

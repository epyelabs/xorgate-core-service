import type { EventBridgeEvent } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import {
  buildSegmentRows,
  parseMediaSegmentObjectKey,
  sidecarKeyFor,
  sidecarMatchesKey,
  videoSidecarSchema,
} from '../services/media-segments';

// Shape of the S3 "Object Created" event delivered via EventBridge (same as media-finalize).
interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number };
}

const s3 = new S3Client({});

/** Thrown inside the transaction to roll back when another delivery won the race. */
class AlreadyIngested extends Error {}

/**
 * Device video-segment ingest (offline recording plan, Phase 4). EventBridge
 * rule on S3 "Object Created" under media-sessions/v1/ → this Lambda. The
 * device uploads sidecar-first, then the mp4 — only the .mp4 event drives
 * ingest (sidecar events return immediately), and the sidecar GET can
 * therefore never race the mp4's own upload.
 *
 * Populates the (previously unused) media_sessions/media_segments tables (D5):
 * the first segment of a session creates the session row (id = the
 * device-minted uuidv7); every segment rolls started_at/ended_at/
 * last_segment_at forward. Session close is advisory and happens later in the
 * sweeper (services/media-sessions.ts) — there is no explicit end signal.
 *
 * Error semantics (async EventBridge invoke, retries + on-failure DLQ), same
 * split as telemetry-batch-ingest:
 *  - Permanent (bad key, unknown device, invalid sidecar, identity mismatch)
 *    → log + return (drop; a retry can never succeed).
 *  - Transient (S3/DB failure, sidecar object missing — should not happen
 *    given sidecar-first ordering) → throw, so Lambda retry / DLQ recover it.
 *
 * Idempotency: media_segments' unique s3_key index. The segment insert is
 * ON CONFLICT DO NOTHING inside the same tx as the session upsert/rollup; a
 * duplicate delivery inserts nothing and rolls the session update back.
 *
 * Deferred hook (do not build yet): a `session_completed` workflow trigger
 * would fire from the sweeper's close transition, mirroring `recording_saved`
 * in media-finalize.ts → workflow-triggers.ts.
 */
export const handler = async (
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>,
): Promise<void> => {
  const bucket = event.detail?.bucket?.name;
  const key = event.detail?.object?.key;
  if (!bucket || !key) {
    console.warn('media-segment-ingest: event missing bucket/key', { id: event.id });
    return;
  }

  const parsedKey = parseMediaSegmentObjectKey(key);
  if (!parsedKey) {
    console.error('media-segment-ingest: unrecognized key shape, dropping', { key });
    return;
  }
  // Sidecars are fetched alongside their mp4; their own Object Created events
  // carry no extra work (the rule filters on prefix only, like media-finalize).
  if (parsedKey.ext === 'json') return;
  const { deviceId, sessionId, streamKey, seq } = parsedKey;

  // Fast-path dedupe (cheap read); the transactional unique index is the real guard.
  const existing = await db.query.mediaSegments.findFirst({
    where: eq(schema.mediaSegments.s3Key, key),
    columns: { id: true },
  });
  if (existing) {
    console.log('media-segment-ingest: already ingested, skipping', { key });
    return;
  }

  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, deviceId),
    columns: { id: true },
  });
  if (!device) {
    console.error('media-segment-ingest: unknown device, dropping', { key, deviceId });
    return;
  }

  // Sidecar-first upload ordering guarantees this object exists; a miss is a
  // manual/foreign PUT or an S3 hiccup — throw and let retries/DLQ sort it out.
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: sidecarKeyFor(key) }),
  );
  let sidecarRaw: unknown;
  try {
    sidecarRaw = JSON.parse(await obj.Body!.transformToString('utf8'));
  } catch (err) {
    console.error('media-segment-ingest: sidecar is not JSON, dropping', { key, err });
    return;
  }
  const sidecar = videoSidecarSchema.safeParse(sidecarRaw);
  if (!sidecar.success) {
    console.error('media-segment-ingest: sidecar failed validation, dropping', {
      key,
      issues: sidecar.error.issues.slice(0, 5),
    });
    return;
  }
  if (!sidecarMatchesKey(parsedKey, sidecar.data)) {
    // The key prefix is IAM-scoped ground truth; a contradicting sidecar means
    // a mis-built file. Refuse rather than misattribute footage.
    console.error('media-segment-ingest: sidecar identity mismatches key, dropping', { key });
    return;
  }

  const { session, segment, segmentEnd } = buildSegmentRows(parsedKey, key, sidecar.data);

  try {
    await db.transaction(async (tx) => {
      // Session row first (media_segments.session_id FK). Sequential statements
      // only — RDS Data API forbids interleaving inside a transaction.
      await tx.insert(schema.mediaSessions).values(session).onConflictDoNothing();
      const inserted = await tx
        .insert(schema.mediaSegments)
        .values(segment)
        .onConflictDoNothing()
        .returning({ id: schema.mediaSegments.id });
      if (inserted.length === 0) throw new AlreadyIngested(key);
      // Roll the session window forward. Segments normally arrive oldest-first
      // (uploader ordering) but redeliveries/crash recovery can reorder —
      // least/greatest keeps the window correct regardless. Reopen a session
      // the sweeper closed early if a straggler arrives (status back to open;
      // the sweeper will re-close it after the window).
      await tx
        .update(schema.mediaSessions)
        .set({
          startedAt: sql`least(${schema.mediaSessions.startedAt}, ${tsParam(segment.startTs.toISOString())})`,
          endedAt: sql`greatest(coalesce(${schema.mediaSessions.endedAt}, 'epoch'::timestamptz), ${tsParam(segmentEnd.toISOString())})`,
          lastSegmentAt: sql`now()`,
          status: 'open',
        })
        .where(eq(schema.mediaSessions.id, sessionId));
    });
  } catch (err) {
    if (err instanceof AlreadyIngested) {
      console.log('media-segment-ingest: concurrent duplicate delivery, rolled back', { key });
      return;
    }
    throw err; // transient DB failure → Lambda retry / DLQ
  }

  console.log('media-segment-ingest: ingested', {
    key,
    deviceId,
    streamKey,
    sessionId,
    seq,
    startTs: segment.startTs,
    durationMs: segment.durationMs,
    sizeBytes: segment.sizeBytes,
    finalized: segment.finalized,
  });
};

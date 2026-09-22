import { gunzipSync } from 'node:zlib';
import type { EventBridgeEvent } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_FUTURE_MS,
  isTelemetryArtifactKey,
  parseSegment,
  parseTelemetryObjectKey,
} from '../services/telemetry-batch';
import { ensureSegmentNormalized, indexSegment } from '../services/telemetry-sessions';

// Shape of the S3 "Object Created" event delivered via EventBridge (same as media-finalize).
interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number };
}

const s3 = new S3Client({});

/** Rows per INSERT: 6 params/row keeps each Data API statement comfortably sized. */
const INSERT_BATCH_ROWS = 200;

const maxAgeMs = (): number => {
  const days = Number(process.env.TELEMETRY_BATCH_MAX_AGE_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_MAX_AGE_MS;
};

/** Thrown inside the transaction to roll back when another delivery won the race. */
class AlreadyIngested extends Error {}

/**
 * Batch telemetry ingest (offline recording plan, Phase 2). EventBridge rule on
 * S3 "Object Created" under telemetry/v1/ → this Lambda. The device uploaded a
 * closed recording segment (gzipped JSONL); we parse it and insert
 * `telemetry_readings` rows — history only, D4: **never** `device_latest`
 * (bulk replay of old samples must not clobber live values; the live 1 Hz path
 * remains the realtime plane).
 *
 * Error semantics (async EventBridge invoke, retries + on-failure DLQ):
 *  - Permanent (bad key, unknown device, unparseable gzip, deviceId mismatch)
 *    → log + return (drop; a retry can never succeed).
 *  - Transient (S3/DB failure) → throw, so Lambda retry / DLQ recover it.
 *
 * Idempotency: `telemetry_ingest_log` (PK s3_key). The row inserts in the SAME
 * transaction as the readings, so a crash mid-ingest leaves no log row and the
 * redelivery re-ingests atomically; a duplicate delivery hits the PK and rolls
 * back its readings. Age-window rejection (partition safety) skips lines, not
 * files — see services/telemetry-batch.ts.
 *
 * Session index (telemetry-session-artifacts plan, Phase 1): the same
 * transaction also upserts `telemetry_sessions` / `telemetry_segments`
 * (services/telemetry-sessions.ts indexSegment), including for a file whose
 * every line is outside the partition window: the artifact builder reads S3,
 * not the window, and a 91-day-old segment is still part of its session.
 * After the commit the object's metadata is normalised (Content-Encoding:
 * gzip, README Q14) with a CopyObject onto itself; that re-fires this event
 * once, and the fast-path dedupe below absorbs it (and re-checks the header,
 * because a device uploader retry can re-PUT a key AFTER normalisation).
 */
export const handler = async (
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>,
): Promise<void> => {
  const bucket = event.detail?.bucket?.name;
  const key = event.detail?.object?.key;
  if (!bucket || !key) {
    console.warn('telemetry-batch-ingest: event missing bucket/key', { id: event.id });
    return;
  }

  if (isTelemetryArtifactKey(key)) {
    // Our own overview.v1.json.gz (built by the sweeper) shares the prefix
    // the rule matches on. Not a segment; nothing to do.
    console.log('telemetry-batch-ingest: artifact object, ignoring', { key });
    return;
  }
  const parsedKey = parseTelemetryObjectKey(key);
  if (!parsedKey) {
    console.error('telemetry-batch-ingest: unrecognized key shape, dropping', { key });
    return;
  }
  const { deviceId, sessionId } = parsedKey;

  // Fast-path dedupe (cheap read); the transactional PK below is the real guard.
  const existing = await db.query.telemetryIngestLog.findFirst({
    where: eq(schema.telemetryIngestLog.s3Key, key),
    columns: { s3Key: true },
  });
  if (existing) {
    console.log('telemetry-batch-ingest: already ingested, skipping', { key });
    // The only path that sees a re-PUT after normalisation (and our own
    // re-fired copy event): HEAD, and re-copy only if the header is missing.
    const normalized = await ensureSegmentNormalized(bucket, key);
    if (normalized !== 'already') {
      console.log('telemetry-batch-ingest: normalised on duplicate delivery', { key, normalized });
    }
    return;
  }

  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, deviceId),
    columns: { id: true },
  });
  if (!device) {
    console.error('telemetry-batch-ingest: unknown device, dropping', { key, deviceId });
    return;
  }

  // Fetch + gunzip. S3 failures throw (transient); a corrupt gzip is permanent.
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const gz = Buffer.from(await obj.Body!.transformToByteArray());
  const objectBytes = event.detail.object.size ?? obj.ContentLength ?? gz.length;
  let text: string;
  try {
    text = gunzipSync(gz).toString('utf8');
  } catch (err) {
    console.error('telemetry-batch-ingest: gunzip failed, dropping', { key, err });
    return;
  }

  const parsed = parseSegment(text, {
    deviceId,
    now: Date.now(),
    maxAgeMs: maxAgeMs(),
    maxFutureMs: DEFAULT_MAX_FUTURE_MS,
  });
  if (parsed.deviceIdMismatch) {
    // The key prefix is IAM-scoped ground truth; a contradicting header means a
    // mis-built file. Refuse rather than attribute data to the wrong device.
    console.error('telemetry-batch-ingest: header deviceId mismatches key, dropping', { key });
    return;
  }

  const skipped = parsed.skippedInvalid + parsed.skippedAge;
  const indexInput = {
    s3Key: key,
    deviceId,
    sessionId,
    seq: parsedKey.seq,
    header: parsed.header,
    firstTs: parsed.firstTs,
    lastTs: parsed.lastTs,
    samples: parsed.sampleLines,
    bytes: objectBytes,
    keyStartTsMs: parsedKey.startTsMs,
  };

  try {
    await db.transaction(async (tx) => {
      // Sequential batches — RDS Data API forbids interleaving inside a
      // transaction (no Promise.all here, per the driver's known limits).
      // A file with nothing insertable (every line outside the partition
      // window) skips the readings but is STILL indexed and logged.
      for (let i = 0; i < parsed.rows.length; i += INSERT_BATCH_ROWS) {
        await tx
          .insert(schema.telemetryReadings)
          .values(parsed.rows.slice(i, i + INSERT_BATCH_ROWS));
      }
      await indexSegment(tx, indexInput);
      const logged = await tx
        .insert(schema.telemetryIngestLog)
        .values({
          s3Key: key,
          deviceId,
          sessionId,
          rowsInserted: parsed.rows.length,
          linesSkipped: skipped,
        })
        .onConflictDoNothing()
        .returning({ s3Key: schema.telemetryIngestLog.s3Key });
      if (logged.length === 0) throw new AlreadyIngested(key);
    });
  } catch (err) {
    if (err instanceof AlreadyIngested) {
      console.log('telemetry-batch-ingest: concurrent duplicate delivery, rolled back', { key });
      return;
    }
    throw err; // transient DB failure → Lambda retry / DLQ
  }

  if (parsed.rows.length === 0) {
    console.warn('telemetry-batch-ingest: no insertable rows (indexed only)', { key, skipped });
  } else {
    console.log('telemetry-batch-ingest: ingested', {
      key,
      deviceId,
      sessionId,
      samples: parsed.samples,
      rows: parsed.rows.length,
      skippedInvalid: parsed.skippedInvalid,
      skippedAge: parsed.skippedAge,
      firstTs: parsed.firstTs,
      lastTs: parsed.lastTs,
    });
  }

  // README Q14, AFTER the commit so the ingest-log row exists before the
  // re-fired Object Created event can arrive. Never throws; a failure leaves
  // normalized=false for the sweeper to retry.
  const normalized = await ensureSegmentNormalized(bucket, key);
  console.log('telemetry-batch-ingest: normalised', { key, normalized });
};

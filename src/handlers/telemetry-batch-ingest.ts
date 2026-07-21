import { gunzipSync } from 'node:zlib';
import type { EventBridgeEvent } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_FUTURE_MS,
  parseSegment,
  parseTelemetryObjectKey,
} from '../services/telemetry-batch';

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
  if (parsed.rows.length === 0) {
    // Nothing insertable (e.g. all lines outside the partition window). Still
    // log the object so redeliveries don't re-parse it forever.
    await db
      .insert(schema.telemetryIngestLog)
      .values({ s3Key: key, deviceId, sessionId, rowsInserted: 0, linesSkipped: skipped })
      .onConflictDoNothing();
    console.warn('telemetry-batch-ingest: no insertable rows', { key, skipped });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Sequential batches — RDS Data API forbids interleaving inside a
      // transaction (no Promise.all here, per the driver's known limits).
      for (let i = 0; i < parsed.rows.length; i += INSERT_BATCH_ROWS) {
        await tx
          .insert(schema.telemetryReadings)
          .values(parsed.rows.slice(i, i + INSERT_BATCH_ROWS));
      }
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

  console.log('telemetry-batch-ingest: ingested', {
    key,
    deviceId,
    sessionId,
    samples: parsed.samples,
    rows: parsed.rows.length,
    skippedInvalid: parsed.skippedInvalid,
    skippedAge: parsed.skippedAge,
  });
};

import { gunzipSync } from 'node:zlib';
import type { EventBridgeEvent } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_FUTURE_MS,
  isTelemetryArtifactKey,
  parseSegment,
  parseTelemetryObjectKey,
} from '../services/telemetry-batch';
import {
  applySegmentShifts,
  applySessionClockCorrection,
  loadSessionClockState,
  prepareTelemetryClockStep,
  readClockStepMeta,
  repairReputSegment,
  type PreparedTelemetryClockStep,
} from '../services/telemetry-clock-step';
import { ensureSegmentNormalized, indexSegment } from '../services/telemetry-sessions';
import { dispatchWebhookEvents } from '../services/webhooks/emit';
import { emitTelemetrySessionStarted } from '../services/webhooks/sessions';

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
 *
 * Clock-step correction (plans/clock-step-correction §4.3, D6-D11), on unless
 * CLOCK_STEP_CORRECTION=0: a file whose samples disagree with their own
 * monotonic clock by >= CLOCK_STEP_MIN_MS straddles a boot-time clock step.
 * BEFORE the transaction this object is rewritten with its stale lines
 * re-stamped and every earlier file of the session is shifted whole (S3);
 * INSIDE it the earlier files' bounds and readings move, this file inserts
 * corrected rows, and the session gets its corrected bounds + audit columns.
 * A late file stamped before a corrected session's step is shifted by the
 * session's correction (D10). Our PUTs re-fire Object Created like the
 * normalisation copy does: for an already-ingested key the fast path absorbs
 * it (dedupe is by key, the new ETag does not matter); for THIS key, which may
 * still be mid-transaction, the object's `xg-clock-step` metadata lets the
 * re-fired run replay the same correction and lose the ingest-log race
 * harmlessly (services/telemetry-clock-step.ts).
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
    // 'copied' here means the object was re-PUT un-normalised after ingest
    // (a device retry), i.e. the device's raw stamps are back in S3 while the
    // DB holds the corrected ones: put the object back in line (S3 only).
    if (normalized === 'copied' && recordingConfig.clockStepCorrection) {
      try {
        const repaired = await repairReputSegment(bucket, key, {
          clockStepMinMs: recordingConfig.clockStepMinMs,
          reparse: (t, clockStepMinMs) =>
            parseSegment(t, { deviceId, now: Date.now(), maxAgeMs: maxAgeMs(), maxFutureMs: DEFAULT_MAX_FUTURE_MS, clockStepMinMs }),
        });
        if (repaired !== 'none') console.log('telemetry-batch-ingest: clock step re-applied to re-PUT object', { key, repaired });
      } catch (err) {
        console.error('telemetry-batch-ingest: clock step repair of re-PUT object failed', { key, err });
      }
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

  // D10 needs the session's correction state; read it BEFORE parsing.
  const clockStepMinMs = recordingConfig.clockStepCorrection ? recordingConfig.clockStepMinMs : 0;
  const sessionClock = clockStepMinMs > 0 ? await loadSessionClockState(sessionId) : null;

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

  const parseOpts = { deviceId, now: Date.now(), maxAgeMs: maxAgeMs(), maxFutureMs: DEFAULT_MAX_FUTURE_MS };
  let parsed = parseSegment(text, { ...parseOpts, clockStepMinMs });
  if (parsed.deviceIdMismatch) {
    // The key prefix is IAM-scoped ground truth; a contradicting header means a
    // mis-built file. Refuse rather than attribute data to the wrong device.
    console.error('telemetry-batch-ingest: header deviceId mismatches key, dropping', { key });
    return;
  }

  // Clock-step phase 1 (S3, before the transaction). Throws on S3 failure:
  // transient, and a retry replays it from the objects' metadata.
  let clock: PreparedTelemetryClockStep | null = null;
  if (clockStepMinMs > 0) {
    clock = await prepareTelemetryClockStep({
      bucket,
      key,
      sessionId,
      seq: parsedKey.seq,
      text,
      meta: readClockStepMeta(obj.Metadata),
      parsed,
      session: sessionClock,
      reparse: (t) => parseSegment(t, parseOpts),
    });
    if (clock) parsed = clock.parsed;
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
    // A corrected object's stored size (this call's PUT, or the earlier
    // attempt's object we just read), not the size the device's event carried.
    bytes: clock ? (clock.bytes ?? gz.length) : objectBytes,
    keyStartTsMs: parsedKey.startTsMs,
  };

  let startedEventId: string | null = null;
  let readingsMoved = 0;
  try {
    startedEventId = await db.transaction(async (tx) => {
      // Sequential batches — RDS Data API forbids interleaving inside a
      // transaction (no Promise.all here, per the driver's known limits).
      // Clock-step (c): earlier files' bounds + readings first, so their
      // stale-ts match never meets this file's freshly inserted rows.
      if (clock && clock.earlier.length > 0) {
        readingsMoved = await applySegmentShifts(tx, deviceId, clock.earlier);
      }
      // A file with nothing insertable (every line outside the partition
      // window) skips the readings but is STILL indexed and logged.
      for (let i = 0; i < parsed.rows.length; i += INSERT_BATCH_ROWS) {
        await tx
          .insert(schema.telemetryReadings)
          .values(parsed.rows.slice(i, i + INSERT_BATCH_ROWS));
      }
      const indexed = await indexSegment(tx, indexInput);
      // Clock-step (d): after this file is indexed with corrected bounds, the
      // session's bounds are recomputed from its segments and audited.
      if (clock?.kind === 'step') {
        await applySessionClockCorrection(tx, {
          sessionId,
          shiftMs: clock.shiftMs,
          staleBefore: clock.staleBefore,
          bytesDelta: clock.earlier.reduce((sum, f) => sum + f.bytesDelta, 0),
        });
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
      // xorgate-webhooks P3: this delivery created the session, so the outbox
      // row commits with it (README D3). A duplicate delivery threw above and
      // rolled the session back, so a re-ingest can never emit a second one.
      if (!indexed.created) return null;
      return emitTelemetrySessionStarted(tx, {
        sessionId,
        deviceId,
        startedAt: indexed.startedAt,
        rateHz: parsed.header?.rateHz ?? null,
        timeSource: parsed.header?.timeSource ?? null,
      });
    });
  } catch (err) {
    if (err instanceof AlreadyIngested) {
      console.log('telemetry-batch-ingest: concurrent duplicate delivery, rolled back', { key });
      return;
    }
    throw err; // transient DB failure → Lambda retry / DLQ
  }

  if (clock) {
    console.log('telemetry-batch-ingest: clock step corrected', {
      key,
      kind: clock.kind,
      steps: clock.steps,
      shiftMs: clock.shiftMs,
      staleBefore: clock.staleBefore,
      filesRewritten: (clock.rewroteSelf ? 1 : 0) + clock.earlier.filter((f) => f.rewritten).length,
      earlierFiles: clock.earlier.length,
      readingsMoved,
    });
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

  // Never throws; with the `webhooks` flag off it only leaves the row for the log.
  await dispatchWebhookEvents([startedEventId]);

  // README Q14, AFTER the commit so the ingest-log row exists before the
  // re-fired Object Created event can arrive. Never throws; a failure leaves
  // normalized=false for the sweeper to retry.
  const normalized = await ensureSegmentNormalized(bucket, key);
  console.log('telemetry-batch-ingest: normalised', { key, normalized });
};

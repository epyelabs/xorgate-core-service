import { gunzipSync } from 'node:zlib';
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';
import { tsParam } from '../utils/sql';
import { parseTelemetryObjectKey, summarizeSegment, type SegmentHeaderInfo } from './telemetry-batch';
import { gzipOverview, OverviewBuilder, overviewKeyFor } from './telemetry-overview';
import { promotedInsightColumns } from './telemetry-insights/index';

/**
 * Telemetry session index + overview artifacts (telemetry-session-artifacts
 * plan, Phase 1). The I/O half of the design: services/telemetry-overview.ts
 * and services/telemetry-insights/ are pure; this file owns the two index
 * tables, the S3 metadata normalisation (README Q14) and the close-and-build
 * pass the housekeeping tick runs. Every writer of the index goes through
 * `indexSegment` (the ingest Lambda inside its transaction, the backfill
 * through `reconcileTelemetryIndex`) so the roll-forward semantics live once.
 *
 * RDS Data API rules honoured here: statements inside a transaction are
 * strictly sequential; timestamps in raw `sql` go through tsParam(); jsonb
 * through an explicit cast.
 */

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;

/** Object metadata every raw segment carries once normalised (README Q14). */
export const SEGMENT_CONTENT_TYPE = 'application/x-ndjson';
export const SEGMENT_CONTENT_ENCODING = 'gzip';
export const SEGMENT_CACHE_CONTROL = 'private, max-age=86400, immutable';
export const OVERVIEW_CONTENT_TYPE = 'application/json';
export const OVERVIEW_CACHE_CONTROL = 'private, max-age=86400';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface IndexSegmentInput {
  s3Key: string;
  deviceId: string;
  sessionId: string;
  seq: number;
  header: SegmentHeaderInfo | null;
  /** Min / max sample ts in the file; null when the file has no valid sample. */
  firstTs: number | null;
  lastTs: number | null;
  samples: number;
  bytes: number;
  /** The key's startTsMs: the window fallback for a file without samples. */
  keyStartTsMs: number;
}

export interface IndexSegmentOptions {
  /**
   * Backfill of an object ingested before the index existed: the session is
   * created/left `closed` with `overview_stale = true` (so the sweeper builds
   * it on its next pass instead of waiting out the close window) and the
   * arrival clock is the ingest log's, not now().
   */
  backfill?: { arrivedAt: Date };
}

// Rank mapping mirrors worstTimeSource() in telemetry-batch.ts; keep in sync.
const timeSourceRankSql = (expr: SQL | PgColumn) =>
  sql`(case ${expr} when 'ntp' then 4 when 'gps' then 3 when 'nitz' then 2 when 'rtc' then 1 when 'unsynced' then 0 else -1 end)`;

/**
 * Index one segment inside the caller's transaction. Sequence (no Promise.all,
 * Data API): session row if absent -> segment row (ON CONFLICT DO NOTHING) ->
 * if it was new, roll the session forward. Returns false when the segment was
 * already indexed (nothing changed).
 */
export async function indexSegment(
  tx: Tx,
  input: IndexSegmentInput,
  opts: IndexSegmentOptions = {},
): Promise<boolean> {
  const startTs = new Date(input.firstTs ?? input.keyStartTsMs);
  const endTs = new Date(input.lastTs ?? input.firstTs ?? input.keyStartTsMs);
  const arrivedAt = opts.backfill?.arrivedAt ?? new Date();
  const status = opts.backfill ? 'closed' : 'open';

  await tx
    .insert(schema.telemetrySessions)
    .values({
      id: input.sessionId,
      deviceId: input.deviceId,
      startedAt: startTs,
      endedAt: endTs,
      lastSegmentAt: arrivedAt,
      status,
      rateHz: input.header?.rateHz ?? null,
      timeSource: input.header?.timeSource ?? null,
      overviewStale: Boolean(opts.backfill),
    })
    .onConflictDoNothing();

  const inserted = await tx
    .insert(schema.telemetrySegments)
    .values({
      s3Key: input.s3Key,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      seq: input.seq,
      startTs,
      endTs,
      samples: input.samples,
      bytes: input.bytes,
      uploadedAt: arrivedAt,
    })
    .onConflictDoNothing()
    .returning({ s3Key: schema.telemetrySegments.s3Key });
  if (inserted.length === 0) return false;

  const t = schema.telemetrySessions;
  const newSource = input.header?.timeSource ?? null;
  await tx
    .update(t)
    .set({
      startedAt: sql`least(${t.startedAt}, ${tsParam(startTs.toISOString())})`,
      endedAt: sql`greatest(coalesce(${t.endedAt}, 'epoch'::timestamptz), ${tsParam(endTs.toISOString())})`,
      lastSegmentAt: sql`greatest(${t.lastSegmentAt}, ${tsParam(arrivedAt.toISOString())})`,
      status,
      segmentCount: sql`${t.segmentCount} + 1`,
      sampleCount: sql`${t.sampleCount} + ${input.samples}`,
      byteCount: sql`${t.byteCount} + ${input.bytes}`,
      rateHz: sql`coalesce(${t.rateHz}, ${input.header?.rateHz ?? null})`,
      // Worst-of: a header that reports a worse clock than the row downgrades it.
      timeSource: sql`case when ${newSource} is null then ${t.timeSource} when ${t.timeSource} is null then ${newSource} when ${timeSourceRankSql(sql`${newSource}`)} < ${timeSourceRankSql(t.timeSource)} then ${newSource} else ${t.timeSource} end`,
      // A segment after a build makes the artifact stale; a backfilled
      // session is stale by definition (nothing has been built yet).
      overviewStale: opts.backfill ? sql`true` : sql`(${t.overviewKey} is not null)`,
      updatedAt: sql`now()`,
    })
    .where(eq(t.id, input.sessionId));
  return true;
}

export type NormalizeResult = 'already' | 'copied' | 'missing' | 'failed';

/**
 * README Q14: make the raw segment inflate natively in every client's
 * fetch(). HEAD first (idempotent re-runs, the re-fired event from our own
 * copy, a device uploader retry that re-PUT the key and stripped the header),
 * then CopyObject onto the same key with replaced metadata. Never throws: the
 * caller's ingest has already committed and must not be retried for this.
 */
export async function normalizeSegmentObject(bucket: string, key: string): Promise<NormalizeResult> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (head.ContentEncoding === SEGMENT_CONTENT_ENCODING && head.ContentType === SEGMENT_CONTENT_TYPE) {
      return 'already';
    }
  } catch (err) {
    if (isNotFound(err)) return 'missing';
    console.error('telemetry-sessions: head before normalise failed', { key, err });
    return 'failed';
  }
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
        MetadataDirective: 'REPLACE',
        ContentEncoding: SEGMENT_CONTENT_ENCODING,
        ContentType: SEGMENT_CONTENT_TYPE,
        CacheControl: SEGMENT_CACHE_CONTROL,
      }),
    );
    return 'copied';
  } catch (err) {
    if (isNotFound(err)) return 'missing';
    console.error('telemetry-sessions: normalise copy failed', { key, err });
    return 'failed';
  }
}

/** Normalise + record the outcome on the index row. */
export async function ensureSegmentNormalized(bucket: string, key: string): Promise<NormalizeResult> {
  const result = await normalizeSegmentObject(bucket, key);
  if (result === 'already' || result === 'copied') {
    await db
      .update(schema.telemetrySegments)
      .set({ normalized: true })
      .where(and(eq(schema.telemetrySegments.s3Key, key), eq(schema.telemetrySegments.normalized, false)));
  } else if (result === 'failed') {
    // Leave normalized=false; the sweeper retries un-normalised rows each tick.
  }
  return result;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export interface ClosedTelemetrySession {
  id: string;
  deviceId: string;
}

/**
 * Advisory close, same rule and knob as media sessions (README D6): no segment
 * ARRIVAL for `mediaSessionCloseAfterMs` (server clock). A straggler re-opens
 * the session through indexSegment and marks its overview stale; the next
 * pass closes and rebuilds it.
 */
export async function closeStaleTelemetrySessions(): Promise<ClosedTelemetrySession[]> {
  const staleSecs = Math.round(recordingConfig.mediaSessionCloseAfterMs / 1000);
  const t = schema.telemetrySessions;
  return db
    .update(t)
    .set({ status: 'closed', updatedAt: sql`now()` })
    .where(
      and(
        eq(t.status, 'open'),
        sql`${t.lastSegmentAt} < now() - make_interval(secs => ${sql.raw(String(staleSecs))})`,
      ),
    )
    .returning({ id: t.id, deviceId: t.deviceId });
}

export interface BuildResult {
  sessionId: string;
  key: string;
  segments: number;
  missingSegments: number;
  samples: number;
  jsonBytes: number;
  gzipBytes: number;
  ms: number;
}

/**
 * Build (or rebuild) one session's overview.v1.json.gz from its indexed
 * segments: list from the index (never S3 LIST), GET + gunzip each in seq
 * order, stream through the builder, PUT with Content-Encoding: gzip, then
 * record the artifact, the insights mirror and the promoted columns on the
 * row. Idempotent: rewrites the same key in place.
 */
export async function buildSessionOverview(sessionId: string, bucket = BUCKET): Promise<BuildResult> {
  if (!bucket) throw new Error('BUCKET_NAME is not set');
  const started = Date.now();
  const session = await db.query.telemetrySessions.findFirst({
    where: eq(schema.telemetrySessions.id, sessionId),
  });
  if (!session) throw new Error(`telemetry session ${sessionId} not found`);

  const segments = await db
    .select({
      s3Key: schema.telemetrySegments.s3Key,
      seq: schema.telemetrySegments.seq,
      bytes: schema.telemetrySegments.bytes,
    })
    .from(schema.telemetrySegments)
    .where(eq(schema.telemetrySegments.sessionId, sessionId))
    .orderBy(asc(schema.telemetrySegments.seq));

  const builder = new OverviewBuilder({
    deviceId: session.deviceId,
    sessionId: session.id,
    rateHz: session.rateHz,
    timeSource: session.timeSource,
    startedAt: session.startedAt.getTime(),
    endedAt: session.endedAt?.getTime() ?? null,
  });

  for (const seg of segments) {
    let gz: Buffer;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: seg.s3Key }));
      gz = Buffer.from(await obj.Body!.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) {
        builder.noteMissingSegment();
        continue;
      }
      throw err;
    }
    let text: string;
    try {
      text = gunzipSync(gz).toString('utf8');
    } catch (err) {
      console.error('telemetry-sessions: segment gunzip failed, skipping in build', { key: seg.s3Key, err });
      builder.noteMissingSegment();
      continue;
    }
    builder.feedSegment({ key: seg.s3Key, seq: seg.seq, bytes: seg.bytes, text });
  }

  const builtAt = Date.now();
  const object = builder.finish(builtAt);
  const json = JSON.stringify(object);
  const body = gzipOverview(object);
  const key = overviewKeyFor(session.deviceId, session.id);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: OVERVIEW_CONTENT_TYPE,
      ContentEncoding: 'gzip',
      CacheControl: OVERVIEW_CACHE_CONTROL,
    }),
  );

  const promoted = promotedInsightColumns(object.insights);
  const t = schema.telemetrySessions;
  await db
    .update(t)
    .set({
      overviewKey: key,
      overviewBuiltAt: new Date(builtAt),
      overviewStale: false,
      insights: sql`${JSON.stringify(object.insights)}::jsonb`,
      insightsComputed: sql`${JSON.stringify(object.insights.computed)}::jsonb`,
      distanceM: promoted.distanceM,
      durationMs: promoted.durationMs,
      maxSpeedKph: promoted.maxSpeedKph,
      updatedAt: sql`now()`,
    })
    .where(eq(t.id, sessionId));

  return {
    sessionId,
    key,
    segments: object.source.segments,
    missingSegments: object.source.missingSegments,
    samples: object.source.samples,
    jsonBytes: Buffer.byteLength(json),
    gzipBytes: body.length,
    ms: Date.now() - started,
  };
}

export interface HousekeepingOptions {
  bucket?: string;
  /** Builds per pass, oldest first; the rest wait for the next tick. */
  maxBuilds?: number;
  /** Un-normalised segment rows to retry per pass. */
  maxNormalizeRetries?: number;
  /** Stop starting new work once this epoch-ms is reached. */
  deadline?: number;
}

export interface HousekeepingResult {
  closed: number;
  built: number;
  buildFailures: number;
  pendingBuilds: number;
  normalized: number;
  builds: BuildResult[];
}

/**
 * The sweeper's step 2b (README D6, Q5): close stale sessions, then build the
 * overview of every closed session that needs one (just closed, or re-opened
 * by a straggler and closed again), bounded per tick; then retry metadata
 * normalisation on rows the ingest could not complete. One log line per build.
 */
export async function runTelemetryHousekeeping(opts: HousekeepingOptions = {}): Promise<HousekeepingResult> {
  const bucket = opts.bucket ?? BUCKET;
  if (!bucket) throw new Error('BUCKET_NAME is not set');
  const maxBuilds = opts.maxBuilds ?? 10;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const result: HousekeepingResult = {
    closed: 0,
    built: 0,
    buildFailures: 0,
    pendingBuilds: 0,
    normalized: 0,
    builds: [],
  };

  const closed = await closeStaleTelemetrySessions();
  result.closed = closed.length;

  // Everything closed that has no artifact or a stale one, oldest first: the
  // just-closed rows are in here by construction (overview_key null or stale).
  const t = schema.telemetrySessions;
  const pending = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.status, 'closed'), sql`(${t.overviewKey} is null or ${t.overviewStale} = true)`))
    .orderBy(asc(t.lastSegmentAt))
    .limit(maxBuilds + 1);
  result.pendingBuilds = pending.length;

  for (const row of pending.slice(0, maxBuilds)) {
    if (Date.now() >= deadline) break;
    try {
      const built = await buildSessionOverview(row.id, bucket);
      result.built++;
      result.pendingBuilds--;
      result.builds.push(built);
      console.log('telemetry-sessions: overview built', built);
    } catch (err) {
      result.buildFailures++;
      console.error('telemetry-sessions: overview build failed', { sessionId: row.id, err });
    }
  }

  // Normalisation retries. Skip rows younger than two minutes: their ingest
  // may still be mid-copy, and racing it buys nothing.
  const retries = await db
    .select({ s3Key: schema.telemetrySegments.s3Key })
    .from(schema.telemetrySegments)
    .where(
      and(
        eq(schema.telemetrySegments.normalized, false),
        sql`${schema.telemetrySegments.uploadedAt} < now() - interval '2 minutes'`,
      ),
    )
    .orderBy(asc(schema.telemetrySegments.uploadedAt))
    .limit(opts.maxNormalizeRetries ?? 20);
  for (const row of retries) {
    if (Date.now() >= deadline) break;
    const outcome = await ensureSegmentNormalized(bucket, row.s3Key);
    if (outcome === 'copied' || outcome === 'already') result.normalized++;
  }

  return result;
}

export interface ReconcileOptions {
  bucket?: string;
  /** Objects to index per call. */
  limit?: number;
  deadline?: number;
}

export interface ReconcileResult {
  indexed: number;
  alreadyIndexed: number;
  missing: number;
  failed: number;
  normalized: number;
  /** Ingest-log rows still without an index row after this call (best effort). */
  remaining: number;
}

/**
 * The backfill (phase file 1.6), written as a reconciliation so it is
 * idempotent and safe to re-run: every `telemetry_ingest_log` key without a
 * `telemetry_segments` row is fetched, summarised (header, first/last ts,
 * sample count) and indexed through the same `indexSegment` the ingest uses,
 * with the session marked closed + stale so the housekeeping pass builds its
 * overview. Each object is also normalised (README Q14); expect one no-op
 * "already ingested" ingest invocation per object from the re-fired event.
 *
 * An object the lifecycle already deleted is counted as `missing` and left
 * alone: the sweeper's ingest-log expiry removes its row a day after S3 did.
 */
export async function reconcileTelemetryIndex(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const bucket = opts.bucket ?? BUCKET;
  if (!bucket) throw new Error('BUCKET_NAME is not set');
  const limit = opts.limit ?? 50;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const result: ReconcileResult = {
    indexed: 0,
    alreadyIndexed: 0,
    missing: 0,
    failed: 0,
    normalized: 0,
    remaining: 0,
  };

  const log = schema.telemetryIngestLog;
  const seg = schema.telemetrySegments;
  const pending = await db
    .select({ s3Key: log.s3Key, ingestedAt: log.ingestedAt })
    .from(log)
    .leftJoin(seg, eq(seg.s3Key, log.s3Key))
    .where(isNull(seg.s3Key))
    .orderBy(asc(log.ingestedAt))
    .limit(limit + 1);
  result.remaining = pending.length;

  for (const row of pending.slice(0, limit)) {
    if (Date.now() >= deadline) break;
    const parsedKey = parseTelemetryObjectKey(row.s3Key);
    if (!parsedKey) {
      result.failed++;
      console.error('telemetry-sessions: reconcile skipped unrecognised key', { key: row.s3Key });
      continue;
    }
    let gz: Buffer;
    let size: number;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.s3Key }));
      gz = Buffer.from(await obj.Body!.transformToByteArray());
      size = obj.ContentLength ?? gz.length;
    } catch (err) {
      if (isNotFound(err)) {
        result.missing++;
        continue;
      }
      result.failed++;
      console.error('telemetry-sessions: reconcile GET failed', { key: row.s3Key, err });
      continue;
    }
    let text: string;
    try {
      text = gunzipSync(gz).toString('utf8');
    } catch (err) {
      result.failed++;
      console.error('telemetry-sessions: reconcile gunzip failed', { key: row.s3Key, err });
      continue;
    }
    const summary = summarizeSegment(text);
    try {
      const wasNew = await db.transaction((tx) =>
        indexSegment(
          tx,
          {
            s3Key: row.s3Key,
            deviceId: parsedKey.deviceId,
            sessionId: parsedKey.sessionId,
            seq: parsedKey.seq,
            header: summary.header,
            firstTs: summary.firstTs,
            lastTs: summary.lastTs,
            samples: summary.sampleLines,
            bytes: size,
            keyStartTsMs: parsedKey.startTsMs,
          },
          { backfill: { arrivedAt: row.ingestedAt } },
        ),
      );
      if (wasNew) result.indexed++;
      else result.alreadyIndexed++;
      result.remaining--;
    } catch (err) {
      result.failed++;
      console.error('telemetry-sessions: reconcile index failed', { key: row.s3Key, err });
      continue;
    }
    const outcome = await ensureSegmentNormalized(bucket, row.s3Key);
    if (outcome === 'copied' || outcome === 'already') result.normalized++;
  }

  return result;
}

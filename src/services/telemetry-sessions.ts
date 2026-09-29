import { gunzipSync } from 'node:zlib';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';
import { isoSql, tsParam } from '../utils/sql';
import {
  parseTelemetryObjectKey,
  plausibleSampleTs,
  summarizeSegment,
  type SegmentHeaderInfo,
} from './telemetry-batch';
import { gzipOverview, OverviewBuilder, overviewKeyFor } from './telemetry-overview';
import { promotedInsightColumns } from './telemetry-insights/index';
import { evaluateTelemetrySessionCompletedTriggers } from './workflow-triggers';
import { dispatchWebhookEvents, emitWebhookEvents } from './webhooks/emit';
import {
  emitTelemetrySessionCompleted,
  telemetryCloseSql,
  telemetryEndedEvents,
  type TelemetryClosedRow,
} from './webhooks/sessions';

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

export interface IndexSegmentResult {
  /** False when the segment was already indexed (nothing changed). */
  indexed: boolean;
  /**
   * True when THIS call created the session row (xorgate-webhooks P3: the
   * live ingest emits `telemetry_session.started` for it; the backfill does
   * not). Only meaningful with `indexed`: a duplicate rolls the caller back.
   */
  created: boolean;
  /** The session start this call wrote when it created the row (device clock, clamped). */
  startedAt: Date;
}

/**
 * Index one segment inside the caller's transaction. Sequence (no Promise.all,
 * Data API): session row if absent -> segment row (ON CONFLICT DO NOTHING) ->
 * if it was new, roll the session forward. Emits nothing: the caller decides
 * whether a created session is news (live ingest) or history (backfill).
 */
export async function indexSegment(
  tx: Tx,
  input: IndexSegmentInput,
  opts: IndexSegmentOptions = {},
): Promise<IndexSegmentResult> {
  const arrivedAt = opts.backfill?.arrivedAt ?? new Date();
  // Bounds come from the device clock and feed the manifest's overlap join, so
  // an implausible future ts (a 2080 RTC) must not make a session "overlap"
  // every window for decades: clamp to the arrival time (P2; manual/026
  // repaired the rows indexed before this).
  const startMs = plausibleSampleTs(input.firstTs ?? input.keyStartTsMs, arrivedAt.getTime());
  const endMs = Math.max(
    startMs,
    plausibleSampleTs(input.lastTs ?? input.firstTs ?? input.keyStartTsMs, arrivedAt.getTime()),
  );
  const startTs = new Date(startMs);
  const endTs = new Date(endMs);
  const status = opts.backfill ? 'closed' : 'open';

  const createdRows = await tx
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
    .onConflictDoNothing()
    .returning({ id: schema.telemetrySessions.id });
  const created = createdRows.length > 0;

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
  if (inserted.length === 0) return { indexed: false, created, startedAt: startTs };

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
  return { indexed: true, created, startedAt: startTs };
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
 *
 * `deviceId` scopes it for close-on-read (the replay manifest and the sessions
 * listing run it best-effort, like `closeStaleMediaSessions(deviceId)`), so a
 * device someone is looking at reads honestly on dev, where the sweeper
 * schedule is off. Closing does not build: the overview stays null until the
 * housekeeping tick (prod) or a manual pass (dev) gets to it.
 */
export async function closeStaleTelemetrySessions(deviceId?: string): Promise<ClosedTelemetrySession[]> {
  const staleSecs = Math.round(recordingConfig.mediaSessionCloseAfterMs / 1000);
  // xorgate-webhooks P3: close + `telemetry_session.ended` outbox rows in one
  // transaction (README D3), dispatched after commit. Every closer (sweeper,
  // manifest and listing close-on-read) goes through here.
  const { rows, eventIds } = await db.transaction(async (tx) => {
    const res = await tx.execute<TelemetryClosedRow & Record<string, unknown>>(telemetryCloseSql(staleSecs, deviceId));
    const rows = (res?.rows ?? []) as TelemetryClosedRow[];
    const eventIds = await emitWebhookEvents(tx, telemetryEndedEvents(rows));
    return { rows, eventIds };
  });
  await dispatchWebhookEvents(eventIds);
  return rows.map((r) => ({ id: r.id, deviceId: r.device_id }));
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
      uploadedAt: schema.telemetrySegments.uploadedAt,
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
    // `uploadedAt` lets the builder drop samples an RTC stamped in the far
    // future (P6; the same one-day rule the ingest index applies).
    builder.feedSegment({ key: seg.s3Key, seq: seg.seq, bytes: seg.bytes, text, uploadedAt: seg.uploadedAt.getTime() });
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
      overviewBytes: body.length,
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
  /**
   * Sessions built before manual/026 whose `overview_bytes` is still null:
   * one HEAD each per pass (Phase 2). Zero once the backfill has caught up.
   */
  maxBytesBackfills?: number;
  /** Sessions whose `telemetry_session_completed` triggers to evaluate per pass (P6). */
  maxTriggerFires?: number;
  /** Stop starting new work once this epoch-ms is reached. */
  deadline?: number;
}

export interface HousekeepingResult {
  closed: number;
  built: number;
  buildFailures: number;
  pendingBuilds: number;
  normalized: number;
  /** `overview_bytes` rows filled from a HEAD this pass (pre-026 artifacts). */
  bytesBackfilled: number;
  /** Sessions whose `telemetry_session_completed` triggers were evaluated this pass. */
  completedFired: number;
  /** Workflow runs those evaluations started. */
  completedRuns: number;
  builds: BuildResult[];
}

/**
 * Log lines the CloudWatch metric filters read (api-stack.ts, P6 item 8).
 * ONE object per line, so under the sweeper's JSON log format the runtime
 * emits it as `message: { msg, ... }` and a filter can select on
 * `$.message.msg` and extract `$.message.ms` / `$.message.gzipBytes`. The
 * `msg` strings are part of that contract: change them together with the
 * filters. Under the text log format (local runs) they print as util.inspect.
 */
export const BUILD_LOG_MSG = 'telemetry-sessions: overview built';
export const BUILD_FAILED_LOG_MSG = 'telemetry-sessions: overview build failed';

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
    bytesBackfilled: 0,
    completedFired: 0,
    completedRuns: 0,
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
      console.log({ msg: BUILD_LOG_MSG, ...built });
    } catch (err) {
      result.buildFailures++;
      console.error({ msg: BUILD_FAILED_LOG_MSG, sessionId: row.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  // P6 item 9: `telemetry_session_completed` workflow triggers, for every
  // session that is closed with a current overview and has not fired since
  // its last segment arrived (the just-built ones by construction, plus any a
  // close-on-read closed and an earlier tick built).
  if (Date.now() < deadline) {
    const fired = await fireTelemetrySessionCompleted({ limit: opts.maxTriggerFires ?? 25, deadline });
    result.completedFired = fired.sessions;
    result.completedRuns = fired.runs;
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

  // Phase 2: artifacts built before `overview_bytes` existed (manual/026) get
  // their size from ONE HEAD each, bounded per pass, so the manifest never
  // HEADs per request. Self-terminating: every filled row leaves the set.
  if (Date.now() < deadline) {
    result.bytesBackfilled = await backfillOverviewBytes(bucket, {
      limit: opts.maxBytesBackfills ?? 25,
      deadline,
    });
  }

  return result;
}

/**
 * Fill `overview_bytes` on closed sessions that have an artifact but no
 * recorded size (built before manual/026). One HEAD per row; an artifact that
 * is gone (lifecycle) is flagged stale so the builder rewrites it, and a
 * transient HEAD failure is left for the next pass. Returns rows filled.
 */
export async function backfillOverviewBytes(
  bucket: string,
  opts: { limit?: number; deadline?: number } = {},
): Promise<number> {
  const t = schema.telemetrySessions;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const rows = await db
    .select({ id: t.id, overviewKey: t.overviewKey })
    .from(t)
    .where(and(sql`${t.overviewKey} is not null`, isNull(t.overviewBytes)))
    .orderBy(asc(t.overviewBuiltAt))
    .limit(opts.limit ?? 25);
  let filled = 0;
  for (const row of rows) {
    if (Date.now() >= deadline || !row.overviewKey) break;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: row.overviewKey }));
      if (typeof head.ContentLength !== 'number') continue;
      await db
        .update(t)
        .set({ overviewBytes: head.ContentLength })
        .where(and(eq(t.id, row.id), isNull(t.overviewBytes)));
      filled++;
    } catch (err) {
      if (isNotFound(err)) {
        await db
          .update(t)
          .set({ overviewStale: true, updatedAt: sql`now()` })
          .where(eq(t.id, row.id));
        console.warn('telemetry-sessions: overview object missing, flagged for rebuild', {
          sessionId: row.id,
          key: row.overviewKey,
        });
        continue;
      }
      console.error('telemetry-sessions: overview HEAD failed', { sessionId: row.id, err });
    }
  }
  return filled;
}

/**
 * Evaluate `telemetry_session_completed` workflow triggers (P6 item 9, README
 * Q15) for sessions that owe a fire: closed, overview built and not stale,
 * and `completed_fired_at` null or older than `last_segment_at` (manual/027).
 * The fire is recorded BEFORE the evaluation so a crash mid-way re-fires at
 * most the session it was on (at-least-once, like the media twin), and it is
 * recorded even when no attachment subscribes, so the row does not stay in
 * the candidate set forever. Best-effort per session: one bad template never
 * blocks the pass. Oldest first, bounded per pass.
 */
export async function fireTelemetrySessionCompleted(
  opts: { limit?: number; deadline?: number } = {},
): Promise<{ sessions: number; runs: number }> {
  const t = schema.telemetrySessions;
  const d = schema.devices;
  const w = schema.workspaces;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const rows = await db
    .select({
      id: t.id,
      deviceId: t.deviceId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      rateHz: t.rateHz,
      timeSource: t.timeSource,
      segmentCount: t.segmentCount,
      sampleCount: t.sampleCount,
      insights: t.insights,
      lastSegmentAt: t.lastSegmentAt,
      // xorgate-webhooks P3 (`telemetry_session.completed`): the rest of the
      // payload, the timestamps as SQL-rendered ISO strings (the `ended` key
      // carries last_segment_at in exactly this shape), and the device's scope.
      byteCount: t.byteCount,
      distanceM: t.distanceM,
      durationMs: t.durationMs,
      maxSpeedKph: t.maxSpeedKph,
      startedAtIso: sql<string>`${isoSql(sql`${t.startedAt}`)}`,
      endedAtIso: sql<string | null>`${isoSql(sql`${t.endedAt}`)}`,
      lastSegmentAtIso: sql<string>`${isoSql(sql`${t.lastSegmentAt}`)}`,
      previousCompletedFiredAt: sql<string | null>`${isoSql(sql`${t.completedFiredAt}`)}`,
      workspaceId: d.workspaceId,
      organizationId: w.organizationId,
    })
    .from(t)
    .leftJoin(d, eq(d.id, t.deviceId))
    .leftJoin(w, eq(w.id, d.workspaceId))
    .where(
      and(
        eq(t.status, 'closed'),
        sql`${t.overviewKey} is not null`,
        eq(t.overviewStale, false),
        sql`(${t.completedFiredAt} is null or ${t.completedFiredAt} < ${t.lastSegmentAt})`,
      ),
    )
    .orderBy(asc(t.lastSegmentAt))
    .limit(opts.limit ?? 25);
  let sessions = 0;
  let runs = 0;
  const eventIds: string[] = [];
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    // Claim first (the predicate re-checked in the UPDATE): a pass that lost
    // the race to a concurrent one skips the row instead of firing twice. The
    // webhook outbox row commits with the claim (README D3); the key carries
    // the claimed `completed_fired_at`, read back from this UPDATE.
    const claim = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(t)
        .set({ completedFiredAt: sql`now()` })
        .where(
          and(
            eq(t.id, row.id),
            sql`(${t.completedFiredAt} is null or ${t.completedFiredAt} < ${t.lastSegmentAt})`,
          ),
        )
        .returning({ id: t.id, completedFiredAt: sql<string>`${isoSql(sql`${t.completedFiredAt}`)}` });
      if (claimed.length === 0) return null;
      const eventId = await emitTelemetrySessionCompleted(tx, row, claimed[0]!.completedFiredAt);
      return { eventId };
    });
    if (!claim) continue;
    if (claim.eventId) eventIds.push(claim.eventId);
    sessions++;
    try {
      const n = await evaluateTelemetrySessionCompletedTriggers(row);
      runs += n;
      if (n > 0) console.log('telemetry-sessions: telemetry_session_completed fired', { sessionId: row.id, runs: n });
    } catch (err) {
      console.error('telemetry-sessions: telemetry_session_completed trigger eval failed', { sessionId: row.id, err });
    }
  }
  await dispatchWebhookEvents(eventIds);
  return { sessions, runs };
}

export interface DeleteSessionResult {
  sessionId: string;
  found: boolean;
  segments: number;
  objectsDeleted: number;
  ingestLogRows: number;
}

/**
 * Operator job: remove one telemetry session completely (its overview and
 * segment objects, its ingest-log rows, and the index rows via the FK
 * cascade), so a later backfill pass cannot re-index it. For fixture / noise
 * sessions on dev (P2 and P3 wrote four under Toronto Node 01); the local
 * IAM user has no s3:DeleteObject, the sweeper's role does.
 */
export async function deleteTelemetrySession(sessionId: string, bucket = BUCKET): Promise<DeleteSessionResult> {
  if (!bucket) throw new Error('BUCKET_NAME is not set');
  const session = await db.query.telemetrySessions.findFirst({ where: eq(schema.telemetrySessions.id, sessionId) });
  if (!session) return { sessionId, found: false, segments: 0, objectsDeleted: 0, ingestLogRows: 0 };
  const segments = await db
    .select({ s3Key: schema.telemetrySegments.s3Key })
    .from(schema.telemetrySegments)
    .where(eq(schema.telemetrySegments.sessionId, sessionId));
  const keys = segments.map((s) => s.s3Key);
  if (session.overviewKey) keys.push(session.overviewKey);
  let objectsDeleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const out = await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
    );
    objectsDeleted += chunk.length - (out.Errors?.length ?? 0);
    for (const e of out.Errors ?? []) console.error('telemetry-sessions: delete object failed', { key: e.Key, code: e.Code });
  }
  let ingestLogRows = 0;
  if (segments.length > 0) {
    const gone = await db
      .delete(schema.telemetryIngestLog)
      .where(inArray(schema.telemetryIngestLog.s3Key, segments.map((s) => s.s3Key)))
      .returning({ s3Key: schema.telemetryIngestLog.s3Key });
    ingestLogRows = gone.length;
  }
  await db.delete(schema.telemetrySessions).where(eq(schema.telemetrySessions.id, sessionId));
  console.log('telemetry-sessions: session deleted', { sessionId, segments: segments.length, objectsDeleted, ingestLogRows });
  return { sessionId, found: true, segments: segments.length, objectsDeleted, ingestLogRows };
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
  /** Ingest-log rows without an index row BEFORE this call, minus what it indexed. */
  remaining: number;
  /**
   * Ingest-log rows whose device no longer exists (deleted device; its S3
   * objects and log rows outlive the row the session FK needs). Never
   * indexed, never retried; the sweeper's ingest-log expiry removes them.
   */
  orphaned: number;
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
    orphaned: 0,
  };

  const log = schema.telemetryIngestLog;
  const seg = schema.telemetrySegments;
  const dev = schema.devices;
  const [counts] = await db
    .select({
      remaining: sql<number>`count(*) filter (where ${dev.id} is not null)::int`,
      orphaned: sql<number>`count(*) filter (where ${dev.id} is null)::int`,
    })
    .from(log)
    .leftJoin(seg, eq(seg.s3Key, log.s3Key))
    .leftJoin(dev, eq(dev.id, log.deviceId))
    .where(isNull(seg.s3Key));
  result.remaining = counts.remaining;
  result.orphaned = counts.orphaned;
  if (limit <= 0) return result;

  const pending = await db
    .select({ s3Key: log.s3Key, ingestedAt: log.ingestedAt })
    .from(log)
    .leftJoin(seg, eq(seg.s3Key, log.s3Key))
    .innerJoin(dev, eq(dev.id, log.deviceId))
    .where(isNull(seg.s3Key))
    .orderBy(asc(log.ingestedAt))
    .limit(limit);

  for (const row of pending) {
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
      // Backfill: a session this creates is history, already closed. It must
      // NOT emit `telemetry_session.started` (xorgate-webhooks P3), so the
      // result's `created` is deliberately ignored here, and no close ever
      // emits its `ended`, which keeps its `completed` silent too
      // (services/webhooks/sessions.ts emitTelemetrySessionCompleted).
      const { indexed: wasNew } = await db.transaction((tx) =>
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

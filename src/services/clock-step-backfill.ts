import { asc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';
import { nominalSegmentMs, totalTelemetryShiftMs } from './clock-step';
import { parseSegment } from './telemetry-batch';
import {
  applyTelemetryClockStep,
  prepareTelemetryClockStep,
  readSegmentObject,
  type SegmentShift,
} from './telemetry-clock-step';
import {
  applyMediaClockStep,
  correctInflatedSegmentRowSql,
  planMediaSegment,
  type ExecutesSql,
} from './media-clock-step';
import { tsParam, uuidParam } from '../utils/sql';

/**
 * Clock-step backfill (plans/clock-step-correction PLAN §4.4): repair the
 * sessions ingested before the ingest-time correction existed, with the SAME
 * routines ingest uses (services/media-clock-step.ts for media; the telemetry
 * half is wired by P2's services/telemetry-clock-step.ts). Runs inside the
 * OfflineSweeperFn as the `clock-step-backfill` job (it is the only principal
 * with object access to the bucket); scripts/clock-step-backfill.ts drives it
 * and prints the tables. The response shape below IS the script's contract.
 *
 * Media scan: every `media_segments` row whose duration exceeds the device's
 * nominal segment length + CLOCK_STEP_MIN_MS and that carries no
 * `meta.clockStep` yet (= never corrected). Processed oldest first, one
 * session transaction per row, so two steps in one session compose exactly
 * as they would have at ingest (D11). Dry run computes the "after" bounds
 * arithmetically; apply re-reads them from the committed rows.
 */

export interface ClockStepBackfillOptions {
  dryRun: boolean;
  sessionId?: string;
  mediaOnly?: boolean;
  telemetryOnly?: boolean;
  /** Candidates per call (per kind); the driver re-runs with `after` while `truncated`. */
  limit?: number;
  /** Resume cursor: ISO timestamp; media rows with start_ts / telemetry sessions with started_at AFTER it. */
  after?: string;
  bucket: string;
  /** Epoch ms; stop starting new sessions past it. */
  deadline?: number;
}

export interface SessionBounds {
  startedAt: string;
  endedAt: string | null;
  /** media: sum(duration_ms); telemetry: ended − started. */
  spanMs: number;
}

export interface MediaClockStepCandidate {
  deviceId: string;
  deviceName: string | null;
  sessionId: string;
  streamKey: string;
  seq: number;
  rawStartTs: string;
  rawDurationMs: number;
  nominalMs: number;
  stepMs: number;
  finalized: boolean;
  shiftedRows: number;
  before: SessionBounds;
  after: SessionBounds;
  applied: boolean;
  error?: string;
}

export interface TelemetryClockStepCandidate {
  deviceId: string;
  deviceName: string | null;
  sessionId: string;
  seq: number;
  steps: { atIndex: number; jumpMs: number }[];
  totalShiftMs: number;
  earlierFiles: number;
  before: SessionBounds;
  after: SessionBounds;
  applied: boolean;
  error?: string;
}

export interface ClockStepBackfillResult {
  dryRun: boolean;
  media: { scanned: number; candidates: MediaClockStepCandidate[] };
  telemetry: { scanned: number; candidates: TelemetryClockStepCandidate[] };
  truncated: boolean;
  /** Pass back as `after` to continue a truncated scan (the last scanned stamp). */
  nextAfter: string | null;
}

interface MediaScanRow {
  id: string;
  session_id: string;
  device_id: string;
  device_name: string | null;
  recording_config: unknown;
  stream_key: string;
  seq: number;
  start_ts: string;
  duration_ms: number;
  finalized: boolean;
  started_at: string;
  ended_at: string | null;
  clock_correction_ms: number | null;
  clock_stale_before: string | null;
  sum_ms: number;
  shifted_rows: number;
}

/** The Data API hands timestamptz back without an offset; drizzle's raw rows are strings. */
function isoFromDb(v: string | Date | null): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function mediaScanSql(opts: { sessionId?: string; minStepMs: number; limit: number; after?: string }) {
  // Pre-filter on the device's configured nominal (default 60 s, like
  // nominalSegmentMs); the exact decision is re-made in JS with planMediaSegment.
  return sql`select g.id, g.session_id, g.device_id, d.name as device_name, d.recording_config,
      g.stream_key, g.seq, g.start_ts, g.duration_ms, g.finalized,
      s.started_at, s.ended_at, s.clock_correction_ms, s.clock_stale_before,
      (select coalesce(sum(x.duration_ms), 0)::bigint from media_segments x where x.session_id = g.session_id) as sum_ms,
      (select count(*)::int from media_segments x
         where x.session_id = g.session_id and x.start_ts <= g.start_ts and x.id <> g.id) as shifted_rows
    from media_segments g
    join media_sessions s on s.id = g.session_id
    join devices d on d.id = g.device_id
    where g.duration_ms > ${opts.minStepMs}::int
        + 1000 * coalesce((d.recording_config->'video'->>'segmentSeconds')::int, 60)
      and (g.meta is null or g.meta->'clockStep' is null)
      ${opts.sessionId ? sql`and g.session_id = ${uuidParam(opts.sessionId)}` : sql``}
      ${opts.after ? sql`and g.start_ts > ${tsParam(opts.after)}` : sql``}
    order by g.start_ts asc, g.seq asc
    limit ${opts.limit + 1}`;
}

function recomputeSessionBoundsSql(sessionId: string) {
  const sid = uuidParam(sessionId);
  return sql`update media_sessions
    set started_at = coalesce((select min(s.start_ts) from media_segments s where s.session_id = ${sid}), started_at),
        ended_at = coalesce(
          (select max(s.start_ts + s.duration_ms * interval '1 millisecond') from media_segments s where s.session_id = ${sid}),
          ended_at)
    where id = ${sid}`;
}

async function readMediaBounds(exec: ExecutesSql, sessionId: string): Promise<SessionBounds> {
  const res = (await exec.execute(
    sql`select s.started_at, s.ended_at,
          (select coalesce(sum(x.duration_ms), 0)::bigint from media_segments x where x.session_id = s.id) as sum_ms
        from media_sessions s where s.id = ${uuidParam(sessionId)}`,
  )) as unknown as { rows?: { started_at: string; ended_at: string | null; sum_ms: number }[] };
  const row = res.rows?.[0];
  if (!row) throw new Error(`session ${sessionId} vanished during backfill`);
  return { startedAt: isoFromDb(row.started_at) as string, endedAt: isoFromDb(row.ended_at), spanMs: Number(row.sum_ms) };
}

/** Pure: the bounds a dry run predicts for a session after one media plan. */
export function predictMediaBounds(
  before: SessionBounds,
  plan: { kind: string; stepMs: number; rawDurationMs: number; durationMs: number },
): SessionBounds {
  if (plan.kind === 'none') return before;
  const spanMs = before.spanMs - plan.rawDurationMs + plan.durationMs;
  if (plan.kind !== 'step') return { ...before, spanMs };
  // Every row at or before the inflated one shifts by the step, the session's
  // first row included; the inflated row's corrected end equals its raw end,
  // and later rows are already on the real clock, so ended_at holds.
  return {
    startedAt: new Date(new Date(before.startedAt).getTime() + plan.stepMs).toISOString(),
    endedAt: before.endedAt,
    spanMs,
  };
}

async function backfillMedia(
  opts: ClockStepBackfillOptions,
): Promise<{ scanned: number; candidates: MediaClockStepCandidate[]; truncated: boolean; nextAfter: string | null }> {
  const limit = opts.limit ?? 50;
  const minStepMs = recordingConfig.clockStepMinMs;
  const res = (await db.execute(
    mediaScanSql({ sessionId: opts.sessionId, minStepMs, limit, after: opts.after }),
  )) as unknown as { rows?: MediaScanRow[] };
  const rows = res.rows ?? [];
  const truncated = rows.length > limit;
  const work = truncated ? rows.slice(0, limit) : rows;
  const candidates: MediaClockStepCandidate[] = [];

  for (const r of work) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) break;
    const nominalMs = nominalSegmentMs(r.recording_config as Parameters<typeof nominalSegmentMs>[0]);
    const rawStartTs = new Date(isoFromDb(r.start_ts) as string);
    const plan = planMediaSegment({
      startTs: rawStartTs,
      durationMs: Number(r.duration_ms),
      finalized: Boolean(r.finalized),
      nominalMs,
      minStepMs,
      enabled: true,
      session: {
        clockCorrectionMs: r.clock_correction_ms === null ? null : Number(r.clock_correction_ms),
        clockStaleBefore: r.clock_stale_before ? new Date(isoFromDb(r.clock_stale_before) as string) : null,
      },
    });
    if (plan.kind === 'none') continue;
    const before: SessionBounds = {
      startedAt: isoFromDb(r.started_at) as string,
      endedAt: isoFromDb(r.ended_at),
      spanMs: Number(r.sum_ms),
    };
    const stepMs = plan.step?.stepMs ?? (plan.kind === 'straggler' ? Number(plan.clockStep?.stepMs ?? 0) : 0);
    const candidate: MediaClockStepCandidate = {
      deviceId: r.device_id,
      deviceName: r.device_name,
      sessionId: r.session_id,
      streamKey: r.stream_key,
      seq: Number(r.seq),
      rawStartTs: rawStartTs.toISOString(),
      rawDurationMs: Number(r.duration_ms),
      nominalMs,
      stepMs,
      finalized: Boolean(r.finalized),
      shiftedRows: plan.kind === 'step' ? Number(r.shifted_rows) : 0,
      before,
      after: predictMediaBounds(before, { kind: plan.kind, stepMs, rawDurationMs: Number(r.duration_ms), durationMs: plan.durationMs }),
      applied: false,
    };
    if (opts.dryRun) {
      candidates.push(candidate);
      continue;
    }
    try {
      candidate.after = await db.transaction(async (tx) => {
        // Sequential statements only (RDS Data API). Same order as ingest:
        // the inflated row first (corrected in place, guarded on no
        // meta.clockStep so a re-run is a no-op), then the propagation.
        await tx.execute(
          correctInflatedSegmentRowSql({
            segmentRowId: r.id,
            startTs: plan.startTs,
            durationMs: plan.durationMs,
            clockStep: plan.clockStep as Record<string, unknown>,
          }),
        );
        if (plan.step) {
          await applyMediaClockStep(tx, {
            sessionId: r.session_id,
            segmentRowId: r.id,
            rawStartTs: plan.step.rawStartTs,
            stepMs: plan.step.stepMs,
            nominalMs: plan.step.nominalMs,
          });
        } else {
          await tx.execute(recomputeSessionBoundsSql(r.session_id));
        }
        return readMediaBounds(tx, r.session_id);
      });
      candidate.applied = true;
      console.log('clock-step-backfill: media session corrected', {
        sessionId: r.session_id,
        seq: candidate.seq,
        kind: plan.kind,
        stepMs,
        before,
        after: candidate.after,
      });
    } catch (err) {
      candidate.error = (err as Error).message;
      console.error('clock-step-backfill: media session failed', { sessionId: r.session_id, err });
    }
    candidates.push(candidate);
  }
  const last = work[work.length - 1];
  return { scanned: work.length, candidates, truncated, nextAfter: last ? isoFromDb(last.start_ts) : null };
}

// --- Telemetry half (PLAN §4.4, routines from services/telemetry-clock-step.ts) ---

interface TelemetryScanRow {
  id: string;
  device_id: string;
  device_name: string | null;
  started_at: string;
  ended_at: string | null;
  rate_hz: number | null;
  sample_count: number;
  clock_correction_ms: number | null;
}

/**
 * Candidate telemetry sessions: never corrected, closed, and spanning far
 * more wall-clock than their sample count can account for at their rate (a
 * stale-boot straddle adds the whole step to the span; a recording hole does
 * too, which only costs the S3 reads that then find no in-file step). A
 * `sessionId` filter bypasses the heuristic so one session can always be
 * forced.
 */
function telemetryScanSql(opts: { sessionId?: string; minStepMs: number; limit: number; after?: string }) {
  const minSecs = Math.ceil(opts.minStepMs / 1000);
  return sql`select s.id, s.device_id, d.name as device_name, s.started_at, s.ended_at, s.rate_hz,
      s.sample_count, s.clock_correction_ms
    from telemetry_sessions s
    join devices d on d.id = s.device_id
    where s.ended_at is not null
      ${
        opts.sessionId
          ? sql`and s.id = ${uuidParam(opts.sessionId)}`
          : sql`and s.clock_correction_ms is null
      and extract(epoch from (s.ended_at - s.started_at))
          > s.sample_count::float / greatest(coalesce(s.rate_hz, 1), 1) + ${minSecs}::int`
      }
      ${opts.after ? sql`and s.started_at > ${tsParam(opts.after)}` : sql``}
    order by s.started_at asc
    limit ${opts.limit + 1}`;
}

async function readTelemetryBounds(exec: ExecutesSql, sessionId: string): Promise<SessionBounds> {
  const res = (await exec.execute(
    sql`select started_at, ended_at from telemetry_sessions where id = ${uuidParam(sessionId)}`,
  )) as unknown as { rows?: { started_at: string; ended_at: string | null }[] };
  const row = res.rows?.[0];
  if (!row) throw new Error(`telemetry session ${sessionId} vanished during backfill`);
  const startedAt = isoFromDb(row.started_at) as string;
  const endedAt = isoFromDb(row.ended_at);
  return { startedAt, endedAt, spanMs: endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : 0 };
}

/** Pure: the bounds a dry run predicts after a telemetry step of `shiftMs` (every file before it shifts, the end holds). */
export function predictTelemetryBounds(before: SessionBounds, shiftMs: number): SessionBounds {
  const startedAt = new Date(new Date(before.startedAt).getTime() + shiftMs).toISOString();
  return {
    startedAt,
    endedAt: before.endedAt,
    spanMs: before.endedAt ? new Date(before.endedAt).getTime() - new Date(startedAt).getTime() : 0,
  };
}

async function backfillTelemetry(
  opts: ClockStepBackfillOptions,
): Promise<{ scanned: number; candidates: TelemetryClockStepCandidate[]; truncated: boolean; nextAfter: string | null }> {
  const limit = opts.limit ?? 10;
  const minStepMs = recordingConfig.clockStepMinMs;
  const res = (await db.execute(
    telemetryScanSql({ sessionId: opts.sessionId, minStepMs, limit, after: opts.after }),
  )) as unknown as { rows?: TelemetryScanRow[] };
  const rows = res.rows ?? [];
  const truncated = rows.length > limit;
  const work = truncated ? rows.slice(0, limit) : rows;
  const candidates: TelemetryClockStepCandidate[] = [];
  const seg = schema.telemetrySegments;

  for (const s of work) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) break;
    const segments = await db
      .select({ s3Key: seg.s3Key, seq: seg.seq, bytes: seg.bytes })
      .from(seg)
      .where(eq(seg.sessionId, s.id))
      .orderBy(asc(seg.seq));
    let correctionMs: number | null = s.clock_correction_ms === null ? null : Number(s.clock_correction_ms);
    let before: SessionBounds = {
      startedAt: isoFromDb(s.started_at) as string,
      endedAt: isoFromDb(s.ended_at),
      spanMs: s.ended_at ? new Date(isoFromDb(s.ended_at) as string).getTime() - new Date(isoFromDb(s.started_at) as string).getTime() : 0,
    };

    for (const file of segments) {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) break;
      const obj = await readSegmentObject(opts.bucket, file.s3Key);
      if (!obj) continue; // lifecycle removed it; nothing to correct
      const parse = (text: string, detect: boolean) =>
        parseSegment(text, {
          deviceId: s.device_id,
          now: Date.now(),
          // Backfill: every line counts (the readings UPDATE matches by exact
          // ts, so an out-of-partition line simply matches nothing).
          maxAgeMs: Number.MAX_SAFE_INTEGER,
          maxFutureMs: Number.MAX_SAFE_INTEGER,
          ...(detect ? { clockStepMinMs: minStepMs } : {}),
        });
      const parsed = parse(obj.text, true);
      const base = {
        deviceId: s.device_id,
        deviceName: s.device_name,
        sessionId: s.id,
        seq: Number(file.seq),
      };
      if (parsed.clockSteps.length === 0) {
        if (obj.meta?.own && correctionMs === null) {
          // An earlier attempt rewrote the object but never committed the DB
          // half, and the step file's own stale ts are no longer recoverable
          // from its content: leave it to an operator rather than guess.
          candidates.push({
            ...base,
            steps: obj.meta.own.steps,
            totalShiftMs: obj.meta.own.shiftMs,
            earlierFiles: 0,
            before,
            after: before,
            applied: false,
            error: 'object already rewritten (x-amz-meta-xg-clock-step.own) but the session was never corrected; inspect manually',
          });
        }
        continue;
      }
      const shiftMs = totalTelemetryShiftMs(parsed.clockSteps);
      const earlierRows = (await db.execute(
        sql`select count(*)::int as n from telemetry_segments
            where session_id = ${uuidParam(s.id)} and seq < ${Number(file.seq)}::int
              and start_ts <= ${tsParam(new Date(parsed.rawFirstTs as number).toISOString())}`,
      )) as unknown as { rows?: { n: number }[] };
      const candidate: TelemetryClockStepCandidate = {
        ...base,
        steps: parsed.clockSteps,
        totalShiftMs: shiftMs,
        earlierFiles: Number(earlierRows.rows?.[0]?.n ?? 0),
        before,
        after: predictTelemetryBounds(before, shiftMs),
        applied: false,
      };
      if (opts.dryRun) {
        candidates.push(candidate);
        before = candidate.after; // a second step file in the same session predicts from here
        continue;
      }
      try {
        // Phase 1 (S3): rewrite this object + shift the earlier files; the
        // session state is irrelevant here (a step file is never a straggler).
        const prepared = await prepareTelemetryClockStep({
          bucket: opts.bucket,
          key: file.s3Key,
          sessionId: s.id,
          seq: Number(file.seq),
          text: obj.text,
          meta: obj.meta,
          parsed,
          session: null,
          reparse: (text) => parse(text, false),
        });
        if (!prepared) throw new Error('prepareTelemetryClockStep returned no plan for a file with steps');
        const selfBytes = prepared.bytes ?? Number(file.bytes);
        const self: SegmentShift = {
          s3Key: file.s3Key,
          firstTs: prepared.parsed.firstTs,
          lastTs: prepared.parsed.lastTs,
          bytes: selfBytes,
          bytesDelta: selfBytes - Number(file.bytes),
          staleTsGroups: prepared.parsed.staleTsGroups,
          rewritten: prepared.rewroteSelf,
        };
        // Phase 2 (DB), one transaction: earlier files first (seq order), then
        // this file, then the session roll-up + audit columns.
        const moved = await db.transaction(async (tx) => {
          const r = await applyTelemetryClockStep(tx, {
            sessionId: s.id,
            deviceId: s.device_id,
            files: [...prepared.earlier, self],
            shiftMs: prepared.shiftMs,
            staleBefore: prepared.staleBefore,
          });
          candidate.after = await readTelemetryBounds(tx, s.id);
          return r.readingsMoved;
        });
        candidate.applied = true;
        correctionMs = (correctionMs ?? 0) + prepared.shiftMs;
        before = candidate.after;
        console.log('clock-step-backfill: telemetry session corrected', {
          sessionId: s.id,
          seq: candidate.seq,
          steps: prepared.steps,
          shiftMs: prepared.shiftMs,
          earlierFiles: prepared.earlier.length,
          readingsMoved: moved,
          before: candidate.before,
          after: candidate.after,
        });
      } catch (err) {
        candidate.error = (err as Error).message;
        console.error('clock-step-backfill: telemetry session failed', { sessionId: s.id, seq: candidate.seq, err });
      }
      candidates.push(candidate);
    }
  }
  const last = work[work.length - 1];
  return { scanned: work.length, candidates, truncated, nextAfter: last ? isoFromDb(last.started_at) : null };
}

export async function runClockStepBackfill(opts: ClockStepBackfillOptions): Promise<ClockStepBackfillResult> {
  const media = opts.telemetryOnly
    ? { scanned: 0, candidates: [] as MediaClockStepCandidate[], truncated: false, nextAfter: null as string | null }
    : await backfillMedia(opts);
  const telemetry = opts.mediaOnly
    ? { scanned: 0, candidates: [] as TelemetryClockStepCandidate[], truncated: false, nextAfter: null as string | null }
    : await backfillTelemetry(opts);
  // One cursor for both scans: the driver re-runs with the SMALLER of the two
  // so neither kind skips rows; a kind already past it just rescans a little.
  const cursors = [media.nextAfter, telemetry.nextAfter].filter((c): c is string => c !== null);
  return {
    dryRun: opts.dryRun,
    media: { scanned: media.scanned, candidates: media.candidates },
    telemetry: { scanned: telemetry.scanned, candidates: telemetry.candidates },
    truncated: media.truncated || telemetry.truncated,
    nextAfter: cursors.length ? cursors.sort()[0] : null,
  };
}

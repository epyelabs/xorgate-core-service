import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { recordingConfig } from '../config/recording';
import { nominalSegmentMs } from './clock-step';
import {
  applyMediaClockStep,
  correctInflatedSegmentRowSql,
  planMediaSegment,
  type ExecutesSql,
} from './media-clock-step';
import { uuidParam } from '../utils/sql';

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
  /** Candidates per call (per kind); the driver re-runs when `truncated`. */
  limit?: number;
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

function mediaScanSql(opts: { sessionId?: string; minStepMs: number; limit: number }) {
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

async function backfillMedia(opts: ClockStepBackfillOptions): Promise<{ scanned: number; candidates: MediaClockStepCandidate[]; truncated: boolean }> {
  const limit = opts.limit ?? 50;
  const minStepMs = recordingConfig.clockStepMinMs;
  const res = (await db.execute(mediaScanSql({ sessionId: opts.sessionId, minStepMs, limit }))) as unknown as { rows?: MediaScanRow[] };
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
  return { scanned: work.length, candidates, truncated };
}

export async function runClockStepBackfill(opts: ClockStepBackfillOptions): Promise<ClockStepBackfillResult> {
  const media = opts.telemetryOnly
    ? { scanned: 0, candidates: [] as MediaClockStepCandidate[], truncated: false }
    : await backfillMedia(opts);
  // Telemetry half: wired in P2's follow-up commit (services/telemetry-clock-step.ts).
  const telemetry = { scanned: 0, candidates: [] as TelemetryClockStepCandidate[], truncated: false };
  return {
    dryRun: opts.dryRun,
    media: { scanned: media.scanned, candidates: media.candidates },
    telemetry: { scanned: telemetry.scanned, candidates: telemetry.candidates },
    truncated: media.truncated || telemetry.truncated,
  };
}

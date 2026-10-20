import { sql, type SQL } from 'drizzle-orm';
import { detectMediaClockStep, isStaleStraggler, shiftTs } from './clock-step';
import { jsonbParam, tsParam, uuidParam } from '../utils/sql';

/**
 * Media clock-step correction (plans/clock-step-correction PLAN §4.2), the
 * half that knows about media rows. Two layers:
 *
 *  - `planMediaSegment` (pure): sidecar timing + nominal length + the
 *    session's correction state → the values the new media_segments row is
 *    inserted with, its `meta.clockStep` audit object, and whether a new step
 *    must be propagated to the rows already stored. Unit-tested in
 *    test/media-clock-step.test.ts.
 *  - `applyMediaClockStep` / `correctInflatedSegmentRowSql` (in-transaction
 *    SQL): shift every row stamped before a step, re-derive the session
 *    bounds, record the audit columns. Shared by the ingest Lambda
 *    (handlers/media-segment-ingest.ts) and the P3 backfill.
 *
 * RDS Data API rules: the caller runs these on a `tx` and awaits each one
 * before the next (no Promise.all); timestamps go through tsParam(), ids
 * through uuidParam(), integers carry an explicit ::bigint cast, jsonb is
 * built server-side with jsonb_build_object or bound through jsonbParam().
 */

/** The session columns the plan reads (`media_sessions`, D9/D10). */
export interface MediaSessionClockState {
  clockCorrectionMs: number | null;
  clockStaleBefore: Date | null;
}

export interface PlanMediaSegmentInput {
  /** Raw sidecar start (stale when the device booted on a fake-hwclock stamp). */
  startTs: Date;
  /** Raw sidecar duration (`mtime − birthtime`; inflated by a step). */
  durationMs: number;
  finalized: boolean;
  /** `nominalSegmentMs(device.recordingConfig)`. */
  nominalMs: number;
  /** `recordingConfig.clockStepMinMs`. */
  minStepMs: number;
  /** `recordingConfig.clockStepCorrection` (D13 kill switch). */
  enabled: boolean;
  /** The session row as stored; null when this delivery creates it (no correction yet). */
  session: MediaSessionClockState | null;
}

/** A step that must be pushed onto the rows already stored (§4.2 steps 3-4). */
export interface MediaStepToApply {
  stepMs: number;
  /** The inflated segment's raw start: every row at or before it is pre-step. */
  rawStartTs: Date;
  nominalMs: number;
}

export interface MediaSegmentPlan {
  /**
   * - `none`: untouched (normal segment, or the kill switch is off);
   * - `step`: finalized inflated segment, shifted + clamped, `step` set (D2/D3);
   * - `clamp`: crash-cut inflated segment, clamped only (D5);
   * - `straggler`: pre-step segment arriving after the step, shifted by the
   *   session's accumulated correction (D10).
   */
  kind: 'none' | 'step' | 'clamp' | 'straggler';
  /** Values to insert / roll the session window forward with (CORRECTED). */
  startTs: Date;
  durationMs: number;
  segmentEnd: Date;
  /** `meta.clockStep` for the new row; null = no key added. */
  clockStep: Record<string, unknown> | null;
  /** Non-null only for `kind: 'step'`. */
  step: MediaStepToApply | null;
  rawStartTs: Date;
  rawDurationMs: number;
}

/**
 * Decide how one uploaded segment is stored. Precedence:
 *  1. kill switch off → `none` (the manifest cap, D14, still guards reads);
 *  2. D10 straggler (raw start below the session's `clock_stale_before`) →
 *     shift by `clock_correction_ms`; an inflated straggler is also clamped to
 *     nominal but starts no new step (its step is the one already applied);
 *  3. D3/D4 finalized inflated → shift by `rawDuration − nominal`, clamp;
 *  4. D5 crash-cut inflated → clamp only;
 *  5. otherwise `none`.
 */
export function planMediaSegment(input: PlanMediaSegmentInput): MediaSegmentPlan {
  const rawStartTs = input.startTs;
  const rawDurationMs = input.durationMs;
  const unchanged: MediaSegmentPlan = {
    kind: 'none',
    startTs: rawStartTs,
    durationMs: rawDurationMs,
    segmentEnd: shiftTs(rawStartTs, rawDurationMs),
    clockStep: null,
    step: null,
    rawStartTs,
    rawDurationMs,
  };
  if (!input.enabled) return unchanged;

  const detected = detectMediaClockStep(
    { durationMs: rawDurationMs, finalized: input.finalized },
    input.nominalMs,
    input.minStepMs,
  );

  if (input.session && isStaleStraggler(rawStartTs.getTime(), input.session)) {
    const shiftMs = input.session.clockCorrectionMs as number;
    const startTs = shiftTs(rawStartTs, shiftMs);
    const durationMs = detected ? detected.durationMs : rawDurationMs;
    return {
      kind: 'straggler',
      startTs,
      durationMs,
      segmentEnd: shiftTs(startTs, durationMs),
      clockStep: {
        stepMs: shiftMs,
        shifted: true,
        rawStartTs: rawStartTs.toISOString(),
        ...(detected ? { rawDurationMs } : {}),
      },
      step: null,
      rawStartTs,
      rawDurationMs,
    };
  }

  if (!detected) return unchanged;

  if (detected.clampedOnly) {
    return {
      kind: 'clamp',
      startTs: rawStartTs,
      durationMs: detected.durationMs,
      segmentEnd: shiftTs(rawStartTs, detected.durationMs),
      clockStep: { clampedOnly: true, rawDurationMs },
      step: null,
      rawStartTs,
      rawDurationMs,
    };
  }

  const startTs = shiftTs(rawStartTs, detected.stepMs);
  return {
    kind: 'step',
    startTs,
    durationMs: detected.durationMs,
    segmentEnd: shiftTs(startTs, detected.durationMs),
    clockStep: {
      stepMs: detected.stepMs,
      rawStartTs: rawStartTs.toISOString(),
      rawDurationMs,
    },
    step: { stepMs: detected.stepMs, rawStartTs, nominalMs: input.nominalMs },
    rawStartTs,
    rawDurationMs,
  };
}

/** The slice of a drizzle transaction handle these statements need. */
export interface ExecutesSql {
  execute(query: SQL): Promise<unknown>;
}

export interface ApplyMediaClockStepInput {
  sessionId: string;
  /** The inflated segment's own row (already stored corrected): excluded from the shift. */
  segmentRowId: string;
  rawStartTs: Date;
  stepMs: number;
  nominalMs: number;
}

/**
 * §4.2 step 3: every OTHER row of the session stamped at or before the
 * inflated segment's raw start is late by `stepMs`: shift it and merge
 * `{ stepMs: <cumulative>, shifted: true }` into its `meta.clockStep`
 * (existing clockStep keys, e.g. a straggler's `rawStartTs`, are kept).
 */
export function shiftEarlierSegmentsSql(input: ApplyMediaClockStepInput): SQL {
  const step = sql`${input.stepMs}::bigint`;
  return sql`update media_segments
    set start_ts = start_ts + ${step} * interval '1 millisecond',
        meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end)
          || jsonb_build_object(
               'clockStep',
               (case when jsonb_typeof(meta->'clockStep') = 'object' then meta->'clockStep' else '{}'::jsonb end)
                 || jsonb_build_object(
                      'stepMs', coalesce((meta->'clockStep'->>'stepMs')::bigint, 0) + ${step},
                      'shifted', true))
    where session_id = ${uuidParam(input.sessionId)}
      and start_ts <= ${tsParam(input.rawStartTs.toISOString())}
      and id <> ${uuidParam(input.segmentRowId)}`;
}

/**
 * §4.2 step 4: re-derive the session window from its (now shifted) rows (a
 * least/greatest roll-forward would keep the stale start) and record the
 * audit columns (D9): `clock_correction_ms` accumulates (D11),
 * `clock_stale_before` = raw start + nominal = the raw instant below which a
 * late segment is still on the stale clock (D10).
 */
export function recomputeSessionAfterStepSql(input: ApplyMediaClockStepInput): SQL {
  const sid = uuidParam(input.sessionId);
  const staleBefore = new Date(input.rawStartTs.getTime() + input.nominalMs).toISOString();
  return sql`update media_sessions
    set started_at = coalesce((select min(s.start_ts) from media_segments s where s.session_id = ${sid}), started_at),
        ended_at = coalesce(
          (select max(s.start_ts + s.duration_ms * interval '1 millisecond') from media_segments s where s.session_id = ${sid}),
          ended_at),
        clock_correction_ms = coalesce(clock_correction_ms, 0) + ${input.stepMs}::bigint,
        clock_stale_before = ${tsParam(staleBefore)},
        clock_corrected_at = now()
    where id = ${sid}`;
}

/**
 * Propagate a detected step (§4.2 steps 3 then 4, sequential). The caller has
 * already stored the inflated segment corrected (ingest: inserted shifted +
 * clamped; backfill: `correctInflatedSegmentRowSql` first).
 */
export async function applyMediaClockStep(tx: ExecutesSql, input: ApplyMediaClockStepInput): Promise<void> {
  await tx.execute(shiftEarlierSegmentsSql(input));
  await tx.execute(recomputeSessionAfterStepSql(input));
}

/**
 * Backfill helper (P3): correct an inflated row ingested before this plan in
 * place, exactly as ingest would have inserted it (`plan.startTs`,
 * `plan.durationMs`, `meta.clockStep = plan.clockStep`). Guarded on
 * `meta.clockStep` being absent so a re-run is a no-op; returns the SQL so the
 * caller can read the affected-row count from its driver result.
 */
export function correctInflatedSegmentRowSql(input: {
  segmentRowId: string;
  startTs: Date;
  durationMs: number;
  clockStep: Record<string, unknown>;
}): SQL {
  return sql`update media_segments
    set start_ts = ${tsParam(input.startTs.toISOString())},
        duration_ms = ${input.durationMs}::int,
        meta = (case when jsonb_typeof(meta) = 'object' then meta else '{}'::jsonb end)
          || jsonb_build_object('clockStep', ${jsonbParam(input.clockStep)})
    where id = ${uuidParam(input.segmentRowId)}
      and (meta is null or meta->'clockStep' is null)`;
}

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  applyMediaClockStep,
  correctInflatedSegmentRowSql,
  planMediaSegment,
  type PlanMediaSegmentInput,
} from '../src/services/media-clock-step';

// Real prod shape (plans/clock-step-correction §1): Tacloban 04 session
// 01a14919-c536-7056-8107-2c3dbd738f8f. seq 0 is boundary-anchored at
// 09:03:10.471Z (60 000 ms); seq 1 was open across a ~66 min NTP step and
// reports 4 012 833 ms from a stale 09:04:10.471Z; seq 2 starts (real clock)
// at 10:11:03.304Z.
const SEQ1_RAW = new Date('2026-10-17T09:04:10.471Z');
const SEQ1_RAW_DURATION = 4_012_833;
const SEQ2_REAL = new Date('2026-10-17T10:11:03.304Z');
const NOMINAL = 60_000;
const MIN = 10_000;
const STEP = SEQ1_RAW_DURATION - NOMINAL; // 3 952 833

function input(partial: Partial<PlanMediaSegmentInput> = {}): PlanMediaSegmentInput {
  return {
    startTs: SEQ1_RAW,
    durationMs: SEQ1_RAW_DURATION,
    finalized: true,
    nominalMs: NOMINAL,
    minStepMs: MIN,
    enabled: true,
    session: null,
    ...partial,
  };
}

describe('planMediaSegment', () => {
  it('normal segment: stored as the sidecar says, no audit key, no step', () => {
    const p = planMediaSegment(input({ durationMs: 59_981 }));
    expect(p.kind).toBe('none');
    expect(p.startTs).toEqual(SEQ1_RAW);
    expect(p.durationMs).toBe(59_981);
    expect(p.segmentEnd).toEqual(new Date(SEQ1_RAW.getTime() + 59_981));
    expect(p.clockStep).toBeNull();
    expect(p.step).toBeNull();
  });

  it('a long-but-plausible segment (67.7 s, the max ever seen) is not a step', () => {
    expect(planMediaSegment(input({ durationMs: 67_729 })).kind).toBe('none');
  });

  it('finalized inflated (Tacloban 04 seq 1): shifted by the step, clamped to nominal, ends exactly at seq 2', () => {
    const p = planMediaSegment(input());
    expect(p.kind).toBe('step');
    expect(p.step).toEqual({ stepMs: STEP, rawStartTs: SEQ1_RAW, nominalMs: NOMINAL });
    expect(p.startTs.toISOString()).toBe('2026-10-17T10:10:03.304Z');
    expect(p.durationMs).toBe(NOMINAL);
    expect(p.segmentEnd).toEqual(SEQ2_REAL);
    expect(p.clockStep).toEqual({
      stepMs: STEP,
      rawStartTs: '2026-10-17T09:04:10.471Z',
      rawDurationMs: SEQ1_RAW_DURATION,
    });
    expect(p.rawStartTs).toEqual(SEQ1_RAW);
    expect(p.rawDurationMs).toBe(SEQ1_RAW_DURATION);
  });

  it('crash-cut inflated (D5): clamped to nominal, NOT shifted, no step to propagate', () => {
    const p = planMediaSegment(input({ finalized: false }));
    expect(p.kind).toBe('clamp');
    expect(p.startTs).toEqual(SEQ1_RAW);
    expect(p.durationMs).toBe(NOMINAL);
    expect(p.segmentEnd).toEqual(new Date(SEQ1_RAW.getTime() + NOMINAL));
    expect(p.clockStep).toEqual({ clampedOnly: true, rawDurationMs: SEQ1_RAW_DURATION });
    expect(p.step).toBeNull();
  });

  it('D10 straggler: seq 0 arriving after the step is shifted by the session correction', () => {
    const seq0Raw = new Date('2026-10-17T09:03:10.471Z');
    const session = {
      clockCorrectionMs: STEP,
      clockStaleBefore: new Date(SEQ1_RAW.getTime() + NOMINAL),
    };
    const p = planMediaSegment(input({ startTs: seq0Raw, durationMs: 60_000, session }));
    expect(p.kind).toBe('straggler');
    expect(p.startTs).toEqual(new Date(seq0Raw.getTime() + STEP));
    expect(p.startTs.toISOString()).toBe('2026-10-17T10:09:03.304Z');
    expect(p.durationMs).toBe(60_000);
    expect(p.clockStep).toEqual({ stepMs: STEP, shifted: true, rawStartTs: '2026-10-17T09:03:10.471Z' });
    expect(p.step).toBeNull();
  });

  it('a post-step segment on a corrected session is left alone', () => {
    const session = { clockCorrectionMs: STEP, clockStaleBefore: new Date(SEQ1_RAW.getTime() + NOMINAL) };
    const p = planMediaSegment(input({ startTs: SEQ2_REAL, durationMs: 59_990, session }));
    expect(p.kind).toBe('none');
    expect(p.startTs).toEqual(SEQ2_REAL);
  });

  it('an inflated straggler is clamped and shifted by the existing correction, starting no new step', () => {
    const session = { clockCorrectionMs: STEP, clockStaleBefore: new Date(SEQ1_RAW.getTime() + NOMINAL) };
    const raw = new Date('2026-10-17T09:00:00.000Z');
    const p = planMediaSegment(input({ startTs: raw, durationMs: 200_000, session }));
    expect(p.kind).toBe('straggler');
    expect(p.durationMs).toBe(NOMINAL);
    expect(p.startTs).toEqual(new Date(raw.getTime() + STEP));
    expect(p.clockStep).toMatchObject({ stepMs: STEP, shifted: true, rawDurationMs: 200_000 });
    expect(p.step).toBeNull();
  });

  it('a second step on an already-corrected session (D11) is a new step', () => {
    const session = { clockCorrectionMs: STEP, clockStaleBefore: new Date(SEQ1_RAW.getTime() + NOMINAL) };
    const raw = new Date('2026-10-17T10:20:00.000Z');
    const p = planMediaSegment(input({ startTs: raw, durationMs: 75_000, session }));
    expect(p.kind).toBe('step');
    expect(p.step?.stepMs).toBe(15_000);
  });

  it('kill switch off (D13): everything is stored raw, stragglers included', () => {
    expect(planMediaSegment(input({ enabled: false })).kind).toBe('none');
    const session = { clockCorrectionMs: STEP, clockStaleBefore: new Date(SEQ1_RAW.getTime() + NOMINAL) };
    const p = planMediaSegment(
      input({ enabled: false, startTs: new Date('2026-10-17T09:03:10.471Z'), durationMs: 60_000, session }),
    );
    expect(p.kind).toBe('none');
    expect(p.durationMs).toBe(60_000);
  });

  it('honours a non-default nominal (30 s segments)', () => {
    const p = planMediaSegment(input({ durationMs: 95_000, nominalMs: 30_000 }));
    expect(p.kind).toBe('step');
    expect(p.step?.stepMs).toBe(65_000);
    expect(p.durationMs).toBe(30_000);
  });
});

// The in-transaction SQL, rendered the way drizzle hands it to the driver:
// checks the statements run in order, one at a time, and that every value is
// a bound param with the cast the Data API needs.
describe('applyMediaClockStep', () => {
  const dialect = new PgDialect();
  const SID = '01a14919-c536-7056-8107-2c3dbd738f8f';
  const ROW = '01a1491a-0000-7000-8000-000000000001';

  async function capture() {
    const calls: { sql: string; params: unknown[] }[] = [];
    let inFlight = 0;
    const tx = {
      execute: async (q: SQL) => {
        inFlight++;
        expect(inFlight).toBe(1); // strictly sequential (RDS Data API)
        calls.push(dialect.sqlToQuery(q));
        await Promise.resolve();
        inFlight--;
        return { rows: [] };
      },
    };
    await applyMediaClockStep(tx, {
      sessionId: SID,
      segmentRowId: ROW,
      rawStartTs: SEQ1_RAW,
      stepMs: STEP,
      nominalMs: NOMINAL,
    });
    return calls;
  }

  it('shifts the earlier rows first (cumulative stepMs merged into meta.clockStep), then re-derives the session', async () => {
    const [shift, session] = await capture();
    expect(shift.sql).toMatch(/^update media_segments/);
    expect(shift.sql).toContain("start_ts = start_ts + $1::bigint * interval '1 millisecond'");
    expect(shift.sql).toContain("coalesce((meta->'clockStep'->>'stepMs')::bigint, 0) + $2::bigint");
    expect(shift.sql).toContain("'shifted', true");
    expect(shift.sql).toContain('session_id = $3::uuid');
    expect(shift.sql).toContain('start_ts <= $4::timestamptz');
    expect(shift.sql).toContain('id <> $5::uuid');
    expect(shift.params).toEqual([STEP, STEP, SID, '2026-10-17T09:04:10.471Z', ROW]);

    expect(session.sql).toMatch(/^update media_sessions/);
    expect(session.sql).toContain('min(s.start_ts)');
    expect(session.sql).toContain("max(s.start_ts + s.duration_ms * interval '1 millisecond')");
    expect(session.sql).toContain('clock_correction_ms = coalesce(clock_correction_ms, 0) + $');
    expect(session.sql).toContain('clock_corrected_at = now()');
    // clock_stale_before = raw start + nominal
    expect(session.params).toContain('2026-10-17T09:05:10.471Z');
    expect(session.params).toContain(STEP);
    expect(session.params.filter((p) => p === SID)).toHaveLength(3);
  });

  it('backfill row correction is guarded on meta.clockStep being absent (re-run = no-op)', () => {
    const plan = planMediaSegment(input());
    const q = dialect.sqlToQuery(
      correctInflatedSegmentRowSql({
        segmentRowId: ROW,
        startTs: plan.startTs,
        durationMs: plan.durationMs,
        clockStep: plan.clockStep!,
      }),
    );
    expect(q.sql).toContain("meta->'clockStep' is null");
    expect(q.sql).toContain('$3::jsonb');
    expect(q.params).toEqual([
      '2026-10-17T10:10:03.304Z',
      NOMINAL,
      JSON.stringify(plan.clockStep),
      ROW,
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CONTIGUITY_SLACK_MS,
  buildSessionTimeline,
  type ReplaySegmentInput,
} from '../src/services/replay-manifest';

// Fixtures model REAL dev fodder pathologies (spike/manifests/*.json):
// rotation seams with slight overlap (~59.98 s wall delta vs 60.0 s media),
// fstat-anchored heads (~62 s), the 180 s eviction hole after seq 6 in
// 019f8fba-03cd…, and the finalized=false crash artifact in 019f8f6f-….
const T0 = 1784822760716; // real cam0 session start (epoch ms)

function seg(partial: Partial<ReplaySegmentInput> & { seq: number; startTs: number }): ReplaySegmentInput {
  return {
    durationMs: 59990,
    finalized: true,
    sizeBytes: 14_000_000,
    s3Key: `media-sessions/v1/dev/cam0/session/${String(partial.seq).padStart(5, '0')}.mp4`,
    meta: { anchor: 'computed' },
    ...partial,
    startTs: new Date(partial.startTs),
  };
}

describe('buildSessionTimeline', () => {
  it('returns null for an empty segment list', () => {
    expect(buildSessionTimeline([])).toBeNull();
  });

  it('contiguous rotation seams: effective duration = next-startTs delta, even when it overlaps media duration', () => {
    // Real seam anatomy: wall delta ~59.98 s vs 60.0 s durationMs (tiny overlap).
    const t = buildSessionTimeline([
      seg({ seq: 0, startTs: T0, durationMs: 60000 }),
      seg({ seq: 1, startTs: T0 + 59983, durationMs: 60000 }),
      seg({ seq: 2, startTs: T0 + 59983 + 59996, durationMs: 59991 }),
    ])!;
    expect(t.segments.map((s) => s.effectiveDurationMs)).toEqual([59983, 59996, 59991]);
    expect(t.gaps).toEqual([]);
    expect(t.fromTs).toBe(T0);
    expect(t.toTs).toBe(T0 + 59983 + 59996 + 59991);
    expect(t.outOfOrder).toBe(false);
  });

  it('fstat head: 62 s delta within durationMs + slack stays contiguous (delta wins)', () => {
    // Real seq-0 rows: fstat anchor inflates BOTH startTs-back and durationMs
    // (~61996), so the 62 s first delta is still delta ≤ durationMs + 2 s.
    const t = buildSessionTimeline([
      seg({ seq: 0, startTs: T0, durationMs: 61992, meta: { anchor: 'fstat' } }),
      seg({ seq: 1, startTs: T0 + 61992, durationMs: 59984 }),
    ])!;
    expect(t.segments[0].effectiveDurationMs).toBe(61992);
    expect(t.segments[0].anchor).toBe('fstat');
    expect(t.gaps).toEqual([]);
  });

  it('eviction hole: falls back to durationMs and emits exactly one gap (real 180 s hole shape)', () => {
    // Modeled on 019f8fba-03cd…: seqs 6 → 10, 179958 ms hole.
    const s6End = T0 + 59991;
    const t = buildSessionTimeline([
      seg({ seq: 6, startTs: T0, durationMs: 59991 }),
      seg({ seq: 10, startTs: s6End + 179958, durationMs: 59988 }),
      seg({ seq: 11, startTs: s6End + 179958 + 59985, durationMs: 59990 }),
    ])!;
    expect(t.segments[0].effectiveDurationMs).toBe(59991);
    expect(t.gaps).toEqual([
      { fromTs: s6End, toTs: s6End + 179958, reason: 'missing-segments' },
    ]);
    // Zero-drift invariant the spike measured on all 4 real sessions:
    // summed effective + gap total === wall span.
    const summed = t.segments.reduce((a, s) => a + s.effectiveDurationMs, 0);
    const gapTotal = t.gaps.reduce((a, g) => a + (g.toTs - g.fromTs), 0);
    expect(summed + gapTotal).toBe(t.toTs - t.fromTs);
  });

  it('crash-cut segment never bridges: keeps durationMs and sub-slack holes emit no gap', () => {
    // Device restarted ~1.5 s after the cut — the hole is absorbed client-side
    // by the micro-gap jump, not declared a manifest gap.
    const t = buildSessionTimeline([
      seg({ seq: 3, startTs: T0, durationMs: 31000, finalized: false }),
      seg({ seq: 0, startTs: T0 + 32500, durationMs: 59990 }),
    ])!;
    expect(t.segments[0].effectiveDurationMs).toBe(31000);
    expect(t.segments[0].finalized).toBe(false);
    expect(t.gaps).toEqual([]);
  });

  it('crash-cut segment with a large hole emits the gap from the cut, not the nominal end', () => {
    const t = buildSessionTimeline([
      seg({ seq: 3, startTs: T0, durationMs: 31000, finalized: false }),
      seg({ seq: 0, startTs: T0 + 300000, durationMs: 59990 }),
    ])!;
    expect(t.gaps).toEqual([
      { fromTs: T0 + 31000, toTs: T0 + 300000, reason: 'missing-segments' },
    ]);
  });

  it('trailing crash-cut segment (real 019f8f6f shape) uses its own durationMs', () => {
    const t = buildSessionTimeline([
      seg({ seq: 12, startTs: T0, durationMs: 59992 }),
      seg({ seq: 13, startTs: T0 + 59992, durationMs: 41500, finalized: false }),
    ])!;
    expect(t.segments[1].effectiveDurationMs).toBe(41500);
    expect(t.toTs).toBe(T0 + 59992 + 41500);
  });

  it('single-segment session', () => {
    const t = buildSessionTimeline([seg({ seq: 0, startTs: T0, durationMs: 59990 })])!;
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].effectiveDurationMs).toBe(59990);
    expect(t.fromTs).toBe(T0);
    expect(t.toTs).toBe(T0 + 59990);
    expect(t.gaps).toEqual([]);
  });

  it('out-of-order startTs: sorts by startTs (never seq) and flags it', () => {
    const rows = [
      seg({ seq: 5, startTs: T0 + 59990, durationMs: 59990 }),
      seg({ seq: 4, startTs: T0, durationMs: 59990 }),
    ];
    const t = buildSessionTimeline(rows)!;
    expect(t.outOfOrder).toBe(true);
    expect(t.segments.map((s) => s.seq)).toEqual([4, 5]);
    const sorted = buildSessionTimeline([rows[1], rows[0]])!;
    expect(sorted.outOfOrder).toBe(false);
    expect(sorted.segments).toEqual(t.segments);
  });

  it('evicted head: sessionStartedAt before the first surviving segment yields a leading gap', () => {
    const startedAt = T0 - 240000; // four head segments expired by retention
    const t = buildSessionTimeline(
      [seg({ seq: 4, startTs: T0, durationMs: 59990 })],
      { sessionStartedAt: new Date(startedAt) },
    )!;
    expect(t.gaps).toEqual([{ fromTs: startedAt, toTs: T0, reason: 'evicted-head' }]);
    expect(t.fromTs).toBe(startedAt);
    expect(t.toTs).toBe(T0 + 59990);
  });

  it('sessionStartedAt within slack of the first segment yields no leading gap', () => {
    const t = buildSessionTimeline(
      [seg({ seq: 0, startTs: T0, durationMs: 59990 })],
      { sessionStartedAt: new Date(T0 - CONTIGUITY_SLACK_MS) },
    )!;
    expect(t.gaps).toEqual([]);
    expect(t.fromTs).toBe(T0);
  });

  it('non-positive delta (duplicate startTs) falls back to durationMs without a gap', () => {
    const t = buildSessionTimeline([
      seg({ seq: 0, startTs: T0, durationMs: 59990 }),
      seg({ seq: 1, startTs: T0, durationMs: 59990 }),
    ])!;
    expect(t.segments.map((s) => s.effectiveDurationMs)).toEqual([59990, 59990]);
    expect(t.gaps).toEqual([]);
  });

  it('passes anchor/sizeBytes/finalized through and tolerates null meta', () => {
    const t = buildSessionTimeline([
      seg({ seq: 0, startTs: T0, meta: null, sizeBytes: null }),
    ])!;
    expect(t.segments[0].anchor).toBeNull();
    expect(t.segments[0].sizeBytes).toBeNull();
  });
});

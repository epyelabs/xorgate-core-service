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

// ---------------------------------------------------------------------------
// Telemetry block (telemetry-session-artifacts plan, Phase 2)
// ---------------------------------------------------------------------------

import {
  buildTelemetryManifest,
  REPLAY_TELEMETRY_MAX_SEGMENTS,
  telemetrySegmentOverlaps,
  telemetrySessionOverlaps,
  type TelemetrySegmentInput,
  type TelemetrySessionInput,
} from '../src/services/replay-manifest';

// Modelled on the real dev drive 019fe89f (Toronto Node 01): 1 Hz, 60 s
// segments, a 25 km drive whose session row spans the recorded samples.
const S0 = 1786314223040;
const MIN = 60_000;

function tsession(
  partial: Partial<TelemetrySessionInput> & { id: string; startedAt: number; endedAt?: number | null },
): TelemetrySessionInput {
  return {
    status: 'closed',
    rateHz: 1,
    timeSource: 'ntp',
    overviewKey: `telemetry/v1/dev/${partial.id}/overview.v1.json.gz`,
    overviewBuiltAt: new Date(S0 + 3 * 60 * MIN),
    overviewBytes: 23579,
    insights: { computed: { distance: 1 }, computedAt: S0, events: [], distance: { meters: 25181.6 } },
    ...partial,
    startedAt: new Date(partial.startedAt),
    endedAt: partial.endedAt === null ? null : new Date(partial.endedAt ?? partial.startedAt + 45 * MIN),
  };
}

function tseg(
  sessionId: string,
  seq: number,
  startTs: number,
  partial: Partial<TelemetrySegmentInput> = {},
): TelemetrySegmentInput {
  return {
    sessionId,
    seq,
    startTs: new Date(startTs),
    endTs: new Date(startTs + 59_000),
    samples: 60,
    bytes: 5466,
    normalized: true,
    s3Key: `telemetry/v1/dev/${sessionId}/${startTs}-${String(seq).padStart(5, '0')}.jsonl.gz`,
    ...partial,
  };
}

describe('telemetry overlap predicates', () => {
  it('a session overlaps a window it straddles at either edge, and one it sits inside', () => {
    const inside = tsession({ id: 'a', startedAt: S0 + MIN, endedAt: S0 + 2 * MIN });
    const straddlesFrom = tsession({ id: 'b', startedAt: S0 - MIN, endedAt: S0 + MIN });
    const straddlesTo = tsession({ id: 'c', startedAt: S0 + 9 * MIN, endedAt: S0 + 11 * MIN });
    const before = tsession({ id: 'd', startedAt: S0 - 5 * MIN, endedAt: S0 - MIN });
    const after = tsession({ id: 'e', startedAt: S0 + 10 * MIN, endedAt: S0 + 12 * MIN });
    const win = [S0, S0 + 10 * MIN] as const;
    expect(telemetrySessionOverlaps(inside, ...win)).toBe(true);
    expect(telemetrySessionOverlaps(straddlesFrom, ...win)).toBe(true);
    expect(telemetrySessionOverlaps(straddlesTo, ...win)).toBe(true);
    expect(telemetrySessionOverlaps(before, ...win)).toBe(false);
    // startedAt == to is excluded: the window is [from, to).
    expect(telemetrySessionOverlaps(after, ...win)).toBe(false);
    // endedAt == from is included (>= from).
    expect(telemetrySessionOverlaps(tsession({ id: 'f', startedAt: S0 - MIN, endedAt: S0 }), ...win)).toBe(true);
  });

  it('an open session with no endedAt overlaps by its startedAt alone', () => {
    const open = tsession({ id: 'o', status: 'open', startedAt: S0 + MIN, endedAt: null });
    expect(telemetrySessionOverlaps(open, S0, S0 + 10 * MIN)).toBe(true);
    expect(telemetrySessionOverlaps(open, S0 + 2 * MIN, S0 + 10 * MIN)).toBe(false);
  });

  it('a segment overlaps by its sample bounds', () => {
    const seg = tseg('a', 0, S0);
    expect(telemetrySegmentOverlaps(seg, S0 + 30_000, S0 + MIN)).toBe(true);
    expect(telemetrySegmentOverlaps(seg, S0 + 59_000, S0 + MIN)).toBe(true); // endTs == from
    expect(telemetrySegmentOverlaps(seg, S0 + 59_001, S0 + MIN)).toBe(false);
    expect(telemetrySegmentOverlaps(seg, S0 - MIN, S0)).toBe(false); // startTs == to
  });
});

describe('buildTelemetryManifest', () => {
  it('a device with no telemetry yields an empty block, not an absent one', () => {
    expect(buildTelemetryManifest([], [], { fromMs: S0, toMs: S0 + MIN })).toEqual({
      sessions: [],
      truncated: false,
    });
  });

  it('keeps overlapping sessions in startedAt order and clips each one\'s segments to the window', () => {
    // Session A straddles `from`; session B is entirely inside; session C is
    // after the window and must be dropped.
    const a = tsession({ id: 'a', startedAt: S0 - 3 * MIN, endedAt: S0 + 2 * MIN });
    const b = tsession({ id: 'b', startedAt: S0 + 5 * MIN, endedAt: S0 + 7 * MIN });
    const c = tsession({ id: 'c', startedAt: S0 + 20 * MIN, endedAt: S0 + 25 * MIN });
    const segments = [
      tseg('a', 0, S0 - 3 * MIN),
      tseg('a', 1, S0 - 2 * MIN),
      tseg('a', 2, S0 - MIN), // ends at S0 - 1 s: outside
      tseg('a', 3, S0), // inside
      tseg('a', 4, S0 + MIN),
      tseg('b', 0, S0 + 5 * MIN),
      tseg('b', 1, S0 + 6 * MIN),
      tseg('c', 0, S0 + 20 * MIN),
    ];
    const out = buildTelemetryManifest([c, b, a], segments, { fromMs: S0, toMs: S0 + 10 * MIN });
    expect(out.truncated).toBe(false);
    expect(out.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out.sessions[0].segments.map((s) => s.seq)).toEqual([3, 4]);
    expect(out.sessions[1].segments.map((s) => s.seq)).toEqual([0, 1]);
    // Shape: epoch ms bounds from the row, overview carries format/bytes/builtAt + key, insights ride along.
    expect(out.sessions[0]).toMatchObject({
      status: 'closed',
      rateHz: 1,
      timeSource: 'ntp',
      from: S0 - 3 * MIN,
      to: S0 + 2 * MIN,
      overview: {
        format: 'overview.v1',
        bytes: 23579,
        builtAt: S0 + 3 * 60 * MIN,
        s3Key: 'telemetry/v1/dev/a/overview.v1.json.gz',
      },
      insights: { distance: { meters: 25181.6 } },
    });
    expect(out.sessions[0].segments[0]).toEqual({
      seq: 3,
      startTs: S0,
      endTs: S0 + 59_000,
      samples: 60,
      bytes: 5466,
      s3Key: `telemetry/v1/dev/a/${S0}-00003.jsonl.gz`,
    });
  });

  it('an open session has overview: null even when a stale artifact key exists', () => {
    const open = tsession({ id: 'o', status: 'open', startedAt: S0, endedAt: S0 + MIN });
    const out = buildTelemetryManifest([open], [tseg('o', 0, S0)], { fromMs: S0, toMs: S0 + 10 * MIN });
    expect(out.sessions[0].overview).toBeNull();
    expect(out.sessions[0].segments).toHaveLength(1);
  });

  it('a closed session whose artifact is not built yet has overview: null and insights: null', () => {
    const fresh = tsession({
      id: 'f',
      startedAt: S0,
      overviewKey: null,
      overviewBuiltAt: null,
      overviewBytes: null,
      insights: null,
    });
    const out = buildTelemetryManifest([fresh], [tseg('f', 0, S0)], { fromMs: S0, toMs: S0 + MIN });
    expect(out.sessions[0].overview).toBeNull();
    expect(out.sessions[0].insights).toBeNull();
  });

  it('a pre-026 artifact reports bytes: null rather than a guess', () => {
    const s = tsession({ id: 'p', startedAt: S0, overviewBytes: null });
    const out = buildTelemetryManifest([s], [tseg('p', 0, S0)], { fromMs: S0, toMs: S0 + MIN });
    expect(out.sessions[0].overview?.bytes).toBeNull();
  });

  it('a session whose bounds straddle the window but whose data sits in a recording hole is not listed', () => {
    // Real dev shape (before manual/026): sessions 019fb027/019fb037 had a
    // second segment stamped 2080 by a garbage RTC, so their bounds covered
    // every window for decades while no segment ever fell inside one.
    const hole = tsession({ id: 'h', startedAt: S0 - 10 * MIN, endedAt: S0 + 100 * MIN });
    const out = buildTelemetryManifest(
      [hole],
      [tseg('h', 0, S0 - 10 * MIN), tseg('h', 1, S0 + 90 * MIN)],
      { fromMs: S0, toMs: S0 + 10 * MIN },
    );
    expect(out.sessions).toEqual([]);
    // With one segment inside, it is back.
    const back = buildTelemetryManifest(
      [hole],
      [tseg('h', 0, S0 - 10 * MIN), tseg('h', 1, S0 + 2 * MIN), tseg('h', 2, S0 + 90 * MIN)],
      { fromMs: S0, toMs: S0 + 10 * MIN },
    );
    expect(back.sessions.map((x) => x.id)).toEqual(['h']);
    expect(back.sessions[0].segments.map((x) => x.seq)).toEqual([1]);
  });

  it('drops un-normalised segments: a raw-gzip object must never reach a client', () => {
    const s = tsession({ id: 'n', startedAt: S0 });
    const out = buildTelemetryManifest(
      [s],
      [tseg('n', 0, S0, { normalized: false }), tseg('n', 1, S0 + MIN)],
      { fromMs: S0, toMs: S0 + 10 * MIN },
    );
    expect(out.sessions[0].segments.map((x) => x.seq)).toEqual([1]);
  });

  it('caps at REPLAY_TELEMETRY_MAX_SEGMENTS across sessions, keeping the earliest by startTs, and flags it', () => {
    expect(REPLAY_TELEMETRY_MAX_SEGMENTS).toBe(1500);
    const cap = 5;
    const a = tsession({ id: 'a', startedAt: S0, endedAt: S0 + 4 * MIN });
    const b = tsession({ id: 'b', startedAt: S0 + 4 * MIN, endedAt: S0 + 8 * MIN });
    const segments = [
      ...[0, 1, 2, 3].map((i) => tseg('a', i, S0 + i * MIN)),
      ...[0, 1, 2, 3].map((i) => tseg('b', i, S0 + (4 + i) * MIN)),
    ];
    const out = buildTelemetryManifest([a, b], segments, { fromMs: S0, toMs: S0 + 10 * MIN }, { maxSegments: cap });
    expect(out.truncated).toBe(true);
    expect(out.sessions[0].segments).toHaveLength(4);
    expect(out.sessions[1].segments.map((x) => x.seq)).toEqual([0]);
    // Exactly at the cap is not truncated.
    const exact = buildTelemetryManifest([a, b], segments.slice(0, cap), { fromMs: S0, toMs: S0 + 10 * MIN }, { maxSegments: cap });
    expect(exact.truncated).toBe(false);
    // A session the cap emptied entirely is not listed (the client sees truncated: true).
    const tight = buildTelemetryManifest([a, b], segments, { fromMs: S0, toMs: S0 + 10 * MIN }, { maxSegments: 4 });
    expect(tight.sessions.map((x) => x.id)).toEqual(['a']);
  });

  it('orders segments by startTs, never by seq (a re-opened session can renumber)', () => {
    const s = tsession({ id: 'r', startedAt: S0 });
    const out = buildTelemetryManifest(
      [s],
      [tseg('r', 0, S0 + 2 * MIN), tseg('r', 7, S0)],
      { fromMs: S0, toMs: S0 + 10 * MIN },
    );
    expect(out.sessions[0].segments.map((x) => x.seq)).toEqual([7, 0]);
  });
});

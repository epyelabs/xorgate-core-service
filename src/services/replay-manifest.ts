/**
 * Pure timeline math for the replay manifest (Composite Replays plan, Phase 2).
 * Free of AWS/DB imports so it unit-tests directly; handlers/device-sessions.ts
 * does the I/O (queries + presigning).
 *
 * Contract (plan README, decision R2): the replay clock is wall-clock epoch ms.
 * Segment `i` covers `[startTs_i, startTs_i + effectiveDurationMs_i)` where the
 * effective duration is the NEXT segment's startTs delta when the pair is
 * contiguous, else the segment's own durationMs — next-segment deltas beat
 * durationMs because rotation timestamps are accurate while durations drift
 * (seq-0 `anchor:'fstat'` rows even include ~2 s of pipeline startup). The
 * contiguity nominal is the segment's own durationMs + 2 s slack — the exact
 * rule the Phase 1 spike validated at 0.00 s drift on 4 real dev sessions
 * (spike/dump-manifest.mjs); a per-session or median-derived nominal was
 * considered and rejected as needless indirection.
 *
 * Crash-cut segments (`finalized=false`) never bridge: their durationMs is
 * mtime-derived and the media really ends at the cut, so the effective
 * duration stays durationMs and any hole to the next segment can become a gap.
 *
 * Gaps are emitted only when the hole exceeds the same 2 s slack — smaller
 * seams are absorbed client-side by the player's micro-gap jump controller
 * (spike recipe item 4). For finalized segments this is automatic: a
 * non-contiguous delta implies a hole > 2 s by construction.
 */

export const CONTIGUITY_SLACK_MS = 2000;

export interface ReplaySegmentInput {
  seq: number;
  startTs: Date;
  durationMs: number;
  finalized: boolean;
  sizeBytes: number | null;
  s3Key: string;
  meta: unknown;
}

export interface ReplayManifestSegment {
  seq: number;
  startTs: number; // epoch ms
  effectiveDurationMs: number;
  finalized: boolean;
  anchor: string | null; // meta passthrough: fstat | computed | boundary
  sizeBytes: number | null;
  s3Key: string; // stripped before the response; presigning input
}

export interface ReplayGap {
  fromTs: number; // epoch ms
  toTs: number;
  reason: 'missing-segments' | 'evicted-head';
}

export interface SessionTimeline {
  segments: ReplayManifestSegment[];
  gaps: ReplayGap[];
  /** Replay bounds: leading-gap start (if any) → last segment's effective end. */
  fromTs: number;
  toTs: number;
  /** True when input rows were not already sorted by startTs (seq lied). */
  outOfOrder: boolean;
}

export function buildSessionTimeline(
  rows: ReplaySegmentInput[],
  opts: { sessionStartedAt?: Date } = {},
): SessionTimeline | null {
  if (rows.length === 0) return null;

  const work = rows.map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    return {
      seg: {
        seq: r.seq,
        startTs: r.startTs.getTime(),
        effectiveDurationMs: r.durationMs, // provisional; fixed up below
        finalized: r.finalized,
        anchor: typeof meta.anchor === 'string' ? meta.anchor : null,
        sizeBytes: r.sizeBytes,
        s3Key: r.s3Key,
      } satisfies ReplayManifestSegment,
      durationMs: r.durationMs,
    };
  });
  // Never trust seq for ordering (README gotcha: eviction holes + reopened
  // sessions make seq arithmetic a lie); order by actual startTs.
  const outOfOrder = work.some((w, i) => i > 0 && w.seg.startTs < work[i - 1].seg.startTs);
  if (outOfOrder) work.sort((a, b) => a.seg.startTs - b.seg.startTs || a.seg.seq - b.seg.seq);
  const segs = work.map((w) => w.seg);

  const gaps: ReplayGap[] = [];
  const first = segs[0];
  const startedAtMs = opts.sessionStartedAt?.getTime();
  if (startedAtMs !== undefined && first.startTs - startedAtMs > CONTIGUITY_SLACK_MS) {
    gaps.push({ fromTs: startedAtMs, toTs: first.startTs, reason: 'evicted-head' });
  }

  for (let i = 0; i < work.length; i++) {
    const { seg: cur, durationMs } = work[i];
    const next = work[i + 1]?.seg;
    const delta = next ? next.startTs - cur.startTs : null;
    const contiguous =
      cur.finalized && delta !== null && delta > 0 && delta <= durationMs + CONTIGUITY_SLACK_MS;
    cur.effectiveDurationMs = contiguous ? (delta as number) : durationMs;
    if (next) {
      const hole = next.startTs - (cur.startTs + cur.effectiveDurationMs);
      if (hole > CONTIGUITY_SLACK_MS) {
        gaps.push({
          fromTs: cur.startTs + cur.effectiveDurationMs,
          toTs: next.startTs,
          reason: 'missing-segments',
        });
      }
    }
  }

  const last = segs[segs.length - 1];
  return {
    segments: segs,
    gaps,
    fromTs: gaps[0]?.reason === 'evicted-head' ? gaps[0].fromTs : first.startTs,
    toTs: last.startTs + last.effectiveDurationMs,
    outOfOrder,
  };
}

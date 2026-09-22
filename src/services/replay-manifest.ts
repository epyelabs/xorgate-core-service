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

// ---------------------------------------------------------------------------
// Telemetry block (telemetry-session-artifacts plan, Phase 2; README §4.2)
// ---------------------------------------------------------------------------
//
// The replay is addressed by (device, window); telemetry sessions are joined
// to it by OVERLAP with that window, never by id (README §2.6: video and
// telemetry sessions are minted independently on the device). The handler
// runs the same predicates in SQL to keep the query indexed and small; this
// is the contract, unit-tested, and the shape the manifest emits minus the
// URLs, which the handler presigns in the same batch as the video segments.

/** Q7: telemetry has its own presign budget, separate from the 600 video segments. */
export const REPLAY_TELEMETRY_MAX_SEGMENTS = 1500;

export const REPLAY_TELEMETRY_OVERVIEW_FORMAT = 'overview.v1';

export interface TelemetrySessionInput {
  id: string;
  status: string;
  rateHz: number | null;
  timeSource: string | null;
  startedAt: Date;
  endedAt: Date | null;
  overviewKey: string | null;
  overviewBuiltAt: Date | null;
  overviewBytes: number | null;
  insights: unknown;
}

export interface TelemetrySegmentInput {
  sessionId: string;
  seq: number;
  startTs: Date;
  endTs: Date;
  samples: number;
  bytes: number;
  normalized: boolean;
  s3Key: string;
}

export interface ReplayTelemetryOverview {
  format: typeof REPLAY_TELEMETRY_OVERVIEW_FORMAT;
  /** Gzipped size; null for an artifact built before the size was recorded. */
  bytes: number | null;
  builtAt: number; // epoch ms
  s3Key: string; // stripped before the response; presigning input
}

export interface ReplayTelemetrySegment {
  seq: number;
  startTs: number; // epoch ms, first sample in the file
  endTs: number; // epoch ms, last sample in the file
  samples: number;
  bytes: number;
  s3Key: string; // stripped before the response; presigning input
}

export interface ReplayTelemetrySession {
  id: string;
  status: string;
  rateHz: number | null;
  timeSource: string | null;
  from: number; // epoch ms
  to: number;
  /** null while the session is open or its artifact is not built yet (D6). */
  overview: ReplayTelemetryOverview | null;
  /** Only the normalised segments overlapping the window, by startTs. */
  segments: ReplayTelemetrySegment[];
  insights: unknown | null;
}

export interface ReplayTelemetry {
  sessions: ReplayTelemetrySession[];
  /** The segment cap was hit; the client should narrow the window. */
  truncated: boolean;
}

/** A session overlaps [from, to) when it started before `to` and had not ended before `from`. */
export function telemetrySessionOverlaps(
  s: Pick<TelemetrySessionInput, 'startedAt' | 'endedAt'>,
  fromMs: number,
  toMs: number,
): boolean {
  const started = s.startedAt.getTime();
  const ended = (s.endedAt ?? s.startedAt).getTime();
  return started < toMs && ended >= fromMs;
}

/** A segment overlaps [from, to) by its sample bounds. */
export function telemetrySegmentOverlaps(
  seg: Pick<TelemetrySegmentInput, 'startTs' | 'endTs'>,
  fromMs: number,
  toMs: number,
): boolean {
  return seg.startTs.getTime() < toMs && seg.endTs.getTime() >= fromMs;
}

/**
 * Assemble the `telemetry` block for a window. Pure: sessions in, segments
 * in, shape out (URLs are added by the caller). Rules:
 *  - sessions that do not overlap the window are dropped; the rest are
 *    ordered by startedAt;
 *  - segments are clipped to the window and to `normalized = true` (an
 *    un-normalised object would reach a client as raw gzip), ordered by
 *    startTs then seq, and CAPPED at `maxSegments` across all sessions: the
 *    first `maxSegments` by startTs survive and `truncated` is set, never a 400;
 *  - a session is LISTED only when at least one of its segments survived the
 *    clip: a session whose bounds straddle the window but whose data sits in
 *    a recording hole (or, before manual/026, behind a garbage clock) has
 *    nothing to show for this window, and its overview would draw another
 *    time's route over this one;
 *  - `overview` is null while the session is open or has no artifact yet.
 */
export function buildTelemetryManifest(
  sessions: TelemetrySessionInput[],
  segments: TelemetrySegmentInput[],
  window: { fromMs: number; toMs: number },
  opts: { maxSegments?: number } = {},
): ReplayTelemetry {
  const maxSegments = opts.maxSegments ?? REPLAY_TELEMETRY_MAX_SEGMENTS;
  const { fromMs, toMs } = window;

  const kept = sessions
    .filter((s) => telemetrySessionOverlaps(s, fromMs, toMs))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1));
  const keptIds = new Set(kept.map((s) => s.id));

  const inWindow = segments
    .filter((seg) => seg.normalized && keptIds.has(seg.sessionId) && telemetrySegmentOverlaps(seg, fromMs, toMs))
    .sort((a, b) => a.startTs.getTime() - b.startTs.getTime() || a.seq - b.seq);
  const truncated = inWindow.length > maxSegments;
  const budgeted = truncated ? inWindow.slice(0, maxSegments) : inWindow;

  const bySession = new Map<string, ReplayTelemetrySegment[]>();
  for (const seg of budgeted) {
    const shaped: ReplayTelemetrySegment = {
      seq: seg.seq,
      startTs: seg.startTs.getTime(),
      endTs: seg.endTs.getTime(),
      samples: seg.samples,
      bytes: seg.bytes,
      s3Key: seg.s3Key,
    };
    const list = bySession.get(seg.sessionId);
    if (list) list.push(shaped);
    else bySession.set(seg.sessionId, [shaped]);
  }

  return {
    sessions: kept.filter((s) => bySession.has(s.id)).map((s) => ({
      id: s.id,
      status: s.status,
      rateHz: s.rateHz,
      timeSource: s.timeSource,
      from: s.startedAt.getTime(),
      to: (s.endedAt ?? s.startedAt).getTime(),
      overview:
        s.status === 'closed' && s.overviewKey && s.overviewBuiltAt
          ? {
              format: REPLAY_TELEMETRY_OVERVIEW_FORMAT,
              bytes: s.overviewBytes,
              builtAt: s.overviewBuiltAt.getTime(),
              s3Key: s.overviewKey,
            }
          : null,
      segments: bySession.get(s.id) ?? [],
      insights: s.insights ?? null,
    })),
    truncated,
  };
}

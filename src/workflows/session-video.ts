import {
  buildSessionTimeline,
  type ReplaySegmentInput,
} from '../services/replay-manifest';
import type { ResolvedVideoSession } from './production';

/**
 * PURE half of "an on-device media session becomes a workflow video input"
 * (destroy-kvs-recorder Phase W). No DB or AWS imports, so the whole mapping —
 * ordering, wall-clock anchoring, gaps, crash cuts, the single-chunk narrowing
 * — unit-tests directly. The DB legwork lives in
 * services/media-session-input.ts.
 *
 * Timeline math is delegated to `buildSessionTimeline` (services/replay-
 * manifest.ts), the SAME function the replay player uses. Reusing it is what
 * keeps the engine and the player from forming two independent opinions about
 * a session's clock — the player is this phase's correctness baseline.
 */

/** The `media_sessions` fields the mapping needs. */
export interface SessionIdentity {
  id: string;
  streamKey: string;
  startedAt: Date;
  timeSource: string | null;
}

/**
 * Maps one session's segment rows to the ordered, wall-clock-anchored list the
 * `device_session` executor binding carries. Returns null when the session has
 * no usable segments (retention expired them, or `onlySeq` matched nothing) —
 * a caller with a `source.video` node then fails with "No video input", which
 * is the honest outcome.
 *
 * `opts.onlySeq` narrows to ONE segment (the `segment_uploaded` N=1 case)
 * AFTER the timeline is built over the whole session, so the kept segment
 * still gets its next-delta-derived `effectiveDurationMs` rather than a
 * possibly fstat-inflated `durationMs`. `onlySeq: null` means "the newest
 * segment", which is what a manual chunk run wants.
 */
export function resolveSessionVideo(
  session: SessionIdentity,
  rows: ReplaySegmentInput[],
  opts: { onlySeq?: number | null } = {},
): ResolvedVideoSession | null {
  const timeline = buildSessionTimeline(rows, { sessionStartedAt: session.startedAt });
  if (!timeline) return null;

  // buildSessionTimeline keeps only the EFFECTIVE duration; the raw recorded
  // duration is carried alongside it for logging/diagnostics. Keyed by s3Key —
  // it is the unique index on media_segments; `seq` is not.
  const rawDurationByKey = new Map(rows.map((r) => [r.s3Key, r.durationMs]));

  const narrow = 'onlySeq' in opts;
  let segments = timeline.segments;
  if (narrow) {
    const wanted =
      opts.onlySeq === null || opts.onlySeq === undefined
        ? segments[segments.length - 1]
        : segments.find((s) => s.seq === opts.onlySeq);
    if (!wanted) return null;
    segments = [wanted];
  }
  if (segments.length === 0) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    sessionId: session.id,
    streamKey: session.streamKey,
    timeSource: session.timeSource,
    segments: segments.map((s) => ({
      s3Key: s.s3Key,
      startTs: s.startTs,
      durationMs: rawDurationByKey.get(s.s3Key) ?? s.effectiveDurationMs,
      effectiveDurationMs: s.effectiveDurationMs,
      seq: s.seq,
      finalized: s.finalized,
    })),
    // Narrowed to one chunk, the window is that chunk — not the session.
    fromTs: narrow ? first.startTs : timeline.fromTs,
    toTs: narrow ? last.startTs + last.effectiveDurationMs : timeline.toTs,
    gaps: narrow
      ? []
      : timeline.gaps.map((g) => ({ fromTs: g.fromTs, toTs: g.toTs, reason: g.reason })),
  };
}

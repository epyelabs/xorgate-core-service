import { describe, expect, it } from 'vitest';
import { resolveSessionVideo, type SessionIdentity } from '../src/workflows/session-video';
import type { ReplaySegmentInput } from '../src/services/replay-manifest';
import {
  buildTriggeredInputs,
  resolveTriggeredWindow,
  sessionBinding,
  sessionsWindow,
  triggeredVideoSelection,
  type ResolvedVideoSession,
} from '../src/workflows/production';
import type { EngineRunCtx, VideoPayload } from '@xorgate/workflow-engine';
import { platformCatalog } from '../src/workflows/catalog';
import type { WorkflowDefinition } from '../src/schemas/workflows';

/**
 * destroy-kvs-recorder Phase W: Workflows take recorded video from on-device
 * SESSIONS (media_sessions + N media_segments) instead of the dead cloud
 * `recordings` table. The load-bearing claim is that `source.video` emits ONE
 * VideoPayload per segment, each anchored at that segment's own startTs — so
 * drift is bounded to a single ~60 s segment instead of accumulating, and gaps
 * cost nothing because the next segment simply re-anchors.
 *
 * These are pure: the timeline mapping (resolveSessionVideo) and the executor
 * both run without a DB, with fetchVideo stubbed.
 */

const T0 = Date.UTC(2026, 6, 27, 20, 30, 0); // 2026-07-27T20:30:00Z
const SESSION: SessionIdentity = {
  id: 'a1b2c3d4-0000-7000-8000-000000000001',
  streamKey: 'cam0',
  startedAt: new Date(T0),
  timeSource: 'ntp',
};

function seg(
  seq: number,
  startTs: number,
  durationMs: number,
  finalized = true,
): ReplaySegmentInput {
  return {
    seq,
    startTs: new Date(startTs),
    durationMs,
    finalized,
    sizeBytes: 1_000_000,
    s3Key: `media-sessions/v1/dev/cam0/${SESSION.id}/${seq}.mp4`,
    meta: { anchor: seq === 0 ? 'fstat' : 'boundary' },
  };
}

// The real executor, from the one catalog instance the platform runs (the engine package's).
const sourceVideo = platformCatalog.getExecutor('source.video')!;

/** Runs the real source.video executor over a binding and collects its emits. */
async function runSourceVideo(
  binding: unknown,
): Promise<{ payloads: VideoPayload[]; tss: number[]; fetched: string[]; summary: string }> {
  const fetched: string[] = [];
  let summary = '';
  const ctx = {
    binding,
    nodeId: 'v1',
    window: null,
    sources: {
      async fetchVideo({ key }: { bucket: string | null; key: string }) {
        fetched.push(key);
        return { path: `/tmp/${fetched.length}.mp4` };
      },
    },
    setSummary(s: string) {
      summary = s;
    },
    log() {},
  } as unknown as EngineRunCtx;

  const payloads: VideoPayload[] = [];
  const tss: number[] = [];
  for await (const emit of sourceVideo([], {}, ctx)) {
    payloads.push(emit.payload as VideoPayload);
    tss.push(emit.ts);
  }
  return { payloads, tss, fetched, summary };
}

describe('resolveSessionVideo: session -> ordered, anchored segment list', () => {
  it('orders by startTs and carries each segment its own anchor', () => {
    // Deliberately fed out of seq order: seq must never drive ordering.
    const rows = [seg(2, T0 + 120_000, 60_000), seg(0, T0, 60_000), seg(1, T0 + 60_000, 60_000)];
    const resolved = resolveSessionVideo(SESSION, rows)!;
    expect(resolved.segments.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(resolved.segments.map((s) => s.startTs)).toEqual([
      T0,
      T0 + 60_000,
      T0 + 120_000,
    ]);
    expect(resolved.gaps).toEqual([]);
    expect(resolved.fromTs).toBe(T0);
    expect(resolved.toTs).toBe(T0 + 180_000);
    expect(resolved.timeSource).toBe('ntp');
  });

  it('emits a gap and keeps the post-gap segment anchored at its own startTs', () => {
    // 60 s of video, a 5-minute offline stretch, then recording resumes.
    const rows = [
      seg(0, T0, 60_000),
      seg(1, T0 + 360_000, 60_000),
      seg(2, T0 + 420_000, 60_000),
    ];
    const resolved = resolveSessionVideo(SESSION, rows)!;
    expect(resolved.gaps).toEqual([
      { fromTs: T0 + 60_000, toTs: T0 + 360_000, reason: 'missing-segments' },
    ]);
    // The post-gap segment re-anchors: drift cannot cross the hole.
    expect(resolved.segments[1].startTs).toBe(T0 + 360_000);
    expect(resolved.segments[0].effectiveDurationMs).toBe(60_000);
  });

  it('never bridges a crash-cut (finalized:false) segment', () => {
    // seq 1 was cut mid-write; its media really ends at the cut, so its
    // effective duration stays its own durationMs even though the next
    // segment starts sooner than durationMs would suggest.
    const rows = [
      seg(0, T0, 60_000),
      seg(1, T0 + 60_000, 12_000, false),
      seg(2, T0 + 90_000, 60_000),
    ];
    const resolved = resolveSessionVideo(SESSION, rows)!;
    expect(resolved.segments[1].effectiveDurationMs).toBe(12_000);
    expect(resolved.segments[1].finalized).toBe(false);
    expect(resolved.gaps).toEqual([
      { fromTs: T0 + 72_000, toTs: T0 + 90_000, reason: 'missing-segments' },
    ]);
  });

  it('clamps an over-reported (fstat) duration to the next segment delta', () => {
    // seq 0 fstat-reports 62 s of a 60 s rotation; effective must be the real
    // 60 s delta, or its frames would spill past seq 1's anchor.
    const rows = [seg(0, T0, 62_000), seg(1, T0 + 60_000, 60_000)];
    const resolved = resolveSessionVideo(SESSION, rows)!;
    expect(resolved.segments[0].durationMs).toBe(62_000); // raw, for diagnostics
    expect(resolved.segments[0].effectiveDurationMs).toBe(60_000); // what the decoder honors
  });

  it('narrows to one chunk for segment_uploaded (the N=1 case)', () => {
    const rows = [seg(0, T0, 60_000), seg(1, T0 + 60_000, 60_000), seg(2, T0 + 120_000, 60_000)];
    const one = resolveSessionVideo(SESSION, rows, { onlySeq: 1 })!;
    expect(one.segments).toHaveLength(1);
    expect(one.segments[0].seq).toBe(1);
    // The window is that chunk, not the session.
    expect(one.fromTs).toBe(T0 + 60_000);
    expect(one.toTs).toBe(T0 + 120_000);

    // onlySeq: null = the newest segment (what a manual chunk run wants).
    const newest = resolveSessionVideo(SESSION, rows, { onlySeq: null })!;
    expect(newest.segments[0].seq).toBe(2);
  });

  it('returns null when the session has no segments left', () => {
    expect(resolveSessionVideo(SESSION, [])).toBeNull();
    expect(resolveSessionVideo(SESSION, [seg(0, T0, 60_000)], { onlySeq: 99 })).toBeNull();
  });
});

describe('source.video executor: one VideoPayload per segment', () => {
  it('yields payloads in startTs order, each anchored at its own segment startTs', async () => {
    const rows = [seg(0, T0, 60_000), seg(1, T0 + 60_000, 60_000), seg(2, T0 + 120_000, 60_000)];
    const resolved = resolveSessionVideo(SESSION, rows)!;
    const { payloads, tss, fetched, summary } = await runSourceVideo(sessionBinding(resolved));

    expect(payloads).toHaveLength(3);
    // THE claim: each payload's anchor IS its segment's startTs, in order.
    expect(payloads.map((p) => p.startedAtMs)).toEqual(resolved.segments.map((s) => s.startTs));
    expect(tss).toEqual(resolved.segments.map((s) => s.startTs));
    // One fetch per segment, in the same order, and every file distinct.
    expect(fetched).toEqual(resolved.segments.map((s) => s.s3Key));
    expect(new Set(payloads.map((p) => p.path)).size).toBe(3);
    // Each payload carries its session/segment identity and a decode clamp.
    expect(payloads.map((p) => p.sessionId)).toEqual([SESSION.id, SESSION.id, SESSION.id]);
    expect(payloads.map((p) => p.segmentSeq)).toEqual([0, 1, 2]);
    expect(payloads.every((p) => p.releasable === true)).toBe(true);
    // Truncation is legible: the summary names how far the run actually got.
    expect(summary).toContain('3/3 segments');
    expect(summary).toContain(new Date(T0 + 180_000).toISOString());
  });

  it('anchors correctly across a gap and honors a crash-cut clamp', async () => {
    const rows = [
      seg(0, T0, 60_000),
      seg(1, T0 + 60_000, 12_000, false), // crash cut
      seg(2, T0 + 300_000, 60_000), // after a gap
    ];
    const resolved = resolveSessionVideo(SESSION, rows)!;
    const { payloads } = await runSourceVideo(sessionBinding(resolved));

    expect(payloads.map((p) => p.startedAtMs)).toEqual([T0, T0 + 60_000, T0 + 300_000]);
    // No frames may be emitted inside the gap: the crash-cut segment's decode
    // window ends at the cut, and the next one re-anchors past the hole.
    expect(payloads[1].durationMs).toBe(12_000);
    expect(payloads[1].startedAtMs + payloads[1].durationMs!).toBeLessThan(payloads[2].startedAtMs);
  });

  it('emits exactly one payload for a single-segment (segment_uploaded) binding', async () => {
    const rows = [seg(0, T0, 60_000), seg(1, T0 + 60_000, 60_000)];
    const resolved = resolveSessionVideo(SESSION, rows, { onlySeq: 1 })!;
    const { payloads, fetched } = await runSourceVideo(sessionBinding(resolved));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].startedAtMs).toBe(T0 + 60_000);
    expect(fetched).toHaveLength(1);
  });

  it('rejects the retired cloud-recorder binding outright', async () => {
    await expect(
      runSourceVideo({ kind: 'recording', s3Key: 'media/v1/dev/cam0/r1.mp4' }),
    ).rejects.toThrow(/Unsupported video binding/);
  });
});

describe('triggeredVideoSelection: trigger context -> media selection', () => {
  it('classifies both media triggers and both schedule selections', () => {
    expect(
      triggeredVideoSelection({ type: 'session_completed', sessionId: 's1', streamKey: 'cam0' }),
    ).toEqual({ kind: 'session', sessionId: 's1', streamKey: 'cam0' });
    expect(
      triggeredVideoSelection({
        type: 'segment_uploaded',
        sessionId: 's1',
        streamKey: 'cam0',
        seq: 7,
      }),
    ).toEqual({ kind: 'segment', sessionId: 's1', streamKey: 'cam0', seq: 7 });
    // A chunk run with no explicit seq falls through to "newest".
    expect(
      triggeredVideoSelection({ type: 'segment_uploaded', sessionId: 's1', streamKey: 'cam0' }),
    ).toEqual({ kind: 'segment', sessionId: 's1', streamKey: 'cam0', seq: null });
    expect(
      triggeredVideoSelection({ selection: { mode: 'sessions', sessionIds: ['s1', 's2'] } }),
    ).toEqual({ kind: 'sessions', sessionIds: ['s1', 's2'] });
    expect(triggeredVideoSelection({ selection: { mode: 'lastNSessions', n: 3 } })).toEqual({
      kind: 'lastNSessions',
      n: 3,
    });
  });

  it('returns null for telemetry-only contexts and for retired cloud selections', () => {
    expect(triggeredVideoSelection({ type: 'telemetry_condition' })).toBeNull();
    expect(triggeredVideoSelection(null)).toBeNull();
    expect(
      triggeredVideoSelection({ type: 'recording_saved', s3Key: 'media/v1/x.mp4' }),
    ).toBeNull();
    expect(
      triggeredVideoSelection({ selection: { mode: 'recordings', recordingIds: ['r1'] } }),
    ).toBeNull();
  });
});

describe('buildTriggeredInputs: node -> session binding', () => {
  const videoNode = (id: string, streamKey?: string) => ({
    id,
    type: 'source.video',
    position: { x: 0, y: 0 },
    data: { label: 'Video', config: streamKey ? { streamKey } : {} },
  });
  const definition = (nodes: ReturnType<typeof videoNode>[]): WorkflowDefinition => ({
    schemaVersion: 2,
    nodes,
    edges: [],
  });

  const resolvedFor = (streamKey: string): ResolvedVideoSession =>
    resolveSessionVideo({ ...SESSION, id: `sess-${streamKey}`, streamKey }, [seg(0, T0, 60_000)])!;

  it('binds an unqualified video node to the primary session', () => {
    const inputs = buildTriggeredInputs(
      definition([videoNode('v1')]),
      [resolvedFor('cam0'), resolvedFor('cam1')],
      'fargate',
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0].binding).toMatchObject({ kind: 'device_session', streamKey: 'cam0' });
  });

  it('routes each camera to its own session in a multi-cam graph', () => {
    const inputs = buildTriggeredInputs(
      definition([videoNode('v1', 'cam1'), videoNode('v2', 'cam0')]),
      [resolvedFor('cam0'), resolvedFor('cam1')],
      'fargate',
    );
    expect(inputs.map((i) => (i.binding as { streamKey: string }).streamKey)).toEqual([
      'cam1',
      'cam0',
    ]);
  });

  it('fails loudly rather than binding the wrong camera', () => {
    expect(() =>
      buildTriggeredInputs(definition([videoNode('v1', 'cam9')]), [resolvedFor('cam0')], 'fargate'),
    ).toThrow(/No recorded session for stream "cam9"/);
  });

  it('fails when a video node has no session at all', () => {
    expect(() => buildTriggeredInputs(definition([videoNode('v1')]), [], 'fargate')).toThrow(
      /No video input \(on-device session\) available/,
    );
  });
});

describe('resolveTriggeredWindow: telemetry window follows the real session', () => {
  it('prefers an explicit context window, then the media timeline, then the default', () => {
    const resolved = resolveSessionVideo(SESSION, [seg(0, T0, 60_000), seg(1, T0 + 60_000, 60_000)])!;
    const media = sessionsWindow([resolved])!;
    expect(media).toEqual({
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 120_000).toISOString(),
    });

    // Session-derived, not the 15-minute guess.
    expect(resolveTriggeredWindow({ type: 'session_completed' }, new Date(T0), media)).toEqual(media);
    // An explicit window still wins.
    const explicit = { from: 'a', to: 'b' };
    expect(resolveTriggeredWindow({ window: explicit }, new Date(T0), media)).toEqual(explicit);
    // Telemetry-only run: unchanged 15-minute fallback.
    expect(resolveTriggeredWindow({}, new Date(T0), null)).toEqual({
      from: new Date(T0 - 15 * 60_000).toISOString(),
      to: new Date(T0).toISOString(),
    });
  });

  it('narrows the window to the chunk on a segment_uploaded run', () => {
    const rows = [seg(0, T0, 60_000), seg(1, T0 + 60_000, 60_000), seg(2, T0 + 120_000, 60_000)];
    const chunk = resolveSessionVideo(SESSION, rows, { onlySeq: 1 })!;
    expect(sessionsWindow([chunk])).toEqual({
      from: new Date(T0 + 60_000).toISOString(),
      to: new Date(T0 + 120_000).toISOString(),
    });
  });
});

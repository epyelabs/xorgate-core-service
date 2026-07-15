import { z } from 'zod';
import type { EngineEmit, EngineInChannel, EngineRunCtx, VideoPayload } from '../types';
import { defineNode } from '../types';

// Abstract video input. The template only declares "this workflow consumes
// video"; the CONCRETE feed (uploaded file, device recording, live stream, or
// webcam) is a binding chosen when the workflow is attached to a device or when
// a simulation is started, never on the template.
export const def = defineNode({
  type: 'source.video',
  version: 1,
  group: 'source',
  label: 'Video',
  description:
    'Video input. The concrete feed (file, device recording, live stream, webcam) is bound at attach or simulation time.',
  ui: { icon: 'video' },
  inputs: [],
  outputs: [{ id: 'video', label: 'Video', channel: 'video', cardinality: 'many', required: false }],
  config: z.object({
    streamKey: z
      .string()
      .min(1)
      .optional()
      .describe('Restrict device bindings to this camera stream (default: any)'),
  }),
  requires: [{ token: 'video' }],
  runtime: { target: 'any' },
});

// Binding kinds this source accepts (executor-owned union, session 1 pattern).
// Batch kinds resolve to an object the target fetches to local disk through
// ctx.sources.fetchVideo; `video_local` short-circuits to a path already on
// disk (tests, and the M3 simulator's warm-session cache). `webcam` (M5) is
// the live plane: the browser publishes sampled JPEG frames to the run's
// ingest topic and the target exposes them through ctx.sources.openLiveFrames;
// this executor emits a live VideoPayload that video.decode_sample consumes as
// a sampling pass-through. `device_live` (device-side frame publish, symmetric
// with webcam) remains reserved and throws.
const WEBCAM_DEFAULT_MAX_DURATION_SECONDS = 300;
const WEBCAM_IDLE_TIMEOUT_SECONDS = 60;
const bindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recording'),
    s3Key: z.string().min(1),
    bucket: z.string().min(1).optional(), // default: the run's output bucket
    recordingId: z.string().min(1).optional(),
    recordingStartedAt: z.string().min(1).optional(),
    captureStartedAt: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('video_file'), // uploaded file (M3 presigned upload)
    s3Key: z.string().min(1),
    bucket: z.string().min(1).optional(),
    startedAt: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('video_local'), // tests / already-local media
    path: z.string().min(1),
    startedAt: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('device_live') }).passthrough(), // reserved (M5 stretch not taken)
  z.object({
    kind: z.literal('webcam'),
    maxDurationSeconds: z.number().positive().max(1800).optional(),
  }),
]);

function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export const executor = async function* sourceVideo(
  _inputs: EngineInChannel[],
  _config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  if (!ctx.binding) throw new Error('Video source has no input binding on this run');
  const parsed = bindingSchema.safeParse(ctx.binding);
  if (!parsed.success) {
    throw new Error(`Unsupported video binding "${String(ctx.binding.kind)}"`);
  }
  const binding = parsed.data;
  if (binding.kind === 'device_live') {
    throw new Error('Live device streams are not available yet (device-side frame publish is not enabled)');
  }
  if (binding.kind === 'webcam') {
    if (!ctx.sources.openLiveFrames) {
      throw new Error('This engine target has no live ingest support (webcam bindings need the media engine)');
    }
    const maxDurationMs = (binding.maxDurationSeconds ?? WEBCAM_DEFAULT_MAX_DURATION_SECONDS) * 1000;
    const anchor = Date.now(); // live frames carry their own browser-stamped ts
    ctx.setSummary(`live webcam ingest (max ${Math.round(maxDurationMs / 1000)}s)`);
    const payload: VideoPayload = {
      path: `live:${ctx.nodeId}`,
      startedAtMs: anchor,
      recordingId: null,
      live: {
        nodeId: ctx.nodeId,
        maxDurationMs,
        idleTimeoutMs: WEBCAM_IDLE_TIMEOUT_SECONDS * 1000,
      },
    };
    yield { ch: 'video' as const, ts: anchor, payload };
    return;
  }

  let path: string;
  let startedAtMs: number | null;
  let label: string;
  if (binding.kind === 'video_local') {
    path = binding.path;
    startedAtMs = parseMs(binding.startedAt);
    label = binding.path;
  } else {
    if (!ctx.sources.fetchVideo) {
      throw new Error('This engine target cannot fetch video inputs (no media support)');
    }
    ({ path } = await ctx.sources.fetchVideo({
      bucket: binding.bucket ?? null,
      key: binding.s3Key,
    }));
    startedAtMs =
      binding.kind === 'recording'
        ? parseMs(binding.captureStartedAt) ?? parseMs(binding.recordingStartedAt)
        : parseMs(binding.startedAt);
    label = binding.s3Key;
  }

  // Wall-clock anchor for frame timestamps: capture start when known, else the
  // run window, else "now" (relative-only media such as uploaded files).
  const anchor = startedAtMs ?? ctx.window?.fromMs ?? Date.now();
  ctx.setSummary(`video ${label} (${binding.kind})`);
  const payload: VideoPayload = {
    path,
    startedAtMs: anchor,
    recordingId: binding.kind === 'recording' ? binding.recordingId ?? null : null,
  };
  yield { ch: 'video' as const, ts: anchor, payload };
};

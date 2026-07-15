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
// disk (tests, and the M3 simulator's warm-session cache). `webcam` and
// `device_live` are reserved for the live plane (M3/M5) and throw until then.
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
  z.object({ kind: z.literal('device_live') }).passthrough(), // M5
  z.object({ kind: z.literal('webcam') }).passthrough(), // M3/M5
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
  if (binding.kind === 'device_live' || binding.kind === 'webcam') {
    throw new Error(`Live video bindings ("${binding.kind}") are not implemented until M3/M5`);
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

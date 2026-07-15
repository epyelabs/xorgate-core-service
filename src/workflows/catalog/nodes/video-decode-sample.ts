import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import { decodeJpegToRgba, mjpegFrames } from '../../engine/media';
import type { EngineEmit, EngineInChannel, EngineRunCtx, FramePayload, VideoPayload } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  fps: z.number().positive().max(30).default(2).describe('Frames sampled per second'),
  maxWidth: z
    .number()
    .int()
    .min(160)
    .max(3840)
    .optional()
    .describe('Downscale frames to this width while decoding (default: source size)'),
});

export const def = defineNode({
  type: 'video.decode_sample',
  version: 1,
  group: 'video',
  label: 'Decode & Sample',
  description: 'Decodes a video stream and samples frames at a fixed rate.',
  ui: { icon: 'film' },
  inputs: [{ id: 'video', label: 'Video', channel: 'video', cardinality: 'one', required: true }],
  outputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'many', required: false }],
  config: configSchema,
  requires: [],
  runtime: { target: 'media' },
});

// ffmpeg (spawned) samples at cfg.fps and emits an mjpeg stream; each JPEG is
// decoded to a raw RGBA FramePayload so downstream nodes share one buffer with
// zero re-decoding. Dimensions come from the decoded frames themselves (no
// ffprobe dependency); scale='min(iw,maxWidth)' never upscales. Frame
// timestamps anchor at the source's startedAtMs + i/fps. Backpressure reaches
// ffmpeg through the stdout pipe; live-mode drop-oldest applies because this
// is a `frames` channel.
export const executor = async function* videoDecodeSample(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  let frameSeq = 0;
  let videos = 0;
  for await (const msg of requireInput(inputs, 'video').messages) {
    if (msg.ch !== 'video') continue;
    const video = msg.payload as VideoPayload;
    videos += 1;
    const filters = [`fps=${cfg.fps}`];
    if (cfg.maxWidth !== undefined) filters.push(`scale='min(iw,${cfg.maxWidth})':-2`);
    const args = [
      '-i', video.path,
      '-vf', filters.join(','),
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '3',
      'pipe:1',
    ];
    let localIndex = 0;
    for await (const jpegBuf of mjpegFrames(args)) {
      const { width, height, data } = decodeJpegToRgba(jpegBuf);
      const ts = video.startedAtMs + Math.round((localIndex * 1000) / cfg.fps);
      const payload: FramePayload = {
        seq: frameSeq,
        ts,
        image: data,
        width,
        height,
        format: 'rgba',
      };
      localIndex += 1;
      frameSeq += 1;
      yield { ch: 'frames' as const, ts, payload };
    }
    ctx.log(`decoded ${localIndex} frame(s) from ${video.path}`);
  }
  ctx.setSummary(`${frameSeq} frame(s) sampled at ${cfg.fps} fps from ${videos} video(s)`);
};

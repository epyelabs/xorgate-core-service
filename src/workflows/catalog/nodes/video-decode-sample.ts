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
//
// LIVE pass-through (M5, M1 decision 10): a live VideoPayload (webcam-over-
// MQTT) carries pre-encoded JPEG frames from the browser, so no ffmpeg is
// spawned; frames are jpeg-decoded and re-emitted, downsampled to cfg.fps by
// dropping frames that arrive faster (the browser publish rate is the true
// ceiling). cfg.maxWidth is ignored on live streams (the browser already caps
// capture at <= 480p to fit the IoT message limit).
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
    if (video.live) {
      if (!ctx.sources.openLiveFrames) {
        throw new Error('This engine target has no live ingest support');
      }
      if (cfg.maxWidth !== undefined) {
        ctx.log('maxWidth is ignored for live streams (browser capture is pre-scaled)');
      }
      const minIntervalMs = 1000 / cfg.fps;
      let lastEmittedTs = -Infinity;
      let received = 0;
      let dropped = 0;
      for await (const ingest of ctx.sources.openLiveFrames(video.live)) {
        received += 1;
        if (ingest.ts - lastEmittedTs < minIntervalMs) {
          dropped += 1;
          continue;
        }
        const { width, height, data } = decodeJpegToRgba(ingest.jpeg);
        lastEmittedTs = ingest.ts;
        const payload: FramePayload = {
          seq: frameSeq,
          ts: ingest.ts,
          image: data,
          width,
          height,
          format: 'rgba',
        };
        frameSeq += 1;
        yield { ch: 'frames' as const, ts: ingest.ts, payload };
      }
      ctx.log(`live ingest ended: ${received} frame(s) received, ${dropped} dropped by fps sampling`);
      continue;
    }
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

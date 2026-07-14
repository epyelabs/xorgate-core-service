import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

export const def = defineNode({
  type: 'video.decode_sample',
  version: 1,
  group: 'video',
  label: 'Decode & Sample',
  description: 'Decodes a video stream and samples frames at a fixed rate.',
  ui: { icon: 'film' },
  inputs: [{ id: 'video', label: 'Video', channel: 'video', cardinality: 'one', required: true }],
  outputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'many', required: false }],
  config: z.object({
    fps: z.number().positive().max(30).default(2).describe('Frames sampled per second'),
    maxWidth: z
      .number()
      .int()
      .min(160)
      .max(3840)
      .optional()
      .describe('Downscale frames to this width while decoding (default: source size)'),
  }),
  requires: [],
  runtime: { target: 'media' },
});

export const executor = stubExecutor(def.type);

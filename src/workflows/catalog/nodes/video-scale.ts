import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

export const def = defineNode({
  type: 'video.scale',
  version: 1,
  group: 'video',
  label: 'Scale',
  description: 'Resizes decoded frames.',
  ui: { icon: 'scaling' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'many', required: false }],
  config: z.object({
    width: z.number().int().min(32).max(3840).default(640).describe('Target width in pixels'),
    height: z
      .number()
      .int()
      .min(32)
      .max(2160)
      .optional()
      .describe('Target height in pixels (default: keep aspect ratio)'),
  }),
  requires: [],
  runtime: { target: 'media' },
});

export const executor = stubExecutor(def.type);

import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

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

export const executor = stubExecutor(def.type);

import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

// Emits json:depth records (per-frame depth statistics + an S3 artifact ref for
// the rendered map). Backend-selectable per architecture.md §6: CPU ONNX
// (relative depth) by default, GPU endpoint (metric depth) when demanded. Ports
// do not change between backends.
export const def = defineNode({
  type: 'model.depth',
  version: 1,
  group: 'model',
  label: 'Depth Estimation',
  description: 'Estimates per-frame depth for distance reasoning and depth-map visualization.',
  ui: { icon: 'layers' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [
    { id: 'depth', label: 'Depth', channel: 'json', tag: 'depth', cardinality: 'many', required: false },
  ],
  config: z.object({
    backend: z
      .enum(['cpu-onnx', 'gpu-endpoint'])
      .default('cpu-onnx')
      .describe('cpu-onnx: relative depth in-process; gpu-endpoint: metric depth (Depth Pro)'),
    model: z.string().min(1).default('depth-anything-v2-small').describe('Depth model (from the model registry)'),
  }),
  requires: [],
  runtime: { target: 'media', gpuPreferred: false, modelRef: { family: 'depth' } },
});

export const executor = stubExecutor(def.type);

import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

// Overlay-annotated video preview (architecture.md §3.3's derived-rule example):
// requires frames plus at least one overlay input, expressed as the port
// signature + an atLeastOneOf constraint. The FE filters the overlay
// multi-select by which tagged inputs are connected.
export const def = defineNode({
  type: 'output.visualization',
  version: 1,
  group: 'output',
  label: 'Video Visualization',
  description: 'Renders detection / depth overlays on the video for preview and review.',
  ui: { icon: 'monitor-play' },
  inputs: [
    { id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true },
    {
      id: 'detections',
      label: 'Detections',
      channel: 'json',
      tag: 'detections',
      cardinality: 'one',
      required: false,
    },
    { id: 'depth', label: 'Depth', channel: 'json', tag: 'depth', cardinality: 'one', required: false },
  ],
  outputs: [],
  config: z.object({
    overlays: z
      .array(z.enum(['boxes', 'labels', 'confidence', 'depth_map']))
      .default(['boxes', 'labels'])
      .describe('Overlay layers to render (options depend on connected inputs)'),
  }),
  requires: [],
  runtime: { target: 'media' },
  constraints: [{ kind: 'atLeastOneOf', ports: ['detections', 'depth'] }],
});

export const executor = stubExecutor(def.type);

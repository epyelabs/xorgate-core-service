import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

// Emits json:detections records ({ ts, boxes: [{ cls, confidence, xyxy }] }).
// The model name resolves against the S3 model registry (M2); until the
// registry lands the default matches the cv-runner's bundled YOLOv8n.
export const def = defineNode({
  type: 'model.object_detection',
  version: 1,
  group: 'model',
  label: 'Object Detection',
  description: 'Runs a detector over frames and emits bounding boxes.',
  ui: { icon: 'scan-eye' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [
    {
      id: 'detections',
      label: 'Detections',
      channel: 'json',
      tag: 'detections',
      cardinality: 'many',
      required: false,
    },
  ],
  config: z.object({
    model: z.string().min(1).default('yolov8n').describe('Detection model (from the model registry)'),
    minConfidence: z.number().min(0).max(1).default(0.4).describe('Discard detections below this score'),
    classes: z
      .array(z.string().min(1))
      .optional()
      .describe('Keep only these class names (default: all)'),
  }),
  requires: [],
  runtime: { target: 'media', modelRef: { family: 'detection' } },
});

export const executor = stubExecutor(def.type);

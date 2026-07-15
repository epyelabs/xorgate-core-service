import { z } from 'zod';
import { mergeByTs, requireInput } from '../../engine/helpers';
import { encodeRgbaToJpeg } from '../../engine/media';
import { drawDetections, type OverlayKind } from '../../engine/vision';
import type {
  DetectionBox,
  DetectionsPayload,
  EngineEmit,
  EngineInChannel,
  EngineRunCtx,
  FramePayload,
} from '../types';
import { defineNode } from '../types';

// Overlay-annotated video preview (architecture.md §3.3's derived-rule example):
// requires frames plus at least one overlay input, expressed as the port
// signature + an atLeastOneOf constraint. The FE filters the overlay
// multi-select by which tagged inputs are connected.

const configSchema = z.object({
  overlays: z
    .array(z.enum(['boxes', 'labels', 'confidence', 'depth_map']))
    .default(['boxes', 'labels'])
    .describe('Overlay layers to render (options depend on connected inputs)'),
});

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
  config: configSchema,
  requires: [],
  runtime: { target: 'media' },
  constraints: [{ kind: 'atLeastOneOf', ports: ['detections', 'depth'] }],
});

// Minimal M2 renderer: box/label/confidence overlays on a COPY of each shared
// frame, JPEG-encoded to frames/<nodeId>/<frameSeq>.jpg through the target's
// artifact sink. Detections pair with frames by exact ts (the detector stamps
// its output with the frame ts, and mergeByTs breaks ties detections-first, so
// a frame's boxes always arrive before the frame). depth_map rendering is M4.
export const executor = async function* outputVisualization(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  if (!ctx.artifacts) {
    throw new Error('This engine target has no artifact sink for visualization frames');
  }
  const framesInput = requireInput(inputs, 'frames');
  const detectionsInput = inputs.find((i) => i.port === 'detections');
  const depthInput = inputs.find((i) => i.port === 'depth');
  if (depthInput && !detectionsInput) {
    throw new Error('Depth-only visualization is not implemented until M4');
  }
  const overlays = new Set<OverlayKind>(cfg.overlays.filter((o) => o !== 'depth_map'));
  if (cfg.overlays.includes('depth_map')) {
    ctx.log('depth_map overlay is not implemented until M4; rendering the other overlays');
  }

  const boxesByTs = new Map<number, DetectionBox[]>();
  let rendered = 0;
  const merged = detectionsInput ? mergeByTs([detectionsInput, framesInput]) : mergeByTs([framesInput]);
  for await (const { input, msg } of merged) {
    if (input === detectionsInput) {
      if (msg.ch !== 'json') continue;
      const det = msg.payload as DetectionsPayload;
      boxesByTs.set(msg.ts, det.boxes ?? []);
      continue;
    }
    if (msg.ch !== 'frames') continue;
    const frame = msg.payload as FramePayload;
    const boxes = boxesByTs.get(msg.ts) ?? [];
    boxesByTs.delete(msg.ts);
    const canvas = Buffer.from(frame.image); // shared buffer: copy before drawing
    drawDetections(canvas, frame.width, frame.height, boxes, overlays);
    const jpegBuf = encodeRgbaToJpeg(canvas, frame.width, frame.height, 80);
    await ctx.artifacts.putFrame(ctx.nodeId, frame.seq, jpegBuf);
    rendered += 1;
  }
  ctx.setSummary(`${rendered} annotated frame(s)`);
};

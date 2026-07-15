/**
 * Headless smoke test for the v2 engine (M2 sessions 1 + 2). No test framework
 * in this repo; run from the service root with:
 *
 *   npx ts-node -T --compilerOptions '{"module":"commonjs","target":"ES2022"}' scripts/engine-smoke.ts
 *
 * Covers:
 *   1. bounded-channel backpressure (block policy, producer stalls at capacity)
 *   2. drop-oldest policy (live-mode frames channels: latest wins)
 *   3. scenario 5 (idle detect): telemetry -> ema -> window_aggregate ->
 *      threshold -> event, from an in-memory (telemetry_inline) source, through
 *      to the frozen result.json shape
 *   4. step/skip semantics: failing node -> failed step, descendants skipped,
 *      independent branch still ok
 *   5. output.data_capture collects records (unit level)
 *   6. logic.debounce sustained-true / rising-edge behavior (unit level)
 *   7. vision units: letterbox tensor packing, YOLOv8 head decode + NMS +
 *      class filter + coordinate mapping, RGBA box drawing
 *   8. v2 finalize row mapping against a synthetic (schema-valid) result.json
 *   9. scenario 1 (person detect on a video file): source.video (video_local)
 *      -> ffmpeg decode -> onnxruntime detection -> data_capture +
 *      visualization JPEGs, using the ffmpeg-static devDependency and the
 *      cv-runner's baked yolov8n.onnx as a local registry. (The events leg of
 *      scenario 1 needs a detections->condition node that is not in the frozen
 *      M1 catalog; records + visualization are the asserted outputs.)
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getExecutor } from '../src/workflows/catalog/index';
import type {
  EngineArtifactSink,
  EngineMessage,
  EngineRunCtx,
  EngineSourceReader,
} from '../src/workflows/catalog/types';
import { BoundedChannel } from '../src/workflows/engine/channel';
import { decodeJpegToRgba } from '../src/workflows/engine/media';
import { runGraph } from '../src/workflows/engine/index';
import { buildEngineResult, engineResultSchema } from '../src/workflows/engine/manifest';
import { v2EventRows, v2RunUpdate, v2StepRows } from '../src/workflows/engine/finalize';
import {
  classColor,
  drawDetections,
  letterboxToTensor,
  postprocessYoloV8,
} from '../src/workflows/engine/vision';
import { modelManifestSchema, type ModelManifest } from '../src/workflows/models/registry';
import type { WorkflowDefinition } from '../src/schemas/workflows';

// Executors spawn `ffmpeg` from PATH unless FFMPEG_PATH points elsewhere; the
// dev machine has no system ffmpeg, so use the ffmpeg-static binary.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG_STATIC: string = require('ffmpeg-static');
process.env.FFMPEG_PATH = FFMPEG_STATIC;

const failingSources: EngineSourceReader = {
  readTelemetryWindow: async () => {
    throw new Error('smoke test must not hit a telemetry store');
  },
};

function stubCtx(overrides: Partial<EngineRunCtx> = {}): EngineRunCtx & { captured: unknown[]; summary: string | null } {
  const captured: unknown[] = [];
  const ctx = {
    runId: 'smoke',
    mode: 'batch' as const,
    deviceId: null,
    window: null,
    nodeId: 'unit',
    binding: null,
    sources: failingSources,
    emitEvent: () => {},
    captureRecord: (r: unknown) => captured.push(r),
    setSummary: (s: string) => {
      ctx.summary = s;
    },
    log: () => {},
    captured,
    summary: null as string | null,
    ...overrides,
  };
  return ctx;
}

async function microtasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// --- 1. Backpressure -----------------------------------------------------------
async function testBackpressure(): Promise<void> {
  const ch = new BoundedChannel<number>(4);
  let resolvedPushes = 0;
  const producer = (async () => {
    for (let i = 0; i < 12; i++) {
      await ch.push(i);
      resolvedPushes += 1;
    }
    ch.close();
  })();
  await microtasks();
  assert.strictEqual(resolvedPushes, 4, `producer should stall at capacity (resolved ${resolvedPushes})`);
  const seen: number[] = [];
  for await (const v of ch) {
    seen.push(v);
    await microtasks(2); // slow consumer
  }
  await producer;
  assert.strictEqual(resolvedPushes, 12);
  assert.deepStrictEqual(seen, [...Array(12).keys()]);
  assert.ok(ch.maxDepth <= 4, `channel depth ${ch.maxDepth} exceeded capacity`);
  console.log('ok: backpressure (block policy, depth capped at capacity)');
}

// --- 2. Drop-oldest ---------------------------------------------------------------
async function testDropOldest(): Promise<void> {
  const ch = new BoundedChannel<number>(4, 'drop-oldest');
  for (let i = 0; i < 10; i++) await ch.push(i); // never blocks
  ch.close();
  const seen: number[] = [];
  for await (const v of ch) seen.push(v);
  assert.deepStrictEqual(seen, [6, 7, 8, 9], `drop-oldest kept ${JSON.stringify(seen)}`);
  console.log('ok: drop-oldest (latest wins)');
}

// --- 3. Scenario 5: idle detect from an in-memory telemetry source ----------------
function scenario5Definition(): WorkflowDefinition {
  const node = (id: string, type: string, label: string, config: Record<string, unknown>) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, config },
  });
  const edge = (source: string, target: string, sourceHandle: string, targetHandle: string) => ({
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  });
  return {
    schemaVersion: 2,
    nodes: [
      node('src', 'source.telemetry', 'Telemetry', { metrics: ['vehicle.speed'] }),
      node('ema', 'telemetry.ema', 'EMA Smoothing', { alpha: 0.5 }),
      node('agg', 'telemetry.window_aggregate', 'Window Aggregate', { windowSeconds: 30, fn: 'mean' }),
      node('thr', 'logic.threshold', 'Threshold', { operator: 'lt', value: 2 }),
      node('evt', 'output.event', 'Emit Event', { kind: 'idle_detect', cooldownSeconds: 300 }),
    ],
    edges: [
      edge('src', 'ema', 'telemetry', 'telemetry'),
      edge('ema', 'agg', 'telemetry', 'telemetry'),
      edge('agg', 'thr', 'telemetry', 'telemetry'),
      edge('thr', 'evt', 'condition', 'condition'),
    ],
  };
}

async function testScenario5(): Promise<void> {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const samples: Array<{ ts: number; signals: Record<string, number> }> = [];
  // 60 s of driving (~20 kph with jitter), then 120 s idling (~0.3 kph).
  for (let i = 0; i < 60; i++) {
    samples.push({ ts: t0 + i * 1000, signals: { 'vehicle.speed': 20 + (i % 3) } });
  }
  for (let i = 60; i < 180; i++) {
    samples.push({ ts: t0 + i * 1000, signals: { 'vehicle.speed': 0.3 } });
  }

  const outcome = await runGraph(
    {
      runId: 'run-scenario5',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition: scenario5Definition(),
      bindings: { src: { kind: 'telemetry_inline', samples } },
    },
    { sources: failingSources, channelCapacity: 8 }, // small capacity to exercise backpressure
  );

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error}`);
  assert.strictEqual(outcome.steps.length, 5);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  assert.strictEqual(outcome.events.length, 1, `expected 1 idle event, got ${outcome.events.length}`);
  const event = outcome.events[0];
  assert.strictEqual(event.kind, 'idle_detect');
  const occurredMs = Date.parse(event.occurredAt);
  assert.ok(
    occurredMs > t0 + 60_000 && occurredMs <= t0 + 180_000,
    `event at ${event.occurredAt} is outside the idle period`,
  );
  assert.strictEqual(outcome.metrics.okSteps, 5);
  assert.ok(outcome.metrics.messages > 500, 'expected messages from all four streaming stages');

  // Freeze check: the outcome must assemble into a schema-valid result.json.
  const result = engineResultSchema.parse(buildEngineResult('run-scenario5', outcome));
  assert.strictEqual(result.status, 'succeeded');
  assert.strictEqual(result.artifacts.eventsKey, 'workflows/v2/runs/run-scenario5/events.jsonl');
  console.log(
    `ok: scenario 5 (idle detect) — event at ${event.occurredAt}, ${outcome.metrics.messages} messages`,
  );
}

// --- 4. Step/skip semantics --------------------------------------------------------
async function testSkipSemantics(): Promise<void> {
  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      {
        id: 'src',
        type: 'source.telemetry',
        position: { x: 0, y: 0 },
        data: { label: 'Telemetry', config: { metrics: ['a', 'b'] } },
      },
      {
        // Two signals + no config.signal -> the threshold executor throws.
        id: 'thr',
        type: 'logic.threshold',
        position: { x: 0, y: 0 },
        data: { label: 'Threshold', config: { operator: 'gt', value: 1 } },
      },
      {
        id: 'evt',
        type: 'output.event',
        position: { x: 0, y: 0 },
        data: { label: 'Emit Event', config: { kind: 'x' } },
      },
      {
        // Independent branch off the same source: must complete ok.
        id: 'ema',
        type: 'telemetry.ema',
        position: { x: 0, y: 0 },
        data: { label: 'EMA Smoothing', config: {} },
      },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'thr', sourceHandle: 'telemetry', targetHandle: 'telemetry' },
      { id: 'e2', source: 'thr', target: 'evt', sourceHandle: 'condition', targetHandle: 'condition' },
      { id: 'e3', source: 'src', target: 'ema', sourceHandle: 'telemetry', targetHandle: 'telemetry' },
    ],
  };
  const samples = [...Array(50).keys()].map((i) => ({
    ts: Date.UTC(2026, 0, 1) + i * 1000,
    signals: { a: i, b: i * 2 },
  }));
  const outcome = await runGraph(
    {
      runId: 'run-skip',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition,
      bindings: { src: { kind: 'telemetry_inline', samples } },
    },
    { sources: failingSources, channelCapacity: 4 },
  );
  const byNode = new Map(outcome.steps.map((s) => [s.nodeId, s]));
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.failedNodeId, 'thr');
  assert.match(outcome.error ?? '', /signals/);
  assert.strictEqual(byNode.get('thr')!.status, 'failed');
  assert.strictEqual(byNode.get('evt')!.status, 'skipped');
  assert.strictEqual(byNode.get('src')!.status, 'ok', byNode.get('src')!.output);
  assert.strictEqual(byNode.get('ema')!.status, 'ok', byNode.get('ema')!.output);
  console.log('ok: skip semantics (failed node, skipped descendant, independent branch ok)');
}

// --- 5. output.data_capture (unit) --------------------------------------------------
async function testDataCapture(): Promise<void> {
  const executor = getExecutor('output.data_capture')!;
  const channel = new BoundedChannel<EngineMessage>(8);
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 3; i++) {
    await channel.push({ ch: 'json', tag: 'speed_limit', ts: t0 + i, seq: i, payload: { kph: 50 + i } });
  }
  channel.close();
  const ctx = stubCtx({ nodeId: 'cap' });
  const inputs = [{ port: 'records', from: { nodeId: 'up', port: 'out' }, messages: channel }];
  for await (const _msg of executor(inputs, { format: 'jsonl' }, ctx)) {
    assert.fail('data_capture must not emit messages');
  }
  assert.strictEqual(ctx.captured.length, 3);
  const first = ctx.captured[0] as { ts: number; tag: string; record: { kph: number } };
  assert.strictEqual(first.tag, 'speed_limit');
  assert.strictEqual(first.record.kph, 50);
  assert.strictEqual(ctx.summary, 'captured 3 record(s)');
  console.log('ok: data_capture (records collected via ctx)');
}

// --- 6. logic.debounce (unit) --------------------------------------------------------
async function testDebounce(): Promise<void> {
  const executor = getExecutor('logic.debounce')!;
  const channel = new BoundedChannel<EngineMessage>(64);
  const t0 = Date.UTC(2026, 0, 1);
  const feed: Array<[number, boolean]> = [];
  feed.push([t0, true]); // 1 s blip: must not pass
  feed.push([t0 + 1000, false]);
  for (let i = 10; i <= 20; i++) feed.push([t0 + i * 1000, true]); // sustained 10 s
  feed.push([t0 + 21_000, false]);
  let seq = 0;
  for (const [ts, value] of feed) {
    await channel.push({ ch: 'condition', ts, seq: seq++, payload: { value } });
  }
  channel.close();
  const ctx = stubCtx({ nodeId: 'deb' });
  const inputs = [{ port: 'condition', from: { nodeId: 'up', port: 'condition' }, messages: channel }];
  const out: Array<{ ts: number; value: boolean }> = [];
  for await (const msg of executor(inputs, { minDurationMs: 3000, cooldownMs: 0 }, ctx)) {
    out.push({ ts: msg.ts, value: (msg.payload as { value: boolean }).value });
  }
  const firstTrue = out.find((m) => m.value);
  assert.ok(firstTrue, 'debounce never turned true');
  assert.strictEqual(firstTrue!.ts, t0 + 13_000, `debounce turned true at ${firstTrue!.ts - t0}ms`);
  assert.strictEqual(out.filter((m, i) => m.value && (i === 0 || !out[i - 1].value)).length, 1);
  assert.ok(!out[0].value, 'the 1 s blip must not pass');
  console.log('ok: debounce (sustained-true gate)');
}

// --- 7. Vision units (letterbox / postprocess / drawing) ----------------------------
const DETECTION_INPUT: ModelManifest['input'] = {
  width: 4,
  height: 4,
  layout: 'nchw',
  colorSpace: 'rgb',
  normalize: { scale: 1 / 255 },
  letterbox: { enabled: true, padValue: 114 },
};

function testVisionUnits(): void {
  // Letterbox: a 2x1 red|blue image into 4x4 -> scale 2, content rows 1-2,
  // padded rows at 114/255.
  const image = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]); // red, blue (RGBA)
  const { data, scale, padX, padY } = letterboxToTensor(
    { image, width: 2, height: 1 },
    DETECTION_INPUT,
  );
  assert.strictEqual(scale, 2);
  assert.strictEqual(padX, 0);
  assert.strictEqual(padY, 1);
  const plane = 16;
  const pad = 114 / 255;
  assert.ok(Math.abs(data[0] - pad) < 1e-6, 'top-left must be padding');
  assert.ok(Math.abs(data[1 * 4 + 0] - 1) < 1e-6, 'R channel at content row 1, col 0 must be red');
  assert.ok(Math.abs(data[2 * plane + 1 * 4 + 3] - 1) < 1e-6, 'B channel at content col 3 must be blue');
  assert.ok(Math.abs(data[2 * 4 + 0] - 1) < 1e-6, 'content spans rows 1-2 at scale 2');
  assert.ok(Math.abs(data[3 * 4 + 0] - pad) < 1e-6, 'row 3 must be padding');

  // YOLOv8 decode: dims (1, 4+2 classes, 3 anchors); anchor1 overlaps anchor0
  // (same class, lower score) and must be NMS-suppressed; anchor2 is another
  // class. Coordinates map letterbox -> source via scale 0.5, pad (10, 20).
  const anchors = 3;
  const out = new Float32Array(6 * anchors);
  const put = (c: number, j: number, v: number): void => {
    out[c * anchors + j] = v;
  };
  // anchor 0: person 0.9 at cxcywh (100, 100, 40, 40)
  put(0, 0, 100); put(1, 0, 100); put(2, 0, 40); put(3, 0, 40); put(4, 0, 0.9); put(5, 0, 0.1);
  // anchor 1: person 0.8, heavy overlap with anchor 0
  put(0, 1, 104); put(1, 1, 100); put(2, 1, 40); put(3, 1, 40); put(4, 1, 0.8); put(5, 1, 0.05);
  // anchor 2: car 0.7, elsewhere
  put(0, 2, 300); put(1, 2, 200); put(2, 2, 50); put(3, 2, 60); put(4, 2, 0.1); put(5, 2, 0.7);
  const opts = {
    classNames: ['person', 'car'],
    minConfidence: 0.5,
    iouThreshold: 0.45,
    scale: 0.5,
    padX: 10,
    padY: 20,
    sourceWidth: 640,
    sourceHeight: 480,
  };
  const boxes = postprocessYoloV8(out, [1, 6, anchors], opts);
  assert.strictEqual(boxes.length, 2, `expected 2 boxes after NMS, got ${boxes.length}`);
  assert.strictEqual(boxes[0].cls, 'person');
  assert.strictEqual(boxes[0].confidence, 0.9);
  assert.deepStrictEqual(boxes[0].xyxy, [140, 120, 220, 200]);
  assert.strictEqual(boxes[1].cls, 'car');
  const personsOnly = postprocessYoloV8(out, [1, 6, anchors], {
    ...opts,
    classFilter: new Set(['person']),
  });
  assert.strictEqual(personsOnly.length, 1);
  assert.strictEqual(personsOnly[0].cls, 'person');

  // Drawing: box outline lands palette pixels on a copy, interior untouched.
  const w = 20;
  const h = 20;
  const canvas = Buffer.alloc(w * h * 4, 64);
  drawDetections(canvas, w, h, [{ cls: 'person', confidence: 0.9, xyxy: [2, 6, 14, 18] }], new Set(['boxes']));
  const color = classColor('person');
  assert.strictEqual(canvas[(6 * w + 2) * 4], color[0], 'outline pixel must be the class color');
  assert.strictEqual(canvas[(12 * w + 8) * 4], 64, 'interior must be untouched');
  console.log('ok: vision units (letterbox, yolo decode + NMS + class filter, drawing)');
}

// --- 8. v2 finalize row mapping -----------------------------------------------------
function testFinalizeV2Mapping(): void {
  const outcome = {
    status: 'succeeded' as const,
    error: null,
    failedNodeId: null,
    steps: [
      { seq: 0, nodeId: 'src', label: 'Video', status: 'ok' as const, output: '1 message(s)', durationMs: 12.6 },
      { seq: 1, nodeId: 'cap', label: 'Data Capture', status: 'ok' as const, output: 'captured 3 record(s)', durationMs: 3 },
    ],
    events: [
      {
        kind: 'idle_detect',
        occurredAt: '2026-01-01T12:01:30.000Z',
        confidence: 1,
        payloadSummary: 'idle_detect',
        payload: { observed: 0.4 },
      },
    ],
    captures: { cap: [{ ts: 1, tag: 'detections', record: {} }] },
    metrics: { nodes: 2, okSteps: 2, events: 1, messages: 10 },
  };
  const result = engineResultSchema.parse(buildEngineResult('run-fin', outcome, { cap: 'json' }));
  const steps = v2StepRows('run-fin', result);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps[0], {
    runId: 'run-fin',
    seq: 0,
    nodeId: 'src',
    label: 'Video',
    status: 'ok',
    output: '1 message(s)',
    durationMs: 13,
  });
  const events = v2EventRows({ id: 'run-fin', deviceId: 'dev-1' }, result);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].clip, false);
  assert.strictEqual(events[0].clipS3Key, null);
  assert.strictEqual(events[0].occurredAt.toISOString(), '2026-01-01T12:01:30.000Z');
  const started = new Date('2026-01-01T12:00:00Z');
  const now = new Date('2026-01-01T12:02:00Z');
  const update = v2RunUpdate(result, started, now);
  assert.strictEqual(update.status, 'succeeded');
  assert.strictEqual(update.durationMs, 120_000);
  assert.strictEqual(update.engineVersion, 2);
  assert.strictEqual(update.eventCount, 1);
  assert.deepStrictEqual(update.artifacts.outputs['cap'], {
    recordsKey: 'workflows/v2/runs/run-fin/outputs/cap/records.json',
    count: 1,
    format: 'json',
  });
  console.log('ok: v2 finalize row mapping (steps, events, run update)');
}

// --- 9. Scenario 1: person detect on a video file -----------------------------------
// COCO class names in YOLO index order (what the export CI publishes for yolov8*).
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
];

const YOLO_MODEL_PATH = path.resolve(__dirname, '../cv-runner/models/yolov8n.onnx');

function localDetectionManifest(): ModelManifest {
  return modelManifestSchema.parse({
    manifestVersion: 1,
    family: 'detection',
    name: 'yolov8n',
    version: 1,
    backend: 'cpu-onnx',
    input: {
      width: 640,
      height: 640,
      normalize: { scale: 1 / 255 },
      letterbox: { enabled: true, padValue: 114 },
    },
    classNames: COCO_CLASSES,
    postprocess: { kind: 'yolov8', nmsIouThreshold: 0.45 },
  });
}

function synthesizeMp4(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG_STATIC,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
        '-pix_fmt', 'yuv420p', '-y', outPath,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function testScenario1(): Promise<void> {
  if (!existsSync(YOLO_MODEL_PATH)) {
    throw new Error(
      `scenario 1 needs ${YOLO_MODEL_PATH} (the cv-runner's baked model); export/download it per cv-runner/README.md`,
    );
  }
  const workDir = await mkdtemp(path.join(tmpdir(), 'engine-smoke-'));
  const mp4Path = path.join(workDir, 'fixture.mp4');
  await synthesizeMp4(mp4Path);

  const node = (id: string, type: string, label: string, config: Record<string, unknown>) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, config },
  });
  const edge = (source: string, target: string, sourceHandle: string, targetHandle: string) => ({
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  });
  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      node('src', 'source.video', 'Video', {}),
      node('dec', 'video.decode_sample', 'Decode & Sample', { fps: 2 }),
      node('det', 'model.object_detection', 'Object Detection', {
        model: 'yolov8n',
        minConfidence: 0.5,
        classes: ['person'],
      }),
      node('cap', 'output.data_capture', 'Data Capture', { format: 'jsonl' }),
      node('viz', 'output.visualization', 'Video Visualization', { overlays: ['boxes', 'labels'] }),
    ],
    edges: [
      edge('src', 'dec', 'video', 'video'),
      edge('dec', 'det', 'frames', 'frames'),
      edge('det', 'cap', 'detections', 'records'),
      edge('dec', 'viz', 'frames', 'frames'),
      edge('det', 'viz', 'detections', 'detections'),
    ],
  };

  const sources: EngineSourceReader = {
    readTelemetryWindow: async () => {
      throw new Error('scenario 1 must not read telemetry');
    },
    fetchVideo: async () => {
      throw new Error('video_local bindings must not hit fetchVideo');
    },
    fetchModel: async ({ family, name }) => {
      assert.strictEqual(family, 'detection');
      assert.strictEqual(name, 'yolov8n');
      return { manifest: localDetectionManifest(), modelPath: YOLO_MODEL_PATH };
    },
  };
  const frameArtifacts = new Map<string, Buffer>();
  const artifacts: EngineArtifactSink = {
    async putFrame(nodeId, frameSeq, jpegBuf) {
      const key = `frames/${nodeId}/${frameSeq}.jpg`;
      frameArtifacts.set(key, jpegBuf);
      return key;
    },
  };

  const t0 = Date.parse('2026-01-01T12:00:00Z');
  const outcome = await runGraph(
    {
      runId: 'run-scenario1',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition,
      bindings: { src: { kind: 'video_local', path: mp4Path, startedAt: '2026-01-01T12:00:00Z' } },
    },
    { sources, artifacts, channelCapacity: 8 },
  );

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error}`);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  const records = (outcome.captures['cap'] ?? []) as Array<{
    ts: number;
    tag: string | null;
    record: { frameSeq: number; boxes: unknown[] };
  }>;
  const frames = records.length;
  assert.ok(frames >= 4 && frames <= 8, `expected ~6 sampled frames, got ${frames}`);
  assert.strictEqual(records[0].tag, 'detections');
  assert.strictEqual(records[0].ts, t0, 'first frame ts must anchor at the binding startedAt');
  assert.strictEqual(records[1].ts, t0 + 500, 'frame ts must step by 1/fps');
  for (const r of records) {
    assert.ok(Array.isArray(r.record.boxes), 'each detection record carries a boxes array');
  }
  // testsrc contains no people at minConfidence 0.5; the mechanics (per-frame
  // records) are the assertion, real-detection parity comes from export-CI
  // fixtures. Visualization must have written one JPEG per frame.
  assert.strictEqual(frameArtifacts.size, frames, 'one visualization JPEG per frame');
  const firstJpeg = frameArtifacts.get('frames/viz/0.jpg');
  assert.ok(firstJpeg, 'frame 0 artifact missing');
  assert.strictEqual(firstJpeg![0], 0xff);
  assert.strictEqual(firstJpeg![1], 0xd8, 'artifact must start with a JPEG SOI marker');
  const decoded = decodeJpegToRgba(firstJpeg!);
  assert.strictEqual(decoded.width, 320);
  assert.strictEqual(decoded.height, 240);

  // Freeze check: the outcome assembles into a schema-valid v2 result.json.
  const result = engineResultSchema.parse(buildEngineResult('run-scenario1', outcome, { cap: 'jsonl' }));
  assert.strictEqual(result.artifacts.outputs['cap'].count, frames);
  const detStep = outcome.steps.find((s) => s.nodeId === 'det')!;
  console.log(
    `ok: scenario 1 (video decode -> onnx detection -> capture + visualization) — ${frames} frames, det: ${detStep.output}`,
  );
}

// --- 10. video.scale (unit, persistent ffmpeg rawvideo pipe) -------------------------
async function testVideoScale(): Promise<void> {
  const executor = getExecutor('video.scale')!;
  const channel = new BoundedChannel<EngineMessage>(8);
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 3; i++) {
    const image = Buffer.alloc(64 * 48 * 4);
    image.fill(i * 60 + 40); // distinct flat gray per frame
    await channel.push({
      ch: 'frames',
      ts: t0 + i * 500,
      seq: i,
      payload: { seq: i, ts: t0 + i * 500, image, width: 64, height: 48, format: 'rgba' },
    });
  }
  channel.close();
  const ctx = stubCtx({ nodeId: 'scale' });
  const inputs = [{ port: 'frames', from: { nodeId: 'up', port: 'frames' }, messages: channel }];
  const frames: Array<{ width: number; height: number; image: Buffer }> = [];
  for await (const msg of executor(inputs, { width: 32 }, ctx)) {
    frames.push(msg.payload as { width: number; height: number; image: Buffer });
  }
  assert.strictEqual(frames.length, 3);
  assert.strictEqual(frames[0].width, 32);
  assert.strictEqual(frames[0].height, 24, 'aspect ratio kept, even-rounded');
  assert.strictEqual(frames[0].image.length, 32 * 24 * 4);
  // Flat input -> flat output at the same level (scaling must not shift values).
  assert.ok(Math.abs(frames[1].image[0] - 100) <= 2, `frame 1 level ${frames[1].image[0]}`);
  console.log('ok: video.scale (persistent ffmpeg rawvideo pipe, 3 frames)');
}

async function main(): Promise<void> {
  await testBackpressure();
  await testDropOldest();
  await testScenario5();
  await testSkipSemantics();
  await testDataCapture();
  await testDebounce();
  testVisionUnits();
  testFinalizeV2Mapping();
  await testScenario1();
  await testVideoScale();
  console.log('\nengine smoke: all checks passed');
}

main().catch((err) => {
  console.error('\nengine smoke FAILED:', err);
  process.exit(1);
});

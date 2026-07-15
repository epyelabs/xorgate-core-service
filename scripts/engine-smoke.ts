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
 *      visualization JPEGs + the M3 events leg (detection_gate -> emit event;
 *      testsrc contains no people, so the leg runs ok with zero events here),
 *      using the ffmpeg-static devDependency and the cv-runner's baked
 *      yolov8n.onnx as a local registry
 *  10. video.scale unit (persistent ffmpeg rawvideo pipe)
 *  11. scenario 1 events leg, deterministic: real detection_gate + output.event
 *      executors chained over synthetic detections -> exactly one rising-edge
 *      event (M3's sanctioned catalog addition)
 *  12. scenario 2 (overspeed): telemetry -> Roads connector (mocked HTTP +
 *      fake secrets) -> comparator -> debounce -> event, end to end through
 *      runGraph, with cache-hit lookup counting and live progress records
 *  13. telemetry_csv binding: CSV via the fetchText seam, metrics filter,
 *      non-numeric cell skipping
 *  14. progress plane: IotRunProgress against a fake transport during a real
 *      run (status/steps/events payloads parse against the frozen schemas) +
 *      preview downscale (640 -> 480, base64 under the IoT cap)
 *  15. simulations module: request schema, binding validation issues, API ->
 *      executor binding mapping, schema-valid simulation manifest
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
  EngineSecretReader,
  EngineSourceReader,
} from '../src/workflows/catalog/types';
import { parseTelemetryCsv } from '../src/workflows/catalog/nodes/source-telemetry';
import { BoundedChannel } from '../src/workflows/engine/channel';
import { decodeJpegToRgba, encodeRgbaToJpeg } from '../src/workflows/engine/media';
import { runGraph } from '../src/workflows/engine/index';
import { buildEngineResult, engineResultSchema, runManifestSchema } from '../src/workflows/engine/manifest';
import { v2EventRows, v2RunUpdate, v2StepRows } from '../src/workflows/engine/finalize';
import {
  IotRunProgress,
  simEventPayloadSchema,
  simPreviewPayloadSchema,
  simRecordPayloadSchema,
  simStatusPayloadSchema,
  simStepPayloadSchema,
  simTopicPrefix,
} from '../src/workflows/engine/progress';
import {
  buildSimulationManifest,
  createSimulationSchema,
  engineTargetForDefinition,
  simulationWindow,
  toManifestInputs,
  validateSimulationBindings,
  type SimulationBinding,
} from '../src/workflows/simulations';
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

const failingFetch: typeof fetch = async () => {
  throw new Error('smoke test must not reach the network');
};

function stubCtx(overrides: Partial<EngineRunCtx> = {}): EngineRunCtx & { captured: unknown[]; summary: string | null; events: unknown[] } {
  const captured: unknown[] = [];
  const events: unknown[] = [];
  const ctx = {
    runId: 'smoke',
    mode: 'batch' as const,
    deviceId: null,
    window: null,
    nodeId: 'unit',
    binding: null,
    sources: failingSources,
    artifacts: null,
    secrets: null,
    http: failingFetch,
    emitEvent: (e: unknown) => events.push(e),
    captureRecord: (r: unknown) => captured.push(r),
    setSummary: (s: string) => {
      ctx.summary = s;
    },
    log: () => {},
    captured,
    events,
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
      // M3 events leg: detections -> gate -> event. testsrc has no people, so
      // this asserts the leg RUNS (steps ok, zero events); the deterministic
      // event assertion is testDetectionGateEventsLeg.
      node('gate', 'logic.detection_gate', 'Detection Gate', {
        classes: ['person'],
        minConfidence: 0.5,
        minCount: 1,
      }),
      node('evt', 'output.event', 'Emit Event', { kind: 'person_at_perimeter' }),
    ],
    edges: [
      edge('src', 'dec', 'video', 'video'),
      edge('dec', 'det', 'frames', 'frames'),
      edge('det', 'cap', 'detections', 'records'),
      edge('dec', 'viz', 'frames', 'frames'),
      edge('det', 'viz', 'detections', 'detections'),
      edge('det', 'gate', 'detections', 'detections'),
      edge('gate', 'evt', 'condition', 'condition'),
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
  const gateStep = outcome.steps.find((s) => s.nodeId === 'gate')!;
  assert.strictEqual(gateStep.status, 'ok', `gate step: ${gateStep.output}`);
  assert.match(gateStep.output, /detection frame\(s\)/);
  const detStep = outcome.steps.find((s) => s.nodeId === 'det')!;
  console.log(
    `ok: scenario 1 (video decode -> onnx detection -> capture + visualization + events leg) — ${frames} frames, det: ${detStep.output}`,
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

// --- 11. Scenario 1 events leg, deterministic (detection_gate -> output.event) -------
async function testDetectionGateEventsLeg(): Promise<void> {
  const gate = getExecutor('logic.detection_gate')!;
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const detections = new BoundedChannel<EngineMessage>(16);
  const frame = (seq: number, boxes: Array<{ cls: string; confidence: number }>) => ({
    ch: 'json' as const,
    tag: 'detections',
    ts: t0 + seq * 500,
    seq,
    payload: {
      ts: t0 + seq * 500,
      frameSeq: seq,
      width: 640,
      height: 480,
      boxes: boxes.map((b) => ({ ...b, xyxy: [10, 10, 50, 90] as [number, number, number, number] })),
    },
  });
  await detections.push(frame(0, []));
  await detections.push(frame(1, [{ cls: 'person', confidence: 0.3 }])); // below minConfidence
  await detections.push(frame(2, [{ cls: 'car', confidence: 0.9 }])); // wrong class
  await detections.push(frame(3, [{ cls: 'person', confidence: 0.9 }])); // fires
  await detections.push(frame(4, [{ cls: 'person', confidence: 0.9 }])); // still true, no re-fire
  detections.close();

  const gateCtx = stubCtx({ nodeId: 'gate' });
  const gateOut = new BoundedChannel<EngineMessage>(16);
  let seq = 0;
  for await (const msg of gate(
    [{ port: 'detections', from: { nodeId: 'det', port: 'detections' }, messages: detections }],
    { classes: ['person'], minConfidence: 0.5, minCount: 1 },
    gateCtx,
  )) {
    await gateOut.push({ ...msg, seq: seq++ } as EngineMessage);
  }
  gateOut.close();
  assert.strictEqual(gateCtx.summary, 'true on 2/5 detection frame(s)');

  const eventExec = getExecutor('output.event')!;
  const evtCtx = stubCtx({ nodeId: 'evt' });
  for await (const _msg of eventExec(
    [{ port: 'condition', from: { nodeId: 'gate', port: 'condition' }, messages: gateOut }],
    { kind: 'person_at_perimeter' },
    evtCtx,
  )) {
    assert.fail('output.event must not emit messages');
  }
  const events = evtCtx.events as Array<{ kind: string; occurredAt: string; payload: { observed: number; boxes: unknown[] } }>;
  assert.strictEqual(events.length, 1, `expected 1 rising-edge event, got ${events.length}`);
  assert.strictEqual(events[0].kind, 'person_at_perimeter');
  assert.strictEqual(Date.parse(events[0].occurredAt), t0 + 3 * 500, 'event must fire on frame 3');
  assert.strictEqual(events[0].payload.observed, 1);
  assert.strictEqual(events[0].payload.boxes.length, 1, 'event payload carries the matching boxes');
  console.log('ok: scenario 1 events leg (detection_gate -> output.event, one rising-edge event)');
}

// --- 12. Scenario 2: overspeed via the Roads connector -------------------------------
async function testScenario2(): Promise<void> {
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
      node('src', 'source.telemetry', 'Telemetry', {
        metrics: ['speed_kph', 'gps.latitude', 'gps.longitude'],
      }),
      node('roads', 'connector.third_party', 'Connector', { provider: 'google_roads' }),
      node('cmp', 'logic.comparator', 'Comparator', {
        signal: 'speed_kph',
        operator: 'gt',
        field: 'speedLimitKph',
      }),
      node('deb', 'logic.debounce', 'Debounce', { minDurationMs: 5000, cooldownMs: 0 }),
      node('evt', 'output.event', 'Emit Event', { kind: 'overspeed' }),
    ],
    edges: [
      edge('src', 'roads', 'telemetry', 'positions'),
      edge('src', 'cmp', 'telemetry', 'signal'),
      edge('roads', 'cmp', 'speed_limit', 'reference'),
      edge('cmp', 'deb', 'condition', 'condition'),
      edge('deb', 'evt', 'condition', 'condition'),
    ],
  };

  // 100 s at 1 Hz: 40 s at 40 kph, then 60 s at 80 kph against a 50 kph limit.
  // The track moves to a new rounded position every 10 s -> 10 unique lookups.
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const samples = [...Array(100).keys()].map((i) => ({
    ts: t0 + i * 1000,
    signals: {
      speed_kph: i < 40 ? 40 : 80,
      'gps.latitude': 45.5017,
      'gps.longitude': -73.5673 + Math.floor(i / 10) * 0.001,
    },
  }));

  let requests = 0;
  const mockFetch = (async (input: unknown) => {
    const url = String(input);
    assert.ok(url.startsWith('https://roads.googleapis.com/v1/speedLimits?'), url);
    assert.ok(url.includes('units=KPH'), 'Roads request must ask for KPH');
    assert.ok(url.includes('key=test-roads-key'), 'Roads request must carry the secret key');
    requests += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        speedLimits: [{ placeId: `p${requests}`, speedLimit: 50, units: 'KPH' }],
        snappedPoints: [{ placeId: `p${requests}`, originalIndex: 0 }],
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  const secrets: EngineSecretReader = {
    getSecret: async (name) => {
      assert.strictEqual(name, 'google-roads-api-key');
      return 'test-roads-key';
    },
  };

  // Progress records tee: json-channel messages (the connector's speed limits)
  // must reach the records/<nodeId> topic for the client-side overlay plane.
  const published: Array<{ topic: string; payload: string }> = [];
  const progress = new IotRunProgress({
    runId: 'run-scenario2',
    topicPrefix: simTopicPrefix('org-1', 'run-scenario2'),
    publish: async (topic, payload) => {
      published.push({ topic, payload });
    },
    log: () => {},
  });

  const outcome = await runGraph(
    {
      runId: 'run-scenario2',
      mode: 'simulation',
      deviceId: null,
      window: null,
      definition,
      bindings: { src: { kind: 'telemetry_inline', samples } },
    },
    { sources: failingSources, secrets, httpFetch: mockFetch, progress },
  );
  await progress.flush();

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error}`);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  assert.strictEqual(requests, 10, `expected 10 cache-cold lookups, got ${requests}`);
  assert.strictEqual(outcome.events.length, 1, `expected 1 overspeed event, got ${outcome.events.length}`);
  assert.strictEqual(outcome.events[0].kind, 'overspeed');
  // Overspeed starts at t0+40s; debounce passes after 5 s sustained.
  assert.strictEqual(Date.parse(outcome.events[0].occurredAt), t0 + 45_000, outcome.events[0].occurredAt);

  const recordMsgs = published.filter((p) => p.topic.endsWith('/records/roads'));
  assert.ok(recordMsgs.length >= 1, 'connector records must reach the records topic');
  const rec = simRecordPayloadSchema.parse(JSON.parse(recordMsgs[0].payload));
  assert.strictEqual(rec.tag, 'speed_limit');
  assert.strictEqual((rec.payload as { speedLimitKph: number }).speedLimitKph, 50);
  const stepMsgs = published.filter((p) => p.topic.endsWith('/steps'));
  assert.strictEqual(stepMsgs.length, 5, 'one steps message per node');
  console.log(
    `ok: scenario 2 (overspeed via Roads connector) — event at +45s, ${requests} lookups, ${recordMsgs.length} live record(s)`,
  );
}

// --- 13. telemetry_csv binding through the fetchText seam ----------------------------
async function testTelemetryCsv(): Promise<void> {
  const csv = [
    'ts,vehicle.speed,cabin.temp,note',
    '2026-01-01T12:00:02Z,3,21.5,warm',
    '2026-01-01T12:00:00Z,1,20.0,',
    '2026-01-01T12:00:01Z,2,,cold',
  ].join('\n');

  // Unit: parser semantics (ordering, metrics filter, non-numeric skipping).
  const parsed = parseTelemetryCsv(csv);
  assert.strictEqual(parsed.samples.length, 3);
  assert.deepStrictEqual(
    parsed.samples.map((s) => s.signals['vehicle.speed']),
    [1, 2, 3],
    'samples must be ts-sorted',
  );
  assert.strictEqual(parsed.samples[0].signals['cabin.temp'], 20);
  assert.strictEqual(parsed.skippedCells, 2, 'both "warm"/"cold" note cells skip');
  const filtered = parseTelemetryCsv(csv, ['vehicle.speed']);
  assert.deepStrictEqual(Object.keys(filtered.samples[0].signals), ['vehicle.speed']);

  // Through the executor + fetchText seam (the run-path shape).
  const executor = getExecutor('source.telemetry')!;
  const sources: EngineSourceReader = {
    readTelemetryWindow: async () => {
      throw new Error('CSV binding must not read the telemetry store');
    },
    fetchText: async ({ bucket, key }) => {
      assert.strictEqual(bucket, null);
      assert.strictEqual(key, 'workflows/v2/uploads/org-1/2026-07-15/u1/drive.csv');
      return csv;
    },
  };
  const ctx = stubCtx({
    nodeId: 'src',
    sources,
    binding: { kind: 'telemetry_csv', s3Key: 'workflows/v2/uploads/org-1/2026-07-15/u1/drive.csv' },
  });
  const out: number[] = [];
  for await (const msg of executor([], { metrics: ['vehicle.speed'] }, ctx)) {
    out.push((msg.payload as { signals: Record<string, number> }).signals['vehicle.speed']);
  }
  assert.deepStrictEqual(out, [1, 2, 3]);
  assert.match(ctx.summary ?? '', /csv/);
  console.log('ok: telemetry_csv (parser + fetchText seam through source.telemetry)');
}

// --- 14. Progress plane: publisher during a real run + preview downscale -------------
async function testProgressPlane(): Promise<void> {
  const published: Array<{ topic: string; payload: string }> = [];
  const progress = new IotRunProgress({
    runId: 'run-progress',
    topicPrefix: simTopicPrefix('org-1', 'run-progress'),
    publish: async (topic, payload) => {
      published.push({ topic, payload });
    },
    log: () => {},
  });

  // Target-shaped lifecycle: running -> graph -> final status -> flush.
  progress.runStatus({ status: 'running' });
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const samples = [...Array(120).keys()].map((i) => ({
    ts: t0 + i * 1000,
    signals: { 'vehicle.speed': i < 30 ? 20 : 0.3 },
  }));
  const definition = scenario5Definition();
  const outcome = await runGraph(
    {
      runId: 'run-progress',
      mode: 'simulation',
      deviceId: null,
      window: null,
      definition,
      bindings: { src: { kind: 'telemetry_inline', samples } },
    },
    { sources: failingSources, progress },
  );
  progress.runStatus({ status: outcome.status, error: outcome.error, failedNodeId: outcome.failedNodeId });
  await progress.flush();

  const prefix = 'wf/sim/org-1/run-progress';
  const byTopic = (suffix: string) => published.filter((p) => p.topic === `${prefix}${suffix}`);
  const statusMsgs = byTopic('/status').map((p) => simStatusPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(statusMsgs.length, 2);
  assert.strictEqual(statusMsgs[0].status, 'running');
  assert.strictEqual(statusMsgs[1].status, 'succeeded');
  const stepMsgs = byTopic('/steps').map((p) => simStepPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(stepMsgs.length, definition.nodes.length, 'one steps message per node');
  assert.ok(stepMsgs.every((m) => m.step.status === 'ok'));
  const eventMsgs = byTopic('/events').map((p) => simEventPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(eventMsgs.length, 1);
  assert.strictEqual(eventMsgs[0].event.kind, 'idle_detect');

  // Preview: a 640x480 frame downscales to 480 wide, base64 under the cap.
  const wide = Buffer.alloc(640 * 480 * 4);
  for (let i = 0; i < wide.length; i += 4) {
    wide[i] = (i / 4) % 256;
    wide[i + 3] = 255;
  }
  progress.preview('viz', 7, encodeRgbaToJpeg(wide, 640, 480, 80));
  await progress.flush();
  const previewMsgs = byTopic('/preview/viz').map((p) => simPreviewPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(previewMsgs.length, 1);
  assert.strictEqual(previewMsgs[0].width, 480);
  assert.strictEqual(previewMsgs[0].frameSeq, 7);
  assert.ok(previewMsgs[0].jpegBase64.length < 110_000, `preview base64 ${previewMsgs[0].jpegBase64.length}`);
  const decoded = decodeJpegToRgba(Buffer.from(previewMsgs[0].jpegBase64, 'base64'));
  assert.strictEqual(decoded.width, 480);
  console.log(
    `ok: progress plane (status/steps/events schemas, preview downscale ${previewMsgs[0].width}x${previewMsgs[0].height})`,
  );
}

// --- 15. Simulations module: request schema, binding validation, manifest ------------
function testSimulationsModule(): void {
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, config },
  });
  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      node('vid', 'source.video'),
      node('tel', 'source.telemetry', { metrics: ['gps.speed'] }),
      node('dec', 'video.decode_sample', { fps: 2 }),
      node('evt', 'output.event', { kind: 'x' }),
    ],
    edges: [],
  };
  const orgId = '9f9e0cf2-0000-4000-8000-000000000001';
  const deviceId = '9f9e0cf2-0000-4000-8000-000000000002';
  const recordingId = '9f9e0cf2-0000-4000-8000-000000000003';

  // Request wire shape parses (the FROZEN simulations POST body).
  const request = createSimulationSchema.parse({
    definition,
    bindings: {
      vid: { kind: 'recording', recordingId },
      tel: {
        kind: 'device_telemetry',
        deviceId,
        window: { from: '2026-01-01T12:00:00Z', to: '2026-01-01T12:10:00Z' },
      },
    },
  });

  // Binding validation: happy path, then each failure class.
  assert.deepStrictEqual(validateSimulationBindings(definition, request.bindings, orgId), []);
  const missing = validateSimulationBindings(definition, { vid: request.bindings.vid }, orgId);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].nodeId, 'tel');
  const wrongKind = validateSimulationBindings(
    definition,
    { ...request.bindings, vid: request.bindings.tel },
    orgId,
  );
  assert.ok(wrongKind.some((i) => i.nodeId === 'vid' && /does not fit/.test(i.message)));
  const foreignUpload = validateSimulationBindings(
    definition,
    {
      ...request.bindings,
      vid: { kind: 'video_file', uploadKey: 'workflows/v2/uploads/other-org/x/v.mp4' } as SimulationBinding,
    },
    orgId,
  );
  assert.ok(foreignUpload.some((i) => /upload endpoint/.test(i.message)));

  // Engine target: media graph -> fargate; telemetry-only -> lambda.
  assert.strictEqual(engineTargetForDefinition(definition), 'fargate');
  assert.strictEqual(engineTargetForDefinition(scenario5Definition()), 'lambda');

  // API bindings -> executor bindings -> schema-valid manifest.
  const inputs = toManifestInputs(request.bindings, new Map([[
    recordingId,
    {
      s3Key: 'media/v1/dev/cam0/rec.mp4',
      recordingId,
      recordingStartedAt: '2026-01-01T12:00:00Z',
      captureStartedAt: '2026-01-01T12:00:03Z',
    },
  ]]));
  const manifest = buildSimulationManifest({
    runId: 'run-sim-1',
    orgId,
    bucket: 'test-bucket',
    definition,
    deviceId,
    inputs,
    window: simulationWindow(request.bindings),
    target: 'fargate',
  });
  runManifestSchema.parse(manifest); // freeze check (buildSimulationManifest already parses)
  assert.strictEqual(manifest.mode, 'simulation');
  assert.strictEqual(manifest.progress?.topicPrefix, `wf/sim/${orgId}/run-sim-1`);
  assert.strictEqual(manifest.window?.from, '2026-01-01T12:00:00.000Z');
  assert.strictEqual(manifest.limits.maxRuntimeSeconds, 900);
  const byNode = new Map(manifest.inputs.map((i) => [i.nodeId, i.binding]));
  assert.deepStrictEqual(byNode.get('vid'), {
    kind: 'recording',
    s3Key: 'media/v1/dev/cam0/rec.mp4',
    recordingId,
    recordingStartedAt: '2026-01-01T12:00:00Z',
    captureStartedAt: '2026-01-01T12:00:03Z',
  });
  assert.deepStrictEqual(byNode.get('tel'), {
    kind: 'telemetry_history',
    window: { from: '2026-01-01T12:00:00Z', to: '2026-01-01T12:10:00Z' },
  });
  console.log('ok: simulations module (request schema, binding validation, manifest mapping)');
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
  await testDetectionGateEventsLeg();
  await testScenario2();
  await testTelemetryCsv();
  await testProgressPlane();
  testSimulationsModule();
  console.log('\nengine smoke: all checks passed');
}

main().catch((err) => {
  console.error('\nengine smoke FAILED:', err);
  process.exit(1);
});

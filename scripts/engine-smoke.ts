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
 *      using the ffmpeg-static devDependency and the baked yolov8n.onnx
 *      (scripts/models/, relocated from the retired cv-runner) as a local
 *      registry
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
 *  16. telemetry.geofence: point-in-polygon + executor semantics (inside /
 *      outside modes, missing-position samples skipped)
 *  17. depth + segmentation vision units: map normalization/stats/downsample,
 *      median-in-box, bit packing, synthetic yolov8-seg decode, mask/depth
 *      drawing
 *  18. proximity gate + boolean fusion, deterministic: synthetic depth records
 *      (per-box proximity) -> proximity_gate -> boolean AND with a braking
 *      condition -> output.event fires exactly once
 *  19. telemetry_materialized binding (the M4 container telemetry seam):
 *      dispatcher-written records.jsonl through the fetchText seam
 *  20. scenario 3 (sudden stops, fusion): gps + imu -> time_align ->
 *      outlier_removal -> kalman -> derivative -> threshold; video -> decode
 *      -> detection -> depth (frames + detections) -> proximity_gate; boolean
 *      AND -> event. Real yolov8n + depth-anything-v2-small ONNX; testsrc has
 *      no vehicles, so the deterministic event assertion is check 18.
 *  21. scenario 8 (road scene segmentation): video -> decode -> segmentation
 *      (+ depth) -> visualization masks/depth_map overlays + captured
 *      json:segments records. Real yolov8n-seg ONNX.
 *  22. model.vlm unit (M5): sampled frames through the REAL Anthropic SDK
 *      request path against a mocked fetch — fps/downscale guardrails,
 *      structured-output verdict parsing, confidence clamping, refusal
 *      handling, secrets seam
 *  23. scenario 4/7 live plane (M5): webcam binding -> source.video ->
 *      decode_sample live pass-through -> model.vlm (mocked Claude) -> event +
 *      capture, end to end through runGraph in live mode with synthetic JPEG
 *      ingest frames via a mocked openLiveFrames seam
 *  24. warm session loop (M5): jobs run serially, a job failure does not kill
 *      the session, idle timeout ends it
 *  25. simulations module M5 additions: webcam API binding validation +
 *      manifest mapping, live manifest mode, session key/queue naming
 *  26. production dispatch module (M6): trigger-context video selection,
 *      triggered manifest inputs (recording bindings + fargate-only
 *      telemetry_history), window resolution, production manifest (mode
 *      batch, wf/run progress prefix, per-target runtime limits)
 *  27. cutover routing (M6): v1 definitions upgraded at fire time route to the
 *      catalog-derived target (video graph -> fargate, telemetry -> lambda);
 *      unknown types are detected before dispatch
 *  28. capability re-verify (M6): upgraded v1 graphs emit metric:* tokens that
 *      real device-model caps satisfy; legacy gps/imu group tokens still
 *      satisfiable for stored attachments
 *
 * Checks 20/21 need the M4 model exports on disk (model-export/out/...); run
 * model-export/export_depth.py and export_yolo.py --name yolov8n-seg first.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getExecutor } from '../src/workflows/catalog/index';
import type {
  DepthPayload,
  EngineArtifactSink,
  EngineMessage,
  EngineRunCtx,
  EngineSecretReader,
  EngineSourceReader,
  FramePayload,
  LiveIngestFrame,
} from '../src/workflows/catalog/types';
import { runSessionLoop } from '../src/workflows/engine/session';
import { parseTelemetryCsv, parseTelemetryJsonl } from '../src/workflows/catalog/nodes/source-telemetry';
import { pointInPolygon } from '../src/workflows/catalog/nodes/telemetry-geofence';
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
  runTopicPrefix,
  simTopicPrefix,
} from '../src/workflows/engine/progress';
import {
  buildProductionManifest,
  buildTriggeredInputs,
  PRODUCTION_MAX_RUNTIME_SECONDS,
  resolveTriggeredWindow,
  triggeredVideoSelection,
  unknownNodeTypes,
} from '../src/workflows/production';
import { upgradeDefinition } from '../src/workflows/compat';
import {
  computeRequiredCapabilities,
  missingCapabilities,
} from '../src/services/workflow-capabilities';
import {
  buildSimulationManifest,
  createSimulationSchema,
  engineTargetForDefinition,
  hasLiveBindings,
  sessionQueueName,
  simulationSessionKey,
  simulationWindow,
  toManifestInputs,
  validateSimulationBindings,
  type SimulationBinding,
} from '../src/workflows/simulations';
import {
  blendDepthOverlay,
  classColor,
  depthMapStats,
  downsampleDepthMap,
  drawDetections,
  drawSegments,
  letterboxToTensor,
  medianDepthInBox,
  normalizeDepthMap,
  packBits,
  postprocessYoloV8,
  postprocessYoloV8Seg,
  unpackBit,
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

// The baked ultralytics 640 export, relocated from the retired cv-runner (M6).
const YOLO_MODEL_PATH = path.resolve(__dirname, 'models/yolov8n.onnx');

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
      `scenario 1 needs ${YOLO_MODEL_PATH} (the baked yolov8n export, committed at scripts/models/); restore it from git or run model-export/export_yolo.py`,
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

// --- 16. telemetry.geofence -----------------------------------------------------------
async function testGeofence(): Promise<void> {
  // Unit: square fence around (45.50, -73.60).
  const square = [
    { lat: 45.49, lng: -73.61 },
    { lat: 45.51, lng: -73.61 },
    { lat: 45.51, lng: -73.59 },
    { lat: 45.49, lng: -73.59 },
  ];
  assert.ok(pointInPolygon(45.5, -73.6, square), 'center must be inside');
  assert.ok(!pointInPolygon(45.6, -73.6, square), 'north point must be outside');
  assert.ok(!pointInPolygon(45.5, -73.7, square), 'west point must be outside');

  const executor = getExecutor('telemetry.geofence')!;
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const channel = new BoundedChannel<EngineMessage>(16);
  const feed = [
    { ts: t0, signals: { 'gps.latitude': 45.5, 'gps.longitude': -73.6 } }, // inside
    { ts: t0 + 1000, signals: { 'gps.latitude': 45.6, 'gps.longitude': -73.6 } }, // outside
    { ts: t0 + 2000, signals: { 'gps.latitude': 45.5 } }, // no lng: skipped
    { ts: t0 + 3000, signals: { 'gps.latitude': 45.505, 'gps.longitude': -73.595 } }, // inside
  ];
  let seq = 0;
  for (const s of feed) await channel.push({ ch: 'telemetry', ts: s.ts, seq: seq++, payload: { signals: s.signals } });
  channel.close();
  const ctx = stubCtx({ nodeId: 'fence' });
  const out: boolean[] = [];
  for await (const msg of executor(
    [{ port: 'telemetry', from: { nodeId: 'src', port: 'telemetry' }, messages: channel }],
    { polygon: square, mode: 'inside' },
    ctx,
  )) {
    out.push((msg.payload as { value: boolean }).value);
  }
  assert.deepStrictEqual(out, [true, false, true], 'inside/outside sequence (positionless sample skipped)');
  assert.match(ctx.summary ?? '', /1 without a position skipped/);

  // Outside mode flips values.
  const channel2 = new BoundedChannel<EngineMessage>(4);
  await channel2.push({ ch: 'telemetry', ts: t0, seq: 0, payload: { signals: feed[1].signals } });
  channel2.close();
  const ctx2 = stubCtx({ nodeId: 'fence2' });
  for await (const msg of executor(
    [{ port: 'telemetry', from: { nodeId: 'src', port: 'telemetry' }, messages: channel2 }],
    { polygon: square, mode: 'outside' },
    ctx2,
  )) {
    assert.strictEqual((msg.payload as { value: boolean }).value, true, 'outside mode must flip');
  }
  console.log('ok: telemetry.geofence (point-in-polygon, inside/outside, skip without position)');
}

// --- 17. Depth + segmentation vision units --------------------------------------------
function testDepthSegVisionUnits(): void {
  // Depth map normalization: raw 2x2 [1, 2, 3, 5] -> u8 [0, 64, 128, 255].
  const map = normalizeDepthMap(new Float32Array([1, 2, 3, 5]), 2, 2);
  assert.strictEqual(map.min, 1);
  assert.strictEqual(map.max, 5);
  assert.deepStrictEqual([...map.values], [0, 64, 128, 255]);
  const stats = depthMapStats(map);
  assert.strictEqual(stats.min, 1);
  assert.strictEqual(stats.max, 5);
  assert.ok(Math.abs(stats.mean - (0 + 64 + 128 + 255) / 4 / 255) < 1e-3, `mean ${stats.mean}`);

  // Downsample keeps aspect and nearest values.
  const wide = normalizeDepthMap(new Float32Array([...Array(8).keys()]), 4, 2);
  const down = downsampleDepthMap(wide, 2);
  assert.strictEqual(down.width, 2);
  assert.strictEqual(down.height, 1);
  assert.strictEqual(down.values.length, 2);

  // Median-in-box: 4x4 map, right half hot (255), left half cold (0); a box
  // over the right half of a 100x100 source frame must read ~1.
  const raw = new Float32Array(16);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) raw[y * 4 + x] = x < 2 ? 0 : 10;
  const halfMap = normalizeDepthMap(raw, 4, 4);
  assert.strictEqual(medianDepthInBox(halfMap, [50, 0, 100, 100], 100, 100), 1);
  assert.strictEqual(medianDepthInBox(halfMap, [0, 0, 50, 100], 100, 100), 0);

  // Bit packing roundtrip.
  const flags = new Uint8Array([1, 0, 1, 1, 0, 0, 0, 1, 1]); // 9 bits -> 2 bytes
  const bits = packBits(flags);
  assert.strictEqual(bits.length, 2);
  for (let i = 0; i < flags.length; i++) {
    assert.strictEqual(unpackBit(bits, i), flags[i] === 1, `bit ${i}`);
  }

  // Synthetic yolov8-seg decode: 1 class, 2 protos, 2 anchors; anchor 0's
  // coeffs select proto 0 (top half positive), so the mask's top rows are set.
  const anchors = 2;
  const channels = 4 + 1 + 2; // cxcywh + 1 class + 2 mask coeffs
  const head = new Float32Array(channels * anchors);
  const put = (c: number, j: number, v: number): void => {
    head[c * anchors + j] = v;
  };
  // anchor 0: box covering the whole 8x8 input, class score 0.9, coeffs [4, 0]
  put(0, 0, 4); put(1, 0, 4); put(2, 0, 8); put(3, 0, 8); put(4, 0, 0.9); put(5, 0, 4); put(6, 0, 0);
  // anchor 1: below confidence
  put(4, 1, 0.1);
  const pw = 4;
  const ph = 4;
  const proto = new Float32Array(2 * ph * pw);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      proto[(0 * ph + y) * pw + x] = y < 2 ? 1 : -1; // proto 0: top half on
      proto[(1 * ph + y) * pw + x] = 5; // proto 1: everywhere (must be ignored, coeff 0)
    }
  }
  const instances = postprocessYoloV8Seg(head, [1, channels, anchors], proto, [1, 2, ph, pw], {
    classNames: ['road'],
    minConfidence: 0.5,
    iouThreshold: 0.45,
    maskThreshold: 0.5,
    scale: 1,
    padX: 0,
    padY: 0,
    sourceWidth: 8,
    sourceHeight: 8,
    inputWidth: 8,
    inputHeight: 8,
  });
  assert.strictEqual(instances.length, 1);
  const inst = instances[0];
  assert.strictEqual(inst.cls, 'road');
  assert.strictEqual(inst.maskWidth, 4);
  assert.strictEqual(inst.maskHeight, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      assert.strictEqual(unpackBit(inst.maskBits, y * 4 + x), y < 2, `mask (${x},${y})`);
    }
  }

  // Mask drawing blends only masked pixels; depth overlay blends everywhere.
  const w = 8;
  const h = 8;
  const canvas = Buffer.alloc(w * h * 4, 64);
  drawSegments(canvas, w, h, [inst], false);
  // Canvas rows 0-3 map to mask rows 0-1 (top half, set); rows 4-7 to mask
  // rows 2-3 (clear). Row 5 col 3 avoids the 1 px box outline.
  assert.notStrictEqual(canvas[(0 * w + 3) * 4], 64, 'masked pixel must be tinted');
  assert.strictEqual(canvas[(5 * w + 3) * 4 + 2], 64, 'unmasked interior blue channel untouched');
  const canvas2 = Buffer.alloc(4 * 4 * 4, 64);
  blendDepthOverlay(canvas2, 4, 4, halfMap);
  assert.notStrictEqual(canvas2[0], 64, 'depth overlay must tint the frame');
  console.log('ok: depth/segmentation vision units (normalize, median-in-box, seg decode, drawing)');
}

// --- 18. Fusion events leg, deterministic (proximity_gate + boolean -> event) ---------
async function testProximityFusionLeg(): Promise<void> {
  const gate = getExecutor('logic.proximity_gate')!;
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const emptyMap = { width: 1, height: 1, min: 0, max: 1, encoding: 'u8' as const, data: Buffer.from([0]).toString('base64') };
  const depthMsg = (seq: number, boxes: Array<{ cls: string; confidence: number; proximity: number }>) => ({
    ch: 'json' as const,
    tag: 'depth',
    ts: t0 + seq * 500,
    seq,
    payload: {
      ts: t0 + seq * 500,
      frameSeq: seq,
      width: 640,
      height: 480,
      stats: { min: 0, max: 1, mean: 0.5, median: 0.5 },
      map: emptyMap,
      boxes: boxes.map((b) => ({ ...b, xyxy: [10, 10, 50, 90] as [number, number, number, number] })),
    } satisfies DepthPayload,
  });

  // Guard: depth records WITHOUT boxes (no detections wired) fail the gate.
  const bare = new BoundedChannel<EngineMessage>(4);
  const noBoxes = depthMsg(0, []);
  delete (noBoxes.payload as { boxes?: unknown }).boxes;
  await bare.push(noBoxes);
  bare.close();
  await assert.rejects(
    async () => {
      const ctx = stubCtx({ nodeId: 'prox0' });
      for await (const _m of gate(
        [{ port: 'depth', from: { nodeId: 'dep', port: 'depth' }, messages: bare }],
        {},
        ctx,
      )) {
        /* consume */
      }
    },
    /Detections input/,
    'boxless depth records must fail the gate loudly',
  );

  // Gate: far car -> false; near car -> true; near person filtered by class.
  const depthCh = new BoundedChannel<EngineMessage>(16);
  await depthCh.push(depthMsg(0, []));
  await depthCh.push(depthMsg(1, [{ cls: 'car', confidence: 0.9, proximity: 0.3 }]));
  await depthCh.push(depthMsg(2, [{ cls: 'person', confidence: 0.9, proximity: 0.95 }]));
  await depthCh.push(depthMsg(3, [{ cls: 'car', confidence: 0.9, proximity: 0.85 }]));
  await depthCh.push(depthMsg(4, [{ cls: 'car', confidence: 0.9, proximity: 0.88 }]));
  depthCh.close();
  const gateCtx = stubCtx({ nodeId: 'prox' });
  const gateOut = new BoundedChannel<EngineMessage>(16);
  let seq = 0;
  for await (const msg of gate(
    [{ port: 'depth', from: { nodeId: 'dep', port: 'depth' }, messages: depthCh }],
    { classes: ['car', 'truck'], minProximity: 0.6 },
    gateCtx,
  )) {
    await gateOut.push({ ...msg, seq: seq++ } as EngineMessage);
  }
  gateOut.close();
  assert.strictEqual(gateCtx.summary, 'true on 2/5 depth frame(s)');

  // Boolean AND with a braking condition that is true from t0+1000 on; the
  // fused stream first turns true at the near-car frame (t0+1500).
  const boolExec = getExecutor('logic.boolean')!;
  const brakeCh = new BoundedChannel<EngineMessage>(16);
  for (let i = 0; i < 5; i++) {
    await brakeCh.push({ ch: 'condition', ts: t0 + i * 500 + 1, seq: i, payload: { value: i >= 2 } });
  }
  brakeCh.close();
  const boolCtx = stubCtx({ nodeId: 'fuse' });
  const fused = new BoundedChannel<EngineMessage>(32);
  seq = 0;
  for await (const msg of boolExec(
    [
      { port: 'conditions', from: { nodeId: 'prox', port: 'condition' }, messages: gateOut },
      { port: 'conditions', from: { nodeId: 'thr', port: 'condition' }, messages: brakeCh },
    ],
    { op: 'and' },
    boolCtx,
  )) {
    await fused.push({ ...msg, seq: seq++ } as EngineMessage);
  }
  fused.close();

  const eventExec = getExecutor('output.event')!;
  const evtCtx = stubCtx({ nodeId: 'evt' });
  for await (const _msg of eventExec(
    [{ port: 'condition', from: { nodeId: 'fuse', port: 'condition' }, messages: fused }],
    { kind: 'sudden_stop_behind_vehicle' },
    evtCtx,
  )) {
    assert.fail('output.event must not emit messages');
  }
  const events = evtCtx.events as Array<{ kind: string; occurredAt: string }>;
  assert.strictEqual(events.length, 1, `expected 1 fused event, got ${events.length}`);
  assert.strictEqual(events[0].kind, 'sudden_stop_behind_vehicle');
  assert.strictEqual(Date.parse(events[0].occurredAt), t0 + 3 * 500, 'event fires on the near-car frame');
  console.log('ok: fusion events leg (proximity_gate -> boolean AND -> one rising-edge event)');
}

// --- 19. telemetry_materialized binding (M4 container telemetry seam) -----------------
async function testMaterializedTelemetry(): Promise<void> {
  // Parser: unordered lines sort by ts; bad lines fail loudly.
  const jsonl =
    JSON.stringify({ ts: 2000, signals: { 'gps.speed': 12 } }) +
    '\n' +
    JSON.stringify({ ts: 1000, signals: { 'gps.speed': 11, 'imu.accel_x': -0.2 } }) +
    '\n';
  const samples = parseTelemetryJsonl(jsonl);
  assert.deepStrictEqual(
    samples.map((s) => s.ts),
    [1000, 2000],
  );
  assert.strictEqual(samples[0].signals['imu.accel_x'], -0.2);
  assert.throws(() => parseTelemetryJsonl('not json\n'), /not JSON/);
  assert.throws(() => parseTelemetryJsonl('{"ts":"x"}\n'), /sample/);

  // Through the executor + fetchText seam, exactly like the dispatcher writes it.
  const executor = getExecutor('source.telemetry')!;
  const key = 'workflows/v2/runs/run-m/inputs/src/records.jsonl';
  const sources: EngineSourceReader = {
    readTelemetryWindow: async () => {
      throw new Error('materialized binding must not read the telemetry store');
    },
    fetchText: async (ref) => {
      assert.strictEqual(ref.bucket, null);
      assert.strictEqual(ref.key, key);
      return jsonl;
    },
  };
  const ctx = stubCtx({
    nodeId: 'src',
    sources,
    binding: { kind: 'telemetry_materialized', s3Key: key },
  });
  const speeds: number[] = [];
  for await (const msg of executor([], { metrics: ['gps.speed'] }, ctx)) {
    speeds.push((msg.payload as { signals: Record<string, number> }).signals['gps.speed']);
  }
  assert.deepStrictEqual(speeds, [11, 12]);
  assert.match(ctx.summary ?? '', /materialized history/);
  console.log('ok: telemetry_materialized (jsonl parser + fetchText seam through source.telemetry)');
}

// --- 20/21. Scenario 3 + 8: local model registry over the M4 exports -------------------
const EXPORT_OUT = path.resolve(__dirname, '../model-export/out');
const DEPTH_MODEL_DIR = path.join(EXPORT_OUT, 'depth/depth-anything-v2-small/1');
const SEG_MODEL_DIR = path.join(EXPORT_OUT, 'segmentation/yolov8n-seg/1');

function localRegistrySources(): EngineSourceReader {
  return {
    readTelemetryWindow: async () => {
      throw new Error('media scenarios must not read a telemetry store');
    },
    fetchVideo: async () => {
      throw new Error('video_local bindings must not hit fetchVideo');
    },
    fetchModel: async ({ family, name }) => {
      if (family === 'detection') {
        assert.strictEqual(name, 'yolov8n');
        return { manifest: localDetectionManifest(), modelPath: YOLO_MODEL_PATH };
      }
      const dir = family === 'depth' ? DEPTH_MODEL_DIR : SEG_MODEL_DIR;
      if (!existsSync(path.join(dir, 'model.onnx'))) {
        throw new Error(
          `scenario needs ${dir}/model.onnx; run the model-export/ scripts first (export_depth.py / export_yolo.py --name yolov8n-seg)`,
        );
      }
      const manifest = modelManifestSchema.parse(
        JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
      );
      assert.strictEqual(manifest.name, name);
      return { manifest, modelPath: path.join(dir, 'model.onnx') };
    },
  };
}

function collectingArtifacts(): { sink: EngineArtifactSink; frames: Map<string, Buffer> } {
  const frames = new Map<string, Buffer>();
  return {
    frames,
    sink: {
      async putFrame(nodeId, frameSeq, jpegBuf) {
        const artifactKey = `frames/${nodeId}/${frameSeq}.jpg`;
        frames.set(artifactKey, jpegBuf);
        return artifactKey;
      },
    },
  };
}

const graphNode = (id: string, type: string, label: string, config: Record<string, unknown>) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
});
const graphEdge = (source: string, target: string, sourceHandle: string, targetHandle: string) => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});

async function testScenario3(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'engine-smoke-s3-'));
  const mp4Path = path.join(workDir, 'road.mp4');
  await synthesizeMp4(mp4Path);

  const t0 = Date.parse('2026-01-01T12:00:00Z');
  // 30 s at 1 Hz: cruise at 40 kph, brake hard 40 -> 0 between t+15 and t+18,
  // then stopped. One wild outlier at t+5 for outlier_removal to eat.
  const gpsSamples = [...Array(30).keys()].map((i) => ({
    ts: t0 + i * 1000,
    signals: {
      'gps.speed': i === 5 ? 400 : i < 15 ? 40 : i < 18 ? 40 - (i - 14) * 13.3 : 0,
    },
  }));
  const imuSamples = [...Array(30).keys()].map((i) => ({
    ts: t0 + i * 1000 + 50, // slightly offset clock: time_align merges these
    signals: { 'imu.accel_x': i >= 15 && i < 18 ? -3.7 : 0.05 },
  }));

  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      graphNode('gps', 'source.telemetry', 'GPS', { metrics: ['gps.speed'] }),
      graphNode('imu', 'source.telemetry', 'IMU', { metrics: ['imu.accel_x'] }),
      graphNode('align', 'telemetry.time_align', 'Time Align', { toleranceMs: 200 }),
      graphNode('clean', 'telemetry.outlier_removal', 'Outlier Removal', {
        signal: 'gps.speed',
        method: 'zscore',
        threshold: 3,
      }),
      graphNode('kal', 'telemetry.kalman', 'Kalman Filter', {
        signal: 'gps.speed',
        processNoise: 1,
        measurementNoise: 0.05,
      }),
      graphNode('rate', 'telemetry.derivative', 'Derivative', {
        mode: 'rate',
        signal: 'gps.speed',
        outputSignal: 'speed_rate',
      }),
      graphNode('thr', 'logic.threshold', 'Hard Braking', {
        signal: 'speed_rate',
        operator: 'lt',
        value: -8,
      }),
      graphNode('vid', 'source.video', 'Video', {}),
      graphNode('dec', 'video.decode_sample', 'Decode & Sample', { fps: 2 }),
      graphNode('det', 'model.object_detection', 'Object Detection', {
        model: 'yolov8n',
        minConfidence: 0.5,
        classes: ['car', 'truck', 'bus'],
      }),
      graphNode('dep', 'model.depth', 'Depth Estimation', { model: 'depth-anything-v2-small' }),
      graphNode('prox', 'logic.proximity_gate', 'Proximity Gate', {
        classes: ['car', 'truck', 'bus'],
        minProximity: 0.6,
      }),
      graphNode('fuse', 'logic.boolean', 'Boolean Combine', { op: 'and' }),
      graphNode('evt', 'output.event', 'Emit Event', { kind: 'sudden_stop_behind_vehicle' }),
      graphNode('capd', 'output.data_capture', 'Depth Capture', { format: 'jsonl' }),
    ],
    edges: [
      graphEdge('gps', 'align', 'telemetry', 'telemetry'),
      graphEdge('imu', 'align', 'telemetry', 'telemetry'),
      graphEdge('align', 'clean', 'telemetry', 'telemetry'),
      graphEdge('clean', 'kal', 'telemetry', 'telemetry'),
      graphEdge('kal', 'rate', 'telemetry', 'telemetry'),
      graphEdge('rate', 'thr', 'telemetry', 'telemetry'),
      graphEdge('thr', 'fuse', 'condition', 'conditions'),
      graphEdge('vid', 'dec', 'video', 'video'),
      graphEdge('dec', 'det', 'frames', 'frames'),
      graphEdge('dec', 'dep', 'frames', 'frames'),
      graphEdge('det', 'dep', 'detections', 'detections'),
      graphEdge('dep', 'prox', 'depth', 'depth'),
      graphEdge('dep', 'capd', 'depth', 'records'),
      graphEdge('prox', 'fuse', 'condition', 'conditions'),
      graphEdge('fuse', 'evt', 'condition', 'condition'),
    ],
  };

  const { sink, frames } = collectingArtifacts();
  const outcome = await runGraph(
    {
      runId: 'run-scenario3',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition,
      bindings: {
        gps: { kind: 'telemetry_inline', samples: gpsSamples },
        imu: { kind: 'telemetry_inline', samples: imuSamples },
        vid: { kind: 'video_local', path: mp4Path, startedAt: '2026-01-01T12:00:00Z' },
      },
    },
    { sources: localRegistrySources(), artifacts: sink, channelCapacity: 8 },
  );

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error} (${outcome.failedNodeId})`);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  const byNode = new Map(outcome.steps.map((s) => [s.nodeId, s]));
  // The telemetry leg: outlier eaten, braking detected.
  assert.match(byNode.get('clean')!.output, /dropped 1 outlier/);
  assert.match(byNode.get('thr')!.output, /true on [1-9]/, byNode.get('thr')!.output);
  // The video leg: depth records captured with maps, stats, and (empty) boxes;
  // testsrc has no vehicles, so the fused event count is zero BY DESIGN (the
  // deterministic event assertion is the fusion-leg unit).
  const depthRecords = (outcome.captures['capd'] ?? []) as Array<{ tag: string; record: DepthPayload }>;
  assert.ok(depthRecords.length >= 4, `expected sampled depth records, got ${depthRecords.length}`);
  assert.strictEqual(depthRecords[0].tag, 'depth');
  const rec = depthRecords[0].record;
  assert.ok(rec.stats.max > rec.stats.min, 'raw depth range must be non-degenerate');
  assert.ok(rec.map.width <= 160 && rec.map.width >= 2, `embedded map width ${rec.map.width}`);
  const mapBytes = Buffer.from(rec.map.data, 'base64');
  assert.strictEqual(mapBytes.length, rec.map.width * rec.map.height, 'embedded map length matches dims');
  assert.ok(Array.isArray(rec.boxes), 'depth records carry per-box proximity (detections wired)');
  assert.match(byNode.get('prox')!.output, /depth frame\(s\)/);
  assert.strictEqual(outcome.events.length, 0, 'testsrc has no vehicles: fused event must not fire');
  // Depth preview renders (colormap JPEGs through the artifact sink).
  const depFrames = [...frames.keys()].filter((k) => k.startsWith('frames/dep/'));
  assert.strictEqual(depFrames.length, depthRecords.length, 'one rendered depth frame per record');
  const jpeg = frames.get(depFrames[0])!;
  assert.strictEqual(jpeg[0], 0xff);
  assert.strictEqual(jpeg[1], 0xd8, 'depth preview must be a JPEG');
  const decoded = decodeJpegToRgba(jpeg);
  assert.strictEqual(decoded.width, 320, 'depth preview renders at source frame size');
  console.log(
    `ok: scenario 3 (fusion: time_align/outlier/kalman/derivative/threshold + detection/depth/proximity -> boolean) — ${depthRecords.length} depth records, dep: ${byNode.get('dep')!.output}`,
  );
}

async function testScenario8(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'engine-smoke-s8-'));
  const mp4Path = path.join(workDir, 'scene.mp4');
  await synthesizeMp4(mp4Path);

  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      graphNode('vid', 'source.video', 'Video', {}),
      graphNode('dec', 'video.decode_sample', 'Decode & Sample', { fps: 2 }),
      graphNode('seg', 'model.segmentation', 'Segmentation', { model: 'yolov8n-seg', minConfidence: 0.4 }),
      graphNode('dep', 'model.depth', 'Depth Estimation', {
        model: 'depth-anything-v2-small',
        renderPreview: false,
      }),
      graphNode('viz', 'output.visualization', 'Video Visualization', {
        overlays: ['masks', 'labels', 'depth_map'],
      }),
      graphNode('caps', 'output.data_capture', 'Segments Capture', { format: 'jsonl' }),
    ],
    edges: [
      graphEdge('vid', 'dec', 'video', 'video'),
      graphEdge('dec', 'seg', 'frames', 'frames'),
      graphEdge('dec', 'dep', 'frames', 'frames'),
      graphEdge('dec', 'viz', 'frames', 'frames'),
      graphEdge('seg', 'viz', 'segments', 'segments'),
      graphEdge('dep', 'viz', 'depth', 'depth'),
      graphEdge('seg', 'caps', 'segments', 'records'),
    ],
  };

  const { sink, frames } = collectingArtifacts();
  const outcome = await runGraph(
    {
      runId: 'run-scenario8',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition,
      bindings: { vid: { kind: 'video_local', path: mp4Path, startedAt: '2026-01-01T12:00:00Z' } },
    },
    { sources: localRegistrySources(), artifacts: sink, channelCapacity: 8 },
  );

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error} (${outcome.failedNodeId})`);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  const segRecords = (outcome.captures['caps'] ?? []) as Array<{
    tag: string;
    record: { frameSeq: number; instances: unknown[] };
  }>;
  assert.ok(segRecords.length >= 4, `expected sampled segment records, got ${segRecords.length}`);
  assert.strictEqual(segRecords[0].tag, 'segments');
  for (const r of segRecords) {
    assert.ok(Array.isArray(r.record.instances), 'each segments record carries an instances array');
  }
  const vizFrames = [...frames.keys()].filter((k) => k.startsWith('frames/viz/'));
  assert.strictEqual(vizFrames.length, segRecords.length, 'one visualization JPEG per frame');
  const decoded = decodeJpegToRgba(frames.get(vizFrames[0])!);
  assert.strictEqual(decoded.width, 320);
  assert.strictEqual(decoded.height, 240);
  // renderPreview: false on the depth node must suppress its own frames while
  // the visualization (depth_map overlay) still renders.
  assert.strictEqual(
    [...frames.keys()].filter((k) => k.startsWith('frames/dep/')).length,
    0,
    'renderPreview: false suppresses depth preview frames',
  );
  const byNode = new Map(outcome.steps.map((s) => [s.nodeId, s]));
  console.log(
    `ok: scenario 8 (recording -> segmentation (+depth) -> masks/depth visualization) — ${vizFrames.length} frames, seg: ${byNode.get('seg')!.output}`,
  );
}

// --- 22. model.vlm unit: real SDK path against a mocked Messages API ------------------
function rgbaFrame(seq: number, ts: number, width = 64, height = 48): EngineMessage {
  const image = Buffer.alloc(width * height * 4);
  for (let i = 0; i < image.length; i += 4) {
    image[i] = (seq * 37) % 256;
    image[i + 1] = 128;
    image[i + 2] = 255 - ((seq * 37) % 256);
    image[i + 3] = 255;
  }
  const payload: FramePayload = { seq, ts, image, width, height, format: 'rgba' };
  return { ch: 'frames', ts, seq, payload };
}

/** A fetch mock speaking just enough Messages API for the real Anthropic SDK. */
function mockClaudeFetch(
  respond: (requestBody: Record<string, unknown>, n: number) => { verdict: boolean; confidence: number; reason: string } | 'refusal',
): { fetch: typeof fetch; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.includes('/v1/messages'), `unexpected SDK request URL: ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const out = respond(body, requests.length);
    const message =
      out === 'refusal'
        ? {
            id: 'msg_smoke',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: 'refusal',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          }
        : {
            id: 'msg_smoke',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: JSON.stringify(out) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 20 },
          };
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_smoke' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

async function testVlmUnit(): Promise<void> {
  const exec = getExecutor('model.vlm')!;
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const frames = new BoundedChannel<EngineMessage>(16);
  // 5 frames 500 ms apart with maxFps 1 -> frames 0 / 2 / 4 are analyzed.
  for (let i = 0; i < 5; i++) await frames.push(rgbaFrame(i, t0 + i * 500, 800, 600));
  frames.close();

  const { fetch: mocked, requests } = mockClaudeFetch((_body, n) =>
    n === 2 ? { verdict: true, confidence: 1.7, reason: 'clearly distracted' } : n === 3 ? 'refusal' : { verdict: false, confidence: 0.9, reason: 'eyes on road' },
  );
  let secretAsked: string | null = null;
  const secrets: EngineSecretReader = {
    getSecret: async (name) => {
      secretAsked = name;
      return 'sk-ant-test';
    },
  };
  const ctx = stubCtx({ nodeId: 'vlm', secrets, http: mocked });
  const out: EngineMessage[] = [];
  let seq = 0;
  for await (const msg of exec(
    [{ port: 'frames', from: { nodeId: 'dec', port: 'frames' }, messages: frames }],
    { prompt: 'Is the driver looking away from the road?', maxFps: 1, maxWidth: 320, minConfidence: 0.5 },
    ctx,
  )) {
    out.push({ ...msg, seq: seq++ } as EngineMessage);
  }

  assert.strictEqual(secretAsked, 'anthropic-api-key');
  assert.strictEqual(requests.length, 3, `maxFps sampling: expected 3 API calls, got ${requests.length}`);
  const req = requests[0] as {
    model: string;
    system: string;
    thinking: { type: string };
    output_config: { format: { type: string; schema: { required: string[] } } };
    messages: Array<{ role: string; content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }> }>;
  };
  assert.strictEqual(req.model, 'claude-sonnet-5', 'default model');
  assert.strictEqual(req.thinking.type, 'disabled');
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.deepStrictEqual(req.output_config.format.schema.required, ['verdict', 'confidence', 'reason']);
  const [img, txt] = req.messages[0].content;
  assert.strictEqual(img.type, 'image');
  assert.strictEqual(img.source!.media_type, 'image/jpeg');
  // 800-wide frame downscaled to maxWidth 320 before encoding.
  const decoded = decodeJpegToRgba(Buffer.from(img.source!.data, 'base64'));
  assert.strictEqual(decoded.width, 320, `frame must be downscaled (got ${decoded.width})`);
  assert.strictEqual(txt.type, 'text');

  const conditions = out.filter((m) => m.ch === 'condition');
  const records = out.filter((m) => m.ch === 'json');
  assert.strictEqual(conditions.length, 3);
  assert.strictEqual(records.length, 3);
  assert.ok(records.every((m) => m.tag === 'vlm'));
  const values = conditions.map((m) => (m.payload as { value: boolean }).value);
  assert.deepStrictEqual(values, [false, true, false], 'verdict #2 true; refusal (#3) is false');
  const rec2 = records[1].payload as { verdict: boolean; confidence: number; reason: string; model: string };
  assert.strictEqual(rec2.verdict, true);
  assert.strictEqual(rec2.confidence, 1, 'confidence must clamp to 1');
  const rec3 = records[2].payload as { confidence: number; reason: string };
  assert.strictEqual(rec3.confidence, 0);
  assert.ok(rec3.reason.includes('declined'), rec3.reason);
  assert.match(
    ctx.summary ?? '',
    /^verdict true on 1\/3 analyzed frame\(s\) of 5 \(claude-sonnet-5, ~\d+ ms\/frame\)$/,
  );
  console.log('ok: model.vlm unit (mocked Claude API through the real SDK, sampling + downscale + refusal)');
}

// --- 23. scenario 4/7 live plane: webcam -> decode pass-through -> vlm ---------------
async function testLiveWebcamVlmGraph(): Promise<void> {
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
      node('vlm', 'model.vlm', 'VLM Analysis', {
        prompt: 'Is a person visible?',
        maxFps: 2,
        maxWidth: 320,
      }),
      node('evt', 'output.event', 'Emit Event', { kind: 'driver_distraction' }),
      node('cap', 'output.data_capture', 'Data Capture', { format: 'jsonl' }),
    ],
    edges: [
      edge('src', 'dec', 'video', 'video'),
      edge('dec', 'vlm', 'frames', 'frames'),
      edge('vlm', 'evt', 'condition', 'condition'),
      edge('vlm', 'cap', 'analysis', 'records'),
    ],
  };

  // 10 synthetic browser frames, 250 ms apart: decode at fps 2 keeps every
  // other one (500 ms interval) -> 5 frames reach the VLM.
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  let liveRef: { nodeId: string; maxDurationMs: number; idleTimeoutMs: number } | null = null;
  const sources: EngineSourceReader = {
    readTelemetryWindow: async () => {
      throw new Error('not used');
    },
    openLiveFrames(ref) {
      liveRef = ref;
      return (async function* frames(): AsyncGenerator<LiveIngestFrame> {
        for (let i = 0; i < 10; i++) {
          const f = rgbaFrame(i, t0 + i * 250, 64, 48).payload as FramePayload;
          yield { seq: i, ts: f.ts, jpeg: encodeRgbaToJpeg(f.image, f.width, f.height, 85) };
        }
      })();
    },
  };
  // Verdict true from the 3rd analyzed frame on -> exactly one rising edge.
  const { fetch: mocked, requests } = mockClaudeFetch((_body, n) =>
    n >= 3 ? { verdict: true, confidence: 0.95, reason: 'person visible' } : { verdict: false, confidence: 0.9, reason: 'empty scene' },
  );
  const secrets: EngineSecretReader = { getSecret: async () => 'sk-ant-test' };

  const outcome = await runGraph(
    {
      runId: 'run-live-vlm',
      mode: 'live',
      deviceId: null,
      window: null,
      definition,
      bindings: { src: { kind: 'webcam', maxDurationSeconds: 30 } },
    },
    { sources, secrets, httpFetch: mocked },
  );

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error}`);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  assert.ok(liveRef, 'source.video must open the live seam');
  assert.strictEqual(liveRef!.nodeId, 'src');
  assert.strictEqual(liveRef!.maxDurationMs, 30_000);
  assert.strictEqual(liveRef!.idleTimeoutMs, 60_000);
  assert.strictEqual(requests.length, 5, `expected 5 analyzed frames, got ${requests.length}`);
  assert.strictEqual(outcome.captures['cap']?.length, 5, 'every analyzed frame lands in Data Capture');
  assert.strictEqual(outcome.events.length, 1, `one rising-edge event, got ${outcome.events.length}`);
  assert.strictEqual(outcome.events[0].kind, 'driver_distraction');
  const dec = outcome.steps.find((s) => s.nodeId === 'dec')!;
  assert.ok(dec.output.includes('5 frame(s)'), dec.output);
  console.log(
    `ok: scenario 4/7 live plane (webcam ingest -> decode pass-through -> vlm -> event) — ${requests.length} Claude calls, 1 event`,
  );
}

// --- 24. warm session loop ------------------------------------------------------------
async function testSessionLoop(): Promise<void> {
  const jobs: Array<{ runId: string } | null> = [{ runId: 'r1' }, null, { runId: 'r2' }, { runId: 'r3' }];
  const ran: string[] = [];
  let clock = 0;
  const outcome = await runSessionLoop({
    idleTimeoutMs: 100,
    log: () => {},
    now: () => clock,
    receive: async () => {
      clock += 30; // each poll (empty or not) advances 30 "ms"
      return jobs.shift() ?? null;
    },
    runJob: async (job) => {
      ran.push(job.runId);
      if (job.runId === 'r2') throw new Error('boom');
    },
  });
  assert.deepStrictEqual(ran, ['r1', 'r2', 'r3'], 'jobs run serially; a failure does not kill the loop');
  assert.strictEqual(outcome.jobsRun, 3);
  assert.strictEqual(outcome.jobFailures, 1);
  assert.strictEqual(outcome.endedReason, 'idle');
  console.log('ok: warm session loop (serial jobs, failure tolerance, idle-out)');
}

// --- 25. simulations module M5 additions -----------------------------------------------
function testSimulationsM5(): void {
  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      { id: 'v', type: 'source.video', position: { x: 0, y: 0 }, data: { label: 'Video', config: {} } },
      { id: 'd', type: 'video.decode_sample', position: { x: 0, y: 0 }, data: { label: 'Decode', config: {} } },
      {
        id: 'vlm',
        type: 'model.vlm',
        position: { x: 0, y: 0 },
        data: { label: 'VLM', config: { prompt: 'Is a person visible?' } },
      },
      { id: 'e', type: 'output.event', position: { x: 0, y: 0 }, data: { label: 'Event', config: { kind: 'x' } } },
    ],
    edges: [
      { id: 'e1', source: 'v', target: 'd', sourceHandle: 'video', targetHandle: 'video' },
      { id: 'e2', source: 'd', target: 'vlm', sourceHandle: 'frames', targetHandle: 'frames' },
      { id: 'e3', source: 'vlm', target: 'e', sourceHandle: 'condition', targetHandle: 'condition' },
    ],
  };
  const bindings: Record<string, SimulationBinding> = { v: { kind: 'webcam', maxDurationSeconds: 120 } };
  assert.deepStrictEqual(validateSimulationBindings(definition, bindings, 'org-1'), []);
  assert.ok(hasLiveBindings(bindings));
  assert.strictEqual(engineTargetForDefinition(definition), 'fargate', 'vlm/decode are media-bound');

  // A webcam binding on a telemetry source is rejected.
  const telemetryDef: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      { id: 't', type: 'source.telemetry', position: { x: 0, y: 0 }, data: { label: 'T', config: { metrics: ['a'] } } },
    ],
    edges: [],
  };
  const bad = validateSimulationBindings(telemetryDef, { t: { kind: 'webcam' } }, 'org-1');
  assert.strictEqual(bad.length, 1);
  assert.ok(bad[0].message.includes('does not fit source.telemetry'), bad[0].message);

  const inputs = toManifestInputs(bindings, new Map());
  assert.deepStrictEqual(inputs, [{ nodeId: 'v', binding: { kind: 'webcam', maxDurationSeconds: 120 } }]);

  const manifest = buildSimulationManifest({
    runId: 'run-m5',
    orgId: 'org-1',
    bucket: 'bucket',
    definition,
    deviceId: null,
    inputs,
    window: simulationWindow(bindings),
    target: 'fargate',
  });
  assert.strictEqual(manifest.mode, 'live', 'live bindings flip the manifest to live mode');
  assert.strictEqual(manifest.limits.maxRuntimeSeconds, 900);

  // Batch simulations keep mode simulation.
  const batchManifest = buildSimulationManifest({
    runId: 'run-m5b',
    orgId: 'org-1',
    bucket: 'bucket',
    definition,
    deviceId: null,
    inputs: [{ nodeId: 'v', binding: { kind: 'video_file', s3Key: 'workflows/v2/uploads/org-1/x.mp4' } }],
    window: null,
    target: 'fargate',
  });
  assert.strictEqual(batchManifest.mode, 'simulation');

  const key = simulationSessionKey('org-1', 'template-1');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.strictEqual(key, simulationSessionKey('org-1', 'template-1'), 'session key is stable');
  assert.notStrictEqual(key, simulationSessionKey('org-1', 'template-2'));
  assert.strictEqual(sessionQueueName('xorgate-wfsim-dev-', key), `xorgate-wfsim-dev-${key}`);
  assert.ok(sessionQueueName('xorgate-wfsim-dev-', key).length <= 80, 'SQS queue name limit');
  console.log('ok: simulations module M5 additions (webcam binding, live mode, session naming)');
}

// --- Check 26: production dispatch module (M6) -------------------------------

function testProductionDispatchModule(): void {
  const mkNode = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, config },
  });

  // Trigger-context video selection classification.
  const recCtx = {
    type: 'recording_saved',
    s3Key: 'media/v1/dev/cam0/rec.mp4',
    recordingId: 'rec-1',
    recordingStartedAt: '2026-07-15T00:00:00.000Z',
    captureStartedAt: '2026-07-15T00:00:01.000Z',
  };
  const fromCtx = triggeredVideoSelection(recCtx);
  assert.ok(fromCtx && fromCtx.kind === 'context');
  assert.equal(fromCtx.input.s3Key, recCtx.s3Key);
  assert.equal(fromCtx.input.captureStartedAt, recCtx.captureStartedAt);
  const picked = triggeredVideoSelection({ selection: { mode: 'recordings', recordingIds: ['a', 'b'] } });
  assert.ok(picked && picked.kind === 'recordings' && picked.recordingIds.length === 2);
  const lastN = triggeredVideoSelection({ selection: { mode: 'lastN', n: 3 } });
  assert.ok(lastN && lastN.kind === 'lastN' && lastN.n === 3);
  assert.equal(triggeredVideoSelection({ window: { from: 'x', to: 'y' } }), null);

  // Window resolution: context window wins; else 15 minutes ending at start.
  const win = resolveTriggeredWindow({ window: { from: 'A', to: 'B' } }, new Date());
  assert.deepEqual(win, { from: 'A', to: 'B' });
  const started = new Date('2026-07-15T12:00:00.000Z');
  const fallback = resolveTriggeredWindow({}, started);
  assert.equal(fallback.to, started.toISOString());
  assert.equal(Date.parse(fallback.to) - Date.parse(fallback.from), 15 * 60_000);

  // Triggered inputs: recording bindings per video node; telemetry_history
  // only on the fargate target; no-recording video graph throws.
  const mediaDef = {
    schemaVersion: 2,
    nodes: [
      mkNode('cam', 'source.video'),
      mkNode('gps', 'source.telemetry', { metrics: ['gps.speed'] }),
      mkNode('dec', 'video.decode_sample', { fps: 2 }),
    ],
    edges: [{ id: 'e1', source: 'cam', target: 'dec' }],
  } as never;
  const video = { s3Key: 'media/v1/x.mp4', recordingId: 'r1', recordingStartedAt: null, captureStartedAt: null };
  const fargateInputs = buildTriggeredInputs(mediaDef, video, 'fargate');
  assert.deepEqual(
    fargateInputs.map((i) => `${i.nodeId}:${i.binding.kind}`).sort(),
    ['cam:recording', 'gps:telemetry_history'],
  );
  const camBinding = fargateInputs.find((i) => i.nodeId === 'cam')!.binding as Record<string, unknown>;
  assert.equal(camBinding.s3Key, 'media/v1/x.mp4');
  assert.equal('recordingStartedAt' in camBinding, false); // null fields omitted
  const telDef = {
    schemaVersion: 2,
    nodes: [mkNode('gps', 'source.telemetry', { metrics: ['gps.speed'] })],
    edges: [],
  } as never;
  assert.deepEqual(buildTriggeredInputs(telDef, null, 'lambda'), []);
  assert.throws(() => buildTriggeredInputs(mediaDef, null, 'fargate'), /No video input/);

  // Production manifest: schema-valid, mode batch, wf/run progress prefix,
  // per-target runtime limits.
  const manifest = buildProductionManifest({
    runId: 'run-1',
    orgId: 'org-1',
    bucket: 'bkt',
    definition: mediaDef,
    deviceId: 'dev-1',
    inputs: fargateInputs,
    window: { from: fallback.from, to: fallback.to },
    target: 'fargate',
  });
  assert.equal(manifest.mode, 'batch');
  assert.equal(manifest.progress?.topicPrefix, runTopicPrefix('org-1', 'run-1'));
  assert.equal(manifest.progress?.topicPrefix, 'wf/run/org-1/run-1');
  assert.equal(manifest.limits.maxRuntimeSeconds, PRODUCTION_MAX_RUNTIME_SECONDS.fargate);
  assert.equal(manifest.limits.maxRuntimeSeconds, 1800);
  assert.equal(PRODUCTION_MAX_RUNTIME_SECONDS.lambda, 240);
  runManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
  console.log('check 26 ok: production dispatch module (selection, inputs, window, manifest)');
}

// --- Check 27: cutover routing (M6) -------------------------------------------

function testCutoverRouting(): void {
  const mkV1Node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, config },
  });

  // v1 video graph -> upgraded types -> fargate.
  const v1Video = {
    nodes: [
      mkV1Node('v', 'source.video'),
      mkV1Node('d', 'processor.decode_sample', { fps: 2 }),
      mkV1Node('o', 'processor.object_detection', { model: 'yolo-n' }),
    ],
    edges: [
      { id: 'e1', source: 'v', target: 'd' },
      { id: 'e2', source: 'd', target: 'o' },
    ],
  } as never;
  const upVideo = upgradeDefinition(v1Video);
  assert.equal(upVideo.schemaVersion, 2);
  assert.deepEqual(unknownNodeTypes(upVideo), []);
  assert.equal(engineTargetForDefinition(upVideo), 'fargate');
  assert.ok(upVideo.nodes.some((n) => n.type === 'model.object_detection'));

  // v1 telemetry graph (the PoC overspeed shape) -> lambda.
  const v1Tel = {
    nodes: [
      mkV1Node('g', 'source.gps'),
      mkV1Node('s', 'processor.speed_from_gps'),
      mkV1Node('c', 'processor.speed_limit_check', { limitKph: 80 }),
      mkV1Node('e', 'output.event', { kind: 'overspeed' }),
    ],
    edges: [
      { id: 'e1', source: 'g', target: 's' },
      { id: 'e2', source: 's', target: 'c' },
      { id: 'e3', source: 'c', target: 'e' },
    ],
  } as never;
  const upTel = upgradeDefinition(v1Tel);
  assert.deepEqual(unknownNodeTypes(upTel), []);
  assert.equal(engineTargetForDefinition(upTel), 'lambda');

  // Upgrading a v2 definition is a pure no-op (idempotent at dispatch time).
  assert.deepEqual(upgradeDefinition(upTel), upTel);

  // Unknown types surface BEFORE dispatch (the dispatcher fails the run).
  const bogus = {
    nodes: [mkV1Node('x', 'custom.mystery')],
    edges: [],
  } as never;
  assert.deepEqual(unknownNodeTypes(upgradeDefinition(bogus)), ['custom.mystery']);
  console.log('check 27 ok: cutover routing (v1 upgrade -> catalog-derived target, unknown-type detection)');
}

// --- Check 28: capability re-verify for upgraded graphs (M6) ------------------

function testUpgradedCapabilities(): void {
  const v1Gps = {
    nodes: [
      {
        id: 'g',
        type: 'source.gps',
        position: { x: 0, y: 0 },
        data: { label: 'GPS', config: {} },
      },
    ],
    edges: [],
  } as never;
  // computeRequiredCapabilities upgrades internally: the v1 gps source becomes
  // source.telemetry with explicit metric tokens.
  const required = computeRequiredCapabilities(v1Gps);
  assert.deepEqual(
    required,
    ['metric:gps.latitude', 'metric:gps.longitude', 'metric:gps.speed'],
  );

  const gpsImuVideoCaps = {
    media: { video: [{ key: 'cam0' }] },
    comm: { gps: { fields: ['latitude', 'longitude', 'speed'] } },
    sensors: { imu: { accel: ['x', 'y', 'z'] } },
  };
  assert.deepEqual(missingCapabilities(required, gpsImuVideoCaps), []);
  assert.deepEqual(missingCapabilities(required, {}), required);

  // Legacy group tokens (stored pre-M1 attachments) must STAY satisfiable.
  assert.deepEqual(missingCapabilities(['gps', 'imu', 'video'], gpsImuVideoCaps), []);
  assert.deepEqual(missingCapabilities(['gps', 'imu', 'video'], {}), ['gps', 'imu', 'video']);
  console.log('check 28 ok: upgraded-graph capabilities (metric tokens satisfiable, legacy group tokens intact)');
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
  await testGeofence();
  testDepthSegVisionUnits();
  await testProximityFusionLeg();
  await testMaterializedTelemetry();
  await testScenario3();
  await testScenario8();
  await testVlmUnit();
  await testLiveWebcamVlmGraph();
  await testSessionLoop();
  testSimulationsM5();
  testProductionDispatchModule();
  testCutoverRouting();
  testUpgradedCapabilities();
  console.log('\nengine smoke: all checks passed');
}

main().catch((err) => {
  console.error('\nengine smoke FAILED:', err);
  process.exit(1);
});

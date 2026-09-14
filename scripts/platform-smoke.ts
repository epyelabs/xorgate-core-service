/**
 * Platform smoke: the checks core-service owns now that the engine is
 * `@xorgate/workflow-engine` (wf-engine-integration Q13). The engine's own
 * behaviour (channels, executors, vision, scenarios) is covered by the
 * package's `npm run ci`; what is asserted here is the SHELL around it. No
 * AWS, no network, no test framework:
 *
 *   npm run smoke
 *
 * Checks:
 *   1. served catalog: platformCatalogPayload hashes to EXPECTED_CATALOG_VERSION
 *      with 28 nodes incl. function.javascript / function.python (editor "code")
 *   2. package schemas compose into local zod objects (one physical zod)
 *   3. v2 finalize row mapping against a schema-valid result.json
 *   4. progress plane: IotRunProgress (from the package) over an in-memory
 *      transport during a real runGraph; status/steps/events parse against the
 *      frozen schemas; preview downscale under the IoT cap
 *   5. cloud host: bind() returns the required fields per flavour; the full
 *      Lambda target path (createEngine + cloudHost over a mocked S3 client)
 *      writes events/records first and result.json LAST, the status stream
 *      carries exactly one `running` and one terminal message (emitted by the
 *      engine, not the host), and takeProgress hands the sink over once;
 *      the Fargate artifact path: a visualization frame reaches S3 AND the
 *      local tee, writeArtifacts muxes + uploads video/<nodeId>.mp4 BEFORE
 *      result.json (when an ffmpeg is reachable; skipped otherwise), records
 *      it as artifacts.videos, and removes the local frames
 *   6. pre-flight + routing: function graphs route to Fargate; the Lambda
 *      pre-flight refuses media and function nodes; unknown types everywhere
 *   7. simulations module: request schema, binding validation, API -> executor
 *      binding mapping (session / video_file / device_telemetry / telemetry_csv
 *      / webcam), schema-valid manifest, live mode, session key/queue naming
 *   8. warm session loop: serial jobs, failure tolerance, idle-out
 *   9. production dispatch module: trigger-context selection (sessions),
 *      triggered inputs (device_session + fargate-only telemetry_history),
 *      window resolution, production manifest (batch, wf/run prefix, limits)
 *  10. cutover routing: v1 definitions upgrade to catalog types and route
 *  11. capabilities: upgraded graphs emit metric:* tokens; legacy group tokens
 *  12. secrets resolution order: org key -> platform key -> clear failure
 *  13. org-credentials module: naming, schemas, provider probes (mocked HTTP)
 *  14. the installed package carries no AWS SDK
 *  15. the Lambda engine handler's bundle (esbuild, the api-stack externals)
 *      never requires mqtt: live-ingest is the Fargate runner's import only
 *      (the Models handlers are held to the same rule)
 *  16. xorgate-models pure module (src/models): the model-name rule agrees
 *      with the engine's parseModelName; class edits keep ids and refuse a
 *      used deletion; the split port reproduces the forge's own splits.json
 *      on its 63-image fixture and honours keep-previous; health rules refuse
 *      a class without val instances; the COCO writer emits 0-based
 *      categories, xywh boxes and a header whose counts match; key gating
 *      refuses climbs and foreign prefixes; header-byte dimensions for JPEG
 *      and PNG; the host's root chain is org-first
 *  17. xorgate-models training module (M3): the forge job spec v1 builders
 *      against the frozen examples; the CreateTrainingJob request (channels,
 *      checkpoints, stopping condition, spot, isolation, tags) and the
 *      instance allow-list refusal; the job-name round trip; the finalize
 *      mapping over the real result.json examples incl. the identity and
 *      sha256 refusal paths; the labels file -> annotation rows; the tar
 *      reader against an archive tar(1) wrote
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { S3Client } from '@aws-sdk/client-s3';
import {
  buildEngineResult,
  createEngine,
  engineResultSchema,
  frameKey,
  IotRunProgress,
  NODE_GROUPS,
  runGraph,
  runManifestSchema,
  runTopicPrefix,
  simEventPayloadSchema,
  simPreviewPayloadSchema,
  simStatusPayloadSchema,
  simStepPayloadSchema,
  simTopicPrefix,
  upgradeDefinition,
  workflowDefinitionSchema,
  type EngineRunOutcome,
  type EngineSourceReader,
  type RunManifest,
  type WorkflowDefinition,
} from '@xorgate/workflow-engine';
import { platformResultSchema } from '../src/workflows/host/result';
import { EXPECTED_CATALOG_VERSION, platformCatalog, platformCatalogPayload } from '../src/workflows/catalog';
import { cloudHost, preflightRefusal } from '../src/workflows/host/cloud-host';
import { createSecretReader } from '../src/workflows/host/aws';
import { v2EventRows, v2RunUpdate, v2StepRows } from '../src/workflows/host/finalize';
import { runSessionLoop } from '../src/workflows/host/session';
import {
  buildProductionManifest,
  buildTriggeredInputs,
  PRODUCTION_MAX_RUNTIME_SECONDS,
  resolveTriggeredWindow,
  sessionBinding,
  sessionsWindow,
  triggeredVideoSelection,
  unknownNodeTypes,
  type ResolvedVideoSession,
} from '../src/workflows/production';
import {
  CREDENTIAL_PROVIDERS,
  isSecretGoneError,
  orgSecretName,
  probeCredential,
  PROVIDER_BY_LOGICAL_SECRET,
  setCredentialSchema,
} from '../src/workflows/org-credentials';
import { computeRequiredCapabilities, missingCapabilities } from '../src/services/workflow-capabilities';
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
import { parseModelName } from '@xorgate/workflow-engine/local';
import {
  applyClassEdits,
  assignSplits,
  buildVersionFiles,
  checkHealth,
  classesFromNames,
  computeStats,
  datasetItemKey,
  datasetVersionPrefix,
  isKeyUnder,
  MODEL_NAME_RE,
  modelNameError,
  orgModelPrefix,
  parseItemKey,
  prepareVersion,
  readImageDimensions,
  slugifyDatasetName,
  splitCounts,
  type DatasetClass,
} from '../src/models';
import {
  buildAutolabelJobSpec,
  buildCreateTrainingJobRequest,
  buildTrainJobSpec,
  checkManifestIdentity,
  instanceTypeError,
  jobArtifactsPrefix,
  jobIdFromSagemakerName,
  jobModelTarKey,
  jobRowUpdateFromResult,
  jobSpecKey,
  labelsToAnnotationRows,
  listTarEntries,
  maxMinutesError,
  maxRuntimeSeconds,
  publishCandidate,
  sagemakerJobName,
  summarizeProgress,
  tarEntryBytes,
  isSafeTarPath,
  forgeLabelsSchema,
  forgeResultSchema,
} from '../src/models';
import { modelRootsFor } from '../src/workflows/models/registry';

const failingSources: EngineSourceReader = {
  readTelemetryWindow: async () => {
    throw new Error('smoke test must not hit a telemetry store');
  },
};
const failingFetch: typeof fetch = async () => {
  throw new Error('smoke test must not reach the network');
};

const mkNode = (id: string, type: string, config: Record<string, unknown> = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
});
const mkEdge = (source: string, target: string, sourceHandle: string, targetHandle: string) => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});

/** telemetry -> ema -> window_aggregate -> threshold -> event (the idle-detect scenario). */
function idleDetectDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 2,
    nodes: [
      mkNode('src', 'source.telemetry', { metrics: ['vehicle.speed'] }, 'Telemetry'),
      mkNode('ema', 'telemetry.ema', { alpha: 0.5 }, 'EMA Smoothing'),
      mkNode('agg', 'telemetry.window_aggregate', { windowSeconds: 30, fn: 'mean' }, 'Window Aggregate'),
      mkNode('thr', 'logic.threshold', { operator: 'lt', value: 2 }, 'Threshold'),
      mkNode('evt', 'output.event', { kind: 'idle_detect', cooldownSeconds: 300 }, 'Emit Event'),
    ],
    edges: [
      mkEdge('src', 'ema', 'telemetry', 'telemetry'),
      mkEdge('ema', 'agg', 'telemetry', 'telemetry'),
      mkEdge('agg', 'thr', 'telemetry', 'telemetry'),
      mkEdge('thr', 'evt', 'condition', 'condition'),
    ],
  };
}

function idleSamples(): Array<{ ts: number; signals: Record<string, number> }> {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  return [...Array(120).keys()].map((i) => ({ ts: t0 + i * 1000, signals: { 'vehicle.speed': i < 30 ? 20 : 0.3 } }));
}

// --- 1. Served catalog ---------------------------------------------------------------
function testServedCatalog(): void {
  assert.strictEqual(
    platformCatalogPayload.catalogVersion,
    EXPECTED_CATALOG_VERSION,
    `served catalogVersion ${platformCatalogPayload.catalogVersion} != EXPECTED_CATALOG_VERSION ${EXPECTED_CATALOG_VERSION}`,
  );
  assert.strictEqual(platformCatalogPayload.nodes.length, 28);
  assert.strictEqual(platformCatalogPayload.schemaVersion, 2);
  assert.strictEqual(platformCatalog.listNodeTypes().length, 28);
  for (const type of ['function.javascript', 'function.python']) {
    const def = platformCatalog.getNodeType(type);
    assert.ok(def, `${type} in the platform catalog`);
    assert.strictEqual(def.group, 'function');
    assert.strictEqual(def.ui.editor, 'code');
    assert.ok(def.outputs.some((p) => p.id === 'result' && p.channel === 'json' && p.tag === 'result'));
    const served = platformCatalogPayload.nodes.find((n) => n.type === type);
    assert.ok(served, `${type} served`);
    assert.strictEqual((served as { ui: { editor?: string } }).ui.editor, 'code');
  }
  assert.ok(!NODE_GROUPS.includes('custom' as never) && NODE_GROUPS.includes('function'));
  assert.ok(platformCatalog.getExecutor('source.telemetry'), 'executors resolve from the same instance');
  console.log(`check 1 ok: served catalog ${platformCatalogPayload.catalogVersion}, ${platformCatalogPayload.nodes.length} nodes incl. function.javascript/python`);
}

// --- 2. One physical zod -------------------------------------------------------------
function testSchemaComposition(): void {
  const composed = z.object({ definition: workflowDefinitionSchema, note: z.string().optional() });
  const parsed = composed.safeParse({ definition: idleDetectDefinition(), note: 'x' });
  assert.ok(parsed.success, 'a package schema composes into a local z.object');
  assert.ok(!composed.safeParse({ definition: { nodes: 'nope' } }).success);
  const request = createSimulationSchema.safeParse({ definition: idleDetectDefinition(), bindings: {} });
  assert.ok(request.success);
  console.log('check 2 ok: package schemas compose into local zod objects');
}

// --- 3. Finalize mapping -------------------------------------------------------------
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
      { kind: 'idle_detect', occurredAt: '2026-01-01T12:01:30.000Z', confidence: 1, payloadSummary: 'idle_detect', payload: { observed: 0.4 } },
    ],
    captures: { cap: [{ ts: 1, tag: 'detections', record: {} }] },
    metrics: { nodes: 2, okSteps: 2, events: 1, messages: 10 },
  };
  const result = engineResultSchema.parse(buildEngineResult('run-fin', outcome, { cap: 'json' }));
  const steps = v2StepRows('run-fin', result);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps[0], { runId: 'run-fin', seq: 0, nodeId: 'src', label: 'Video', status: 'ok', output: '1 message(s)', durationMs: 13 });
  const events = v2EventRows({ id: 'run-fin', deviceId: 'dev-1' }, result);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].clip, false);
  assert.strictEqual(events[0].clipS3Key, null);
  assert.strictEqual(events[0].occurredAt.toISOString(), '2026-01-01T12:01:30.000Z');
  const update = v2RunUpdate(result, new Date('2026-01-01T12:00:00Z'), new Date('2026-01-01T12:02:00Z'));
  assert.strictEqual(update.status, 'succeeded');
  assert.strictEqual(update.durationMs, 120_000);
  assert.strictEqual(update.engineVersion, 2);
  assert.strictEqual(update.eventCount, 1);
  assert.deepStrictEqual(update.artifacts.outputs['cap'], { recordsKey: 'workflows/v2/runs/run-fin/outputs/cap/records.json', count: 1, format: 'json' });
  console.log('check 3 ok: v2 finalize row mapping (steps, events, run update)');
}

// --- 4. Progress plane ---------------------------------------------------------------
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
  progress.runStatus({ status: 'running' });
  const definition = idleDetectDefinition();
  const outcome = await runGraph(
    { runId: 'run-progress', mode: 'simulation', deviceId: null, window: null, definition, bindings: { src: { kind: 'telemetry_inline', samples: idleSamples() } } },
    { sources: failingSources, progress, catalog: platformCatalog },
  );
  progress.runStatus({ status: outcome.status, error: outcome.error, failedNodeId: outcome.failedNodeId });
  await progress.flush();

  const prefix = 'wf/sim/org-1/run-progress';
  const byTopic = (suffix: string) => published.filter((p) => p.topic === `${prefix}${suffix}`);
  const statusMsgs = byTopic('/status').map((p) => simStatusPayloadSchema.parse(JSON.parse(p.payload)));
  assert.deepStrictEqual(statusMsgs.map((m) => m.status), ['running', 'succeeded']);
  const stepMsgs = byTopic('/steps').map((p) => simStepPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(stepMsgs.length, definition.nodes.length, 'one steps message per node');
  assert.ok(stepMsgs.every((m) => m.step.status === 'ok'));
  const eventMsgs = byTopic('/events').map((p) => simEventPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(eventMsgs.length, 1);
  assert.strictEqual(eventMsgs[0].event.kind, 'idle_detect');

  // Preview: a 640x480 frame downscales to 480 wide, base64 under the cap.
  const jpeg = jpegJs();
  const wide = Buffer.alloc(640 * 480 * 4);
  for (let i = 0; i < wide.length; i += 4) {
    wide[i] = (i / 4) % 256;
    wide[i + 3] = 255;
  }
  progress.preview('viz', 7, jpeg.encode({ data: wide, width: 640, height: 480 }, 80).data);
  await progress.flush();
  const previewMsgs = byTopic('/preview/viz').map((p) => simPreviewPayloadSchema.parse(JSON.parse(p.payload)));
  assert.strictEqual(previewMsgs.length, 1);
  assert.strictEqual(previewMsgs[0].width, 480);
  assert.strictEqual(previewMsgs[0].frameSeq, 7);
  assert.ok(previewMsgs[0].jpegBase64.length < 110_000, `preview base64 ${previewMsgs[0].jpegBase64.length}`);
  assert.strictEqual(jpeg.decode(Buffer.from(previewMsgs[0].jpegBase64, 'base64'), { useTArray: true }).width, 480);
  console.log(`check 4 ok: progress plane (IotRunProgress from the package; status/steps/events schemas, preview ${previewMsgs[0].width}x${previewMsgs[0].height})`);
}

// jpeg-js is the package's own dependency (not this service's), resolved
// through it on purpose.
function jpegJs(): {
  encode(img: { data: Buffer; width: number; height: number }, quality: number): { data: Buffer };
  decode(buf: Buffer, opts: { useTArray: boolean }): { width: number; height: number };
} {
  return require(require.resolve('jpeg-js', { paths: [path.dirname(require.resolve('@xorgate/workflow-engine/package.json'))] }));
}

// The mux needs an ffmpeg: FFMPEG_PATH, else the sibling engine checkout's
// ffmpeg-static (the laptop layout), else PATH. Returns false when none is
// reachable, in which case the mux assertions are skipped (never faked).
function ffmpegAvailable(): boolean {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return true;
  const sibling = path.resolve(__dirname, '../../../engines/xorgate-workflow-engine/node_modules/ffmpeg-static/ffmpeg');
  if (existsSync(sibling)) {
    process.env.FFMPEG_PATH = sibling;
    return true;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, 'ffmpeg'))) return true;
  }
  return false;
}

// --- 5. Cloud host -------------------------------------------------------------------
function mockS3(): { keys: string[]; restore: () => void } {
  const keys: string[] = [];
  const original = S3Client.prototype.send;
  (S3Client.prototype as { send: unknown }).send = async function mockedSend(cmd: { constructor: { name: string }; input: { Key?: string } }) {
    if (cmd.constructor.name === 'PutObjectCommand') {
      keys.push(cmd.input.Key ?? '');
      return {};
    }
    throw new Error(`smoke: unexpected S3 command ${cmd.constructor.name} for ${cmd.input.Key}`);
  };
  return { keys, restore: () => { (S3Client.prototype as { send: unknown }).send = original; } };
}

async function testCloudHost(): Promise<void> {
  const published: Array<{ topic: string; payload: string }> = [];
  const transport = async (topic: string, payload: string): Promise<void> => {
    published.push({ topic, payload });
  };
  const manifest: RunManifest = runManifestSchema.parse({
    manifestVersion: 2,
    runId: 'run-host',
    mode: 'simulation',
    orgId: 'org-1',
    deviceId: null,
    window: null,
    definition: idleDetectDefinition(),
    inputs: [{ nodeId: 'src', binding: { kind: 'telemetry_inline', samples: idleSamples() } }],
    output: { bucket: 'bkt', prefix: 'workflows/v2/runs/run-host/' },
    progress: { channel: 'iot', topicPrefix: simTopicPrefix('org-1', 'run-host') },
    limits: { maxRuntimeSeconds: 240 },
  });
  const bindings = Object.fromEntries(manifest.inputs.map((i) => [i.nodeId, i.binding]));

  // Lambda flavour: telemetry through the injected reader; no media, no models.
  let telemetryCalls = 0;
  const lambdaHost = cloudHost({
    bucket: 'bkt',
    target: 'lambda',
    telemetry: async () => {
      telemetryCalls += 1;
      return [];
    },
    progressTransport: transport,
    log: () => {},
  });
  const lambdaBound = await lambdaHost.bind({ runId: 'run-host', manifest, bindings, emitVideo: false });
  assert.strictEqual(lambdaBound.runDir, 's3://bkt/workflows/v2/runs/run-host/');
  assert.ok(lambdaBound.progress instanceof IotRunProgress, 'progress bound from the manifest block');
  assert.ok(lambdaBound.artifacts && lambdaBound.secrets && typeof lambdaBound.writeArtifacts === 'function');
  assert.strictEqual(typeof lambdaBound.sources.fetchText, 'function');
  assert.strictEqual(lambdaBound.sources.fetchVideo, undefined, 'lambda flavour fetches no media');
  assert.strictEqual(lambdaBound.sources.fetchModel, undefined, 'lambda flavour fetches no models');
  assert.strictEqual(lambdaBound.sources.openLiveFrames, undefined);
  await lambdaBound.sources.readTelemetryWindow({ deviceId: 'd', metrics: ['a'], window: { fromMs: 0, toMs: 1 } });
  assert.strictEqual(telemetryCalls, 1);
  assert.ok(lambdaHost.takeProgress('run-host') === lambdaBound.progress, 'takeProgress hands the bound sink over');
  assert.strictEqual(lambdaHost.takeProgress('run-host'), undefined, 'and only once');

  // No progress block -> no sink, no publishes.
  const silent = await lambdaHost.bind({ runId: 'run-silent', manifest: { ...manifest, runId: 'run-silent', progress: undefined }, bindings, emitVideo: false });
  assert.strictEqual(silent.progress, undefined);
  assert.strictEqual(lambdaHost.takeProgress('run-silent'), undefined);

  // Fargate flavour: media + models + live seam (only with a progress block); telemetry throws.
  const fargateHost = cloudHost({
    bucket: 'bkt',
    target: 'fargate',
    workDir: '/tmp/smoke-work',
    liveIngest: async function* stubIngest() {
      // never called here; presence is what is asserted
    },
    progressTransport: transport,
    log: () => {},
  });
  const fargateBound = await fargateHost.bind({ runId: 'run-host-f', manifest, bindings, emitVideo: false });
  assert.strictEqual(typeof fargateBound.sources.fetchVideo, 'function');
  assert.strictEqual(typeof fargateBound.sources.releaseVideo, 'function');
  assert.strictEqual(typeof fargateBound.sources.fetchModel, 'function');
  assert.strictEqual(typeof fargateBound.sources.openLiveFrames, 'function');
  await assert.rejects(fargateBound.sources.readTelemetryWindow({ deviceId: 'd', metrics: ['a'], window: { fromMs: 0, toMs: 1 } }), /not available on the media engine target/);
  const noProgress = await fargateHost.bind({ runId: 'x', manifest: { ...manifest, progress: undefined }, bindings, emitVideo: false });
  assert.strictEqual(noProgress.sources.openLiveFrames, undefined, 'live seam needs a progress prefix');
  assert.throws(() => cloudHost({ bucket: 'b', target: 'fargate', log: () => {} }).bind({ runId: 'x', manifest, bindings, emitVideo: false }), /workDir/);
  fargateHost.takeProgress('run-host-f');
  fargateHost.takeProgress('x');

  // The full Lambda target path over a mocked S3: createEngine + cloudHost.
  const s3 = mockS3();
  try {
    const engine = createEngine({ host: lambdaHost, catalog: platformCatalog });
    published.length = 0;
    const { result, outcome, runDir } = await engine.run({ manifest, runId: manifest.runId, deadlineMs: 240_000 });
    await lambdaHost.takeProgress(manifest.runId)?.flush();
    assert.strictEqual(outcome.status, 'succeeded');
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(result.events.length, 1);
    assert.strictEqual(runDir, 's3://bkt/workflows/v2/runs/run-host/');
    // result.json is the LAST object written (the finalize rule keys on it).
    assert.ok(s3.keys.length >= 2, `S3 writes: ${s3.keys.join(', ')}`);
    assert.strictEqual(s3.keys.at(-1), 'workflows/v2/runs/run-host/result.json');
    assert.ok(s3.keys.includes('workflows/v2/runs/run-host/events.jsonl'));
    assert.ok(s3.keys.slice(0, -1).every((k) => !k.endsWith('result.json')));
    // The ENGINE emits running + terminal; the host adds nothing.
    const statuses = published.filter((p) => p.topic.endsWith('/status')).map((p) => simStatusPayloadSchema.parse(JSON.parse(p.payload)).status);
    assert.deepStrictEqual(statuses, ['running', 'succeeded']);
    assert.strictEqual(published.filter((p) => p.topic.endsWith('/steps')).length, manifest.definition.nodes.length);
  } finally {
    s3.restore();
  }

  // The Fargate artifact path (simulator-output-artifacts): frames tee to
  // disk, the MP4 is muxed + uploaded before result.json, the tree is cleaned.
  const workDir = mkdtempSync(path.join(tmpdir(), 'smoke-host-'));
  const vizRunId = 'run-viz';
  const vizHost = cloudHost({ bucket: 'bkt', target: 'fargate', workDir, progressTransport: transport, log: () => {} });
  const vizBound = await vizHost.bind({ runId: vizRunId, manifest: { ...manifest, runId: vizRunId, progress: undefined }, bindings, emitVideo: false });
  const s3v = mockS3();
  const haveFfmpeg = ffmpegAvailable();
  let vizDetail: string;
  try {
    const jpeg = jpegJs();
    const rgba = Buffer.alloc(64 * 48 * 4, 255);
    const frame = jpeg.encode({ data: rgba, width: 64, height: 48 }, 80).data;
    for (let seq = 0; seq < 3; seq++) {
      const key = await vizBound.artifacts!.putFrame('viz', seq, frame);
      assert.strictEqual(key, frameKey(vizRunId, 'viz', seq), 'the S3 key stays the sink return value');
      assert.ok(existsSync(path.join(workDir, vizRunId, 'frames', 'viz', `${seq}.jpg`)), `frame ${seq} teed to the local run dir`);
    }
    assert.deepStrictEqual(s3v.keys, [0, 1, 2].map((seq) => frameKey(vizRunId, 'viz', seq)), 'every frame reached S3');
    const outcome: EngineRunOutcome = {
      status: 'succeeded',
      error: null,
      failedNodeId: null,
      steps: [{ seq: 0, nodeId: 'viz', label: 'Visualization', status: 'ok', output: '3 annotated frame(s)', durationMs: 1 }],
      events: [],
      captures: { cap: [{ ts: 1, tag: 'x', record: {} }] },
      metrics: { nodes: 1, okSteps: 1, events: 0, messages: 0 },
    };
    const vizResult = await vizBound.writeArtifacts(outcome, { cap: 'jsonl' });
    assert.strictEqual(s3v.keys.at(-1), `workflows/v2/runs/${vizRunId}/result.json`, 'result.json is still the last S3 write');
    assert.ok(s3v.keys.includes(`workflows/v2/runs/${vizRunId}/outputs/cap/records.jsonl`));
    assert.ok(!existsSync(path.join(workDir, vizRunId)), 'the local frames are removed after the mux');
    const videoKeyIdx = s3v.keys.indexOf(`workflows/v2/runs/${vizRunId}/video/viz.mp4`);
    const parsed = platformResultSchema.parse(JSON.parse(JSON.stringify(vizResult)));
    engineResultSchema.parse(JSON.parse(JSON.stringify(vizResult))); // the frozen v2 contract still parses the file
    if (haveFfmpeg) {
      assert.ok(videoKeyIdx >= 0 && videoKeyIdx < s3v.keys.length - 1, `video/viz.mp4 uploaded before result.json: ${s3v.keys.join(', ')}`);
      assert.deepStrictEqual(parsed.artifacts.videos, { viz: { key: `workflows/v2/runs/${vizRunId}/video/viz.mp4`, frames: 3, fps: 2 } });
      vizDetail = 'video/viz.mp4 muxed (3 frames @ 2 fps) + uploaded before result.json, artifacts.videos recorded';
    } else {
      assert.strictEqual(videoKeyIdx, -1);
      assert.strictEqual(parsed.artifacts.videos, undefined, 'no ffmpeg: no video recorded, the run still lands');
      vizDetail = 'MUX SKIPPED (no ffmpeg reachable; set FFMPEG_PATH), tee + ordering + cleanup asserted';
    }
    // A failed outcome muxes nothing and still cleans up.
    await vizBound.artifacts!.putFrame('viz', 9, frame);
    const failed = await vizBound.writeArtifacts({ ...outcome, status: 'failed', error: 'boom', failedNodeId: 'viz', captures: {} }, {});
    assert.strictEqual(failed.artifacts.videos, undefined);
    assert.ok(!existsSync(path.join(workDir, vizRunId)));
  } finally {
    s3v.restore();
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`check 5 ok: cloud host (bind per flavour; Lambda path through createEngine: ${s3.keys.length} S3 writes, result.json last, status running+succeeded once each; Fargate path: frames tee to disk + S3, ${vizDetail})`);
}

// --- 6. Pre-flight + routing ---------------------------------------------------------
function testPreflightAndRouting(): void {
  const tele = idleDetectDefinition();
  const fn: WorkflowDefinition = { schemaVersion: 2, nodes: [mkNode('a', 'source.telemetry', { metrics: ['x'] }), mkNode('f', 'function.javascript')], edges: [] };
  const py: WorkflowDefinition = { schemaVersion: 2, nodes: [mkNode('a', 'source.telemetry', { metrics: ['x'] }), mkNode('f', 'function.python')], edges: [] };
  const media: WorkflowDefinition = { schemaVersion: 2, nodes: [mkNode('v', 'source.video'), mkNode('d', 'video.decode_sample')], edges: [] };
  const bad: WorkflowDefinition = { schemaVersion: 2, nodes: [mkNode('x', 'nope.type')], edges: [] };
  assert.strictEqual(engineTargetForDefinition(tele), 'lambda');
  assert.strictEqual(engineTargetForDefinition(fn), 'fargate', 'a JS function node routes to Fargate');
  assert.strictEqual(engineTargetForDefinition(py), 'fargate', 'a Python function node routes to Fargate');
  assert.strictEqual(engineTargetForDefinition(media), 'fargate');
  assert.strictEqual(preflightRefusal(tele, 'lambda'), null);
  assert.strictEqual(preflightRefusal(tele, 'fargate'), null);
  assert.match(preflightRefusal(fn, 'lambda')!.error, /Fargate engine target \(code function sandbox\)/);
  assert.strictEqual(preflightRefusal(fn, 'lambda')!.nodeId, 'f');
  assert.strictEqual(preflightRefusal(fn, 'fargate'), null);
  assert.match(preflightRefusal(media, 'lambda')!.error, /media engine target/);
  assert.strictEqual(preflightRefusal(media, 'fargate'), null);
  assert.match(preflightRefusal(bad, 'lambda')!.error, /Unknown node type "nope.type"/);
  assert.match(preflightRefusal(bad, 'fargate')!.error, /Unknown node type "nope.type"/);
  console.log('check 6 ok: pre-flight + routing (function -> fargate; lambda refuses media/function; unknown types everywhere)');
}

// --- 7. Simulations module -----------------------------------------------------------
function resolvedSession(streamKey = 'cam0', sessionId = '9f9e0cf2-0000-4000-8000-0000000000aa'): ResolvedVideoSession {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  return {
    sessionId,
    streamKey,
    timeSource: 'ntp',
    segments: [
      { s3Key: `media-sessions/v1/dev/${streamKey}/${sessionId}/0.mp4`, startTs: t0, durationMs: 60_000, effectiveDurationMs: 60_000, seq: 0, finalized: true },
      { s3Key: `media-sessions/v1/dev/${streamKey}/${sessionId}/1.mp4`, startTs: t0 + 60_000, durationMs: 60_000, effectiveDurationMs: 60_000, seq: 1, finalized: true },
    ],
    fromTs: t0,
    toTs: t0 + 120_000,
    gaps: [],
  };
}

function testSimulationsModule(): void {
  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [mkNode('vid', 'source.video'), mkNode('tel', 'source.telemetry', { metrics: ['gps.speed'] }), mkNode('dec', 'video.decode_sample', { fps: 2 }), mkNode('evt', 'output.event', { kind: 'x' })],
    edges: [],
  };
  const orgId = '9f9e0cf2-0000-4000-8000-000000000001';
  const deviceId = '9f9e0cf2-0000-4000-8000-000000000002';
  const session = resolvedSession();

  // Request wire shape parses (the FROZEN simulations POST body).
  const request = createSimulationSchema.parse({
    definition,
    bindings: {
      vid: { kind: 'session', sessionId: session.sessionId },
      tel: { kind: 'device_telemetry', deviceId, window: { from: '2026-01-01T12:00:00Z', to: '2026-01-01T12:10:00Z' } },
    },
  });
  assert.deepStrictEqual(validateSimulationBindings(definition, request.bindings, orgId), []);
  const missing = validateSimulationBindings(definition, { vid: request.bindings.vid }, orgId);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].nodeId, 'tel');
  const wrongKind = validateSimulationBindings(definition, { ...request.bindings, vid: request.bindings.tel }, orgId);
  assert.ok(wrongKind.some((i) => i.nodeId === 'vid' && /does not fit/.test(i.message)));
  const foreignUpload = validateSimulationBindings(definition, { ...request.bindings, vid: { kind: 'video_file', uploadKey: 'workflows/v2/uploads/other-org/x/v.mp4' } as SimulationBinding }, orgId);
  assert.ok(foreignUpload.some((i) => /upload endpoint/.test(i.message)));
  assert.ok(!createSimulationSchema.safeParse({ definition, bindings: { vid: { kind: 'recording', recordingId: 'r' } } }).success, 'the retired recording kind is rejected');

  // API bindings -> executor bindings -> schema-valid manifest.
  const inputs = toManifestInputs(request.bindings, new Map([[session.sessionId, session]]));
  const manifest = buildSimulationManifest({ runId: 'run-sim-1', orgId, bucket: 'test-bucket', definition, deviceId, inputs, window: simulationWindow(request.bindings), target: 'fargate' });
  runManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
  assert.strictEqual(manifest.mode, 'simulation');
  assert.strictEqual(manifest.orgId, orgId);
  assert.strictEqual(manifest.progress?.topicPrefix, `wf/sim/${orgId}/run-sim-1`);
  assert.strictEqual(manifest.window?.from, '2026-01-01T12:00:00.000Z');
  assert.strictEqual(manifest.limits.maxRuntimeSeconds, 900);
  const byNode = new Map(manifest.inputs.map((i) => [i.nodeId, i.binding]));
  assert.deepStrictEqual(byNode.get('vid'), sessionBinding(session));
  assert.strictEqual((byNode.get('vid') as { kind: string }).kind, 'device_session');
  assert.deepStrictEqual(byNode.get('tel'), { kind: 'telemetry_history', window: { from: '2026-01-01T12:00:00Z', to: '2026-01-01T12:10:00Z' } });
  // Upload kinds pass through as s3Key on the run bucket.
  const uploads = toManifestInputs({ vid: { kind: 'video_file', uploadKey: `workflows/v2/uploads/${orgId}/v.mp4` }, tel: { kind: 'telemetry_csv', uploadKey: `workflows/v2/uploads/${orgId}/t.csv`, metrics: ['gps.speed'] } }, new Map());
  assert.deepStrictEqual(uploads.map((i) => i.binding), [{ kind: 'video_file', s3Key: `workflows/v2/uploads/${orgId}/v.mp4` }, { kind: 'telemetry_csv', s3Key: `workflows/v2/uploads/${orgId}/t.csv`, metrics: ['gps.speed'] }]);
  // A video-only simulation takes its window from the bound session.
  assert.deepStrictEqual(simulationWindow({ vid: request.bindings.vid }, new Map([[session.sessionId, session]])), sessionsWindow([session]));

  // M5: webcam binding, live mode, session naming.
  const liveDef: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [mkNode('v', 'source.video'), mkNode('d', 'video.decode_sample'), mkNode('vlm', 'model.vlm', { prompt: 'Is a person visible?' }), mkNode('e', 'output.event', { kind: 'x' })],
    edges: [mkEdge('v', 'd', 'video', 'video'), mkEdge('d', 'vlm', 'frames', 'frames'), mkEdge('vlm', 'e', 'condition', 'condition')],
  };
  const liveBindings: Record<string, SimulationBinding> = { v: { kind: 'webcam', maxDurationSeconds: 120 } };
  assert.deepStrictEqual(validateSimulationBindings(liveDef, liveBindings, 'org-1'), []);
  assert.ok(hasLiveBindings(liveBindings));
  assert.strictEqual(engineTargetForDefinition(liveDef), 'fargate');
  const badLive = validateSimulationBindings({ schemaVersion: 2, nodes: [mkNode('t', 'source.telemetry', { metrics: ['a'] })], edges: [] }, { t: { kind: 'webcam' } }, 'org-1');
  assert.ok(badLive.length === 1 && badLive[0].message.includes('does not fit source.telemetry'));
  const liveInputs = toManifestInputs(liveBindings, new Map());
  assert.deepStrictEqual(liveInputs, [{ nodeId: 'v', binding: { kind: 'webcam', maxDurationSeconds: 120 } }]);
  const liveManifest = buildSimulationManifest({ runId: 'run-m5', orgId: 'org-1', bucket: 'bucket', definition: liveDef, deviceId: null, inputs: liveInputs, window: simulationWindow(liveBindings), target: 'fargate' });
  assert.strictEqual(liveManifest.mode, 'live', 'live bindings flip the manifest to live mode');
  const batchManifest = buildSimulationManifest({ runId: 'run-m5b', orgId: 'org-1', bucket: 'bucket', definition: liveDef, deviceId: null, inputs: [{ nodeId: 'v', binding: { kind: 'video_file', s3Key: 'workflows/v2/uploads/org-1/x.mp4' } }], window: null, target: 'fargate' });
  assert.strictEqual(batchManifest.mode, 'simulation');
  const key = simulationSessionKey('org-1', 'template-1');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.strictEqual(key, simulationSessionKey('org-1', 'template-1'));
  assert.notStrictEqual(key, simulationSessionKey('org-1', 'template-2'));
  assert.strictEqual(sessionQueueName('xorgate-wfsim-dev-', key), `xorgate-wfsim-dev-${key}`);
  assert.ok(sessionQueueName('xorgate-wfsim-dev-', key).length <= 80);
  console.log('check 7 ok: simulations module (request schema, binding validation, session/upload/webcam mapping, manifests, session naming)');
}

// --- 8. Warm session loop ------------------------------------------------------------
async function testSessionLoop(): Promise<void> {
  const jobs: Array<{ runId: string } | null> = [{ runId: 'r1' }, null, { runId: 'r2' }, { runId: 'r3' }];
  const ran: string[] = [];
  let clock = 0;
  const outcome = await runSessionLoop({
    idleTimeoutMs: 100,
    log: () => {},
    now: () => clock,
    receive: async () => {
      clock += 30;
      return jobs.shift() ?? null;
    },
    runJob: async (job) => {
      ran.push(job.runId);
      if (job.runId === 'r2') throw new Error('boom');
    },
  });
  assert.deepStrictEqual(ran, ['r1', 'r2', 'r3']);
  assert.strictEqual(outcome.jobsRun, 3);
  assert.strictEqual(outcome.jobFailures, 1);
  assert.strictEqual(outcome.endedReason, 'idle');
  assert.strictEqual(outcome.queueRetired, false, 'no retire seam, nothing retired');

  // M6 (the warm-session exit race): on idle-out the loop takes one final
  // short receive, serves what it finds, and only then retires the queue, so a
  // dispatcher that enqueues after this point fails its SendMessage and takes
  // the cold path instead of stranding the run.
  const trace: string[] = [];
  const late: Array<{ runId: string } | null> = [{ runId: 'late-1' }, null];
  let clock2 = 0;
  const outcome2 = await runSessionLoop({
    idleTimeoutMs: 100,
    log: () => {},
    now: () => clock2,
    receive: async () => {
      clock2 += 60;
      trace.push('receive');
      return null;
    },
    receiveFinal: async () => {
      trace.push('final');
      return late.shift() ?? null;
    },
    retireQueue: async () => {
      trace.push('retire');
    },
    runJob: async (job) => {
      trace.push(`run ${job.runId}`);
    },
  });
  // Two empty long polls reach the timeout; the final receive finds late-1 and
  // serves it (activity resets the idle clock); two more empty polls, an empty
  // final receive, then retire, then exit.
  assert.deepStrictEqual(trace, ['receive', 'receive', 'final', 'run late-1', 'receive', 'receive', 'final', 'retire']);
  assert.strictEqual(outcome2.jobsRun, 1);
  assert.strictEqual(outcome2.queueRetired, true);

  // A retire failure (the queue already gone, a denied DeleteQueue) is logged
  // and never keeps the task alive.
  const logged: string[] = [];
  let clock3 = 0;
  const outcome3 = await runSessionLoop({
    idleTimeoutMs: 100,
    log: (m) => logged.push(m),
    now: () => clock3,
    receive: async () => {
      clock3 += 100;
      return null;
    },
    retireQueue: async () => {
      throw new Error('AWS.SimpleQueueService.NonExistentQueue');
    },
    runJob: async () => {},
  });
  assert.strictEqual(outcome3.queueRetired, false);
  assert.ok(logged.some((m) => /retire.*NonExistentQueue/.test(m)), logged.join(' | '));
  console.log('check 8 ok: warm session loop (serial jobs, failure tolerance, idle-out, final receive then queue retire)');
}

// --- 9. Production dispatch module ---------------------------------------------------
function testProductionDispatchModule(): void {
  assert.deepStrictEqual(triggeredVideoSelection({ type: 'session_completed', sessionId: 's1', streamKey: 'cam0' }), { kind: 'session', sessionId: 's1', streamKey: 'cam0' });
  assert.deepStrictEqual(triggeredVideoSelection({ type: 'segment_uploaded', sessionId: 's1', streamKey: 'cam0', seq: 7 }), { kind: 'segment', sessionId: 's1', streamKey: 'cam0', seq: 7 });
  assert.deepStrictEqual(triggeredVideoSelection({ selection: { mode: 'sessions', sessionIds: ['s1', 's2'] } }), { kind: 'sessions', sessionIds: ['s1', 's2'] });
  assert.deepStrictEqual(triggeredVideoSelection({ selection: { mode: 'lastNSessions', n: 3 } }), { kind: 'lastNSessions', n: 3 });
  assert.strictEqual(triggeredVideoSelection({ type: 'telemetry_condition' }), null);
  assert.strictEqual(triggeredVideoSelection({ type: 'recording_saved', s3Key: 'media/v1/x.mp4' }), null, 'retired cloud-recorder context');

  const started = new Date('2026-07-15T12:00:00.000Z');
  assert.deepStrictEqual(resolveTriggeredWindow({ window: { from: 'A', to: 'B' } }, started), { from: 'A', to: 'B' });
  const fallback = resolveTriggeredWindow({}, started);
  assert.strictEqual(fallback.to, started.toISOString());
  assert.strictEqual(Date.parse(fallback.to) - Date.parse(fallback.from), 15 * 60_000);
  const session = resolvedSession();
  assert.deepStrictEqual(resolveTriggeredWindow({}, started, sessionsWindow([session])), sessionsWindow([session]));

  const mediaDef: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [mkNode('cam', 'source.video'), mkNode('gps', 'source.telemetry', { metrics: ['gps.speed'] }), mkNode('dec', 'video.decode_sample', { fps: 2 })],
    edges: [mkEdge('cam', 'dec', 'video', 'video')],
  };
  const fargateInputs = buildTriggeredInputs(mediaDef, [session], 'fargate');
  assert.deepStrictEqual(fargateInputs.map((i) => `${i.nodeId}:${i.binding.kind}`).sort(), ['cam:device_session', 'gps:telemetry_history']);
  assert.deepStrictEqual(fargateInputs.find((i) => i.nodeId === 'cam')!.binding, sessionBinding(session));
  const telDef: WorkflowDefinition = { schemaVersion: 2, nodes: [mkNode('gps', 'source.telemetry', { metrics: ['gps.speed'] })], edges: [] };
  assert.deepStrictEqual(buildTriggeredInputs(telDef, [], 'lambda'), [], 'lambda telemetry sources take the executor default');
  assert.throws(() => buildTriggeredInputs(mediaDef, [], 'fargate'), /No video input/);
  const multiCam: WorkflowDefinition = { schemaVersion: 2, nodes: [mkNode('c1', 'source.video', { streamKey: 'cam1' }), mkNode('c0', 'source.video', { streamKey: 'cam0' })], edges: [] };
  const cams = buildTriggeredInputs(multiCam, [resolvedSession('cam0'), resolvedSession('cam1', '9f9e0cf2-0000-4000-8000-0000000000bb')], 'fargate');
  assert.deepStrictEqual(cams.map((i) => (i.binding as { streamKey: string }).streamKey), ['cam1', 'cam0']);
  assert.throws(() => buildTriggeredInputs({ schemaVersion: 2, nodes: [mkNode('c9', 'source.video', { streamKey: 'cam9' })], edges: [] }, [session], 'fargate'), /No recorded session for stream "cam9"/);

  const manifest = buildProductionManifest({ runId: 'run-1', orgId: 'org-1', bucket: 'bkt', definition: mediaDef, deviceId: 'dev-1', inputs: fargateInputs, window: fallback, target: 'fargate' });
  assert.strictEqual(manifest.mode, 'batch');
  assert.strictEqual(manifest.orgId, 'org-1');
  assert.strictEqual(manifest.progress?.topicPrefix, runTopicPrefix('org-1', 'run-1'));
  assert.strictEqual(manifest.progress?.topicPrefix, 'wf/run/org-1/run-1');
  assert.strictEqual(manifest.limits.maxRuntimeSeconds, PRODUCTION_MAX_RUNTIME_SECONDS.fargate);
  assert.strictEqual(PRODUCTION_MAX_RUNTIME_SECONDS.fargate, 1800);
  assert.strictEqual(PRODUCTION_MAX_RUNTIME_SECONDS.lambda, 240);
  runManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
  console.log('check 9 ok: production dispatch module (session selection, device_session inputs, window, batch manifest on wf/run)');
}

// --- 10. Cutover routing -------------------------------------------------------------
function testCutoverRouting(): void {
  const v1Video = { nodes: [mkNode('v', 'source.video'), mkNode('d', 'processor.decode_sample', { fps: 2 }), mkNode('o', 'processor.object_detection', { model: 'yolo-n' })], edges: [{ id: 'e1', source: 'v', target: 'd' }, { id: 'e2', source: 'd', target: 'o' }] } as never;
  const upVideo = upgradeDefinition(v1Video);
  assert.strictEqual(upVideo.schemaVersion, 2);
  assert.deepStrictEqual(unknownNodeTypes(upVideo), []);
  assert.strictEqual(engineTargetForDefinition(upVideo), 'fargate');
  assert.ok(upVideo.nodes.some((n) => n.type === 'model.object_detection'));
  const v1Tel = { nodes: [mkNode('g', 'source.gps'), mkNode('s', 'processor.speed_from_gps'), mkNode('c', 'processor.speed_limit_check', { limitKph: 80 }), mkNode('e', 'output.event', { kind: 'overspeed' })], edges: [{ id: 'e1', source: 'g', target: 's' }, { id: 'e2', source: 's', target: 'c' }, { id: 'e3', source: 'c', target: 'e' }] } as never;
  const upTel = upgradeDefinition(v1Tel);
  assert.deepStrictEqual(unknownNodeTypes(upTel), []);
  assert.strictEqual(engineTargetForDefinition(upTel), 'lambda');
  assert.deepStrictEqual(upgradeDefinition(upTel), upTel, 'upgrading v2 is idempotent');
  assert.deepStrictEqual(unknownNodeTypes(upgradeDefinition({ nodes: [mkNode('x', 'custom.mystery')], edges: [] } as never)), ['custom.mystery']);
  console.log('check 10 ok: cutover routing (v1 upgrade -> catalog-derived target, unknown-type detection)');
}

// --- 11. Capabilities ----------------------------------------------------------------
function testUpgradedCapabilities(): void {
  const required = computeRequiredCapabilities({ nodes: [mkNode('g', 'source.gps', {}, 'GPS')], edges: [] } as never);
  assert.deepStrictEqual(required, ['metric:gps.latitude', 'metric:gps.longitude', 'metric:gps.speed']);
  const caps = { media: { video: [{ key: 'cam0' }] }, comm: { gps: { fields: ['latitude', 'longitude', 'speed'] } }, sensors: { imu: { accel: ['x', 'y', 'z'] } } };
  assert.deepStrictEqual(missingCapabilities(required, caps), []);
  assert.deepStrictEqual(missingCapabilities(required, {}), required);
  assert.deepStrictEqual(missingCapabilities(['gps', 'imu', 'video'], caps), []);
  assert.deepStrictEqual(missingCapabilities(['gps', 'imu', 'video'], {}), ['gps', 'imu', 'video']);
  // A function node requires nothing of the device; a video graph requires video.
  assert.deepStrictEqual(computeRequiredCapabilities({ schemaVersion: 2, nodes: [mkNode('f', 'function.javascript')], edges: [] }), []);
  assert.deepStrictEqual(computeRequiredCapabilities({ schemaVersion: 2, nodes: [mkNode('v', 'source.video')], edges: [] }), ['video']);
  console.log('check 11 ok: capabilities (metric tokens from upgraded graphs, legacy group tokens, function nodes need nothing)');
}

// --- 12. Secrets resolution order ----------------------------------------------------
async function testSecretResolutionOrder(): Promise<void> {
  const makeReader = (opts: { orgId: string | null; env: Record<string, string | undefined>; values: Record<string, string | null> }) => {
    const fetched: string[] = [];
    const reader = createSecretReader({
      orgId: opts.orgId,
      env: opts.env,
      fetchSecretValue: async (name) => {
        fetched.push(name);
        return name in opts.values ? opts.values[name] : null;
      },
    });
    return { reader, fetched };
  };
  const env = { GOOGLE_ROADS_SECRET_NAME: 'platform-roads', HERE_SECRET_NAME: 'platform-here' };
  {
    const { reader, fetched } = makeReader({ orgId: 'org-1', env, values: { 'xorgate/orgs/org-1/google_roads': 'org-key', 'platform-roads': 'platform-key' } });
    assert.strictEqual(await reader.getSecret('google-roads-api-key'), 'org-key');
    assert.deepStrictEqual(fetched, ['xorgate/orgs/org-1/google_roads']);
  }
  {
    const { reader, fetched } = makeReader({ orgId: 'org-1', env, values: { 'platform-here': 'platform-here-key' } });
    assert.strictEqual(await reader.getSecret('here-api-key'), 'platform-here-key');
    assert.deepStrictEqual(fetched, ['xorgate/orgs/org-1/here', 'platform-here']);
  }
  {
    const { reader } = makeReader({ orgId: 'org-1', env, values: { 'xorgate/orgs/org-1/google_roads': '', 'platform-roads': 'platform-key' } });
    assert.strictEqual(await reader.getSecret('google-roads-api-key'), 'platform-key');
  }
  {
    const { reader, fetched } = makeReader({ orgId: null, env, values: { 'platform-roads': 'p' } });
    assert.strictEqual(await reader.getSecret('google-roads-api-key'), 'p');
    assert.deepStrictEqual(fetched, ['platform-roads']);
  }
  {
    const { reader } = makeReader({ orgId: 'org-1', env: {}, values: {} });
    await assert.rejects(reader.getSecret('here-api-key'), /no organization credential for here.*HERE_SECRET_NAME/s);
  }
  {
    const { reader } = makeReader({ orgId: 'org-1', env, values: {} });
    await assert.rejects(reader.getSecret('here-api-key'), /"platform-here" does not exist/);
  }
  {
    const { reader } = makeReader({ orgId: null, env, values: {} });
    await assert.rejects(reader.getSecret('unknown-name'), /Unknown secret/);
  }
  {
    const { reader, fetched } = makeReader({ orgId: 'org-1', env, values: { 'platform-roads': 'p' } });
    await reader.getSecret('google-roads-api-key');
    await reader.getSecret('google-roads-api-key');
    assert.strictEqual(fetched.filter((n) => n === 'xorgate/orgs/org-1/google_roads').length, 2, 'org miss re-checked per resolution');
    assert.strictEqual(fetched.filter((n) => n === 'platform-roads').length, 1, 'platform value cached');
  }
  console.log('check 12 ok: secrets resolution order (org -> platform -> clear failure; miss not cached)');
}

// --- 13. Org credentials -------------------------------------------------------------
async function testOrgCredentialsModule(): Promise<void> {
  assert.strictEqual(orgSecretName('org-1', 'google_roads'), 'xorgate/orgs/org-1/google_roads');
  assert.strictEqual(orgSecretName('org-1', 'anthropic'), 'xorgate/orgs/org-1/anthropic');
  assert.strictEqual(PROVIDER_BY_LOGICAL_SECRET['here-api-key'], 'here');
  assert.deepStrictEqual([...CREDENTIAL_PROVIDERS], ['google_roads', 'here', 'anthropic']);
  assert.ok(!setCredentialSchema.safeParse({ apiKey: 'short' }).success);
  assert.strictEqual(setCredentialSchema.parse({ apiKey: '  padded-key-value  ' }).apiKey, 'padded-key-value');
  assert.ok(isSecretGoneError({ name: 'ResourceNotFoundException' }));
  assert.ok(isSecretGoneError({ name: 'InvalidRequestException', message: "You can't perform this operation on the secret because it was marked for deletion." }));
  assert.ok(!isSecretGoneError({ name: 'InvalidRequestException', message: 'other invalid request' }));
  assert.ok(!isSecretGoneError({ name: 'AccessDeniedException', message: 'nope' }));

  const jsonRes = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  {
    const http = (async () => jsonRes(403, { error: { status: 'PERMISSION_DENIED', message: 'Speed limits are not available for this project.' } })) as unknown as typeof fetch;
    const res = await probeCredential('google_roads', 'k', http);
    assert.strictEqual(res.ok, false);
    assert.ok(res.message.includes('Speed limits are not available'), res.message);
  }
  {
    const http = (async (input: unknown) => {
      assert.ok(String(input).includes('roads.googleapis.com/v1/speedLimits'), String(input));
      return jsonRes(200, { speedLimits: [] });
    }) as unknown as typeof fetch;
    assert.strictEqual((await probeCredential('google_roads', 'k', http)).ok, true);
  }
  {
    const http = (async () => jsonRes(401, { error: 'Unauthorized' })) as unknown as typeof fetch;
    assert.strictEqual((await probeCredential('here', 'k', http)).ok, false);
  }
  {
    let seenUrl = '';
    const http = (async (input: unknown) => {
      seenUrl = String(input);
      return jsonRes(400, { error: 'no match' });
    }) as unknown as typeof fetch;
    assert.strictEqual((await probeCredential('here', 'k', http)).ok, true, 'HERE 400 (no match) still proves the key');
    assert.ok(seenUrl.startsWith('https://routematching.hereapi.com/v8/match/routelinks?'), seenUrl);
  }
  {
    let seen: { url: string; init?: RequestInit } | null = null;
    const http = (async (input: unknown, init?: RequestInit) => {
      seen = { url: String(input), init };
      return jsonRes(200, { id: 'msg_1' });
    }) as unknown as typeof fetch;
    assert.strictEqual((await probeCredential('anthropic', 'sk-ant-test', http)).ok, true);
    assert.strictEqual(seen!.url, 'https://api.anthropic.com/v1/messages');
    const headers = seen!.init?.headers as Record<string, string>;
    assert.strictEqual(headers['x-api-key'], 'sk-ant-test');
    assert.ok(headers['anthropic-version']);
    const body = JSON.parse(String(seen!.init?.body)) as { model: string; max_tokens: number };
    assert.strictEqual(body.max_tokens, 1);
    assert.strictEqual(body.model, 'claude-haiku-4-5');
  }
  {
    const http = (async () => jsonRes(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })) as unknown as typeof fetch;
    const res = await probeCredential('anthropic', 'bad', http);
    assert.strictEqual(res.ok, false);
    assert.ok(res.message.includes('invalid x-api-key'), res.message);
  }
  assert.strictEqual((await probeCredential('anthropic', null, failingFetch)).ok, false);
  {
    const http = (async (input: unknown, init?: RequestInit) => {
      assert.strictEqual(String(input), 'https://overpass-api.de/api/interpreter');
      assert.ok((init?.headers as Record<string, string>)['User-Agent']);
      return jsonRes(200, { elements: [] });
    }) as unknown as typeof fetch;
    assert.strictEqual((await probeCredential('osm', null, http)).ok, true);
  }
  console.log('check 13 ok: org-credentials module (naming, schemas, Google/HERE/Claude/OSM probes through the package request builders)');
}

// --- 14. No AWS SDK in the package ---------------------------------------------------
function testPackageHasNoCloudSdk(): void {
  const dist = path.join(path.dirname(require.resolve('@xorgate/workflow-engine/package.json')), 'dist');
  const hits: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/@aws-sdk|aws-lambda/.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  })(dist);
  assert.deepStrictEqual(hits, []);
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(dist), 'package.json'), 'utf8')) as { version: string };
  const pinned = (JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@xorgate/workflow-engine'];
  assert.strictEqual(pkg.version, pinned, `installed ${pkg.version} vs pinned ${pinned}`);
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'exact pin');
  console.log(`check 14 ok: @xorgate/workflow-engine@${pkg.version} (exact pin) carries no AWS SDK`);
}

// --- 15. No mqtt in the Lambda engine bundle -----------------------------------------
function testLambdaBundleHasNoMqtt(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const esbuild = require('esbuild') as typeof import('esbuild');
  const externals = ['@aws-sdk/*', '@xorgate/workflow-engine', 'onnxruntime-node', '@anthropic-ai/sdk', 'mqtt'];
  for (const entry of [
    'src/handlers/workflow-engine.ts',
    'src/handlers/workflow-catalog.ts',
    'src/handlers/workflow-simulations.ts',
    'src/handlers/datasets.ts',
    'src/handlers/models.ts',
    'src/handlers/model-job-dispatch.ts',
    'src/handlers/training-jobs.ts',
    'src/handlers/model-job-finalize.ts',
    'src/handlers/workflow-templates.ts',
  ]) {
    const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', entry)], bundle: true, platform: 'node', target: 'node20', write: false, external: externals, logLevel: 'silent' });
    const text = out.outputFiles.map((f) => f.text).join('\n');
    assert.ok(!/require\(["']mqtt["']\)/.test(text), `${entry} bundle requires mqtt (live-ingest leaked into a Lambda bundle)`);
    // The Models handlers that never touch the engine (datasets, dispatch) are
    // held to the mqtt/optional-deps rule only.
    const usesEngine = !/datasets\.ts$|model-job-dispatch\.ts$|training-jobs\.ts$/.test(entry);
    if (usesEngine) assert.ok(/require\(["']@xorgate\/workflow-engine["']\)/.test(text), `${entry} bundle should require the engine package externally`);
    assert.ok(!/require\(["']onnxruntime-node["']\)/.test(text) && !/require\(["']@anthropic-ai\/sdk["']\)/.test(text), `${entry} bundle must not require the package's optional deps directly`);
  }
  console.log(
    'check 15 ok: Lambda handler bundles (engine, catalog, simulations, datasets, models, model-job-dispatch, training-jobs, model-job-finalize, templates) require the engine package externally and never mqtt',
  );
}

// --- 16. xorgate-models pure module -----------------------------------------------
// The forge's fixture dataset (63 frames of drive.mp4 in five groups) and the
// splits.json `xmf dataset split --seed 0 --train 0.8 --val 0.2` wrote for it
// (fixtures/ds/splits.json at forge f630024): id|group|split, ids and groups
// with their `drive_` / `drive:` prefixes stripped.
const FORGE_FIXTURE_SPLITS = '0000|0|t;0006|0|t;0012|0|t;0018|0|t;0024|0|t;0030|0|t;0036|0|t;0042|0|t;0048|0|t;0054|0|t;0060|0|t;0066|0|t;0072|0|t;0078|1|t;0084|1|t;0090|1|t;0096|1|t;0102|1|t;0108|1|t;0114|1|t;0120|1|t;0126|1|t;0132|1|t;0138|1|t;0144|1|t;0150|1|t;0156|2|v;0162|2|v;0168|2|v;0174|2|v;0180|2|v;0186|2|v;0192|2|v;0198|2|v;0204|2|v;0210|2|v;0216|2|v;0222|2|v;0228|3|t;0234|3|t;0240|3|t;0246|3|t;0252|3|t;0258|3|t;0264|3|t;0270|3|t;0276|3|t;0282|3|t;0288|3|t;0294|3|t;0300|3|t;0306|4|t;0312|4|t;0318|4|t;0324|4|t;0330|4|t;0336|4|t;0342|4|t;0348|4|t;0354|4|t;0360|4|t;0366|4|t;0372|4|t';

function testModelsModule(): void {
  // Names: the literal regex and the engine's parser agree on every probe.
  for (const name of ['yolov8n', 'fixture-vehicles', 'a.b_c-1', 'X']) {
    assert.strictEqual(modelNameError(name), null, name);
    assert.deepStrictEqual(parseModelName('detection', name), { family: 'detection', name });
  }
  for (const bad of ['', '-lead', '.dot', 'has space', 'slash/x', 'pin@2', 'a'.repeat(65)]) {
    assert.ok(modelNameError(bad) !== null, `expected refusal for ${JSON.stringify(bad)}`);
    if (bad !== '' && !bad.includes('@') && bad.length <= 64) assert.throws(() => parseModelName('detection', bad), bad);
  }
  assert.ok(!MODEL_NAME_RE.test('a b'));
  assert.strictEqual(slugifyDatasetName('Yard cameras (west)!'), 'yard-cameras-west');
  assert.strictEqual(slugifyDatasetName('***'), 'dataset');

  // Classes: ids survive a rename and a reorder; a used deletion is refused;
  // duplicate names are refused; a new entry gets a palette color.
  const fresh = classesFromNames(['car', 'truck']);
  assert.ok(fresh.ok);
  const [car, truck] = fresh.classes;
  assert.match(car.id, /^c_[0-9a-f]{8}$/);
  const renamed = applyClassEdits(fresh.classes, [{ id: truck.id, name: 'lorry' }, { id: car.id, name: 'car', color: '#112233' }, { name: 'van' }]);
  assert.ok(renamed.ok);
  assert.deepStrictEqual(renamed.classes.map((c) => c.name), ['lorry', 'car', 'van']);
  assert.strictEqual(renamed.classes[0].id, truck.id);
  assert.strictEqual(renamed.classes[1].color, '#112233');
  assert.strictEqual(renamed.added.length, 1);
  const refused = applyClassEdits(fresh.classes, [{ id: car.id, name: 'car' }], new Map([[truck.id, 3]]));
  assert.ok(!refused.ok && /used by 3 annotation/.test(refused.error));
  const allowed = applyClassEdits(fresh.classes, [{ id: car.id, name: 'car' }], new Map());
  assert.ok(allowed.ok && allowed.removed[0] === truck.id);
  const dup = applyClassEdits(fresh.classes, [{ id: car.id, name: 'Car' }, { id: truck.id, name: 'car' }]);
  assert.ok(!dup.ok && /Duplicate/.test(dup.error));

  // Split: byte-for-byte the forge's assignment on its fixture.
  const fixture = FORGE_FIXTURE_SPLITS.split(';').map((row) => {
    const [id, group, split] = row.split('|');
    return { id: `drive_${id}`, group: `drive:${group}`, split: split === 't' ? 'train' : split === 'v' ? 'val' : 'test' };
  });
  const images = fixture.map((f) => ({ id: f.id, group: f.group }));
  const mine = assignSplits(images, { train: 0.8, val: 0.2, test: 0 }, 0);
  const mismatches = fixture.filter((f) => mine[f.id] !== f.split);
  assert.deepStrictEqual(mismatches, [], `split port disagrees with the forge on ${mismatches.length} image(s)`);
  assert.deepStrictEqual(splitCounts(mine), { train: 51, val: 12, test: 0 });
  assert.deepStrictEqual(assignSplits(images, { train: 0.8, val: 0.2, test: 0 }, 0), mine, 'deterministic');
  const reseeded = assignSplits(images, { train: 0.8, val: 0.2, test: 0 }, 1); // the forge puts drive:3 in val under seed 1
  assert.ok(fixture.some((f) => reseeded[f.id] !== mine[f.id]), 'a different seed moves at least one group');
  // Groups never straddle: every image of a group lands in one split.
  const byGroup = new Map<string, Set<string>>();
  for (const img of images) byGroup.set(img.group, (byGroup.get(img.group) ?? new Set()).add(mine[img.id]));
  assert.ok([...byGroup.values()].every((s) => s.size === 1), 'group straddles splits');
  // keep-previous: kept ids stay put, the fractions apply to the rest.
  const keep = Object.fromEntries(fixture.slice(0, 20).map((f) => [f.id, f.split === 'train' ? ('val' as const) : ('train' as const)]));
  const kept = assignSplits(images, { train: 0.8, val: 0.2, test: 0 }, 0, keep);
  assert.ok(Object.entries(keep).every(([id, s]) => kept[id] === s), 'kept ids moved');

  // Health and stats: a class with no val instance is an error, few is a warning.
  const classNames = ['car', 'truck'];
  const boxes = fixture.filter((f) => f.split === 'train').map((f) => ({ imageId: f.id, classIndex: 1 }));
  boxes.push(...fixture.filter((f) => f.split === 'val').slice(0, 3).map((f) => ({ imageId: f.id, classIndex: 0 })));
  const stats = computeStats(images, boxes, mine, classNames);
  assert.strictEqual(stats.perClass.car.val, 3);
  assert.strictEqual(stats.perClass.truck.val, 0);
  const health = checkHealth(stats, images, mine, classNames);
  assert.ok(!health.ok);
  assert.deepStrictEqual(health.errors.map((e) => e.code), ['CLASS_NO_VAL_INSTANCES']);
  assert.match(health.errors[0].message, /class "truck" has no instance in the val split/);
  assert.ok(health.warnings.some((w) => w.code === 'CLASS_FEW_VAL_INSTANCES' && w.className === 'car'));
  const noVal = checkHealth(computeStats(images, boxes, Object.fromEntries(images.map((i) => [i.id, 'train' as const])), classNames), images, Object.fromEntries(images.map((i) => [i.id, 'train' as const])), classNames);
  assert.ok(noVal.errors.some((e) => e.code === 'NO_VAL'));

  // Version files: 0-based categories in class order, xywh boxes clamped to the
  // image, header counts equal to the files, splits sorted.
  const classes: DatasetClass[] = [
    { id: 'c_aaaaaaaa', name: 'car', color: '#e6194b' },
    { id: 'c_bbbbbbbb', name: 'truck', color: '#3cb44b' },
  ];
  const items = images.map((img) => ({ id: img.id, ext: 'jpg', width: 1280, height: 720, groupKey: img.group, source: { kind: 'upload' } }));
  const annotations = [
    ...fixture.map((f) => ({ itemId: f.id, classId: 'c_aaaaaaaa', x1: 10.004, y1: 20, x2: 110, y2: 80, source: 'human', confidence: null })),
    ...fixture.filter((f) => f.split === 'val').map((f) => ({ itemId: f.id, classId: 'c_bbbbbbbb', x1: -5, y1: 0, x2: 1300, y2: 720, source: 'model', confidence: 0.9 })),
    { itemId: fixture[0].id, classId: 'c_gone', x1: 0, y1: 0, x2: 1, y2: 1, source: 'human', confidence: null },
  ];
  const prepared = prepareVersion(classes, items, annotations, { split: { train: 0.8, val: 0.2, test: 0 }, seed: 0, keepPrevious: false, includeAiLabeled: false });
  assert.ok(prepared.health.ok, JSON.stringify(prepared.health));
  assert.strictEqual(prepared.droppedBoxes, 1);
  assert.deepStrictEqual(prepared.classNames, ['car', 'truck']);
  const files = buildVersionFiles(prepared, { datasetId: 'ds-1', datasetName: 'Fixture', version: 3, createdAt: '2026-09-11T00:00:00.000Z' });
  assert.deepStrictEqual(files.coco.categories, [{ id: 0, name: 'car' }, { id: 1, name: 'truck' }]);
  assert.strictEqual(files.coco.images.length, 63);
  assert.strictEqual(files.coco.annotations.length, 63 + 12);
  const first = files.coco.annotations[0];
  assert.deepStrictEqual(first.bbox, [10, 20, 100, 60]);
  assert.strictEqual(first.category_id, 0);
  const clamped = files.coco.annotations.find((a) => a.category_id === 1)!;
  assert.deepStrictEqual(clamped.bbox, [0, 0, 1280, 720]);
  assert.strictEqual(clamped.source, 'model');
  assert.strictEqual(files.header.images, 63);
  assert.deepStrictEqual(files.header.splits, { train: 51, val: 12, test: 0 });
  assert.strictEqual(files.header.classes.length, files.coco.categories.length);
  assert.strictEqual(files.header.source.datasetId, 'ds-1');
  assert.strictEqual(files.coco.images[0].file_name, `images/${images[0].id}.jpg`);
  assert.deepStrictEqual(Object.keys(files.splits), Object.keys(files.splits).slice().sort());
  assert.strictEqual(Object.keys(files.splits).length, 63);

  // Keys and gating.
  const prefix = datasetVersionPrefix('ds-1', 3);
  assert.strictEqual(prefix, 'datasets/ds-1/versions/3/');
  assert.ok(isKeyUnder(prefix, `${prefix}dataset.json`));
  assert.ok(!isKeyUnder(prefix, `${prefix}../../ds-2/versions/1/dataset.json`));
  assert.ok(!isKeyUnder(prefix, 'datasets/ds-2/versions/3/dataset.json'));
  assert.ok(!isKeyUnder(prefix, prefix));
  assert.ok(!isKeyUnder(prefix, `${prefix}a//b`));
  const itemKey = datasetItemKey('ds-1', '9f9e0cf2-0000-4000-8000-0000000000aa', 'jpg');
  assert.deepStrictEqual(parseItemKey('ds-1', itemKey), { itemId: '9f9e0cf2-0000-4000-8000-0000000000aa', ext: 'jpg' });
  assert.strictEqual(parseItemKey('ds-2', itemKey), null);
  assert.strictEqual(parseItemKey('ds-1', 'datasets/ds-1/items/not-a-uuid.jpg'), null);
  assert.strictEqual(orgModelPrefix('org-1', 'detection', 'fixture-vehicles', 1), 'org-models/org-1/detection/fixture-vehicles/1/');
  assert.deepStrictEqual(modelRootsFor('org-1'), ['org-models/org-1/', 'models/']);
  assert.deepStrictEqual(modelRootsFor(null), ['models/']);

  // Dimensions from header bytes: a JPEG with an APP0 segment then SOF0, and a PNG IHDR.
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0 720x1280
    0xff, 0xda, 0x00, 0x02, // SOS
  ]);
  assert.deepStrictEqual(readImageDimensions(jpeg), { width: 1280, height: 720, format: 'jpeg' });
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepStrictEqual(readImageDimensions(png), { width: 640, height: 480, format: 'png' });
  assert.strictEqual(readImageDimensions(Buffer.from('<html>')), null);
  assert.strictEqual(readImageDimensions(jpeg.subarray(0, 12)), null);

  console.log('check 16 ok: models module (name rule = engine parser; class edits; split = forge splits.json 51/12/0 on 63 images; health; COCO/header/splits writers; key gating; JPEG/PNG dimensions; org-first roots)');
}


// --- 17. xorgate-models training module (M3) ---------------------------------------
// The two result documents are the forge's own committed examples
// (contracts/examples/result-train.json and result-autolabel.json at
// xorgate-model-forge 4a500a9), trimmed to what this service reads; the labels
// document is contracts/examples/autolabel-output.json with the platform's own
// item ids in place of the example's.
const FORGE_RESULT_TRAIN = {
  resultVersion: 1,
  jobId: 'tj_01J9X4M2K8',
  task: 'train',
  recipe: 'yolov8',
  status: 'succeeded',
  startedAt: '2026-09-12T14:10:02.000Z',
  endedAt: '2026-09-12T14:41:37.000Z',
  durationMs: 1895000,
  dataset: { classes: ['forklift', 'pallet'], images: { train: 330, val: 82, test: 0 }, instances: { forklift: 512, pallet: 903 } },
  base: { kind: 'pretrained', ref: 'yolov8n' },
  hyperparameters: { epochs: 50, imgsz: 640, batch: 16, patience: 10, seed: 0 },
  epochsCompleted: 37,
  metrics: {
    mAP50: 0.912,
    mAP50_95: 0.664,
    precision: 0.905,
    recall: 0.881,
    confidence: 0.35,
    perClass: [
      { name: 'forklift', mAP50: 0.951, precision: 0.93, recall: 0.92, instances: 96 },
      { name: 'pallet', mAP50: 0.873, precision: 0.88, recall: 0.84, instances: 181 },
    ],
  },
  model: { family: 'detection', name: 'yard-forklift', version: 2, dir: 'model/detection/yard-forklift/2' },
  check: {
    ok: true,
    lines: [
      'manifest   ok   detection/yard-forklift v2, yolov8, 2 classes, 640x640 nchw rgb',
      'model      ok   model.onnx 11.6 MB, sha256 recorded in manifest.json',
    ],
  },
  artifacts: {
    trainLog: 'train.log',
    weights: 'weights/best.pt',
    eval: { metrics: 'eval/metrics.json', confusion: 'eval/confusion.json', samples: ['eval/samples/0.jpg'] },
  },
  provenance: { orgId: 'cb1e1710-3ee5-49ad-b3d3-32b2290f6e19', datasetVersionId: 'dv_01J9X0B2R4' },
  error: null,
};

const FORGE_RESULT_AUTOLABEL = {
  resultVersion: 1,
  jobId: 'tj_01J9X5A1P0',
  task: 'autolabel',
  recipe: 'yolov8',
  status: 'succeeded',
  startedAt: '2026-09-10T16:01:35.089Z',
  endedAt: '2026-09-10T16:01:36.318Z',
  durationMs: 1229,
  dataset: { classes: ['car', 'truck'], images: { train: 51, val: 12, test: 0 }, instances: {} },
  artifacts: { labels: 'labels.json' },
  labels: { file: 'labels.json', images: 63, boxes: 108, perClass: { car: 92, truck: 16 }, unmapped: { train: 1 } },
  provenance: { orgId: 'cb1e1710-3ee5-49ad-b3d3-32b2290f6e19', datasetId: '6b1c1d8e-5f0a-4c1e-9a7d-2f3e4b5c6d7e' },
  error: null,
};

const FORGE_PROGRESS_JSONL = [
  '{"t":"status","at":"2026-09-12T14:10:02.000Z","status":"running","phase":"prepare"}',
  '{"t":"log","at":"2026-09-12T14:10:05.120Z","line":"materialized yolo layout: 330 train, 82 val images, 2 classes"}',
  '{"t":"status","at":"2026-09-12T14:10:06.000Z","status":"running","phase":"train"}',
  '{"t":"epoch","at":"2026-09-12T14:10:48.300Z","epoch":1,"epochs":50,"loss":2.314,"mAP50":0.102}',
  '{"t":"epoch","at":"2026-09-12T14:11:29.900Z","epoch":2,"epochs":50,"loss":1.871,"mAP50":0.318}',
  '{"t":"epoch","at":"2026-09-12T14:12:10.0', // a partial line, as a live sync leaves one
].join('\n');

function testTrainingModule(): void {
  const jobId = 'b4f3b974-e533-4653-a27e-40c3ee874ef9';
  const orgId = '1d2b4514-7408-4234-af5f-83b9451575ea';

  // Job names round-trip, and another stage's or another tool's name is refused.
  assert.strictEqual(sagemakerJobName('dev', jobId), `xorgate-forge-dev-${jobId}`);
  assert.strictEqual(jobIdFromSagemakerName('dev', `xorgate-forge-dev-${jobId}`), jobId);
  assert.strictEqual(jobIdFromSagemakerName('prod', `xorgate-forge-dev-${jobId}`), null);
  assert.strictEqual(jobIdFromSagemakerName('dev', 'pytorch-training-2026-09-12-20-00-00-000'), null);
  assert.strictEqual(jobIdFromSagemakerName('dev', 'xorgate-forge-dev-not-a-uuid'), null);
  assert.ok(sagemakerJobName('dev', jobId).length <= 63, 'SageMaker job names are at most 63 characters');

  // Guardrails (Q6).
  assert.strictEqual(instanceTypeError('cpu', 'ml.m5.xlarge'), null);
  assert.match(instanceTypeError('cpu', 'ml.p5.48xlarge') ?? '', /not allowed for the cpu target/);
  assert.match(instanceTypeError('gpu', 'ml.m5.xlarge') ?? '', /not allowed for the gpu target/);
  assert.strictEqual(instanceTypeError('gpu', 'ml.g4dn.xlarge'), null);
  assert.strictEqual(maxMinutesError(60), null);
  assert.match(maxMinutesError(241) ?? '', /at most 240/);
  assert.match(maxMinutesError(0) ?? '', /positive integer/);
  // The startup allowance never exceeds the job's own budget, so maxMinutes 1
  // asks SageMaker for a two-minute ceiling and not a twelve-minute one.
  assert.strictEqual(maxRuntimeSeconds(1), 120);
  assert.strictEqual(maxRuntimeSeconds(60), 60 * 60 + 600);
  assert.strictEqual(maxRuntimeSeconds(240), 240 * 60 + 600);

  // Job spec v1: the shape the forge's frozen schema describes.
  const trainSpec = buildTrainJobSpec({
    jobId,
    recipe: 'yolov8',
    output: { family: 'detection', name: 'fixture-vehicles', version: 2, label: 'Fixture vehicles v2' },
    base: { kind: 'pretrained', ref: 'yolov8n' },
    mode: 'fast',
    hyperparameters: { epochs: 3, imgsz: 320 },
    maxMinutes: 30,
    provenance: { orgId, datasetId: 'ds-1', datasetVersion: 1, datasetVersionId: 'dv-1', requestedBy: 'u-1' },
  });
  assert.deepStrictEqual(trainSpec.output, { family: 'detection', name: 'fixture-vehicles', version: 2, label: 'Fixture vehicles v2' });
  assert.deepStrictEqual(trainSpec.base, { kind: 'pretrained', ref: 'yolov8n', path: null });
  assert.deepStrictEqual(trainSpec.hyperparameters, { epochs: 3, imgsz: 320 });
  assert.deepStrictEqual(trainSpec.limits, { maxMinutes: 30 });
  assert.strictEqual(trainSpec.specVersion, 1);
  assert.strictEqual(trainSpec.task, 'train');
  assert.deepStrictEqual(trainSpec.provenance, {
    orgId,
    datasetId: 'ds-1',
    datasetVersion: 1,
    datasetVersionId: 'dv-1',
    requestedBy: 'u-1',
  });
  const autoSpec = buildAutolabelJobSpec({
    jobId,
    recipe: 'yolov8',
    model: { family: 'detection', name: 'yolov8n@1' },
    minConfidence: 0.4,
    classMap: { truck: 'lorry' },
    maxMinutes: 30,
    provenance: { orgId, datasetId: 'ds-1' },
  });
  assert.strictEqual(autoSpec.task, 'autolabel');
  assert.strictEqual(autoSpec.images, 'all');
  assert.deepStrictEqual(autoSpec.classMap, { truck: 'lorry' });
  // An empty classMap is omitted rather than written as {}: identity mapping.
  assert.strictEqual(
    'classMap' in buildAutolabelJobSpec({ jobId, recipe: 'yolov8', model: { family: 'detection', name: 'yolov8n' }, minConfidence: 0.4, classMap: {}, maxMinutes: 5, provenance: { orgId, datasetId: 'ds-1' } }),
    false,
  );

  // CreateTrainingJob: channels, output, checkpoints, stopping condition, spot,
  // isolation and tags, against the forge's own /opt/ml contract.
  const request = buildCreateTrainingJobRequest({
    stage: 'dev',
    jobId,
    orgId,
    bucket: 'xorgate-core-dev',
    imageUri: '111910761410.dkr.ecr.us-east-1.amazonaws.com/xorgate-model-forge-dev:0.1.0',
    roleArn: 'arn:aws:iam::111910761410:role/XorgateForgeExecutionRoleDev',
    target: 'cpu',
    instanceType: 'ml.m5.xlarge',
    spot: false,
    maxMinutes: 30,
    datasetPrefix: 'datasets/ds-1/versions/1/',
  });
  assert.strictEqual(request.TrainingJobName, `xorgate-forge-dev-${jobId}`);
  assert.deepStrictEqual(request.AlgorithmSpecification.ContainerEntrypoint, ['xmf']);
  assert.deepStrictEqual(request.AlgorithmSpecification.ContainerArguments, [
    'run',
    '/opt/ml/input/data/job/job.json',
    '--host',
    'sagemaker',
  ]);
  assert.deepStrictEqual(
    request.InputDataConfig.map((c) => [c.ChannelName, c.DataSource.S3DataSource.S3Uri]),
    [
      ['dataset', 's3://xorgate-core-dev/datasets/ds-1/versions/1/'],
      ['job', `s3://xorgate-core-dev/training/${jobId}/job/`],
    ],
  );
  // The job spec's own prefix holds nothing else, or the channel would sweep
  // in output/ and checkpoints/ as well.
  assert.strictEqual(jobSpecKey(jobId), `training/${jobId}/job/job.json`);
  assert.strictEqual(request.OutputDataConfig.S3OutputPath, `s3://xorgate-core-dev/training/${jobId}/output/`);
  assert.deepStrictEqual(request.CheckpointConfig, {
    S3Uri: `s3://xorgate-core-dev/training/${jobId}/checkpoints/`,
    LocalPath: '/opt/ml/checkpoints',
  });
  assert.strictEqual(request.StoppingCondition.MaxRuntimeInSeconds, 30 * 60 + 600);
  assert.strictEqual(request.StoppingCondition.MaxWaitTimeInSeconds, undefined);
  assert.strictEqual(request.EnableManagedSpotTraining, false);
  assert.strictEqual(request.EnableNetworkIsolation, true);
  assert.strictEqual(request.ResourceConfig.InstanceCount, 1);
  assert.deepStrictEqual(request.Tags.map((t) => t.Key).sort(), ['xorgate:jobId', 'xorgate:orgId', 'xorgate:stage']);
  const spotRequest = buildCreateTrainingJobRequest({
    stage: 'dev',
    jobId,
    orgId,
    bucket: 'b',
    imageUri: 'i',
    roleArn: 'r',
    target: 'gpu',
    instanceType: 'ml.g4dn.xlarge',
    spot: true,
    maxMinutes: 60,
    datasetPrefix: 'datasets/ds-1/versions/1/',
    modelsRoot: `org-models/${orgId}/`,
  });
  assert.strictEqual(spotRequest.EnableManagedSpotTraining, true);
  assert.strictEqual(spotRequest.StoppingCondition.MaxWaitTimeInSeconds, spotRequest.StoppingCondition.MaxRuntimeInSeconds);
  assert.strictEqual(spotRequest.InputDataConfig[2].ChannelName, 'models');
  assert.strictEqual(spotRequest.InputDataConfig[2].DataSource.S3DataSource.S3Uri, `s3://b/org-models/${orgId}/`);
  // An instance outside the allow-list never becomes a request.
  assert.throws(
    () =>
      buildCreateTrainingJobRequest({
        stage: 'dev',
        jobId,
        orgId,
        bucket: 'b',
        imageUri: 'i',
        roleArn: 'r',
        target: 'gpu',
        instanceType: 'ml.p4d.24xlarge',
        spot: true,
        maxMinutes: 60,
        datasetPrefix: 'p/',
      }),
    /not allowed for the gpu target/,
  );

  // Where SageMaker leaves the output tarball.
  assert.strictEqual(
    jobModelTarKey(jobId, `xorgate-forge-dev-${jobId}`),
    `training/${jobId}/output/xorgate-forge-dev-${jobId}/output/model.tar.gz`,
  );

  // Progress: the partial last line is counted, never thrown on.
  const progress = summarizeProgress(FORGE_PROGRESS_JSONL);
  assert.strictEqual(progress.skipped, 1);
  assert.strictEqual(progress.phase, 'train');
  assert.strictEqual(progress.epoch, 2);
  assert.strictEqual(progress.epochs, 50);
  assert.strictEqual(progress.lastEpochMap50, 0.318);
  assert.match(progress.lastLine ?? '', /materialized yolo layout/);
  assert.strictEqual(progress.lines.length, 5);

  // Result v1 parses, and the publish gate agrees with the requested identity.
  const trainResult = forgeResultSchema.parse(FORGE_RESULT_TRAIN);
  const requested = { family: 'detection', name: 'yard-forklift', version: 2 };
  const candidate = publishCandidate(trainResult, requested);
  assert.ok(candidate.ok, 'the example result should publish');
  assert.strictEqual(candidate.value.manifestPath, 'model/detection/yard-forklift/2/manifest.json');
  assert.strictEqual(candidate.value.onnxPath, 'model/detection/yard-forklift/2/model.onnx');
  const wrongName = publishCandidate(trainResult, { family: 'detection', name: 'other', version: 2 });
  assert.ok(!wrongName.ok && /the job asked for detection\/other v2/.test(wrongName.error));
  const failedCheck = publishCandidate({ ...trainResult, check: { ok: false, lines: ['model bad'] } }, requested);
  assert.ok(!failedCheck.ok && /own model check did not pass/.test(failedCheck.error));
  const noModel = publishCandidate({ ...trainResult, model: undefined }, requested);
  assert.ok(!noModel.ok && /no model block/.test(noModel.error));

  // Manifest identity and the sha256 of the bytes actually in the tar.
  const sha = 'a'.repeat(64);
  const manifest = { family: 'detection', name: 'yard-forklift', version: 2, files: { 'model.onnx': { sha256: sha, sizeBytes: 11 } } };
  assert.ok(checkManifestIdentity(manifest, requested, sha, 11).ok);
  const wrongSha = checkManifestIdentity(manifest, requested, 'b'.repeat(64), 11);
  assert.ok(!wrongSha.ok && /does not match manifest.json/.test(wrongSha.error));
  const wrongSize = checkManifestIdentity(manifest, requested, sha, 12);
  assert.ok(!wrongSize.ok && /12 bytes, manifest.json says 11/.test(wrongSize.error));
  const wrongIdentity = checkManifestIdentity({ ...manifest, version: 3 }, requested, sha, 11);
  assert.ok(!wrongIdentity.ok && /manifest.json says detection\/yard-forklift v3/.test(wrongIdentity.error));
  const noFiles = checkManifestIdentity({ family: 'detection', name: 'yard-forklift', version: 2 }, requested, sha, 11);
  assert.ok(!noFiles.ok && /no files\["model.onnx"\].sha256/.test(noFiles.error));

  // Result -> row columns, for both tasks and for a failure.
  const endedAt = new Date('2026-09-12T14:41:37.000Z');
  const trainUpdate = jobRowUpdateFromResult(trainResult, { endedAt, artifactPrefix: jobArtifactsPrefix(jobId) });
  assert.strictEqual(trainUpdate.status, 'succeeded');
  assert.strictEqual((trainUpdate.metrics as { mAP50: number }).mAP50, 0.912);
  assert.strictEqual((trainUpdate.metrics as { epochsCompleted: number }).epochsCompleted, 37);
  assert.strictEqual((trainUpdate.metrics as { confidence: number }).confidence, 0.35, 'the operating confidence rides into the row');
  const legacyUpdate = jobRowUpdateFromResult(
    forgeResultSchema.parse({ ...FORGE_RESULT_TRAIN, metrics: { ...FORGE_RESULT_TRAIN.metrics, confidence: undefined } }),
    { endedAt, artifactPrefix: jobArtifactsPrefix(jobId) },
  );
  assert.strictEqual((legacyUpdate.metrics as { confidence: number | null }).confidence, null, 'a 0.1.0 result (no confidence) still maps');
  assert.strictEqual((trainUpdate.artifacts as { prefix: string }).prefix, `training/${jobId}/artifacts/`);
  assert.strictEqual(trainUpdate.error, null);
  const autoUpdate = jobRowUpdateFromResult(forgeResultSchema.parse(FORGE_RESULT_AUTOLABEL), {
    endedAt,
    artifactPrefix: jobArtifactsPrefix(jobId),
  });
  assert.strictEqual(autoUpdate.status, 'succeeded');
  assert.strictEqual((autoUpdate.metrics as { labels: { boxes: number } }).labels.boxes, 108);
  const failedUpdate = jobRowUpdateFromResult(
    forgeResultSchema.parse({ ...FORGE_RESULT_TRAIN, status: 'failed', error: { phase: 'train', message: 'out of memory' } }),
    { endedAt, artifactPrefix: jobArtifactsPrefix(jobId) },
  );
  assert.strictEqual(failedUpdate.status, 'failed');
  assert.strictEqual(failedUpdate.error, 'train: out of memory');
  assert.strictEqual((failedUpdate.progress as { phase: string }).phase, 'train');

  // Labels file -> annotation rows. Boxes clamp into the image; an unknown
  // class and an image the dataset no longer holds are counted, not fatal.
  const itemA = '11111111-1111-4111-8111-111111111111';
  const itemB = '22222222-2222-4222-8222-222222222222';
  const gone = '33333333-3333-4333-8333-333333333333';
  const labels = forgeLabelsSchema.parse({
    labelsVersion: 1,
    jobId,
    model: { family: 'detection', name: 'yolov8n', version: 1 },
    minConfidence: 0.4,
    classMap: { truck: 'lorry' },
    images: [
      { id: itemA, boxes: [{ cls: 'car', modelCls: 'car', confidence: 0.71, xyxy: [-5, 10, 2000, 400] }] },
      { id: itemA, boxes: [] },
      { id: itemB, boxes: [{ cls: 'unicorn', modelCls: 'unicorn', confidence: 0.9, xyxy: [1, 1, 2, 2] }] },
      { id: gone, boxes: [{ cls: 'car', modelCls: 'car', confidence: 0.5, xyxy: [1, 1, 2, 2] }] },
    ],
    summary: { images: 4, boxes: 3, perClass: { car: 2 }, unmapped: {} },
  });
  const mapped = labelsToAnnotationRows(labels, {
    classIdByName: new Map([['car', 'c_car0000'], ['lorry', 'c_lorry000']]),
    itemSizeById: new Map([
      [itemA, { width: 1280, height: 720 }],
      [itemB, { width: 1280, height: 720 }],
    ]),
    sourceRef: 'detection/yolov8n@1',
  });
  assert.strictEqual(mapped.boxes, 1);
  assert.deepStrictEqual(mapped.labeledItemIds, [itemA]);
  assert.deepStrictEqual(mapped.unknownClasses, ['unicorn']);
  assert.deepStrictEqual(mapped.unknownImages, [gone]);
  assert.deepStrictEqual(
    { x1: mapped.rows[0].x1, y1: mapped.rows[0].y1, x2: mapped.rows[0].x2, y2: mapped.rows[0].y2 },
    { x1: 0, y1: 10, x2: 1280, y2: 400 },
  );
  assert.strictEqual(mapped.rows[0].source, 'model');
  assert.strictEqual(mapped.rows[0].sourceRef, 'detection/yolov8n@1');

  // The tar reader, against an archive tar(1) wrote (what SageMaker ships).
  const tarDir = mkdtempSync(path.join(tmpdir(), 'smoke-tar-'));
  try {
    const deep = path.join(tarDir, 'model', 'detection', 'fixture-vehicles', '1');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(tarDir, 'result.json'), JSON.stringify(FORGE_RESULT_TRAIN));
    writeFileSync(path.join(deep, 'model.onnx'), Buffer.from('onnx-bytes'));
    writeFileSync(path.join(deep, 'manifest.json'), JSON.stringify(manifest));
    const tgz = path.join(tarDir, 'model.tar.gz');
    // COPYFILE_DISABLE: macOS bsdtar otherwise adds an AppleDouble `._x`
    // entry next to every file, which is noise, not a reader problem.
    const res = spawnSync('tar', ['-czf', tgz, '-C', tarDir, 'result.json', 'model'], {
      encoding: 'utf8',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    assert.strictEqual(res.status, 0, `tar: ${res.stderr}`);
    const buf = gunzipSync(readFileSync(tgz));
    const entries = listTarEntries(buf).filter((e) => e.type === 'file');
    const names = entries.map((e) => e.name).sort();
    assert.deepStrictEqual(names, [
      'model/detection/fixture-vehicles/1/manifest.json',
      'model/detection/fixture-vehicles/1/model.onnx',
      'result.json',
    ]);
    const onnx = entries.find((e) => e.name.endsWith('model.onnx'))!;
    assert.strictEqual(tarEntryBytes(buf, onnx).toString('utf8'), 'onnx-bytes');
    const resultEntry = entries.find((e) => e.name === 'result.json')!;
    assert.strictEqual(forgeResultSchema.parse(JSON.parse(tarEntryBytes(buf, resultEntry).toString('utf8'))).jobId, 'tj_01J9X4M2K8');
    assert.strictEqual(isSafeTarPath('model/detection/x/1/model.onnx'), true);
    assert.strictEqual(isSafeTarPath('../escape'), false);
    assert.strictEqual(isSafeTarPath('/abs'), false);
  } finally {
    rmSync(tarDir, { recursive: true, force: true });
  }

  console.log(
    'check 17 ok: training module (job spec v1 builders; CreateTrainingJob channels/checkpoints/spot/isolation/tags + allow-list refusal; job-name round trip; progress tail with a partial line; publish gate + manifest identity and sha256 refusals; result -> row; labels -> annotation rows; tar reader over a real tar(1) archive)',
  );
}

async function main(): Promise<void> {
  testServedCatalog();
  testSchemaComposition();
  testFinalizeV2Mapping();
  await testProgressPlane();
  await testCloudHost();
  testPreflightAndRouting();
  testSimulationsModule();
  await testSessionLoop();
  testProductionDispatchModule();
  testCutoverRouting();
  testUpgradedCapabilities();
  await testSecretResolutionOrder();
  await testOrgCredentialsModule();
  testPackageHasNoCloudSdk();
  testLambdaBundleHasNoMqtt();
  testModelsModule();
  testTrainingModule();
  console.log(`\nplatform smoke: all checks passed; catalogVersion=${platformCatalogPayload.catalogVersion} nodes=${platformCatalogPayload.nodes.length}`);
}

main().catch((err) => {
  console.error('\nplatform smoke FAILED:', err);
  process.exit(1);
});

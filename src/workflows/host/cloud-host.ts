import { readFile } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  captureFormatsOf,
  runPrefix,
  teeArtifactSink,
  upgradeDefinition,
  type EngineBoundRun,
  type EngineHost,
  type EngineHostBindArgs,
  type EngineResult,
  type EngineSourceReader,
  type IotRunProgress,
  type MessageLevel,
  type ModelManifest,
  type ProgressTransport,
  type RunManifest,
  type TelemetrySample,
  type WorkflowDefinition,
} from '@xorgate/workflow-engine';
import { parseModelName } from '@xorgate/workflow-engine/local';
import { downloadModel, resolveModel } from '../models/store';
import { getNodeType } from '../catalog';
import {
  failureOutcome,
  iotAtsEndpoint,
  iotPublishTransport,
  manifestProgress,
  s3ArtifactSink,
  s3Client,
  s3FetchText,
  s3FetchVideo,
  secretsManagerReader,
  writeRunArtifacts,
} from './aws';
import { openIngestFrames } from './live-ingest';

/**
 * The platform's `EngineHost` (wf-engine-integration design §3.2): one factory,
 * two flavours, handed to `createEngine({ host, catalog: platformCatalog })`
 * by the Lambda handler (`target: 'lambda'`) and the Fargate runner
 * (`target: 'fargate'`). `bind()` assembles the four seams for one run over
 * S3, Secrets Manager and IoT, and `writeArtifacts` lands the frozen artifact
 * tree with `result.json` last. What differs per target is exactly what
 * differed before the package: the Lambda flavour reads telemetry history
 * through drizzle and fetches no media or models; the Fargate flavour
 * downloads media and models to `workDir`, opens the live webcam-ingest seam,
 * and has no telemetry store (its task role is DB-free by design).
 *
 * The engine emits `running` and the terminal status itself inside
 * `engine.run`; the host never does. The host keeps each run's progress sink
 * so the target can `flush()` the publish tail once the run resolves
 * (`takeProgress`).
 */

export type TelemetryReader = (query: {
  deviceId: string;
  metrics: string[];
  window: { fromMs: number; toMs: number };
}) => Promise<TelemetrySample[]>;

export type ModelCache = Map<string, Promise<{ manifest: ModelManifest; modelPath: string }>>;

export interface CloudHostOptions {
  /** The run bucket (manifests, artifacts, uploads, the model registry). */
  bucket: string;
  target: 'lambda' | 'fargate';
  /** Fargate: where downloaded media and models land (a mkdtemp per task). */
  workDir?: string;
  /** Lambda: the drizzle-backed history reader. Absent on Fargate (the seam throws). */
  telemetry?: TelemetryReader;
  /** Fargate: open the webcam-ingest seam (MQTT over WSS) for runs with a progress block. */
  liveIngest?: boolean;
  /** Fargate warm session: the per-(family, name@version) model cache that outlives one job. */
  modelCache?: ModelCache;
  /** Progress publish transport. Default: IoT Data ATS publish; the smoke injects memory. */
  progressTransport?: ProgressTransport;
  log?: (message: string, level?: MessageLevel) => void;
  /**
   * TEST ONLY (the conformance run against the dev bucket, plan M3): when
   * set, `fetchText` and `fetchVideo` read an ABSOLUTE local path as is
   * instead of an S3 key. The deployed targets assert it is unset.
   */
  localInputs?: boolean;
}

export interface CloudHost extends EngineHost {
  readonly options: Readonly<CloudHostOptions>;
  /** The progress sink `bind` created for `runId` (if the manifest asked for one); removed on take. */
  takeProgress(runId: string): IotRunProgress | undefined;
  /** The per-(family, name@version) model cache; persists across warm-session jobs. */
  readonly modelCache: ModelCache;
}

export function cloudHost(options: CloudHostOptions): CloudHost {
  const { bucket, target } = options;
  const log = options.log ?? ((m: string) => console.log(`cloud-host: ${m}`));
  const transport = options.progressTransport ?? iotPublishTransport;
  const modelCache: ModelCache = options.modelCache ?? new Map();
  const progressByRun = new Map<string, IotRunProgress>();
  const workDir = options.workDir;
  const localInputs = options.localInputs === true;
  let videoSeq = 0;

  const isLocalInput = (key: string): boolean => localInputs && path.isAbsolute(key);

  function sources(manifest: RunManifest): EngineSourceReader {
    const base: EngineSourceReader = {
      async readTelemetryWindow(query) {
        if (options.telemetry) return options.telemetry(query);
        // Open seam by design: the media target has no DB credentials.
        throw new Error(
          'Device telemetry history is not available on the media engine target; use an inline/CSV binding or a telemetry-only (Lambda) graph',
        );
      },
      // `bucket` on the ref is the run's output bucket when the binding names none.
      async fetchText({ bucket: refBucket, key }) {
        if (isLocalInput(key)) return readFile(key, 'utf8');
        return s3FetchText(refBucket ?? bucket, key);
      },
    };
    if (target !== 'fargate') return base;
    if (!workDir) throw new Error('cloudHost: the fargate flavour needs a workDir for media and models');
    return {
      ...base,
      async fetchVideo({ bucket: refBucket, key }) {
        if (isLocalInput(key)) return { path: key };
        const localPath = path.join(workDir, `input-${videoSeq++}${path.extname(key) || '.mp4'}`);
        await s3FetchVideo(refBucket ?? bucket, key, localPath);
        log(`fetched video s3://${refBucket ?? bucket}/${key} -> ${localPath}`);
        return { path: localPath };
      },
      // Called by video.decode_sample once a `releasable` segment is decoded. A
      // long on-device session is ~60 segments (~1.5 GB+); without this they all
      // sit on the task disk until it exits. Best-effort by design: a failed
      // unlink must never fail the run. Never touches caller-owned files.
      async releaseVideo(localPath: string) {
        if (path.dirname(localPath) !== workDir) return;
        await unlink(localPath).catch(() => {});
      },
      // `name` may carry a version pin (`yolov8n@2`, the package's model-ref
      // rule); the registry resolves it, else the newest version. Cached per
      // (family, name@version) for the host's lifetime, so a warm session's
      // second job skips the download.
      fetchModel({ family, name }) {
        const ref = parseModelName(family, name);
        const cacheKey = `${ref.family}/${ref.name}@${ref.version ?? 'latest'}`;
        let entry = modelCache.get(cacheKey);
        if (!entry) {
          entry = (async () => {
            const manifest = await resolveModel(s3Client(), bucket, ref.family, ref.name, ref.version);
            const modelPath = await downloadModel(s3Client(), bucket, manifest, workDir);
            log(`fetched model ${ref.family}/${ref.name} v${manifest.version} -> ${modelPath}`);
            return { manifest, modelPath };
          })();
          entry.catch(() => modelCache.delete(cacheKey));
          modelCache.set(cacheKey, entry);
        }
        return entry;
      },
      ...(options.liveIngest && manifest.progress?.topicPrefix
        ? { openLiveFrames: liveFrames(manifest.progress.topicPrefix) }
        : {}),
    };
  }

  // The live webcam-ingest seam for one run. The ingest topic derives from
  // the run's progress topic prefix, so live bindings only work on runs that
  // carry a progress block (all simulations do).
  function liveFrames(topicPrefix: string): NonNullable<EngineSourceReader['openLiveFrames']> {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const credentials = fromNodeProviderChain();
    return (ref) =>
      (async function* frames() {
        const endpoint = await iotAtsEndpoint();
        yield* openIngestFrames({
          endpoint,
          region,
          credentials: () => credentials(),
          topicPrefix,
          nodeId: ref.nodeId,
          maxDurationMs: ref.maxDurationMs,
          idleTimeoutMs: ref.idleTimeoutMs,
          log: (m) => log(m),
        });
      })();
  }

  return {
    options,
    modelCache,
    takeProgress(runId: string) {
      const progress = progressByRun.get(runId);
      progressByRun.delete(runId);
      return progress;
    },
    bind(args: EngineHostBindArgs): EngineBoundRun {
      const { runId, manifest } = args;
      // Live progress: only when the manifest asks for it (every simulation
      // and production run today). Visualization JPEGs tee into the preview
      // topic, downscaled, through the package's sink tee.
      const progress = manifestProgress(manifest, (m) => log(m), transport);
      if (progress) progressByRun.set(runId, progress);
      const artifacts = s3ArtifactSink(bucket, runId);
      return {
        runDir: `s3://${bucket}/${runPrefix(runId)}`,
        sources: sources(manifest),
        artifacts: progress ? teeArtifactSink(artifacts, progress) : artifacts,
        // M7: org credentials win over platform secrets when the manifest
        // names the owning org.
        secrets: secretsManagerReader(manifest.orgId ?? null),
        ...(progress ? { progress } : {}),
        writeArtifacts: (outcome, formats) => writeRunArtifacts(bucket, runId, outcome, formats),
      };
    },
  };
}

export interface PreflightRefusal {
  nodeId: string;
  error: string;
}

/**
 * The pre-flight check both targets run before `engine.run`: every node type
 * must be in the platform catalog, and the Lambda target refuses what only the
 * Fargate image can execute (media nodes need ffmpeg and ONNX Runtime; code
 * function nodes need python3 and the package's runner sandbox, so every
 * graph with a `function` group node routes to Fargate, design §3.3). Returns
 * the first refusal, or null when the graph may run here.
 */
export function preflightRefusal(
  definition: WorkflowDefinition,
  target: 'lambda' | 'fargate',
): PreflightRefusal | null {
  for (const node of definition.nodes) {
    const typeDef = getNodeType(node.type);
    if (!typeDef) return { nodeId: node.id, error: `Unknown node type "${node.type}"` };
    if (target === 'lambda' && typeDef.runtime.target === 'media') {
      return {
        nodeId: node.id,
        error: `Node type "${node.type}" needs the media engine target; this run was misrouted to Lambda`,
      };
    }
    if (target === 'lambda' && typeDef.group === 'function') {
      return {
        nodeId: node.id,
        error: `Node type "${node.type}" needs the Fargate engine target (code function sandbox); this run was misrouted to Lambda`,
      };
    }
  }
  return null;
}

/**
 * Lands a refused run exactly as a failed engine run would: the host binds
 * (so the progress sink exists), the status stream carries `running` then
 * `failed`, `result.json` is written last through the same `writeArtifacts`,
 * and the publish tail is flushed. Returns the parsed result.
 */
export async function writeRefusal(
  host: CloudHost,
  manifest: RunManifest,
  refusal: PreflightRefusal,
): Promise<EngineResult> {
  const definition = upgradeDefinition(manifest.definition);
  const bindings = Object.fromEntries(manifest.inputs.map((i) => [i.nodeId, i.binding]));
  const bound = await host.bind({ runId: manifest.runId, manifest, bindings, emitVideo: false });
  const outcome = failureOutcome(definition.nodes.length, refusal.nodeId, refusal.error);
  bound.progress?.runStatus({ status: 'running' });
  const result = await bound.writeArtifacts(outcome, captureFormatsOf(definition));
  bound.progress?.runStatus({ status: 'failed', error: outcome.error, failedNodeId: outcome.failedNodeId });
  await host.takeProgress(manifest.runId)?.flush();
  return result;
}

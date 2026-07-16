import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { EngineSourceReader } from '../src/workflows/catalog/types';
import type { ModelManifest } from '../src/workflows/models/registry';
import { downloadModel, resolveLatestModel } from '../src/workflows/models/store';
import { runGraph, type EngineRunOutcome } from '../src/workflows/engine/index';
import { manifestKey, V2_RUN_PREFIX, type RunManifest } from '../src/workflows/engine/manifest';
import {
  captureFormats,
  failureOutcome,
  iotAtsEndpoint,
  loadRunManifest,
  manifestProgress,
  s3ArtifactSink,
  s3FetchText,
  secretsManagerReader,
  writeRunArtifacts,
} from '../src/workflows/engine/target';
import { openIngestFrames } from '../src/workflows/engine/live-ingest';
import { runSessionLoop } from '../src/workflows/engine/session';
import { teeArtifactSink, type IotRunProgress } from '../src/workflows/engine/progress';
import { upgradeDefinition } from '../src/workflows/compat';

/**
 * Fargate target of the v2 TS engine (replaces the Python cv-runner at the M6
 * cutover). Two launch modes:
 *
 * SINGLE-RUN (the frozen cv-runner contract): env RUN_ID / MANIFEST_BUCKET /
 * MANIFEST_KEY / AWS_REGION. Manifest in from S3, artifacts + result.json out
 * to S3; result.json is written on EVERY exit path so a failed run never
 * strands as "running". Exit 0 even on run failure (the result carries the
 * status); only a failed result upload exits nonzero.
 *
 * WARM SESSION (M5, architecture §5): env ENGINE_SESSION_QUEUE_URL +
 * MANIFEST_BUCKET (+ AWS_REGION, optional ENGINE_SESSION_IDLE_SECONDS). The
 * task long-polls its per-editing-session SQS queue for { runId } jobs, runs
 * each exactly like a single run (manifest key derives from the runId), and
 * exits 0 after the idle timeout. Sources (and their per-(family,name) model
 * cache) persist across jobs, so a rerun skips the model download AND the
 * container cold start.
 *
 * Runs the SAME runGraph as the Lambda handler through the shared target
 * module. Container-specific: S3 video download, model-registry resolution,
 * the S3 frame-artifact sink, the live webcam-ingest seam (MQTT), and NO
 * telemetry store (the task role has no DB access by design).
 */

const s3 = new S3Client({});
const DEFAULT_MAX_RUNTIME_SECONDS = 1800; // mirrors the cv-runner's hard cap
const DEFAULT_SESSION_IDLE_SECONDS = 600; // architecture §5: ~10 min idle-out
const SESSION_POLL_WAIT_SECONDS = 20;

function log(msg: string): void {
  console.log(`[engine-runner] ${msg}`);
}

/** workflows/v2/runs/<runId>/manifest.json -> <runId>, for the no-RUN_ID fallback. */
function runIdFromManifestKey(key: string): string | null {
  if (!key.startsWith(V2_RUN_PREFIX)) return null;
  const rest = key.slice(V2_RUN_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
}

function buildSources(bucket: string, workDir: string): EngineSourceReader {
  let videoSeq = 0;
  const modelCache = new Map<string, Promise<{ manifest: ModelManifest; modelPath: string }>>();
  return {
    async readTelemetryWindow() {
      // Open seam (STATUS): the media target has no DB credentials by design.
      throw new Error(
        'Device telemetry history is not available on the media engine target; use an inline/CSV binding or a telemetry-only (Lambda) graph',
      );
    },
    async fetchText({ bucket: refBucket, key }) {
      return s3FetchText(refBucket ?? bucket, key);
    },
    async fetchVideo({ bucket: refBucket, key }) {
      const localPath = path.join(workDir, `input-${videoSeq++}${path.extname(key) || '.mp4'}`);
      const res = await s3.send(
        new GetObjectCommand({ Bucket: refBucket ?? bucket, Key: key }),
      );
      if (!res.Body) throw new Error(`Empty video object at s3://${refBucket ?? bucket}/${key}`);
      await pipeline(res.Body as Readable, createWriteStream(localPath));
      log(`fetched video s3://${refBucket ?? bucket}/${key} -> ${localPath}`);
      return { path: localPath };
    },
    fetchModel({ family, name }) {
      const cacheKey = `${family}/${name}`;
      let entry = modelCache.get(cacheKey);
      if (!entry) {
        entry = (async () => {
          const manifest = await resolveLatestModel(s3, bucket, family, name);
          const modelPath = await downloadModel(s3, bucket, manifest, workDir);
          log(`fetched model ${family}/${name} v${manifest.version} -> ${modelPath}`);
          return { manifest, modelPath };
        })();
        modelCache.set(cacheKey, entry);
      }
      return entry;
    },
  };
}

/**
 * Wraps the shared sources with the live webcam-ingest seam for one run. The
 * ingest topic derives from the run's progress topic prefix, so live bindings
 * only work on runs that carry a progress block (all simulations do).
 */
function withLiveIngest(base: EngineSourceReader, manifest: RunManifest): EngineSourceReader {
  const topicPrefix = manifest.progress?.topicPrefix;
  if (!topicPrefix) return base;
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const credentials = fromNodeProviderChain();
  return {
    ...base,
    openLiveFrames(ref) {
      return (async function* liveFrames() {
        const endpoint = await iotAtsEndpoint();
        yield* openIngestFrames({
          endpoint,
          region,
          credentials: () => credentials(),
          topicPrefix,
          nodeId: ref.nodeId,
          maxDurationMs: ref.maxDurationMs,
          idleTimeoutMs: ref.idleTimeoutMs,
          log,
        });
      })();
    },
  };
}

/**
 * Executes one run end to end: manifest in, graph, artifacts + result.json
 * out, final progress publish. Never throws for run-level failures (the
 * result carries them); returns false only when result.json could not be
 * written (the caller decides whether that is fatal for the process).
 */
async function executeRun(args: {
  bucket: string;
  manifestKey: string;
  envRunId: string;
  sources: EngineSourceReader;
}): Promise<boolean> {
  const { bucket } = args;
  let manifest: RunManifest | null = null;
  let outcome: EngineRunOutcome;
  let formats: Record<string, 'jsonl' | 'json'> = {};
  let progress: IotRunProgress | null = null;
  try {
    manifest = await loadRunManifest(bucket, args.manifestKey);
    const definition = upgradeDefinition(manifest.definition);
    formats = captureFormats(definition);
    // Live progress (M3 simulations): only when the manifest asks for it.
    // Visualization JPEGs tee into the preview topic, downscaled.
    progress = manifestProgress(manifest, log);
    progress?.runStatus({ status: 'running' });
    const artifacts = s3ArtifactSink(bucket, manifest.runId);
    outcome = await runGraph(
      {
        runId: manifest.runId,
        mode: manifest.mode,
        deviceId: manifest.deviceId,
        window: manifest.window
          ? { fromMs: Date.parse(manifest.window.from), toMs: Date.parse(manifest.window.to) }
          : null,
        definition,
        bindings: Object.fromEntries(manifest.inputs.map((i) => [i.nodeId, i.binding])),
      },
      {
        sources: withLiveIngest(args.sources, manifest),
        artifacts: progress ? teeArtifactSink(artifacts, progress) : artifacts,
        // M7: org credentials win over platform secrets when the manifest
        // names the owning org.
        secrets: secretsManagerReader(manifest.orgId ?? null),
        ...(progress ? { progress } : {}),
        deadlineMs: (manifest.limits.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS) * 1000,
        log,
      },
    );
  } catch (err) {
    // Unreadable manifest or an engine-level crash: still land a result.json.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[engine-runner] run error: ${message}`);
    outcome = failureOutcome(manifest?.definition.nodes.length ?? 0, null, message);
  }

  const resolvedRunId = manifest?.runId || args.envRunId || runIdFromManifestKey(args.manifestKey) || '';
  if (!resolvedRunId) {
    console.error('[engine-runner] FATAL: no runId (env, manifest, or key path); cannot write result.json');
    return false;
  }
  try {
    const result = await writeRunArtifacts(bucket, resolvedRunId, outcome, formats);
    log(
      `result status=${result.status} steps=${result.steps.length} events=${result.events.length} -> s3://${bucket}/workflows/v2/runs/${resolvedRunId}/result.json`,
    );
  } catch (err) {
    console.error(`[engine-runner] FATAL: failed to upload result.json: ${String(err)}`);
    return false;
  }
  // Final status after artifacts are durable; progress errors never fail the task.
  if (progress) {
    try {
      progress.runStatus({ status: outcome.status, error: outcome.error, failedNodeId: outcome.failedNodeId });
      await progress.flush();
    } catch (err) {
      console.error(`[engine-runner] progress flush failed: ${String(err)}`);
    }
  }
  return true;
}

/** WARM SESSION mode: poll the per-session queue until the idle timeout. */
async function sessionMain(queueUrl: string, bucket: string): Promise<number> {
  const sqs = new SQSClient({});
  const idleSeconds = Number(process.env.ENGINE_SESSION_IDLE_SECONDS) || DEFAULT_SESSION_IDLE_SECONDS;
  const workDir = await mkdtemp(path.join(tmpdir(), 'engine-session-'));
  const sources = buildSources(bucket, workDir); // model cache persists across jobs
  log(`warm session start queue=${queueUrl} idle=${idleSeconds}s`);

  const outcome = await runSessionLoop({
    idleTimeoutMs: idleSeconds * 1000,
    log,
    receive: async () => {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: SESSION_POLL_WAIT_SECONDS,
        }),
      );
      const msg = res.Messages?.[0];
      if (!msg?.Body) return null;
      // Delete on receipt: a run whose execution crashes is covered by the
      // watchdog (it always is), and redelivering it to a later session task
      // would re-run a run the watchdog already failed.
      if (msg.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
      }
      try {
        const body = JSON.parse(msg.Body) as { runId?: string };
        if (typeof body.runId === 'string' && body.runId.length > 0) return { runId: body.runId };
      } catch {
        // fall through
      }
      log(`ignoring malformed session message: ${msg.Body.slice(0, 200)}`);
      return null;
    },
    runJob: async (job) => {
      const ok = await executeRun({
        bucket,
        manifestKey: manifestKey(job.runId),
        envRunId: job.runId,
        sources,
      });
      if (!ok) throw new Error('result.json upload failed');
    },
  });
  log(`warm session end: ${outcome.jobsRun} job(s), ${outcome.jobFailures} failure(s)`);
  return 0;
}

async function main(): Promise<number> {
  const bucket = process.env.MANIFEST_BUCKET || '';
  const sessionQueueUrl = process.env.ENGINE_SESSION_QUEUE_URL || '';
  if (!bucket) {
    console.error('[engine-runner] FATAL: MANIFEST_BUCKET is required');
    return 1;
  }
  if (sessionQueueUrl) return sessionMain(sessionQueueUrl, bucket);

  const envRunId = process.env.RUN_ID || '';
  const key = process.env.MANIFEST_KEY || '';
  log(`start run_id=${envRunId} manifest=s3://${bucket}/${key}`);
  if (!key) {
    console.error('[engine-runner] FATAL: MANIFEST_KEY is required');
    return 1;
  }
  const workDir = await mkdtemp(path.join(tmpdir(), 'engine-runner-'));
  const ok = await executeRun({
    bucket,
    manifestKey: key,
    envRunId,
    sources: buildSources(bucket, workDir),
  });
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[engine-runner] FATAL: unhandled error', err);
    process.exit(1);
  },
);

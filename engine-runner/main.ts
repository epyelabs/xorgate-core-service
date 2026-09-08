import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  createEngine,
  manifestKey,
  upgradeDefinition,
  V2_RUN_PREFIX,
  type EngineResult,
  type RunManifest,
} from '@xorgate/workflow-engine';
import { platformCatalog } from '../src/workflows/catalog';
import { failureOutcome, iotAtsEndpoint, loadRunManifest, writeRunArtifacts } from '../src/workflows/host/aws';
import {
  cloudHost,
  preflightRefusal,
  writeRefusal,
  type CloudHost,
  type LiveIngestOpener,
} from '../src/workflows/host/cloud-host';
import { openIngestFrames } from '../src/workflows/host/live-ingest';
import { runSessionLoop } from '../src/workflows/host/session';

/**
 * Fargate target of the workflow engine. Two launch modes:
 *
 * SINGLE-RUN (the frozen contract): env RUN_ID / MANIFEST_BUCKET /
 * MANIFEST_KEY / AWS_REGION. Manifest in from S3, artifacts + result.json out
 * to S3; result.json is written on EVERY exit path so a failed run never
 * strands as "running". Exit 0 even on run failure (the result carries the
 * status); only a failed result upload exits nonzero.
 *
 * WARM SESSION (M5, architecture §5): env ENGINE_SESSION_QUEUE_URL +
 * MANIFEST_BUCKET (+ AWS_REGION, optional ENGINE_SESSION_IDLE_SECONDS). The
 * task long-polls its per-editing-session SQS queue for { runId } jobs, runs
 * each exactly like a single run (manifest key derives from the runId), and
 * exits 0 after the idle timeout. The host (and its per-model cache) persists
 * across jobs, so a rerun skips the model download AND the container cold
 * start.
 *
 * Runs the SAME engine as the Lambda handler: `@xorgate/workflow-engine`
 * over the platform's cloud host (src/workflows/host/cloud-host.ts), fargate
 * flavour: S3 video download, model-registry resolution, the S3 frame sink,
 * the live webcam-ingest seam (MQTT), the code function sandbox (node +
 * python3 in this image), and NO telemetry store (the task role has no DB
 * access by design).
 */

const DEFAULT_MAX_RUNTIME_SECONDS = 1800; // the production media cap
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

// The live webcam-ingest seam (M5): MQTT over WSS with a SigV4-presigned URL
// from the task role's credentials. Wired here, not in the host, so `mqtt`
// stays out of every Lambda bundle (cloud-host.ts header).
const liveIngest: LiveIngestOpener = (args) => {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const credentials = fromNodeProviderChain();
  return (async function* liveFrames() {
    const endpoint = await iotAtsEndpoint();
    yield* openIngestFrames({ endpoint, region, credentials: () => credentials(), ...args });
  })();
};

function buildHost(bucket: string, workDir: string): CloudHost {
  const host = cloudHost({ bucket, target: 'fargate', workDir, liveIngest, log: (m) => log(m) });
  if (host.options.localInputs) throw new Error('localInputs is a test-only host option');
  return host;
}

/**
 * Executes one run end to end: manifest in, pre-flight, graph, artifacts +
 * result.json out, final progress publish. Never throws for run-level
 * failures (the result carries them); returns false only when result.json
 * could not be written (the caller decides whether that is fatal for the
 * process).
 */
async function executeRun(args: {
  host: CloudHost;
  bucket: string;
  manifestKey: string;
  envRunId: string;
}): Promise<boolean> {
  const { bucket, host } = args;
  let manifest: RunManifest | null = null;
  let result: EngineResult | null = null;
  let crash: string | null = null;
  try {
    manifest = await loadRunManifest(bucket, args.manifestKey);
    const definition = upgradeDefinition(manifest.definition);
    const refusal = preflightRefusal(definition, 'fargate');
    if (refusal) {
      result = await writeRefusal(host, manifest, refusal);
      log(`run refused: ${refusal.error}`);
    } else {
      // The engine validates the manifest, binds the host, emits `running`,
      // runs the graph, writes the artifact tree (result.json last) and emits
      // the terminal status; an engine-level throw becomes a failed result.
      const engine = createEngine({
        host,
        catalog: platformCatalog,
        log: (m, level) => log(`[${level}] ${m}`),
      });
      try {
        result = (
          await engine.run({
            manifest,
            runId: manifest.runId,
            deadlineMs: (manifest.limits.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS) * 1000,
          })
        ).result;
      } finally {
        // Progress errors never fail the task.
        await host.takeProgress(manifest.runId)?.flush().catch((err) => {
          console.error(`[engine-runner] progress flush failed: ${String(err)}`);
        });
      }
    }
  } catch (err) {
    // Unreadable manifest, a host bind failure or a failed artifact write:
    // still land a result.json below.
    crash = err instanceof Error ? err.message : String(err);
    console.error(`[engine-runner] run error: ${crash}`);
  }

  if (result) {
    log(
      `result status=${result.status} steps=${result.steps.length} events=${result.events.length} -> s3://${bucket}/${V2_RUN_PREFIX}${manifest?.runId}/result.json`,
    );
    return true;
  }

  const resolvedRunId = manifest?.runId || args.envRunId || runIdFromManifestKey(args.manifestKey) || '';
  if (!resolvedRunId) {
    console.error('[engine-runner] FATAL: no runId (env, manifest, or key path); cannot write result.json');
    return false;
  }
  try {
    const failed = await writeRunArtifacts(
      bucket,
      resolvedRunId,
      failureOutcome(manifest?.definition.nodes.length ?? 0, null, crash ?? 'engine produced no result'),
    );
    log(`result status=${failed.status} (crash path) -> s3://${bucket}/${V2_RUN_PREFIX}${resolvedRunId}/result.json`);
  } catch (err) {
    console.error(`[engine-runner] FATAL: failed to upload result.json: ${String(err)}`);
    return false;
  }
  return true;
}

/** WARM SESSION mode: poll the per-session queue until the idle timeout. */
async function sessionMain(queueUrl: string, bucket: string): Promise<number> {
  const sqs = new SQSClient({});
  const idleSeconds = Number(process.env.ENGINE_SESSION_IDLE_SECONDS) || DEFAULT_SESSION_IDLE_SECONDS;
  const workDir = await mkdtemp(path.join(tmpdir(), 'engine-session-'));
  const host = buildHost(bucket, workDir); // model cache persists across jobs
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
        host,
        bucket,
        manifestKey: manifestKey(job.runId),
        envRunId: job.runId,
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
    host: buildHost(bucket, workDir),
    bucket,
    manifestKey: key,
    envRunId,
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

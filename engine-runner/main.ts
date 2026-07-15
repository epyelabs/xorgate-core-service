import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EngineSourceReader } from '../src/workflows/catalog/types';
import type { ModelManifest } from '../src/workflows/models/registry';
import { downloadModel, resolveLatestModel } from '../src/workflows/models/store';
import { runGraph, type EngineRunOutcome } from '../src/workflows/engine/index';
import { V2_RUN_PREFIX, type RunManifest } from '../src/workflows/engine/manifest';
import {
  captureFormats,
  failureOutcome,
  loadRunManifest,
  s3ArtifactSink,
  writeRunArtifacts,
} from '../src/workflows/engine/target';
import { upgradeDefinition } from '../src/workflows/compat';

/**
 * Fargate target of the v2 TS engine (replaces the Python cv-runner at the M6
 * cutover). Same contract as the cv-runner task: env RUN_ID / MANIFEST_BUCKET /
 * MANIFEST_KEY / AWS_REGION, manifest in from S3, artifacts + result.json out
 * to S3, and result.json is written on EVERY exit path so a failed run never
 * strands as "running". Exit 0 even on run failure (the result carries the
 * status); only a failed result upload exits nonzero.
 *
 * Runs the SAME runGraph as the Lambda handler (src/handlers/workflow-engine.ts)
 * through the shared target module (src/workflows/engine/target.ts). What is
 * container-specific: S3 video download, model-registry resolution, the S3
 * frame-artifact sink, and NO telemetry store (the task role has no DB access;
 * a media graph that needs device telemetry history fails that source).
 */

const s3 = new S3Client({});
const DEFAULT_MAX_RUNTIME_SECONDS = 1800; // mirrors the cv-runner's hard cap

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

async function main(): Promise<number> {
  const envRunId = process.env.RUN_ID || '';
  const bucket = process.env.MANIFEST_BUCKET || '';
  const manifestKey = process.env.MANIFEST_KEY || '';
  log(`start run_id=${envRunId} manifest=s3://${bucket}/${manifestKey}`);
  if (!bucket || !manifestKey) {
    console.error('[engine-runner] FATAL: MANIFEST_BUCKET and MANIFEST_KEY are required');
    return 1;
  }

  let manifest: RunManifest | null = null;
  let outcome: EngineRunOutcome;
  let formats: Record<string, 'jsonl' | 'json'> = {};
  try {
    manifest = await loadRunManifest(bucket, manifestKey);
    const definition = upgradeDefinition(manifest.definition);
    formats = captureFormats(definition);
    const workDir = await mkdtemp(path.join(tmpdir(), 'engine-runner-'));
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
        sources: buildSources(bucket, workDir),
        artifacts: s3ArtifactSink(bucket, manifest.runId),
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

  const runId = manifest?.runId ?? envRunId ?? '';
  const resolvedRunId = runId || runIdFromManifestKey(manifestKey) || '';
  if (!resolvedRunId) {
    console.error('[engine-runner] FATAL: no runId (env, manifest, or key path); cannot write result.json');
    return 1;
  }
  try {
    const result = await writeRunArtifacts(bucket, resolvedRunId, outcome, formats);
    log(
      `result status=${result.status} steps=${result.steps.length} events=${result.events.length} -> s3://${bucket}/workflows/v2/runs/${resolvedRunId}/result.json`,
    );
  } catch (err) {
    console.error(`[engine-runner] FATAL: failed to upload result.json: ${String(err)}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[engine-runner] FATAL: unhandled error', err);
    process.exit(1);
  },
);

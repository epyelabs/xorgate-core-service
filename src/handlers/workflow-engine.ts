import { readTelemetryWindow } from '../services/telemetry-window';
import { getNodeType } from '../workflows/catalog/index';
import type { EngineSourceReader } from '../workflows/catalog/types';
import { runGraph, type EngineRunOutcome } from '../workflows/engine/index';
import { manifestKey, resultKey, type RunManifest } from '../workflows/engine/manifest';
import {
  captureFormats,
  failureOutcome,
  loadRunManifest,
  manifestProgress,
  s3FetchText,
  secretsManagerReader,
  writeRunArtifacts,
} from '../workflows/engine/target';
import { upgradeDefinition } from '../workflows/compat';

/**
 * Lambda target of the v2 TS engine: telemetry-only batch graphs (architecture
 * §4.1). Direct-invoked with { runId } (or an explicit bucket/manifestKey);
 * reads workflows/v2/runs/<runId>/manifest.json, streams the graph in-process,
 * and writes events.jsonl / outputs/<nodeId>/records.jsonl / result.json back
 * under the same prefix (manifest-load and artifact-write halves shared with
 * the Fargate container main via workflows/engine/target.ts). result.json is
 * ALWAYS written, even on failure, so the finalize path is the single place
 * run status is resolved.
 *
 * The engine core is storage-free; this handler supplies the one sanctioned
 * seam: telemetry history reads from telemetry_readings via drizzle. Media
 * graphs (any node with runtime.target === "media") are refused here and
 * belong to the Fargate engine target (engine-runner/).
 *
 * Routed to by BOTH dispatch paths since M6: the simulations handler (direct
 * invoke) and the SQS production dispatcher (every triggered telemetry-only
 * run; media runs go to the Fargate engine-runner instead).
 */

const BUCKET = process.env.BUCKET_NAME;

const DEFAULT_MAX_RUNTIME_SECONDS = 240; // < the Lambda timeout, so the engine fails runs itself

export interface WorkflowEngineEvent {
  runId?: string;
  bucket?: string;
  manifestKey?: string;
}

// `bucket` is the run's output bucket: CSV uploads default to it when the
// binding names no bucket.
const telemetrySources = (bucket: string): EngineSourceReader => ({
  async fetchText({ bucket: refBucket, key }): Promise<string> {
    return s3FetchText(refBucket ?? bucket, key);
  },
  // Shared with the M4 dispatcher-side materialization (services/telemetry-window.ts).
  readTelemetryWindow,
});

export const handler = async (
  event: WorkflowEngineEvent,
): Promise<{ runId: string; status: 'succeeded' | 'failed'; resultKey: string }> => {
  const bucket = event.bucket ?? BUCKET;
  if (!bucket) throw new Error('workflow-engine: no bucket (BUCKET_NAME unset and none in the event)');
  if (!event.runId && !event.manifestKey) {
    throw new Error('workflow-engine: event needs runId or manifestKey');
  }
  const key = event.manifestKey ?? manifestKey(event.runId!);

  let manifest: RunManifest;
  try {
    manifest = await loadRunManifest(bucket, key);
  } catch (err) {
    const message = `Unreadable or invalid run manifest at ${key}: ${err instanceof Error ? err.message : String(err)}`;
    // With a known runId a failed result.json still lets the run finalize.
    if (event.runId) {
      await writeRunArtifacts(bucket, event.runId, failureOutcome(0, null, message));
      return { runId: event.runId, status: 'failed', resultKey: resultKey(event.runId) };
    }
    throw new Error(message);
  }

  const definition = upgradeDefinition(manifest.definition);

  // This target runs telemetry-only graphs; media graphs need the Fargate engine.
  let refusal: { nodeId: string; error: string } | null = null;
  for (const node of definition.nodes) {
    const typeDef = getNodeType(node.type);
    if (!typeDef) {
      refusal = { nodeId: node.id, error: `Unknown node type "${node.type}"` };
      break;
    }
    if (typeDef.runtime.target === 'media') {
      refusal = {
        nodeId: node.id,
        error: `Node type "${node.type}" needs the media engine target; this run was misrouted to Lambda`,
      };
      break;
    }
  }

  // Live progress (M3 simulations): present only when the manifest carries a
  // progress block; production/batch manifests stay silent, exactly as in M2.
  const progress = manifestProgress(manifest, (m) => console.log(`workflow-engine: ${m}`));
  progress?.runStatus({ status: 'running' });

  const outcome: EngineRunOutcome = refusal
    ? failureOutcome(definition.nodes.length, refusal.nodeId, refusal.error)
    : await runGraph(
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
          sources: telemetrySources(bucket),
          secrets: secretsManagerReader(),
          ...(progress ? { progress } : {}),
          deadlineMs: (manifest.limits.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS) * 1000,
        },
      );

  await writeRunArtifacts(bucket, manifest.runId, outcome, captureFormats(definition));
  // Final status goes out AFTER artifacts are durable, so a subscriber that
  // reacts to "succeeded" can immediately fetch records/frames.
  if (progress) {
    progress.runStatus({ status: outcome.status, error: outcome.error, failedNodeId: outcome.failedNodeId });
    await progress.flush();
  }
  console.log('workflow-engine: run complete', {
    runId: manifest.runId,
    status: outcome.status,
    events: outcome.metrics.events,
    messages: outcome.metrics.messages,
  });
  return { runId: manifest.runId, status: outcome.status, resultKey: resultKey(manifest.runId) };
};

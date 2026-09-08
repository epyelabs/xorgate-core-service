import {
  createEngine,
  manifestKey,
  resultKey,
  upgradeDefinition,
  type RunManifest,
} from '@xorgate/workflow-engine';
import { readTelemetryWindow } from '../services/telemetry-window';
import { platformCatalog } from '../workflows/catalog';
import { failureOutcome, loadRunManifest, writeRunArtifacts } from '../workflows/host/aws';
import { cloudHost, preflightRefusal, writeRefusal } from '../workflows/host/cloud-host';

/**
 * Lambda target of the workflow engine: telemetry-only batch graphs
 * (architecture §4.1). Direct-invoked with { runId } (or an explicit
 * bucket/manifestKey); reads workflows/v2/runs/<runId>/manifest.json, runs the
 * graph in-process through `@xorgate/workflow-engine` over the platform's
 * cloud host (workflows/host/cloud-host.ts, the lambda flavour), and writes
 * events.jsonl / outputs/<nodeId>/records.* / result.json back under the same
 * prefix. result.json is ALWAYS written, even on failure, so the finalize path
 * is the single place run status is resolved.
 *
 * The host supplies the one seam this target owns: telemetry history reads
 * from telemetry_readings via drizzle. Media graphs (any node with
 * runtime.target === "media") and graphs with a code function node are
 * refused here pre-flight and belong to the Fargate target (engine-runner/).
 *
 * Routed to by BOTH dispatch paths since M6: the simulations handler (direct
 * invoke) and the SQS production dispatcher (every triggered telemetry-only
 * run; media and function runs go to the Fargate engine-runner instead).
 */

const BUCKET = process.env.BUCKET_NAME;

const DEFAULT_MAX_RUNTIME_SECONDS = 240; // < the Lambda timeout, so the engine fails runs itself

export interface WorkflowEngineEvent {
  runId?: string;
  bucket?: string;
  manifestKey?: string;
}

const log = (m: string): void => console.log(`workflow-engine: ${m}`);

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

  // The lambda flavour: drizzle telemetry reads, no media, no models, no
  // live plane. The test-only local-input switch is never set here.
  const host = cloudHost({ bucket, target: 'lambda', telemetry: readTelemetryWindow, log });
  if (host.options.localInputs) throw new Error('workflow-engine: localInputs is a test-only host option');

  const definition = upgradeDefinition(manifest.definition);
  const refusal = preflightRefusal(definition, 'lambda');
  if (refusal) {
    const result = await writeRefusal(host, manifest, refusal);
    log(`run refused: ${refusal.error} (${manifest.runId})`);
    return { runId: manifest.runId, status: result.status, resultKey: resultKey(manifest.runId) };
  }

  // The engine validates the manifest, binds the host, emits `running`, runs
  // the graph, writes the artifact tree (result.json last) and emits the
  // terminal status. Progress is flushed here, after the run resolves.
  const engine = createEngine({ host, catalog: platformCatalog, log: (m, level) => log(`[${level}] ${m}`) });
  let outcomeStatus: 'succeeded' | 'failed';
  try {
    const { outcome } = await engine.run({
      manifest,
      runId: manifest.runId,
      deadlineMs: (manifest.limits.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS) * 1000,
    });
    outcomeStatus = outcome.status;
    log(
      `run complete ${JSON.stringify({ runId: manifest.runId, status: outcome.status, events: outcome.metrics.events, messages: outcome.metrics.messages })}`,
    );
  } finally {
    await host.takeProgress(manifest.runId)?.flush();
  }
  return { runId: manifest.runId, status: outcomeStatus, resultKey: resultKey(manifest.runId) };
};

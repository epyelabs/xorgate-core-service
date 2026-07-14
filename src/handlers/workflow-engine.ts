import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import { getNodeType } from '../workflows/catalog/index';
import type { EngineSourceReader, TelemetrySample } from '../workflows/catalog/types';
import { runGraph, type EngineRunOutcome } from '../workflows/engine/index';
import {
  buildEngineResult,
  eventsKey,
  manifestKey,
  recordsKey,
  resultKey,
  runManifestSchema,
  type RunManifest,
} from '../workflows/engine/manifest';
import { upgradeDefinition } from '../workflows/compat';

/**
 * Lambda target of the v2 TS engine: telemetry-only batch graphs (architecture
 * §4.1). Direct-invoked with { runId } (or an explicit bucket/manifestKey);
 * reads workflows/v2/runs/<runId>/manifest.json, streams the graph in-process,
 * and writes events.jsonl / outputs/<nodeId>/records.jsonl / result.json back
 * under the same prefix. result.json is ALWAYS written, even on failure, so
 * the (session 2) finalize path is the single place run status is resolved.
 *
 * The engine core is storage-free; this handler supplies the one sanctioned
 * seam: telemetry history reads from telemetry_readings via drizzle. Media
 * graphs (any node with runtime.target === "media") are refused here and
 * belong to the Fargate engine target (session 2).
 *
 * Not routed to yet: workflow-dispatch.ts still drives the PoC inline runner
 * and cv-runner until the M6 cutover.
 */

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;

// Memory guard for the in-process run; the history API serves at most 5k rows,
// so this is generous headroom, not a tuning knob.
const MAX_TELEMETRY_ROWS = 100_000;
const DEFAULT_MAX_RUNTIME_SECONDS = 240; // < the Lambda timeout, so the engine fails runs itself

export interface WorkflowEngineEvent {
  runId?: string;
  bucket?: string;
  manifestKey?: string;
}

const telemetrySources: EngineSourceReader = {
  async readTelemetryWindow({ deviceId, metrics, window }): Promise<TelemetrySample[]> {
    const rows = await db
      .select({
        ts: schema.telemetryReadings.ts,
        metric: schema.telemetryReadings.metric,
        value: schema.telemetryReadings.value,
      })
      .from(schema.telemetryReadings)
      .where(
        and(
          eq(schema.telemetryReadings.deviceId, deviceId),
          inArray(schema.telemetryReadings.metric, metrics),
          sql`${schema.telemetryReadings.ts} >= ${tsParam(new Date(window.fromMs).toISOString())}`,
          sql`${schema.telemetryReadings.ts} < ${tsParam(new Date(window.toMs).toISOString())}`,
        ),
      )
      .orderBy(asc(schema.telemetryReadings.ts))
      .limit(MAX_TELEMETRY_ROWS);
    if (rows.length === MAX_TELEMETRY_ROWS) {
      console.warn('workflow-engine: telemetry window truncated', { deviceId, metrics });
    }
    // Rows are per-metric; group them into one sample per timestamp.
    const byTs = new Map<number, Record<string, number>>();
    for (const row of rows) {
      if (row.value === null) continue;
      const ts = row.ts.getTime();
      (byTs.get(ts) ?? byTs.set(ts, {}).get(ts)!)[row.metric] = row.value;
    }
    return [...byTs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, signals]) => ({ ts, signals }));
  },
};

async function putJson(bucket: string, key: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

async function writeArtifacts(
  bucket: string,
  manifest: RunManifest,
  outcome: EngineRunOutcome,
): Promise<void> {
  const runId = manifest.runId;
  const captureFormats: Record<string, 'jsonl' | 'json'> = {};
  for (const node of manifest.definition.nodes) {
    if (node.type === 'output.data_capture') {
      captureFormats[node.id] = node.data.config?.format === 'json' ? 'json' : 'jsonl';
    }
  }
  const puts: Array<Promise<void>> = [];
  if (outcome.events.length > 0) {
    puts.push(
      putJson(
        bucket,
        eventsKey(runId),
        outcome.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'application/x-ndjson',
      ),
    );
  }
  for (const [nodeId, records] of Object.entries(outcome.captures)) {
    const format = captureFormats[nodeId] ?? 'jsonl';
    puts.push(
      format === 'json'
        ? putJson(bucket, recordsKey(runId, nodeId, 'json'), JSON.stringify(records), 'application/json')
        : putJson(
            bucket,
            recordsKey(runId, nodeId, 'jsonl'),
            records.map((r) => JSON.stringify(r)).join('\n') + '\n',
            'application/x-ndjson',
          ),
    );
  }
  const result = buildEngineResult(runId, outcome, captureFormats);
  puts.push(putJson(bucket, resultKey(runId), JSON.stringify(result), 'application/json'));
  await Promise.all(puts);
}

function failureOutcome(nodeCount: number, failedNodeId: string | null, error: string): EngineRunOutcome {
  return {
    status: 'failed',
    error,
    failedNodeId,
    steps: [],
    events: [],
    captures: {},
    metrics: { nodes: nodeCount, okSteps: 0, events: 0, messages: 0 },
  };
}

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
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    manifest = runManifestSchema.parse(JSON.parse(body ?? '{}'));
  } catch (err) {
    const message = `Unreadable or invalid run manifest at ${key}: ${err instanceof Error ? err.message : String(err)}`;
    // With a known runId a failed result.json still lets the run finalize.
    if (event.runId) {
      await putJson(
        bucket,
        resultKey(event.runId),
        JSON.stringify(buildEngineResult(event.runId, failureOutcome(0, null, message))),
        'application/json',
      );
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
          sources: telemetrySources,
          deadlineMs: (manifest.limits.maxRuntimeSeconds ?? DEFAULT_MAX_RUNTIME_SECONDS) * 1000,
        },
      );

  await writeArtifacts(bucket, { ...manifest, definition }, outcome);
  console.log('workflow-engine: run complete', {
    runId: manifest.runId,
    status: outcome.status,
    events: outcome.metrics.events,
    messages: outcome.metrics.messages,
  });
  return { runId: manifest.runId, status: outcome.status, resultKey: resultKey(manifest.runId) };
};

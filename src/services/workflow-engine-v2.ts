import { eq } from 'drizzle-orm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db, schema } from '../db/index';
import type { WorkflowRun } from '../db/schema';
import type { WorkflowDefinition } from '../schemas/workflows';
import { getNodeType } from '../workflows/catalog/index';
import { manifestKey, runPrefix, type RunManifest } from '../workflows/engine/manifest';

/**
 * EXPERIMENTAL v2 dispatch (M2 session 2, default OFF): when
 * WORKFLOW_V2_EXPERIMENT=on, stored schemaVersion-2 TELEMETRY-ONLY definitions
 * are run on the v2 Lambda engine (v2 manifest to S3, async invoke; the result
 * lands via the workflows/v2/ EventBridge rule -> finalize). Everything else
 * keeps flowing to the PoC inline runner / cv-runner until M6.
 *
 * Idempotency note: unlike the Fargate path there is no taskArn stamp (the
 * watchdog would StopTask a fake ARN), so an SQS redelivery mid-run could
 * invoke the engine twice. Both runs write the same artifact keys and finalize
 * is status-guarded, so the second result is a no-op; acceptable for an
 * experiment, revisited at M6.
 */

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const BUCKET = process.env.BUCKET_NAME;
const ENGINE_FN = process.env.WORKFLOW_ENGINE_FN;

export function v2ExperimentEnabled(): boolean {
  return process.env.WORKFLOW_V2_EXPERIMENT === 'on';
}

/** True iff the STORED definition is schemaVersion 2 with only known, non-media nodes. */
export function isV2TelemetryOnly(definition: WorkflowDefinition): boolean {
  if ((definition.schemaVersion ?? 1) < 2) return false;
  for (const node of definition.nodes) {
    const typeDef = getNodeType(node.type);
    if (!typeDef || typeDef.runtime.target === 'media') return false;
  }
  return true;
}

// Same fallback the inline runner uses (workflow-runner.ts resolveWindow).
function resolveWindow(run: WorkflowRun): { from: string; to: string } {
  const ctx = run.triggerContext as { window?: { from?: string; to?: string } } | null;
  if (ctx?.window?.from && ctx?.window?.to) {
    return { from: ctx.window.from, to: ctx.window.to };
  }
  const to = run.startedAt ?? new Date();
  const from = new Date(to.getTime() - 15 * 60_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function dispatchV2LambdaRun(run: WorkflowRun): Promise<void> {
  if (!BUCKET || !ENGINE_FN) {
    await db
      .update(schema.workflowRuns)
      .set({ status: 'failed', endedAt: new Date(), error: 'v2 engine is not configured' })
      .where(eq(schema.workflowRuns.id, run.id));
    return;
  }
  const manifest: RunManifest = {
    manifestVersion: 2,
    runId: run.id,
    mode: run.mode === 'simulation' ? 'simulation' : 'batch',
    deviceId: run.deviceId,
    window: resolveWindow(run),
    definition: run.definition as WorkflowDefinition,
    inputs: [], // telemetry sources default to a history read over the window
    output: { bucket: BUCKET, prefix: runPrefix(run.id) },
    limits: { maxRuntimeSeconds: 240 },
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey(run.id),
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
    }),
  );
  // Async invoke: the engine always writes result.json, and the workflows/v2/
  // EventBridge rule finalizes the run. A crash before result.json is caught by
  // the 45-minute watchdog, same as a lost Fargate task.
  await lambda.send(
    new InvokeCommand({ FunctionName: ENGINE_FN, InvocationType: 'Event', Payload: JSON.stringify({ runId: run.id }) }),
  );
  console.log('workflow-engine-v2: experimental Lambda run dispatched', { runId: run.id });
}

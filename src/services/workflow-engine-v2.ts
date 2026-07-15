import { eq } from 'drizzle-orm';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db, schema } from '../db/index';
import type { WorkflowRun } from '../db/schema';
import type { WorkflowDefinition } from '../schemas/workflows';
import { getNodeType } from '../workflows/catalog/index';
import { manifestKey, runPrefix, type RunManifest } from '../workflows/engine/manifest';

/**
 * v2 engine dispatch: write the v2 manifest to S3, then either async-invoke
 * the Lambda engine (telemetry-only graphs) or RunTask the engine-runner
 * container (media graphs) with the same env contract as the cv-runner. Two
 * callers:
 *
 * - The M3 simulations handler (workflow-simulations.ts): a NEW dispatch path,
 *   direct (no SQS hop) because the caller is an interactive request that
 *   wants dispatch errors synchronously; the run row exists before dispatch
 *   and the watchdog covers lost tasks, so there is nothing for a retry queue
 *   to add.
 * - The M2 experimental production path (default OFF): when
 *   WORKFLOW_V2_EXPERIMENT=on, stored schemaVersion-2 TELEMETRY-ONLY
 *   definitions run on the v2 Lambda engine. Everything else keeps flowing to
 *   the PoC inline runner / cv-runner until M6.
 *
 * Idempotency notes: Fargate dispatch stamps the REAL taskArn (the watchdog
 * can StopTask it). Lambda dispatch stamps nothing (a fake ARN would be
 * StopTask'd), so an SQS redelivery mid-run could invoke the engine twice;
 * both invocations write the same artifact keys and finalize is
 * status-guarded, so the second result is a no-op. Accepted for the
 * experiment; M6 needs a real idempotency stamp.
 */

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const ecs = new ECSClient({});

const BUCKET = process.env.BUCKET_NAME;
const ENGINE_FN = process.env.WORKFLOW_ENGINE_FN;
const ENGINE_CLUSTER = process.env.ENGINE_CLUSTER_ARN;
const ENGINE_TASKDEF = process.env.ENGINE_TASKDEF;
const ENGINE_SUBNETS = (process.env.ENGINE_SUBNETS ?? '').split(',').filter(Boolean);
const ENGINE_SG = process.env.ENGINE_SG;
const ENGINE_CONTAINER = process.env.ENGINE_CONTAINER_NAME ?? 'engine-runner';

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

async function failRun(runId: string, error: string): Promise<void> {
  await db
    .update(schema.workflowRuns)
    .set({ status: 'failed', endedAt: new Date(), error })
    .where(eq(schema.workflowRuns.id, runId));
}

export interface DispatchV2Options {
  target: 'lambda' | 'fargate';
  /** Full v2 manifest to write. Callers build it (simulations use buildSimulationManifest). */
  manifest: RunManifest;
}

/**
 * Writes the manifest and launches the chosen engine target. On failure the
 * run row is flipped to failed and the error is rethrown so interactive
 * callers can surface it. Fargate launches stamp run.taskArn.
 */
export async function dispatchV2Run(runId: string, opts: DispatchV2Options): Promise<void> {
  if (!BUCKET) {
    await failRun(runId, 'v2 engine is not configured (no bucket)');
    throw new Error('v2 engine is not configured (BUCKET_NAME unset)');
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey(runId),
      Body: JSON.stringify(opts.manifest),
      ContentType: 'application/json',
    }),
  );

  if (opts.target === 'lambda') {
    if (!ENGINE_FN) {
      await failRun(runId, 'v2 Lambda engine is not configured');
      throw new Error('v2 Lambda engine is not configured (WORKFLOW_ENGINE_FN unset)');
    }
    // Async invoke: the engine always writes result.json, and the workflows/v2/
    // EventBridge rule finalizes the run. A crash before result.json is caught
    // by the 45-minute watchdog, same as a lost Fargate task.
    await lambda.send(
      new InvokeCommand({ FunctionName: ENGINE_FN, InvocationType: 'Event', Payload: JSON.stringify({ runId }) }),
    );
    console.log('workflow-engine-v2: Lambda run dispatched', { runId });
    return;
  }

  if (!ENGINE_CLUSTER || !ENGINE_TASKDEF || ENGINE_SUBNETS.length === 0 || !ENGINE_SG) {
    await failRun(runId, 'v2 media engine is not configured (missing ENGINE_* env)');
    throw new Error('v2 media engine is not configured (missing ENGINE_* env)');
  }
  let taskArn: string | undefined;
  try {
    const res = await ecs.send(
      new RunTaskCommand({
        cluster: ENGINE_CLUSTER,
        taskDefinition: ENGINE_TASKDEF,
        launchType: 'FARGATE',
        count: 1,
        startedBy: runId, // 36-char uuid fits ECS's startedBy limit
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: ENGINE_SUBNETS,
            securityGroups: [ENGINE_SG],
            assignPublicIp: 'ENABLED', // recorder VPC has no NAT; public IP = egress
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: ENGINE_CONTAINER,
              // The FROZEN engine-runner env contract; the definition travels
              // via the S3 manifest (ECS env overrides cap at 8 KB).
              environment: [
                { name: 'RUN_ID', value: runId },
                { name: 'MANIFEST_BUCKET', value: BUCKET },
                { name: 'MANIFEST_KEY', value: manifestKey(runId) },
                { name: 'AWS_REGION', value: process.env.AWS_REGION ?? 'us-east-1' },
              ],
            },
          ],
        },
      }),
    );
    taskArn = res.tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error(`RunTask failed: ${res.failures?.[0]?.reason ?? 'no task returned'}`);
  } catch (err) {
    const message = `Failed to launch engine task: ${err instanceof Error ? err.message : String(err)}`;
    console.error('workflow-engine-v2: RunTask failed', { runId, err });
    await failRun(runId, message);
    throw new Error(message);
  }
  await db.update(schema.workflowRuns).set({ taskArn }).where(eq(schema.workflowRuns.id, runId));
  console.log('workflow-engine-v2: engine task launched', { runId, taskArn });
}

/** The M2 experimental production path (telemetry-only, Lambda target). */
export async function dispatchV2LambdaRun(run: WorkflowRun): Promise<void> {
  if (!BUCKET || !ENGINE_FN) {
    return failRun(run.id, 'v2 engine is not configured');
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
  try {
    await dispatchV2Run(run.id, { target: 'lambda', manifest });
  } catch {
    return; // the run row is already failed; the SQS dispatcher must not retry
  }
}

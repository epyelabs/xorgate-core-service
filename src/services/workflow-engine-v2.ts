import { and, eq } from 'drizzle-orm';
import { ECSClient, ListTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { db, schema } from '../db/index';
import type { WorkflowRun } from '../db/schema';
import type { WorkflowDefinition } from '../schemas/workflows';
import { readTelemetryWindow } from './telemetry-window';
import { upgradeDefinition } from '../workflows/compat';
import { engineTargetForDefinition, sessionQueueName } from '../workflows/simulations';
import {
  buildProductionManifest,
  buildTriggeredInputs,
  resolveTriggeredWindow,
  sessionsWindow,
  triggeredVideoSelection,
  unknownNodeTypes,
  type ResolvedVideoSession,
} from '../workflows/production';
import {
  findDeviceSessions,
  findRecentDeviceSessions,
  resolveVideoSessions,
} from './media-session-input';
import { inputRecordsKey, manifestKey, type RunManifest } from '../workflows/engine/manifest';

/**
 * v2 engine dispatch: write the v2 manifest to S3, then either async-invoke
 * the Lambda engine (telemetry-only graphs) or RunTask the engine-runner
 * container (media graphs). Two callers:
 *
 * - The M3 simulations handler (workflow-simulations.ts): direct dispatch (no
 *   SQS hop) because the caller is an interactive request that wants dispatch
 *   errors synchronously; the run row exists before dispatch and the watchdog
 *   covers lost tasks, so there is nothing for a retry queue to add.
 * - The M6 production trigger path (workflow-dispatch.ts): every triggered
 *   run (telemetry_condition / session_completed / segment_uploaded /
 *   schedule / manual / rerun)
 *   lands on dispatchV2TriggeredRun after the dispatcher's atomic
 *   dispatched_at claim. The PoC inline runner and Python cv-runner are
 *   retired; v1 definitions are upgraded at fire time (workflow-triggers.ts)
 *   and here again defensively for rows enqueued before the cutover deploy.
 *
 * Idempotency: the SQS dispatcher claims runs via the dispatched_at column
 * (migration 0016) BEFORE calling in here, so redelivery can never
 * double-invoke either target. Fargate dispatch additionally stamps the real
 * taskArn so the watchdog can StopTask a hung task.
 */

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const ecs = new ECSClient({});
const sqs = new SQSClient({});

const BUCKET = process.env.BUCKET_NAME;
const ENGINE_FN = process.env.WORKFLOW_ENGINE_FN;
const ENGINE_CLUSTER = process.env.ENGINE_CLUSTER_ARN;
const ENGINE_TASKDEF = process.env.ENGINE_TASKDEF;
const ENGINE_SUBNETS = (process.env.ENGINE_SUBNETS ?? '').split(',').filter(Boolean);
const ENGINE_SG = process.env.ENGINE_SG;
const ENGINE_CONTAINER = process.env.ENGINE_CONTAINER_NAME ?? 'engine-runner';
// Warm simulator sessions (M5): per-(org, template) SQS queues under this name
// prefix. Unset = warm sessions disabled, every fargate dispatch is a cold
// RunTask (the M2-M4 behavior).
const SESSION_QUEUE_PREFIX = process.env.WF_SESSION_QUEUE_PREFIX;
// Stale-message guard: a job nobody picked up within this window dies with the
// queue retention, instead of a later session task re-running a watchdog-failed
// run. 15 minutes covers the longest simulation budget (900 s).
const SESSION_QUEUE_ATTRIBUTES = {
  MessageRetentionPeriod: '900',
  VisibilityTimeout: '60',
  ReceiveMessageWaitTimeSeconds: '20',
};

// Guarded running -> failed transition: a no-op when the run was already
// finalized (finalize or the watchdog got there first), so a late dispatch
// error can never clobber a real outcome.
async function failRun(runId: string, error: string): Promise<void> {
  await db
    .update(schema.workflowRuns)
    .set({ status: 'failed', endedAt: new Date(), error })
    .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.status, 'running')));
}

/**
 * The M4 container telemetry seam: dispatcher-materialized inputs. The engine
 * task role is deliberately DB-free, so before a FARGATE dispatch every
 * telemetry_history binding is resolved HERE (same drizzle reader as the
 * Lambda engine, services/telemetry-window.ts), written to
 * inputs/<nodeId>/records.jsonl under the run prefix, and swapped for a
 * telemetry_materialized binding the executor reads through its existing
 * fetchText seam. Lambda dispatches keep reading history directly (cheaper,
 * no double storage). Inputs without a telemetry_history binding pass through
 * untouched.
 *
 * `metrics` default comes from the source node's config (same rule the
 * executor applies), `window` from the binding else the run window.
 */
export async function materializeHistoryInputs(args: {
  runId: string;
  definition: WorkflowDefinition;
  inputs: RunManifest['inputs'];
  deviceId: string | null;
  window: { from: string; to: string } | null;
}): Promise<RunManifest['inputs']> {
  if (!BUCKET) throw new Error('v2 engine is not configured (BUCKET_NAME unset)');
  const nodesById = new Map(args.definition.nodes.map((n) => [n.id, n]));
  const out: RunManifest['inputs'] = [];
  for (const input of args.inputs) {
    if (input.binding.kind !== 'telemetry_history') {
      out.push(input);
      continue;
    }
    const node = nodesById.get(input.nodeId);
    const binding = input.binding as {
      kind: 'telemetry_history';
      metrics?: string[];
      window?: { from: string; to: string };
    };
    const configMetrics = (node?.data.config as { metrics?: unknown } | undefined)?.metrics;
    const metrics =
      binding.metrics ??
      (Array.isArray(configMetrics) ? configMetrics.filter((m): m is string => typeof m === 'string') : []);
    if (metrics.length === 0) {
      throw new Error(`Telemetry source "${input.nodeId}" has no metrics to materialize`);
    }
    const window = binding.window ?? args.window;
    if (!window) throw new Error(`Telemetry source "${input.nodeId}" has no data window to materialize`);
    if (!args.deviceId) throw new Error(`Telemetry source "${input.nodeId}" needs a device on the run`);
    const samples = await readTelemetryWindow({
      deviceId: args.deviceId,
      metrics,
      window: { fromMs: Date.parse(window.from), toMs: Date.parse(window.to) },
    });
    const key = inputRecordsKey(args.runId, input.nodeId);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: samples.map((s) => JSON.stringify(s)).join('\n') + '\n',
        ContentType: 'application/x-ndjson',
      }),
    );
    console.log('workflow-engine-v2: materialized telemetry input', {
      runId: args.runId,
      nodeId: input.nodeId,
      samples: samples.length,
    });
    out.push({ nodeId: input.nodeId, binding: { kind: 'telemetry_materialized', s3Key: key } });
  }
  return out;
}

export interface DispatchV2Options {
  target: 'lambda' | 'fargate';
  /** Full v2 manifest to write. Callers build it (simulations use buildSimulationManifest). */
  manifest: RunManifest;
  /**
   * Warm simulator session routing (M5, fargate simulations only): the
   * editing-session key (simulationSessionKey). When set and the session
   * infrastructure is configured, the run is enqueued to the per-session SQS
   * queue and served by a lingering engine task instead of a cold RunTask;
   * any warm-path failure falls back to the cold path.
   */
  sessionKey?: string;
}

/**
 * Warm-session dispatch: ensure the per-session queue exists, enqueue the job,
 * then ensure a session task is polling it. Send-before-check ordering closes
 * most of the exit race: a task that is still RUNNING when we look will drain
 * the message we just sent; a task that exited between our send and its final
 * poll leaves the message for the replacement task we then launch. The one
 * residual window (task exits AFTER we saw it RUNNING, message unread until
 * the 15-minute queue retention drops it) strands the run for the watchdog —
 * accepted, same backstop as a lost cold task.
 */
async function dispatchToWarmSession(runId: string, sessionKey: string): Promise<string> {
  if (!SESSION_QUEUE_PREFIX) throw new Error('warm sessions are not configured (WF_SESSION_QUEUE_PREFIX unset)');
  if (!ENGINE_CLUSTER || !ENGINE_TASKDEF || ENGINE_SUBNETS.length === 0 || !ENGINE_SG) {
    throw new Error('v2 media engine is not configured (missing ENGINE_* env)');
  }
  const queueName = sessionQueueName(SESSION_QUEUE_PREFIX, sessionKey);
  // CreateQueue is idempotent for an existing queue with identical attributes.
  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: queueName, Attributes: SESSION_QUEUE_ATTRIBUTES }),
  );
  const queueUrl = created.QueueUrl;
  if (!queueUrl) throw new Error(`CreateQueue returned no URL for ${queueName}`);
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ runId }) }));

  const running = await ecs.send(
    new ListTasksCommand({ cluster: ENGINE_CLUSTER, startedBy: sessionKey, desiredStatus: 'RUNNING' }),
  );
  const existing = running.taskArns?.[0];
  if (existing) {
    console.log('workflow-engine-v2: warm session reused', { runId, sessionKey, taskArn: existing });
    return existing;
  }

  const res = await ecs.send(
    new RunTaskCommand({
      cluster: ENGINE_CLUSTER,
      taskDefinition: ENGINE_TASKDEF,
      launchType: 'FARGATE',
      count: 1,
      startedBy: sessionKey, // 32-hex session key; how warm tasks are found
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ENGINE_SUBNETS,
          securityGroups: [ENGINE_SG],
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: ENGINE_CONTAINER,
            // The SESSION launch contract (additive beside the frozen
            // single-run contract): the queue URL flips main.ts into session
            // mode; manifests are located by runId from each job message.
            environment: [
              { name: 'ENGINE_SESSION_QUEUE_URL', value: queueUrl },
              { name: 'MANIFEST_BUCKET', value: BUCKET! },
              { name: 'AWS_REGION', value: process.env.AWS_REGION ?? 'us-east-1' },
            ],
          },
        ],
      },
    }),
  );
  const taskArn = res.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error(`Session RunTask failed: ${res.failures?.[0]?.reason ?? 'no task returned'}`);
  console.log('workflow-engine-v2: warm session launched', { runId, sessionKey, taskArn });
  return taskArn;
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

  // Warm simulator session first (M5); any warm-path failure falls back to a
  // cold per-run task so the simulation still runs, just with the cold start.
  if (opts.sessionKey && SESSION_QUEUE_PREFIX) {
    try {
      const sessionTaskArn = await dispatchToWarmSession(runId, opts.sessionKey);
      // Stamp the session task so the watchdog can StopTask a hung session
      // (the engine's own maxRuntimeSeconds deadline fires long before).
      await db.update(schema.workflowRuns).set({ taskArn: sessionTaskArn }).where(eq(schema.workflowRuns.id, runId));
      return;
    } catch (err) {
      console.error('workflow-engine-v2: warm session dispatch failed; falling back to cold RunTask', {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
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

// The organization owning the run's template: production progress topics are
// org-prefixed (wf/run/<orgId>/<runId>), same scoping as the simulator plane.
async function templateOrgId(templateId: string): Promise<string> {
  const row = await db.query.workflowTemplates.findFirst({
    where: eq(schema.workflowTemplates.id, templateId),
    columns: { organizationId: true },
  });
  if (!row) throw new Error('Workflow template no longer exists');
  return row.organizationId;
}

/**
 * Resolve the triggered run's video input from its trigger context, against
 * on-device `media_sessions`/`media_segments` (Phase W — the cloud
 * `recordings` table is gone):
 *  - `session_completed` / manual session run -> that one session
 *  - `segment_uploaded` -> that ONE chunk of the session (the N=1 case)
 *  - schedule selection -> hand-picked session ids, or the most recent N
 *
 * Returns a LIST, newest first: a multi-camera drive is N per-camera sessions,
 * and buildTriggeredInputs picks per `source.video` node by `config.streamKey`
 * (see sessionForVideoNode). Segment ordering and wall-clock anchoring come
 * from buildSessionTimeline via services/media-session-input.ts.
 */
async function resolveTriggeredVideoSessions(run: WorkflowRun): Promise<ResolvedVideoSession[]> {
  const selection = triggeredVideoSelection(run.triggerContext);
  if (!selection || !run.deviceId) return [];

  switch (selection.kind) {
    case 'session': {
      const rows = await findDeviceSessions(run.deviceId, [selection.sessionId]);
      return resolveVideoSessions(rows);
    }
    case 'segment': {
      const rows = await findDeviceSessions(run.deviceId, [selection.sessionId]);
      return resolveVideoSessions(rows, { onlySeq: selection.seq });
    }
    case 'sessions': {
      const rows = await findDeviceSessions(run.deviceId, selection.sessionIds);
      return resolveVideoSessions(rows);
    }
    case 'lastNSessions': {
      const rows = await findRecentDeviceSessions(run.deviceId, selection.n);
      return resolveVideoSessions(rows);
    }
  }
}

/**
 * The M6 production trigger path: builds the v2 manifest for a triggered
 * (device-attachment) run and dispatches the engine target. Called by the SQS
 * dispatcher AFTER its atomic dispatched_at claim. No retry semantics (same
 * stance as the retired v1 dispatchers): any failure fails the run row with a
 * clear error and returns, so the SQS message always acks.
 */
export async function dispatchV2TriggeredRun(run: WorkflowRun): Promise<void> {
  try {
    if (!BUCKET) throw new Error('v2 engine is not configured (BUCKET_NAME unset)');
    // fireWorkflowRun stamps upgraded definitions since M6; upgrading again is
    // a pure no-op for v2 and covers rows enqueued before the cutover deploy
    // (and historical-rerun snapshots).
    const definition = upgradeDefinition(run.definition as WorkflowDefinition);
    const unknown = unknownNodeTypes(definition);
    if (unknown.length > 0) {
      throw new Error(
        `Definition uses node types not in the catalog (${unknown.join(', ')}); edit and re-publish the template`,
      );
    }
    const target = engineTargetForDefinition(definition);
    // Media first: the resolved session timeline is the telemetry window when
    // the trigger context carries no explicit one, so correlation covers the
    // REAL session instead of the 15-minute default.
    const sessions = await resolveTriggeredVideoSessions(run);
    const window = resolveTriggeredWindow(run.triggerContext, run.startedAt, sessionsWindow(sessions));
    let inputs = buildTriggeredInputs(definition, sessions, target);
    if (target === 'fargate') {
      // The M4 telemetry seam, reused verbatim: history bindings become
      // dispatcher-written records.jsonl objects (the task role is DB-free).
      inputs = await materializeHistoryInputs({
        runId: run.id,
        definition,
        inputs,
        deviceId: run.deviceId,
        window,
      });
    }
    const orgId = await templateOrgId(run.templateId);
    const manifest = buildProductionManifest({
      runId: run.id,
      orgId,
      bucket: BUCKET,
      definition,
      deviceId: run.deviceId,
      inputs,
      window,
      target,
    });
    await dispatchV2Run(run.id, { target, manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('workflow-engine-v2: triggered dispatch failed', { runId: run.id, err });
    await failRun(run.id, message); // no-op if dispatchV2Run already failed it
  }
}

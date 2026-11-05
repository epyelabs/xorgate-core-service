import { routeKey as canonicalRouteKey } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuthError, assertOrgWideScope, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { badRequest, errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { tsParam } from '../utils/sql';
import { fireWorkflowRun } from '../services/workflow-triggers';
import type { WorkflowDefinition } from '../schemas/workflows';
import { runPrefix, runTopicPrefix, simTopicPrefix } from '@xorgate/workflow-engine';
import { apiHandler } from '../utils/api-handler';
import { artifactFileName } from '../workflows/host/result';
import { webhookNamesByNode } from '../services/webhooks/workflow-events';
import { iotPublishTransport } from '../workflows/host/aws';
import {
  CANCEL_STOP_REASON,
  RUN_CANCELLED_ERROR,
  RUN_CANCELLED_STATUS,
  cancelMarkerBody,
  cancelMarkerKey,
  cancelledDurationMs,
  decideStopTask,
} from '../workflows/simulation-saves';

const s3 = new S3Client({});
const ecs = new ECSClient({});
const BUCKET = process.env.BUCKET_NAME;
// The shared Fargate cluster the v2 engine-runner tasks run in (cancel's StopTask).
const ENGINE_CLUSTER = process.env.ENGINE_CLUSTER_ARN;
const ARTIFACT_URL_EXPIRES_SECONDS = 300;
// Bound on the best-effort IoT status publish so a slow DescribeEndpoint can
// never hold the cancel response.
const CANCEL_PUBLISH_TIMEOUT_MS = 2000;

// 'cancelled' (sim-cancel-save): a user stopped an in-flight simulation.
const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;

// Summary select shared by the workspace list and the per-device list.
const summaryColumns = {
  id: schema.workflowRuns.id,
  workspaceId: schema.workflowRuns.workspaceId,
  templateId: schema.workflowRuns.templateId,
  templateName: schema.workflowTemplates.name,
  templateVersion: schema.workflowRuns.templateVersion,
  deviceId: schema.workflowRuns.deviceId,
  deviceName: schema.devices.name,
  serial: schema.devices.serial,
  trigger: schema.workflowRuns.trigger,
  mode: schema.workflowRuns.mode,
  status: schema.workflowRuns.status,
  startedAt: schema.workflowRuns.startedAt,
  endedAt: schema.workflowRuns.endedAt,
  durationMs: schema.workflowRuns.durationMs,
  eventCount: schema.workflowRuns.eventCount,
};

// workspaceId/deviceId/deviceName are null on device-less simulation runs
// (migration 0015); the devices join is a LEFT join for the same reason.
type SummaryRow = {
  id: string;
  workspaceId: string | null;
  templateId: string;
  templateName: string;
  templateVersion: number;
  deviceId: string | null;
  deviceName: string | null;
  serial: string | null;
  trigger: string;
  mode: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  eventCount: number;
};

function toSummary(r: SummaryRow) {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    templateId: r.templateId,
    templateName: r.templateName,
    templateVersion: r.templateVersion,
    deviceId: r.deviceId,
    deviceName: r.deviceName ?? r.serial,
    trigger: r.trigger,
    mode: r.mode,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    durationMs: r.durationMs ?? null,
    eventCount: r.eventCount,
  };
}

// Total runs matching a filter, for the list `page.total`. Counted directly on
// workflow_runs (the list's inner joins are on required FKs, so the count matches).
async function countRuns(where: SQL | undefined): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.workflowRuns)
    .where(where);
  return Number(rows[0]?.total ?? 0);
}

// A short human label for what fired the run, from its trigger + context.
function deriveTriggeredBy(trigger: string, ctx: unknown): string {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const type = typeof c.type === 'string' ? c.type : trigger;
  if (type === 'session_completed' && typeof c.streamKey === 'string') {
    return `session_completed · ${c.streamKey}`;
  }
  if (type === 'segment_uploaded' && typeof c.streamKey === 'string') {
    return typeof c.seq === 'number'
      ? `segment_uploaded · ${c.streamKey} #${c.seq}`
      : `segment_uploaded · ${c.streamKey}`;
  }
  if (type === 'telemetry_session_completed') {
    const insights = c.insights as { distance?: { meters?: unknown } } | null | undefined;
    const meters = insights?.distance?.meters;
    return typeof meters === 'number'
      ? `telemetry_session_completed · ${(meters / 1000).toFixed(1)} km`
      : 'telemetry_session_completed';
  }
  if (type === 'telemetry_condition' && Array.isArray(c.matched) && c.matched.length > 0) {
    const first = c.matched[0] as Record<string, unknown>;
    if (typeof first?.metric === 'string') return `telemetry_condition · ${first.metric}`;
  }
  if (type === 'schedule' && typeof c.cron === 'string') return `schedule · ${c.cron}`;
  return type;
}

/**
 * The GET /workflow-runs/{id} `run` body, or null when the run does not exist in
 * this org. Shared with POST /workflow-runs/{id}/cancel, which answers with the
 * same shape (and puts it in a 409's details so the client can adopt it).
 */
async function loadRunDetail(id: string, organizationId: string) {
  // Detail is scoped through the template's org (every run has a template;
  // its org equals the run's workspace org for production runs). This is
  // what lets device-less simulation runs (null workspace/device, 0015)
  // resolve; devices/workspaces are LEFT joins for the same reason.
  const [row] = await db
    .select({
      run: schema.workflowRuns,
      templateName: schema.workflowTemplates.name,
      deviceName: schema.devices.name,
      serial: schema.devices.serial,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.workflowRuns)
    .innerJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
    )
    .leftJoin(schema.devices, eq(schema.devices.id, schema.workflowRuns.deviceId))
    .leftJoin(schema.workspaces, eq(schema.workspaces.id, schema.workflowRuns.workspaceId))
    .where(
      and(
        eq(schema.workflowRuns.id, id),
        eq(schema.workflowTemplates.organizationId, organizationId),
      ),
    );
  if (!row) return null;
  const run = row.run;

  const [steps, events] = await Promise.all([
    db
      .select()
      .from(schema.workflowRunSteps)
      .where(eq(schema.workflowRunSteps.runId, id))
      .orderBy(asc(schema.workflowRunSteps.seq)),
    db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.runId, id))
      .orderBy(asc(schema.workflowEvents.occurredAt)),
  ]);

  // xorgate-webhooks P2: a simulation never delivers; it says where each
  // event WOULD go (the emitting output.event node's `webhook` name).
  const wouldDeliver = run.mode === 'simulation' ? webhookNamesByNode(run.definition) : null;

  return {
    ...toSummary({ ...run, templateName: row.templateName, deviceName: row.deviceName, serial: row.serial }),
    workspaceName: row.workspaceName,
    triggeredBy: deriveTriggeredBy(run.trigger, run.triggerContext),
    definition: run.definition,
    // ADDITIVE (simulator-output-artifacts): `seq` on steps, `payload` and
    // `clipKey` on events, so the editor's Output panel can show the
    // full trace order and event bodies without reading events.jsonl.
    steps: steps.map((s) => ({
      seq: s.seq,
      nodeId: s.nodeId,
      label: s.label,
      status: s.status,
      output: s.output,
      durationMs: s.durationMs,
    })),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      occurredAt: e.occurredAt.toISOString(),
      confidence: e.confidence ?? 0,
      clip: e.clip,
      clipKey: e.clipS3Key ?? null,
      payloadSummary: e.payloadSummary,
      payload: e.payload ?? null,
      // ADDITIVE (xorgate-webhooks P2): the emitting node (engine >= 0.5.0,
      // else null) and, on simulation runs only, the endpoint name the
      // node routes to in production (null = the node has no `webhook`).
      nodeId: e.nodeId ?? null,
      ...(wouldDeliver
        ? { wouldDeliverTo: (e.nodeId && wouldDeliver.get(e.nodeId)) || null }
        : {}),
    })),
    metrics: run.metrics,
    // v2 engine runs only (null on PoC runs): which engine produced the
    // result and where its Data Capture / events artifacts live in S3
    // (plus `videos`, the muxed visualization MP4s, on Fargate runs).
    engineVersion: run.engineVersion ?? null,
    artifacts: run.artifacts ?? null,
    // ADDITIVE (M6): live-progress subscription hint. v2 runs (their
    // stored snapshot is schemaVersion 2) publish the M3 topic/payload
    // contract under this prefix — wf/run/<org>/<id> for production
    // runs, wf/sim/<org>/<id> for simulations. Null on PoC-era rows,
    // which never published progress. engineVersion can't gate this
    // (finalize stamps it only at run END), the snapshot version can.
    progress:
      ((run.definition as { schemaVersion?: number })?.schemaVersion ?? 1) >= 2
        ? {
            topicPrefix:
              run.mode === 'simulation'
                ? simTopicPrefix(organizationId, id)
                : runTopicPrefix(organizationId, id),
          }
        : null,
    error: run.error ?? null,
    failedNodeId: run.failedNodeId ?? null,
  };
}

/**
 * POST /workflow-runs/{id}/cancel (sim-cancel-save). Atomically claims a
 * running simulation row as 'cancelled', drops a cancel marker for a future
 * engine poll, StopTasks its Fargate task when no other run shares it (warm
 * sessions are shared per org+template), and best-effort publishes the
 * terminal status on the run's IoT status topic. Finalize (v1 + v2) and the
 * watchdog only ever touch 'running' rows, so the engine's later result.json
 * is skipped.
 */
async function cancelSimulationRun(
  id: string,
  organizationId: string,
  userId: string | null,
): Promise<APIGatewayProxyResultV2> {
  const [found] = await db
    .select({ run: schema.workflowRuns })
    .from(schema.workflowRuns)
    .innerJoin(schema.workflowTemplates, eq(schema.workflowTemplates.id, schema.workflowRuns.templateId))
    .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowTemplates.organizationId, organizationId)));
  if (!found) return notFound(`Run "${id}" not found`);
  const run = found.run;
  if (run.mode !== 'simulation') {
    return errorResponse(400, 'RUN_NOT_CANCELLABLE', 'Only simulation runs can be cancelled');
  }

  const notRunning = async () =>
    errorResponse(409, 'RUN_NOT_RUNNING', `Run "${id}" is not running`, {
      run: await loadRunDetail(id, organizationId),
    });
  if (run.status !== 'running') return notRunning();

  // 1. The claim: the conditional UPDATE is the only arbiter against a racing
  // finalize / watchdog / second cancel.
  const endedAt = new Date();
  const claimed = await db
    .update(schema.workflowRuns)
    .set({
      status: RUN_CANCELLED_STATUS,
      endedAt,
      durationMs: cancelledDurationMs(run.startedAt, endedAt),
      error: RUN_CANCELLED_ERROR,
    })
    .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.status, 'running')))
    .returning({ id: schema.workflowRuns.id, taskArn: schema.workflowRuns.taskArn });
  if (claimed.length === 0) return notRunning();
  // Re-read taskArn from the claim: dispatch may have stamped it after our read.
  const taskArn = claimed[0].taskArn ?? run.taskArn;

  // 2. Cancel marker (the seam a future engine release polls). Best-effort.
  if (BUCKET) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: cancelMarkerKey(id),
          Body: cancelMarkerBody({ runId: id, requestedAt: endedAt, requestedByUserId: userId }),
          ContentType: 'application/json',
        }),
      );
    } catch (err) {
      console.warn('workflow-runs: cancel marker write failed', { runId: id, err });
    }
  }

  // 3. StopTask, only when no other running row rides the same task.
  let otherRunningOnTask = 0;
  if (run.executionMode !== 'lambda' && taskArn) {
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.status, 'running'),
          eq(schema.workflowRuns.taskArn, taskArn),
          ne(schema.workflowRuns.id, id),
        ),
      );
    otherRunningOnTask = Number(counted?.n ?? 0);
  }
  const decision = decideStopTask({
    executionMode: run.executionMode,
    taskArn,
    otherRunningOnTask,
    clusterConfigured: Boolean(ENGINE_CLUSTER),
  });
  if (decision.stop) {
    try {
      await ecs.send(new StopTaskCommand({ cluster: ENGINE_CLUSTER, task: decision.taskArn, reason: CANCEL_STOP_REASON }));
      console.log('workflow-runs: cancel stopped engine task', { runId: id, taskArn: decision.taskArn });
    } catch (err) {
      console.warn('workflow-runs: cancel StopTask failed', { runId: id, taskArn: decision.taskArn, err });
    }
  } else {
    console.log('workflow-runs: cancel left engine running', { runId: id, reason: decision.reason });
  }

  // 4. Live view: the terminal status on wf/sim/<org>/<run>/status. The
  // engine's simStatusPayloadSchema enumerates running|succeeded|failed, so a
  // strict parser drops this; the run row (polled) stays the source of truth.
  try {
    const topic = `${simTopicPrefix(organizationId, id)}/status`;
    const payload = JSON.stringify({
      at: endedAt.toISOString(),
      runId: id,
      status: RUN_CANCELLED_STATUS,
      error: RUN_CANCELLED_ERROR,
      failedNodeId: null,
    });
    await Promise.race([
      iotPublishTransport(topic, payload),
      new Promise((_, reject) => setTimeout(() => reject(new Error('publish timeout')), CANCEL_PUBLISH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn('workflow-runs: cancel status publish failed', { runId: id, err });
  }

  return ok({ run: await loadRunDetail(id, organizationId) });
}

/**
 * Workflow runs (executions) read API. Routes (all -> this Lambda):
 *   GET /workflow-runs                     workspace-scoped list (honors X-Workspace-Id)
 *   GET /workflow-runs/{id}                run detail (steps + events + snapshot graph)
 *   GET /devices/{id}/workflow-runs        per-device list
 *   POST /workflow-runs/{id}/cancel        cancel an in-flight simulation (sim-cancel-save)
 * (POST /workflow-runs/{id}/rerun is added with the run-execution path in M3.)
 */
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);

  let auth;
  try {
    const writeMethod = method === 'POST';
    auth = await requireOrgContext(event, writeMethod ? ['owner', 'admin', 'member'] : undefined);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);

  switch (routeKey) {
    case 'GET /workflow-runs': {
      const parsed = parseListParams(event, {
        sortable: ['startedAt'],
        defaultSort: 'startedAt',
        statusValues: RUN_STATUSES,
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, status, from, to } = parsed;

      const emptyPage = ok({ runs: [], page: pageMeta(parsed, 0) });
      if (orgWorkspaceIds.length === 0) return emptyPage;
      const headerWorkspaceId =
        event.headers['x-workspace-id'] ?? event.headers['X-Workspace-Id'];
      let wsFilter = orgWorkspaceIds;
      if (headerWorkspaceId) {
        if (!orgWorkspaceIds.includes(headerWorkspaceId)) return emptyPage;
        wsFilter = [headerWorkspaceId];
      }

      const where = and(
        inArray(schema.workflowRuns.workspaceId, wsFilter),
        status ? eq(schema.workflowRuns.status, status) : undefined,
        from ? sql`${schema.workflowRuns.startedAt} >= ${tsParam(from)}` : undefined,
        to ? sql`${schema.workflowRuns.startedAt} < ${tsParam(to)}` : undefined,
      );
      const total = await countRuns(where);

      const rows = await db
        .select(summaryColumns)
        .from(schema.workflowRuns)
        .innerJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
        )
        .leftJoin(schema.devices, eq(schema.devices.id, schema.workflowRuns.deviceId))
        .where(where)
        .orderBy(
          order === 'asc'
            ? asc(schema.workflowRuns.startedAt)
            : desc(schema.workflowRuns.startedAt),
        )
        .limit(limit)
        .offset(offset);
      return ok({ runs: rows.map(toSummary), page: pageMeta(parsed, total) });
    }

    case 'GET /workflow-runs/{id}': {
      const id = event.pathParameters?.id;
      if (!id) return badRequest('run id required');
      const detail = await loadRunDetail(id, auth.organizationId);
      if (!detail) return notFound(`Run "${id}" not found`);
      return ok({ run: detail });
    }

    case 'POST /workflow-runs/{id}/cancel': {
      const id = event.pathParameters?.id;
      if (!id) return badRequest('run id required');
      // Simulations are org-wide (template-scoped, often device-less), the same
      // gate as the simulator routes that started them.
      try {
        assertOrgWideScope(auth);
      } catch (err) {
        if (err instanceof AuthError) return authErrorResponse(err);
        throw err;
      }
      return cancelSimulationRun(id, auth.organizationId, auth.userId);
    }

    case 'GET /devices/{id}/workflow-runs': {
      const deviceId = event.pathParameters?.id;
      if (!deviceId) return badRequest('device id required');
      const parsed = parseListParams(event, {
        sortable: ['startedAt'],
        defaultSort: 'startedAt',
        statusValues: RUN_STATUSES,
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, status, from, to } = parsed;

      if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);
      // Ownership: the device must belong to a workspace in the caller's org.
      const device = await db.query.devices.findFirst({
        where: and(
          eq(schema.devices.id, deviceId),
          inArray(schema.devices.workspaceId, orgWorkspaceIds),
        ),
        columns: { id: true },
      });
      if (!device) return notFound(`Device "${deviceId}" not found`);

      const where = and(
        eq(schema.workflowRuns.deviceId, deviceId),
        status ? eq(schema.workflowRuns.status, status) : undefined,
        from ? sql`${schema.workflowRuns.startedAt} >= ${tsParam(from)}` : undefined,
        to ? sql`${schema.workflowRuns.startedAt} < ${tsParam(to)}` : undefined,
      );
      const total = await countRuns(where);

      const rows = await db
        .select(summaryColumns)
        .from(schema.workflowRuns)
        .innerJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
        )
        .innerJoin(schema.devices, eq(schema.devices.id, schema.workflowRuns.deviceId))
        .where(where)
        .orderBy(
          order === 'asc'
            ? asc(schema.workflowRuns.startedAt)
            : desc(schema.workflowRuns.startedAt),
        )
        .limit(limit)
        .offset(offset);
      return ok({ runs: rows.map(toSummary), page: pageMeta(parsed, total) });
    }

    case 'POST /workflow-runs/{id}/rerun': {
      const id = event.pathParameters?.id;
      if (!id) return badRequest('run id required');
      if (orgWorkspaceIds.length === 0) return notFound(`Run "${id}" not found`);
      // Load the source run inside the caller's org.
      const source = await db.query.workflowRuns.findFirst({
        where: and(
          eq(schema.workflowRuns.id, id),
          inArray(schema.workflowRuns.workspaceId, orgWorkspaceIds),
        ),
      });
      if (!source) return notFound(`Run "${id}" not found`);
      // Simulation runs re-run through the simulator (their bindings and
      // dispatch path live there), and may have no workspace/device at all.
      if (source.mode === 'simulation' || !source.workspaceId || !source.deviceId) {
        return badRequest('Simulation runs cannot be rerun; start a new simulation from the editor');
      }

      // Clone the snapshot definition + trigger context into a fresh manual run.
      const run = await fireWorkflowRun({
        workspaceId: source.workspaceId,
        deviceId: source.deviceId,
        attachmentId: source.attachmentId, // null if the template was detached — history kept
        templateId: source.templateId,
        templateVersion: source.templateVersion,
        definition: source.definition as WorkflowDefinition,
        trigger: 'manual',
        triggerContext: source.triggerContext,
      });
      return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run: { id: run.id, status: run.status, startedAt: run.startedAt.toISOString() },
        }),
      };
    }

    case 'GET /workflow-runs/{id}/artifact-url': {
      // Presigned GET for a v2 run artifact (Data Capture records, events.jsonl,
      // visualization frames and MP4s, manifest.json, result.json, materialized
      // inputs). The key must live under THIS run's v2 prefix, so
      // a caller can never presign outside runs their org can already read.
      const id = event.pathParameters?.id;
      if (!id) return badRequest('run id required');
      const key = event.queryStringParameters?.key;
      if (!key) return badRequest('key query parameter required');
      if (!BUCKET) throw new Error('workflow-runs: BUCKET_NAME is not configured');
      if (!key.startsWith(runPrefix(id))) {
        return badRequest(`key must start with ${runPrefix(id)}`);
      }
      const [row] = await db
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .innerJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
        )
        .where(
          and(
            eq(schema.workflowRuns.id, id),
            eq(schema.workflowTemplates.organizationId, auth.organizationId),
          ),
        );
      if (!row) return notFound(`Run "${id}" not found`);
      // ADDITIVE: `download=1` signs a Content-Disposition override so a browser
      // saves the object under a name derived from the key instead of
      // rendering it inline (the `download` attribute is ignored cross-origin).
      const download = event.queryStringParameters?.download === '1';
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ...(download
            ? { ResponseContentDisposition: `attachment; filename="${artifactFileName(id, key)}"` }
            : {}),
        }),
        { expiresIn: ARTIFACT_URL_EXPIRES_SECONDS },
      );
      return ok({ url, expiresInSeconds: ARTIFACT_URL_EXPIRES_SECONDS });
    }

    default:
      return methodNotAllowed(method, 'GET, POST');
  }
};

export const handler = apiHandler(restHandler);

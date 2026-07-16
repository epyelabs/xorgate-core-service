import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { tsParam } from '../utils/sql';
import { fireWorkflowRun } from '../services/workflow-triggers';
import type { WorkflowDefinition } from '../schemas/workflows';
import { runPrefix } from '../workflows/engine/manifest';
import { runTopicPrefix, simTopicPrefix } from '../workflows/engine/progress';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const ARTIFACT_URL_EXPIRES_SECONDS = 300;

const RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

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
  if (type === 'recording_saved' && typeof c.streamKey === 'string') {
    return `recording_saved · ${c.streamKey}`;
  }
  if (type === 'telemetry_condition' && Array.isArray(c.matched) && c.matched.length > 0) {
    const first = c.matched[0] as Record<string, unknown>;
    if (typeof first?.metric === 'string') return `telemetry_condition · ${first.metric}`;
  }
  if (type === 'schedule' && typeof c.cron === 'string') return `schedule · ${c.cron}`;
  return type;
}

/**
 * Workflow runs (executions) read API. Routes (all -> this Lambda):
 *   GET /workflow-runs                     workspace-scoped list (honors X-Workspace-Id)
 *   GET /workflow-runs/{id}                run detail (steps + events + snapshot graph)
 *   GET /devices/{id}/workflow-runs        per-device list
 * (POST /workflow-runs/{id}/rerun is added with the run-execution path in M3.)
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;

  let auth;
  try {
    const writeMethod = method === 'POST';
    auth = await requireOrgContext(event, writeMethod ? ['owner', 'admin', 'member'] : undefined);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);

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
            eq(schema.workflowTemplates.organizationId, auth.organizationId),
          ),
        );
      if (!row) return notFound(`Run "${id}" not found`);
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

      return ok({
        run: {
          ...toSummary({ ...run, templateName: row.templateName, deviceName: row.deviceName, serial: row.serial }),
          workspaceName: row.workspaceName,
          triggeredBy: deriveTriggeredBy(run.trigger, run.triggerContext),
          definition: run.definition,
          steps: steps.map((s) => ({
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
            payloadSummary: e.payloadSummary,
          })),
          metrics: run.metrics,
          // v2 engine runs only (null on PoC runs): which engine produced the
          // result and where its Data Capture / events artifacts live in S3.
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
                      ? simTopicPrefix(auth.organizationId, id)
                      : runTopicPrefix(auth.organizationId, id),
                }
              : null,
          error: run.error ?? null,
          failedNodeId: run.failedNodeId ?? null,
        },
      });
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
      // visualization frames). The key must live under THIS run's v2 prefix, so
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
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
        expiresIn: ARTIFACT_URL_EXPIRES_SECONDS,
      });
      return ok({ url, expiresInSeconds: ARTIFACT_URL_EXPIRES_SECONDS });
    }

    default:
      return methodNotAllowed(method, 'GET, POST');
  }
};

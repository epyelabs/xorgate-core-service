import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, methodNotAllowed, notFound, ok } from '../utils/responses';
import { fireWorkflowRun } from '../services/workflow-triggers';
import type { WorkflowDefinition } from '../schemas/workflows';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
  status: schema.workflowRuns.status,
  startedAt: schema.workflowRuns.startedAt,
  endedAt: schema.workflowRuns.endedAt,
  durationMs: schema.workflowRuns.durationMs,
  eventCount: schema.workflowRuns.eventCount,
};

type SummaryRow = {
  id: string;
  workspaceId: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  deviceId: string;
  deviceName: string | null;
  serial: string;
  trigger: string;
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
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    durationMs: r.durationMs ?? null,
    eventCount: r.eventCount,
  };
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

function parseLimit(event: APIGatewayProxyEventV2): number {
  const raw = event.queryStringParameters?.limit;
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
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
  const limit = parseLimit(event);

  switch (routeKey) {
    case 'GET /workflow-runs': {
      if (orgWorkspaceIds.length === 0) return ok({ runs: [] });
      const headerWorkspaceId =
        event.headers['x-workspace-id'] ?? event.headers['X-Workspace-Id'];
      let wsFilter = orgWorkspaceIds;
      if (headerWorkspaceId) {
        if (!orgWorkspaceIds.includes(headerWorkspaceId)) return ok({ runs: [] });
        wsFilter = [headerWorkspaceId];
      }
      const rows = await db
        .select(summaryColumns)
        .from(schema.workflowRuns)
        .innerJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
        )
        .innerJoin(schema.devices, eq(schema.devices.id, schema.workflowRuns.deviceId))
        .where(inArray(schema.workflowRuns.workspaceId, wsFilter))
        .orderBy(desc(schema.workflowRuns.startedAt))
        .limit(limit);
      return ok({ runs: rows.map(toSummary) });
    }

    case 'GET /workflow-runs/{id}': {
      const id = event.pathParameters?.id;
      if (!id) return badRequest('run id required');
      if (orgWorkspaceIds.length === 0) return notFound(`Run "${id}" not found`);
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
        .innerJoin(schema.devices, eq(schema.devices.id, schema.workflowRuns.deviceId))
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workflowRuns.workspaceId))
        .where(
          and(
            eq(schema.workflowRuns.id, id),
            inArray(schema.workflowRuns.workspaceId, orgWorkspaceIds),
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
          error: run.error ?? null,
          failedNodeId: run.failedNodeId ?? null,
        },
      });
    }

    case 'GET /devices/{id}/workflow-runs': {
      const deviceId = event.pathParameters?.id;
      if (!deviceId) return badRequest('device id required');
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
      const rows = await db
        .select(summaryColumns)
        .from(schema.workflowRuns)
        .innerJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
        )
        .innerJoin(schema.devices, eq(schema.devices.id, schema.workflowRuns.deviceId))
        .where(eq(schema.workflowRuns.deviceId, deviceId))
        .orderBy(desc(schema.workflowRuns.startedAt))
        .limit(limit);
      return ok({ runs: rows.map(toSummary) });
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

    default:
      return methodNotAllowed(method, 'GET, POST');
  }
};

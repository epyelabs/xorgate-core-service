import { routeKey as canonicalRouteKey } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import {
  badRequest,
  conflict,
  created,
  errorResponse,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { attachWorkflowSchema, manualRunContextSchema } from '../schemas/workflows';
import type { ManualRunContext, WorkflowDefinition } from '../schemas/workflows';
import {
  computeRequiredCapabilities,
  missingCapabilities,
} from '../services/workflow-capabilities';
import { fireWorkflowRun } from '../services/workflow-triggers';
import { desc } from 'drizzle-orm';

type AttachmentRow = typeof schema.workflowAttachments.$inferSelect;

function mapAttachment(
  a: AttachmentRow,
  t: { name: string; slug: string; publishedVersion: number | null; currentVersion: number },
) {
  return {
    id: a.id,
    deviceId: a.deviceId,
    templateId: a.templateId,
    templateName: t.name,
    templateSlug: t.slug,
    pinnedVersion: a.pinnedVersion ?? null,
    runningVersion: a.pinnedVersion ?? t.publishedVersion ?? t.currentVersion,
    enabled: a.enabled,
    triggers: a.triggers,
    lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null,
    lastRunStatus: a.lastRunStatus ?? null,
    runCount: a.runCount,
    createdAt: a.createdAt.toISOString(),
  };
}

/**
 * Device "Workflows" tab: attach/list/enable/detach templates on one device.
 * Routes (all -> this Lambda):
 *   GET    /devices/{id}/workflows
 *   POST   /devices/{id}/workflows                        body AttachWorkflowInput
 *   PATCH  /devices/{id}/workflows/{attachmentId}         body {enabled}
 *   DELETE /devices/{id}/workflows/{attachmentId}
 * ("Run now" is POST /devices/{id}/workflows/{attachmentId}/run — added with the
 * run-execution path in M3.) Ownership: the device must belong to a workspace in
 * the caller's org (same check as device-sessions.ts).
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const deviceId = event.pathParameters?.id;
  const attachmentId = event.pathParameters?.attachmentId;

  if (!deviceId) return notFound('Device "" not found');

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'PATCH' || method === 'DELETE';
    auth = await requireOrgContext(event, writeMethod ? ['owner', 'admin', 'member'] : undefined);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);

  // Load the device (with its model's io_capabilities) inside the caller's org.
  const [device] = await db
    .select({
      id: schema.devices.id,
      workspaceId: schema.devices.workspaceId,
      serial: schema.devices.serial,
      name: schema.devices.name,
      ioCapabilities: schema.deviceModels.ioCapabilities,
    })
    .from(schema.devices)
    .innerJoin(schema.deviceModels, eq(schema.deviceModels.id, schema.devices.deviceModelId))
    .where(
      and(
        eq(schema.devices.id, deviceId),
        inArray(schema.devices.workspaceId, orgWorkspaceIds),
      ),
    );
  if (!device) return notFound(`Device "${deviceId}" not found`);

  switch (routeKey) {
    case 'GET /devices/{id}/workflows': {
      const rows = await db
        .select({
          attachment: schema.workflowAttachments,
          templateName: schema.workflowTemplates.name,
          templateSlug: schema.workflowTemplates.slug,
          publishedVersion: schema.workflowTemplates.publishedVersion,
          currentVersion: schema.workflowTemplates.currentVersion,
        })
        .from(schema.workflowAttachments)
        .innerJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.workflowAttachments.templateId),
        )
        .where(eq(schema.workflowAttachments.deviceId, deviceId))
        .orderBy(asc(schema.workflowAttachments.createdAt));
      return ok({
        attachments: rows.map((r) =>
          mapAttachment(r.attachment, {
            name: r.templateName,
            slug: r.templateSlug,
            publishedVersion: r.publishedVersion,
            currentVersion: r.currentVersion,
          }),
        ),
      });
    }

    case 'POST /devices/{id}/workflows': {
      const parsed = attachWorkflowSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const { templateId, pinnedVersion, triggers } = parsed.data;

      // Template must belong to the caller's org.
      const template = await db.query.workflowTemplates.findFirst({
        where: and(
          eq(schema.workflowTemplates.id, templateId),
          eq(schema.workflowTemplates.organizationId, auth.organizationId),
        ),
      });
      if (!template) return badRequest(`Workflow template "${templateId}" not found`);

      // Resolve the version that will run: pinned, else the published version.
      const resolvedVersion = pinnedVersion ?? template.publishedVersion;
      if (resolvedVersion == null) {
        return badRequest('Template has no published version; publish it or pin a version.');
      }
      const [versionRow] = await db
        .select({ definition: schema.workflowTemplateVersions.definition })
        .from(schema.workflowTemplateVersions)
        .where(
          and(
            eq(schema.workflowTemplateVersions.templateId, templateId),
            eq(schema.workflowTemplateVersions.version, resolvedVersion),
          ),
        );
      if (!versionRow) return badRequest(`Version ${resolvedVersion} not found for this template`);

      // Capability compatibility vs the device model.
      const required = computeRequiredCapabilities(versionRow.definition as WorkflowDefinition);
      const missing = missingCapabilities(required, device.ioCapabilities);
      if (missing.length > 0) {
        return errorResponse(
          400,
          'INCOMPATIBLE',
          `Device is missing required capabilities: ${missing.join(', ')}`,
          { missing },
        );
      }

      // One attachment per (device, template).
      const existing = await db.query.workflowAttachments.findFirst({
        where: and(
          eq(schema.workflowAttachments.deviceId, deviceId),
          eq(schema.workflowAttachments.templateId, templateId),
        ),
        columns: { id: true },
      });
      if (existing) return conflict('This template is already attached to the device');

      const [row] = await db
        .insert(schema.workflowAttachments)
        .values({
          deviceId,
          templateId,
          pinnedVersion: pinnedVersion ?? null,
          enabled: true,
          triggers,
          createdByUserId: auth.userId,
        })
        .returning();
      return created({ attachment: mapAttachment(row, template) });
    }

    case 'PATCH /devices/{id}/workflows/{attachmentId}': {
      if (!attachmentId) return badRequest('attachment id required');
      const body = safeJson(event.body) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') return badRequest('enabled (boolean) is required');

      const [updated] = await db
        .update(schema.workflowAttachments)
        .set({ enabled: body.enabled, updatedAt: new Date() })
        .where(
          and(
            eq(schema.workflowAttachments.id, attachmentId),
            eq(schema.workflowAttachments.deviceId, deviceId),
          ),
        )
        .returning();
      if (!updated) return notFound(`Attachment "${attachmentId}" not found`);
      const template = await db.query.workflowTemplates.findFirst({
        where: eq(schema.workflowTemplates.id, updated.templateId),
        columns: { name: true, slug: true, publishedVersion: true, currentVersion: true },
      });
      return ok({
        attachment: mapAttachment(
          updated,
          template ?? { name: '', slug: '', publishedVersion: null, currentVersion: 1 },
        ),
      });
    }

    case 'DELETE /devices/{id}/workflows/{attachmentId}': {
      if (!attachmentId) return badRequest('attachment id required');
      const deleted = await db
        .delete(schema.workflowAttachments)
        .where(
          and(
            eq(schema.workflowAttachments.id, attachmentId),
            eq(schema.workflowAttachments.deviceId, deviceId),
          ),
        )
        .returning({ id: schema.workflowAttachments.id });
      if (deleted.length === 0) return notFound(`Attachment "${attachmentId}" not found`);
      return { statusCode: 204, body: '' };
    }

    case 'POST /devices/{id}/workflows/{attachmentId}/run': {
      if (!attachmentId) return badRequest('attachment id required');
      // Context is optional; the FE sends a ManualRunContext, but a bare "run now"
      // is also valid (defaults to a recent telemetry window).
      const rawBody = safeJson(event.body);
      const hasContext = rawBody && Object.keys(rawBody).length > 0;
      let context: ManualRunContext | undefined;
      if (hasContext) {
        const parsed = manualRunContextSchema.safeParse(rawBody);
        if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid run context');
        context = parsed.data;
      }

      const attachment = await db.query.workflowAttachments.findFirst({
        where: and(
          eq(schema.workflowAttachments.id, attachmentId),
          eq(schema.workflowAttachments.deviceId, deviceId),
        ),
      });
      if (!attachment) return notFound(`Attachment "${attachmentId}" not found`);

      const template = await db.query.workflowTemplates.findFirst({
        where: eq(schema.workflowTemplates.id, attachment.templateId),
      });
      if (!template) return notFound('Workflow template not found');

      const resolvedVersion = attachment.pinnedVersion ?? template.publishedVersion;
      if (resolvedVersion == null) {
        return badRequest('Template has no runnable version');
      }
      const [ver] = await db
        .select({ definition: schema.workflowTemplateVersions.definition })
        .from(schema.workflowTemplateVersions)
        .where(
          and(
            eq(schema.workflowTemplateVersions.templateId, attachment.templateId),
            eq(schema.workflowTemplateVersions.version, resolvedVersion),
          ),
        );
      if (!ver) return badRequest(`Version ${resolvedVersion} not found for this template`);

      const triggerContext = await buildManualContext(deviceId, context);
      await fireWorkflowRun({
        workspaceId: device.workspaceId,
        deviceId,
        attachmentId: attachment.id,
        templateId: attachment.templateId,
        templateVersion: resolvedVersion,
        definition: ver.definition as WorkflowDefinition,
        trigger: 'manual',
        triggerContext,
      });

      // Reload the attachment so the response reflects the bumped run stats.
      const fresh = await db.query.workflowAttachments.findFirst({
        where: eq(schema.workflowAttachments.id, attachment.id),
      });
      return ok({ attachment: mapAttachment(fresh ?? attachment, template) });
    }

    default:
      return methodNotAllowed(method, 'GET, POST, PATCH, DELETE');
  }
};

// Resolve a "Run now" context into the run's triggerContext, always including a
// concrete telemetry window (the inline runner reads triggerContext.window).
async function buildManualContext(
  deviceId: string,
  context: ManualRunContext | undefined,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const recentWindow = () => ({
    from: new Date(now.getTime() - 15 * 60_000).toISOString(),
    to: now.toISOString(),
  });

  if (!context) {
    return { type: 'manual', window: recentWindow() };
  }

  // Both media trigger types resolve the same way downstream (the run's
  // `sessionId` becomes a device_session binding); `segment_uploaded` just
  // narrows it to one chunk via `seq`. Deliberately NO explicit `window` here:
  // the dispatcher then derives the telemetry window from the resolved segment
  // timeline (production.ts resolveTriggeredWindow), which is exact — the
  // session row's own started/ended can lag the segments that actually landed.
  if (context.triggerType === 'session_completed' || context.triggerType === 'segment_uploaded') {
    const session = await db.query.mediaSessions.findFirst({
      where: and(
        eq(schema.mediaSessions.id, context.sessionId),
        eq(schema.mediaSessions.deviceId, deviceId),
      ),
      columns: { id: true, streamKey: true, startedAt: true, endedAt: true },
    });
    return {
      type: context.triggerType,
      sessionId: context.sessionId,
      streamKey: session?.streamKey ?? null,
      startedAt: session?.startedAt?.toISOString() ?? null,
      endedAt: session?.endedAt?.toISOString() ?? null,
      // undefined = the session's newest segment (see media-session-input.ts).
      ...(context.triggerType === 'segment_uploaded' ? { seq: context.seq ?? null } : {}),
    };
  }

  if (context.triggerType === 'telemetry_condition') {
    const window =
      context.window.mode === 'range'
        ? {
            from: new Date(context.window.from).toISOString(),
            to: new Date(context.window.to).toISOString(),
          }
        : await lastNWindow(deviceId, context.window.n);
    return { type: 'telemetry_condition', window };
  }

  // Schedule selection: pass the media selection through with NO explicit
  // window, so the dispatcher derives the telemetry window from the sessions it
  // actually resolves (production.ts resolveTriggeredWindow). A telemetry-only
  // graph then falls back to the standard 15-minute window — the media
  // selection has nothing to say about telemetry.
  return { type: 'schedule', selection: context.selection };
}

// Concrete window spanning the device's most recent N telemetry readings.
async function lastNWindow(
  deviceId: string,
  n: number,
): Promise<{ from: string; to: string }> {
  const rows = await db
    .select({ ts: schema.telemetryReadings.ts })
    .from(schema.telemetryReadings)
    .where(eq(schema.telemetryReadings.deviceId, deviceId))
    .orderBy(desc(schema.telemetryReadings.ts))
    .limit(Math.max(1, n));
  const now = new Date();
  if (rows.length === 0) {
    return { from: new Date(now.getTime() - Math.max(1, n) * 1000).toISOString(), to: now.toISOString() };
  }
  const times = rows.map((r) => r.ts.getTime());
  return {
    from: new Date(Math.min(...times)).toISOString(),
    to: new Date(Math.max(...times)).toISOString(),
  };
}

function safeJson(body: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(body ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

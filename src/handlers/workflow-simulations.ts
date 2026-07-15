import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, created, errorResponse, methodNotAllowed, notFound } from '../utils/responses';
import { dispatchV2Run, materializeHistoryInputs } from '../services/workflow-engine-v2';
import { validateDefinitionForPublish } from '../workflows/validate';
import {
  buildSimulationManifest,
  createSimulationSchema,
  createSimulationUploadSchema,
  engineTargetForDefinition,
  SIM_UPLOAD_EXPIRES_SECONDS,
  SIM_UPLOAD_MAX_BYTES,
  simulationProgressResponse,
  simulationSessionKey,
  simulationWindow,
  toManifestInputs,
  uploadPrefixForOrg,
  validateSimulationBindings,
  type ResolvedRecording,
  type SimulationBinding,
  type SimulationBindingIssue,
} from '../workflows/simulations';

/**
 * Simulator API (M3, architecture §5): a simulation is a REAL run of the real
 * v2 engine over the editor's current DRAFT definition (no publish required),
 * with per-source-node input bindings. Routes (both -> this Lambda):
 *
 *   POST /workflow-templates/{id}/simulations          create + dispatch
 *   POST /workflow-templates/{id}/simulations/uploads  presigned POST for video/CSV
 *
 * The draft is validated with the SAME strict publish validator (publish stays
 * the only gate that matters; the simulator surfaces the identical issues).
 * Dispatch is direct (Lambda invoke / RunTask), not via the SQS run queue: the
 * caller is interactive and wants dispatch errors synchronously, and the
 * watchdog + always-written result.json cover everything after launch.
 *
 * Run rows: mode='simulation', trigger='simulation', executionMode
 * lambda|fargate (the v2 dispatch target), templateVersion = the template's
 * currentVersion (what the editor had loaded), deviceId/workspaceId from the
 * bound device when there is one, else NULL (migration 0015).
 */

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;

function safeJson(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return {};
  }
}

function bindingIssuesResponse(issues: SimulationBindingIssue[]): APIGatewayProxyResultV2 {
  return errorResponse(400, 'SIMULATION_BINDING_INVALID', 'Simulation input bindings are invalid', {
    issues,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  const templateId = event.pathParameters?.id;

  let auth;
  try {
    auth = await requireOrgContext(event, ['owner', 'admin', 'member']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgId = auth.organizationId;
  if (!BUCKET) throw new Error('workflow-simulations: BUCKET_NAME is not configured');
  if (!templateId) return badRequest('template id required');

  const template = await db.query.workflowTemplates.findFirst({
    where: and(
      eq(schema.workflowTemplates.id, templateId),
      eq(schema.workflowTemplates.organizationId, orgId),
    ),
  });
  if (!template) return notFound(`Workflow template "${templateId}" not found`);

  switch (routeKey) {
    case 'POST /workflow-templates/{id}/simulations/uploads': {
      const parsed = createSimulationUploadSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const { kind, filename, contentType } = parsed.data;
      const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'upload';
      const key = `${uploadPrefixForOrg(orgId)}${new Date().toISOString().slice(0, 10)}/${randomUUID()}/${safeName}`;
      const maxBytes = SIM_UPLOAD_MAX_BYTES[kind];
      const post = await createPresignedPost(s3, {
        Bucket: BUCKET,
        Key: key,
        Expires: SIM_UPLOAD_EXPIRES_SECONDS,
        Conditions: [['content-length-range', 1, maxBytes]],
        Fields: contentType ? { 'Content-Type': contentType } : undefined,
      });
      return created({
        upload: {
          key,
          url: post.url,
          fields: post.fields,
          expiresInSeconds: SIM_UPLOAD_EXPIRES_SECONDS,
          maxBytes,
        },
      });
    }

    case 'POST /workflow-templates/{id}/simulations': {
      const parsed = createSimulationSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const bindings = parsed.data.bindings;

      // Strict publish validation on the draft (also upgrades v1 -> v2); the
      // simulator surfaces the exact issues publish would.
      const { issues, definition } = validateDefinitionForPublish(parsed.data.definition);
      if (issues.length > 0) {
        return errorResponse(400, 'WORKFLOW_VALIDATION_FAILED', 'Workflow definition failed publish validation', {
          issues,
        });
      }

      const bindingIssues = validateSimulationBindings(definition, bindings, orgId);
      if (bindingIssues.length > 0) return bindingIssuesResponse(bindingIssues);

      // Resolve recording bindings to completed, org-owned recordings.
      const recordingIds = Object.values(bindings)
        .filter((b): b is Extract<SimulationBinding, { kind: 'recording' }> => b.kind === 'recording')
        .map((b) => b.recordingId);
      const recordings = new Map<string, ResolvedRecording & { deviceId: string; workspaceId: string }>();
      if (recordingIds.length > 0) {
        const rows = await db
          .select({
            id: schema.recordings.id,
            s3Key: schema.recordings.s3Key,
            startedAt: schema.recordings.startedAt,
            captureStartedAt: schema.recordings.captureStartedAt,
            deviceId: schema.recordings.deviceId,
            workspaceId: schema.devices.workspaceId,
          })
          .from(schema.recordings)
          .innerJoin(schema.devices, eq(schema.devices.id, schema.recordings.deviceId))
          .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.devices.workspaceId))
          .where(
            and(
              inArray(schema.recordings.id, recordingIds),
              eq(schema.workspaces.organizationId, orgId),
              isNotNull(schema.recordings.s3Key),
            ),
          );
        for (const r of rows) {
          recordings.set(r.id, {
            s3Key: r.s3Key as string,
            recordingId: r.id,
            recordingStartedAt: r.startedAt ? r.startedAt.toISOString() : null,
            captureStartedAt: r.captureStartedAt ? r.captureStartedAt.toISOString() : null,
            deviceId: r.deviceId,
            workspaceId: r.workspaceId,
          });
        }
        const missing = recordingIds.filter((id) => !recordings.has(id));
        if (missing.length > 0) {
          return bindingIssuesResponse(
            missing.map((id) => ({ message: `Recording "${id}" not found (or has no stored media)` })),
          );
        }
      }

      // Resolve the run-level device: the telemetry device when bound (the
      // telemetry_history executor reads ctx.deviceId), else the single
      // recording device, else none (upload-only simulation).
      const telemetryDeviceIds = [
        ...new Set(
          Object.values(bindings)
            .filter((b): b is Extract<SimulationBinding, { kind: 'device_telemetry' }> => b.kind === 'device_telemetry')
            .map((b) => b.deviceId),
        ),
      ];
      let deviceId: string | null = null;
      let workspaceId: string | null = null;
      if (telemetryDeviceIds.length === 1) {
        const device = await db
          .select({ id: schema.devices.id, workspaceId: schema.devices.workspaceId })
          .from(schema.devices)
          .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.devices.workspaceId))
          .where(and(eq(schema.devices.id, telemetryDeviceIds[0]), eq(schema.workspaces.organizationId, orgId)));
        if (device.length === 0) {
          return bindingIssuesResponse([{ message: `Device "${telemetryDeviceIds[0]}" not found` }]);
        }
        deviceId = device[0].id;
        workspaceId = device[0].workspaceId;
      } else {
        const recordingDevices = [...new Set([...recordings.values()].map((r) => r.deviceId))];
        if (recordingDevices.length === 1) {
          const rec = [...recordings.values()][0];
          deviceId = rec.deviceId;
          workspaceId = rec.workspaceId;
        }
      }

      const target = engineTargetForDefinition(definition);
      const [run] = await db
        .insert(schema.workflowRuns)
        .values({
          workspaceId,
          deviceId,
          attachmentId: null,
          templateId: template.id,
          templateVersion: template.currentVersion,
          definition,
          trigger: 'simulation',
          triggerContext: { type: 'simulation', bindings },
          status: 'running',
          executionMode: target,
          mode: 'simulation',
          metrics: {},
        })
        .returning();

      const window = simulationWindow(bindings);
      let inputs = toManifestInputs(bindings, recordings);
      if (target === 'fargate') {
        // M4 container telemetry seam: the engine task role is DB-free, so
        // history bindings are pre-read here and swapped for materialized
        // inputs/<nodeId>/records.jsonl objects (Lambda runs read directly).
        try {
          inputs = await materializeHistoryInputs({
            runId: run.id,
            definition,
            inputs,
            deviceId,
            window,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await db
            .update(schema.workflowRuns)
            .set({ status: 'failed', endedAt: new Date(), error: `Failed to materialize inputs: ${message}` })
            .where(eq(schema.workflowRuns.id, run.id));
          return errorResponse(502, 'SIMULATION_DISPATCH_FAILED', 'Failed to start the simulation engine', {
            runId: run.id,
            message,
          });
        }
      }

      const manifest = buildSimulationManifest({
        runId: run.id,
        orgId,
        bucket: BUCKET,
        definition,
        deviceId,
        inputs,
        window,
        target,
      });

      try {
        // Fargate simulations route through the warm session for this
        // editing session (org+template); Lambda runs are sub-second and
        // never need one. Warm-path failures fall back to a cold task
        // inside dispatchV2Run.
        await dispatchV2Run(run.id, {
          target,
          manifest,
          ...(target === 'fargate' ? { sessionKey: simulationSessionKey(orgId, template.id) } : {}),
        });
      } catch (err) {
        // dispatchV2Run already flipped the run row to failed.
        return errorResponse(502, 'SIMULATION_DISPATCH_FAILED', 'Failed to start the simulation engine', {
          runId: run.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      return created({
        run: {
          id: run.id,
          status: run.status,
          mode: run.mode,
          startedAt: run.startedAt.toISOString(),
          templateId: template.id,
          templateVersion: template.currentVersion,
          engineTarget: target,
          deviceId,
          workspaceId,
        },
        progress: simulationProgressResponse(orgId, run.id),
      });
    }

    default:
      return methodNotAllowed(method, 'POST');
  }
};

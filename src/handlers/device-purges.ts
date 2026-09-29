import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
  requireOrgWideContext,
} from '../middleware/auth';
import type { OrgAuthContext } from '../types/index';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { enqueueModelJob } from '../services/model-jobs';
import { isStalled, normaliseScopes } from '../services/device-purge-rules';
import { accepted, badRequest, errorResponse, notFound, ok } from '../utils/responses';
import { isoSql, tsParam, uuidParam } from '../utils/sql';
import { uuidv7 } from '../utils/uuidv7';

/**
 * `/devices/{id}/purges` (plans/device-wf-data-delete, Phase 1 §1.5). Served
 * from the devices Lambda (no new function: the stack is near the
 * CloudFormation resource cap) but with its own gates, because the POST is
 * organization-wide the way a transfer is: a workspace-scoped session token
 * is refused whatever its role, and only owner|admin may ask, matching every
 * other destructive device operation.
 *
 *   GET  .../purges/preview  counts per scope, for the confirmation dialog
 *   POST .../purges          202 + the row; the queue worker does the work
 *   GET  .../purges          latest first (audit, "last purged")
 *   GET  .../purges/{purgeId} the row; the page polls it
 *
 * The device is resolved through the caller's workspace scope exactly as
 * `DELETE /devices/{id}` does: a foreign device is a 404, never a 403.
 */

const LIST_LIMIT_DEFAULT = 10;
const LIST_LIMIT_MAX = 20;

type PurgeRow = typeof schema.devicePurges.$inferSelect;

function purgeView(row: PurgeRow) {
  return { ...row, stalled: isStalled(row) };
}

async function ownsDevice(auth: OrgAuthContext, deviceId: string): Promise<{ workspaceId: string } | null> {
  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return null;
  const row = await db.query.devices.findFirst({
    where: and(eq(schema.devices.id, deviceId), inArray(schema.devices.workspaceId, orgWorkspaceIds)),
    columns: { id: true, workspaceId: true },
  });
  return row ? { workspaceId: row.workspaceId } : null;
}

export async function handleDevicePurgeRoutes(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  deviceId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!deviceId) return badRequest('device id required in path');
  const isCreate = routeKey === 'POST /devices/{id}/purges';

  let auth: OrgAuthContext;
  try {
    auth = isCreate
      ? await requireOrgWideContext(event, ['owner', 'admin'])
      : await requireOrgContext(event, ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const device = await ownsDevice(auth, deviceId);
  if (!device) return notFound(`Device "${deviceId}" not found`);

  if (isCreate) return createPurge(event, auth, deviceId, device.workspaceId);
  if (routeKey === 'GET /devices/{id}/purges/preview') return preview(deviceId);
  if (routeKey === 'GET /devices/{id}/purges') return list(event, deviceId);
  if (routeKey === 'GET /devices/{id}/purges/{purgeId}') {
    const purgeId = event.pathParameters?.purgeId;
    if (!purgeId) return badRequest('purge id required in path');
    const row = await db.query.devicePurges.findFirst({
      where: and(eq(schema.devicePurges.id, purgeId), eq(schema.devicePurges.deviceId, deviceId)),
    });
    if (!row) return notFound(`Purge "${purgeId}" not found`);
    return ok({ purge: purgeView(row) });
  }
  return notFound('Route not found');
}

async function createPurge(
  event: APIGatewayProxyEventV2,
  auth: OrgAuthContext,
  deviceId: string,
  workspaceId: string,
): Promise<APIGatewayProxyResultV2> {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  const scopes = normaliseScopes((body as { scopes?: unknown })?.scopes);
  if ('error' in scopes) return badRequest(scopes.error);

  // A cross-organization handover in flight detaches attachments itself and
  // moves the device out from under the purge; one at a time.
  const offer = await db.query.deviceTransferOffers.findFirst({
    where: and(
      eq(schema.deviceTransferOffers.deviceId, deviceId),
      eq(schema.deviceTransferOffers.status, 'pending'),
      sql`${schema.deviceTransferOffers.expiresAt} > now()`,
    ),
    columns: { id: true },
  });
  if (offer) {
    return errorResponse(
      409,
      'TRANSFER_PENDING',
      'A transfer offer for this device is pending. Cancel it, or wait for it to resolve, before purging.',
    );
  }

  // One live purge per device. A `running` row whose lease died long ago is
  // an abandoned worker (Lambda killed mid-chunk past SQS's retries); it is
  // closed here so the operator is not locked out by a ghost.
  const active = await db.query.devicePurges.findFirst({
    where: and(
      eq(schema.devicePurges.deviceId, deviceId),
      inArray(schema.devicePurges.status, ['queued', 'running']),
    ),
    orderBy: desc(schema.devicePurges.requestedAt),
  });
  if (active) {
    if (!isStalled(active)) {
      return errorResponse(409, 'PURGE_IN_PROGRESS', 'A purge for this device is already in progress.', {
        purgeId: active.id,
      });
    }
    await db
      .update(schema.devicePurges)
      .set({ status: 'failed', error: 'abandoned', finishedAt: new Date(), leaseUntil: null })
      .where(and(eq(schema.devicePurges.id, active.id), inArray(schema.devicePurges.status, ['queued', 'running'])));
  }

  const now = new Date();
  const [row] = await db
    .insert(schema.devicePurges)
    .values({
      id: uuidv7(now.getTime()),
      deviceId,
      workspaceId,
      organizationId: auth.organizationId,
      scopes,
      status: 'queued',
      cutoff: now,
      counts: {},
      requestedBy: auth.userId ?? auth.apiKeyId ?? 'unknown',
      requestedAt: now,
    })
    .returning();

  try {
    await enqueueModelJob({ kind: 'device_purge', purgeId: row.id });
  } catch (err) {
    console.error('[device-purge] enqueue failed', { purgeId: row.id, err });
    await db
      .update(schema.devicePurges)
      .set({ status: 'failed', error: 'DISPATCH_FAILED', finishedAt: new Date() })
      .where(eq(schema.devicePurges.id, row.id));
    return errorResponse(
      502,
      'PURGE_DISPATCH_FAILED',
      'The purge was recorded but could not be queued. Nothing was deleted; try again.',
      { purgeId: row.id },
    );
  }
  console.log('[device-purge] queued', { purgeId: row.id, deviceId, scopes, requestedBy: row.requestedBy });
  return accepted({ purge: purgeView(row) });
}

async function list(event: APIGatewayProxyEventV2, deviceId: string): Promise<APIGatewayProxyResultV2> {
  const raw = Number(event.queryStringParameters?.limit ?? LIST_LIMIT_DEFAULT);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), LIST_LIMIT_MAX) : LIST_LIMIT_DEFAULT;
  const rows = await db.query.devicePurges.findMany({
    where: eq(schema.devicePurges.deviceId, deviceId),
    orderBy: desc(schema.devicePurges.requestedAt),
    limit,
  });
  return ok({ purges: rows.map(purgeView) });
}

/**
 * What a purge would remove, for the dialog. Four indexed counts plus the
 * readings' time span: a `count(*)` over `telemetry_readings` is unaffordable
 * (millions of rows, ~45 s Data API ceiling), while min/max come off the
 * (device_id, ts, metric) index per partition. Sequential: the Data API
 * driver allows no concurrent statements.
 */
async function preview(deviceId: string): Promise<APIGatewayProxyResultV2> {
  const device = uuidParam(deviceId);
  const now = tsParam(new Date().toISOString());
  const count = async (q: ReturnType<typeof sql>): Promise<number> => {
    const res = await db.execute<{ n: number | string }>(q);
    return Number(res.rows[0]?.n ?? 0);
  };
  const attachments = await count(
    sql`select count(*)::int as n from ${schema.workflowAttachments} where ${schema.workflowAttachments.deviceId} = ${device}`,
  );
  const runs = await count(
    sql`select count(*)::int as n from ${schema.workflowRuns} where ${schema.workflowRuns.deviceId} = ${device} and ${schema.workflowRuns.mode} = 'production' and ${schema.workflowRuns.startedAt} < ${now}`,
  );
  const telemetrySessions = await count(
    sql`select count(*)::int as n from ${schema.telemetrySessions} where ${schema.telemetrySessions.deviceId} = ${device} and ${schema.telemetrySessions.startedAt} < ${now}`,
  );
  const mediaSessions = await count(
    sql`select count(*)::int as n from ${schema.mediaSessions} where ${schema.mediaSessions.deviceId} = ${device} and ${schema.mediaSessions.startedAt} < ${now}`,
  );
  const span = await db.execute<{ from: string | null; to: string | null }>(
    sql`select ${isoSql(sql`min(${schema.telemetryReadings.ts})`)} as "from", ${isoSql(sql`max(${schema.telemetryReadings.ts})`)} as "to" from ${schema.telemetryReadings} where ${schema.telemetryReadings.deviceId} = ${device}`,
  );
  return ok({
    workflows: { attachments, runs },
    telemetry: {
      sessions: telemetrySessions,
      readingsFrom: span.rows[0]?.from ?? null,
      readingsTo: span.rows[0]?.to ?? null,
    },
    media: { sessions: mediaSessions },
  });
}

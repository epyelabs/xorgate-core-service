import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { DEVICE_ROUTABLE_TYPES, isDeviceRoutableType } from '../services/webhooks/catalog';
import { badRequest, methodNotAllowed, notFound, ok } from '../utils/responses';
import { textArrayParam } from '../utils/sql';

/**
 * A device's webhook routes (plans/xorgate-webhooks README D1, the device
 * Settings -> Webhooks sub-tab): which endpoints receive which of the
 * device's presence and session events.
 *
 *   GET /devices/{id}/webhooks  -> { routes: [{ endpointId, endpointName, eventTypes }] }
 *   PUT /devices/{id}/webhooks     { routes: [{ endpointId, eventTypes }] }  (a bare array
 *                                  is accepted too) -> the new set, same shape as GET.
 *                                  Replaces the whole set; [] clears it.
 *
 * Workspace-scoped like the device itself (`resolveWorkspaceScope`, so a
 * workspace-scoped `xgs_` token may manage its own devices' routes, README
 * Q9): owner/admin/member read, owner/admin write. Cross-org devices are 404.
 * Cloud-side only, never part of the device config document.
 *
 * Served by WebhooksFn (handlers/webhooks.ts routes here).
 */

const MAX_ROUTES = 20;

interface RouteInput {
  endpointId: string;
  eventTypes: string[];
}

function parseRoutes(body: string | undefined): RouteInput[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? 'null');
  } catch {
    return 'Invalid JSON body';
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { routes?: unknown }).routes)
      ? (parsed as { routes: unknown[] }).routes
      : null;
  if (!list) return 'body must be { "routes": [{ "endpointId", "eventTypes": [...] }] }';
  if (list.length > MAX_ROUTES) return `at most ${MAX_ROUTES} routes per device`;
  const out: RouteInput[] = [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const r = item as { endpointId?: unknown; eventTypes?: unknown };
    if (!r || typeof r.endpointId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.endpointId)) {
      return `routes[${i}].endpointId must be a webhook endpoint id`;
    }
    if (seen.has(r.endpointId)) return `routes[${i}]: endpoint ${r.endpointId} appears twice; merge its eventTypes`;
    seen.add(r.endpointId);
    if (!Array.isArray(r.eventTypes) || r.eventTypes.length === 0) {
      return `routes[${i}].eventTypes must be a non-empty array`;
    }
    for (const t of r.eventTypes) {
      if (!isDeviceRoutableType(t)) {
        return `routes[${i}].eventTypes: "${String(t)}" is not a device event type (one of: ${DEVICE_ROUTABLE_TYPES.join(', ')})`;
      }
    }
    out.push({ endpointId: r.endpointId, eventTypes: [...new Set(r.eventTypes as string[])] });
  }
  return out;
}

async function currentRoutes(deviceId: string) {
  const r = schema.webhookRoutes;
  const e = schema.webhookEndpoints;
  return db
    .select({ endpointId: r.endpointId, endpointName: e.name, eventTypes: r.eventTypes })
    .from(r)
    .innerJoin(e, eq(e.id, r.endpointId))
    .where(eq(r.deviceId, deviceId))
    .orderBy(asc(e.name));
}

export async function deviceWebhooksHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  if (method !== 'GET' && method !== 'PUT') return methodNotAllowed(method, 'GET, PUT');
  const deviceId = event.pathParameters?.id ?? '';

  let auth;
  try {
    auth = await requireOrgContext(event, method === 'GET' ? ['owner', 'admin', 'member'] : ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const workspaceIds = await resolveWorkspaceScope(auth);
  if (workspaceIds.length === 0 || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    return notFound(`Device "${deviceId}" not found`);
  }
  const device = await db.query.devices.findFirst({
    where: and(eq(schema.devices.id, deviceId), inArray(schema.devices.workspaceId, workspaceIds)),
    columns: { id: true, workspaceId: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

  if (method === 'GET') return ok({ routes: await currentRoutes(device.id) });

  const routes = parseRoutes(event.body);
  if (typeof routes === 'string') return badRequest(routes);
  if (routes.length > 0) {
    const ids = routes.map((r) => r.endpointId);
    const found = await db
      .select({ id: schema.webhookEndpoints.id })
      .from(schema.webhookEndpoints)
      .where(
        and(
          inArray(schema.webhookEndpoints.id, ids),
          eq(schema.webhookEndpoints.organizationId, auth.organizationId),
        ),
      );
    const known = new Set(found.map((f) => f.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) return badRequest(`unknown webhook endpoint(s) in this organization: ${missing.join(', ')}`);
  }

  // Replace the set atomically. Sequential statements: the Data API forbids
  // concurrent ones on a transaction handle.
  await db.transaction(async (tx) => {
    await tx.delete(schema.webhookRoutes).where(eq(schema.webhookRoutes.deviceId, device.id));
    for (const r of routes) {
      await tx.insert(schema.webhookRoutes).values({
        organizationId: auth.organizationId,
        deviceId: device.id,
        workspaceId: device.workspaceId,
        endpointId: r.endpointId,
        eventTypes: textArrayParam(r.eventTypes),
      });
    }
  });
  return ok({ routes: await currentRoutes(device.id) });
}

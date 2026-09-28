import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { AuthError, authErrorResponse, requireOrgContext, requireOrgWideContext } from '../middleware/auth';
import type { OrgAuthContext } from '../types/index';
import { apiHandler } from '../utils/api-handler';
import { pageMeta, parseListParams } from '../utils/list-params';
import {
  accepted,
  badRequest,
  conflict,
  created,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { routeKey as canonicalRouteKey } from '../utils/route';
import { tsParam } from '../utils/sql';
import { uuidv7 } from '../utils/uuidv7';
import { PING_TYPE, WEBHOOK_API_VERSION, WEBHOOK_EVENT_CATALOG } from '../services/webhooks/catalog';
import { enqueueDelivery, LEASE_SECONDS } from '../services/webhooks/deliver';
import { dispatchWebhookEvents, emitWebhookEvent } from '../services/webhooks/emit';
import { createEndpointSecret, deleteEndpointSecret, rotateEndpointSecret } from '../services/webhooks/secrets';
import { endpointUrlProblem } from '../services/webhooks/url-policy';
import { deviceWebhooksHandler } from './device-webhooks';

/**
 * Webhook endpoints (plans/xorgate-webhooks, Phase 1, README D7). One Lambda
 * for the whole surface, including the device routes (handled in
 * device-webhooks.ts), to keep the API stack under CloudFormation's
 * 500-resource limit.
 *
 * Org-wide (`requireOrgWideContext`): reads any role, writes owner/admin,
 * mirroring api-keys.ts. A workspace-scoped `xgs_` token is refused here
 * (endpoints are org resources) but allowed on the device routes.
 *
 *   GET    /webhooks                                     list (shared list dialect)
 *   POST   /webhooks                                     { name, url, description? } -> 201 + secret (once)
 *   GET    /webhooks/{id}                                row + deliveryStats (last 24 h)
 *   PATCH  /webhooks/{id}                                name | url | description | enabled
 *   DELETE /webhooks/{id}                                row (cascade) + secret -> 204
 *   POST   /webhooks/{id}/test                           ping -> 202 { eventId }
 *   POST   /webhooks/{id}/rotate-secret                  new secret (once); previous valid 24 h
 *   GET    /webhooks/{id}/deliveries                     paginated, newest first, ?status=
 *   GET    /webhooks/{id}/deliveries/{deliveryId}        full row + event envelope
 *   POST   /webhooks/{id}/deliveries/{deliveryId}/redeliver   new delivery row -> 202
 *   GET    /webhook-event-types                          the catalog with samples
 *   GET|PUT /devices/{id}/webhooks                       device-webhooks.ts
 *
 * The secret is never returned except by create and rotate-secret.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_RULE = 'name must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit';
const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'exhausted'] as const;

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(event.body ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '') + String((err as { cause?: { message?: string } })?.cause?.message ?? '');
  return /duplicate key value|unique constraint/i.test(msg);
}

async function findEndpoint(orgId: string, id: string): Promise<schema.WebhookEndpoint | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.organizationId, orgId)));
  return row;
}

async function listEndpoints(event: APIGatewayProxyEventV2, auth: OrgAuthContext): Promise<APIGatewayProxyResultV2> {
  const parsed = parseListParams(event, { sortable: ['createdAt', 'name'], defaultSort: 'createdAt' });
  if ('error' in parsed) return parsed.error;
  const e = schema.webhookEndpoints;
  const where = eq(e.organizationId, auth.organizationId);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(e).where(where);
  const sortCol = parsed.sortBy === 'name' ? e.name : e.createdAt;
  const rows = await db
    .select()
    .from(e)
    .where(where)
    .orderBy(parsed.order === 'asc' ? sortCol : desc(sortCol))
    .limit(parsed.limit)
    .offset(parsed.offset);
  return ok({ webhooks: rows, page: pageMeta(parsed, Number(total ?? 0)) });
}

async function createEndpoint(event: APIGatewayProxyEventV2, auth: OrgAuthContext): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  if (!body) return badRequest('Invalid JSON body');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!NAME_RE.test(name)) return badRequest(NAME_RULE);
  const urlProblem = endpointUrlProblem(body.url);
  if (urlProblem) return badRequest(urlProblem);
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    return badRequest('description must be a string');
  }
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) || null : null;

  let row: schema.WebhookEndpoint;
  try {
    [row] = await db
      .insert(schema.webhookEndpoints)
      .values({
        organizationId: auth.organizationId,
        name,
        url: body.url as string,
        description,
        createdBy: auth.userId,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) return conflict(`A webhook endpoint named "${name}" already exists`);
    throw err;
  }
  let secret: string;
  try {
    secret = await createEndpointSecret(auth.organizationId, row.id);
  } catch (err) {
    // No endpoint without a secret: undo the row so the name is free again.
    await db.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, row.id));
    throw err;
  }
  return created({ webhook: row, secret });
}

async function getEndpoint(endpoint: schema.WebhookEndpoint): Promise<APIGatewayProxyResultV2> {
  const d = schema.webhookDeliveries;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const counts = await db
    .select({ status: d.status, count: sql<number>`count(*)::int` })
    .from(d)
    .where(and(eq(d.endpointId, endpoint.id), sql`${d.createdAt} >= ${tsParam(since.toISOString())}`))
    .groupBy(d.status);
  const deliveryStats: Record<string, number> = { pending: 0, delivered: 0, failed: 0, exhausted: 0 };
  for (const c of counts) deliveryStats[c.status] = Number(c.count);
  return ok({ webhook: { ...endpoint, deliveryStats: { windowHours: 24, ...deliveryStats } } });
}

async function patchEndpoint(
  event: APIGatewayProxyEventV2,
  endpoint: schema.WebhookEndpoint,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  if (!body) return badRequest('Invalid JSON body');
  const set: Partial<typeof schema.webhookEndpoints.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!NAME_RE.test(name)) return badRequest(NAME_RULE);
    set.name = name;
  }
  if (body.url !== undefined) {
    const urlProblem = endpointUrlProblem(body.url);
    if (urlProblem) return badRequest(urlProblem);
    set.url = body.url as string;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') return badRequest('description must be a string or null');
    set.description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) || null : null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return badRequest('enabled must be a boolean');
    set.enabled = body.enabled;
    if (body.enabled) {
      // Re-enabling clears the disable record and the failure streak.
      set.disabledAt = null;
      set.disabledReason = null;
      set.consecutiveFailures = 0;
    } else if (endpoint.enabled) {
      set.disabledAt = new Date();
      set.disabledReason = 'manual';
    }
  }
  if (Object.keys(set).length === 0) return badRequest('nothing to update: name, url, description or enabled');
  set.updatedAt = new Date();
  try {
    const [row] = await db
      .update(schema.webhookEndpoints)
      .set(set)
      .where(eq(schema.webhookEndpoints.id, endpoint.id))
      .returning();
    return ok({ webhook: row });
  } catch (err) {
    if (isUniqueViolation(err)) return conflict(`A webhook endpoint named "${set.name}" already exists`);
    throw err;
  }
}

async function deleteEndpoint(endpoint: schema.WebhookEndpoint): Promise<APIGatewayProxyResultV2> {
  await db.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpoint.id));
  try {
    await deleteEndpointSecret(endpoint.organizationId, endpoint.id);
  } catch (err) {
    // The row is gone, so nothing can sign with it again; log and move on.
    console.error('webhooks: secret delete failed after endpoint delete', { endpointId: endpoint.id, err });
  }
  return { statusCode: 204, body: '' };
}

async function testEndpoint(endpoint: schema.WebhookEndpoint): Promise<APIGatewayProxyResultV2> {
  if (!endpoint.enabled) return conflict('This endpoint is disabled; enable it before sending a test ping');
  const eventId = await emitWebhookEvent(db, {
    organizationId: endpoint.organizationId,
    workspaceId: null,
    type: PING_TYPE,
    dedupeKey: `ping:${endpoint.id}:${uuidv7()}`,
    endpointId: endpoint.id,
    data: { message: 'Test ping from xorgate', endpointId: endpoint.id, endpointName: endpoint.name },
  });
  const dispatch = await dispatchWebhookEvents([eventId]);
  return accepted({ eventId, dispatched: dispatch.sent.length === 1 });
}

async function rotateSecret(endpoint: schema.WebhookEndpoint): Promise<APIGatewayProxyResultV2> {
  const secret = await rotateEndpointSecret(endpoint.organizationId, endpoint.id);
  const [row] = await db
    .update(schema.webhookEndpoints)
    .set({ secretVersion: sql`${schema.webhookEndpoints.secretVersion} + 1`, updatedAt: new Date() })
    .where(eq(schema.webhookEndpoints.id, endpoint.id))
    .returning();
  return ok({ webhook: row, secret, previousSecretValidForHours: 24 });
}

const deliveryColumns = () => {
  const d = schema.webhookDeliveries;
  const ev = schema.webhookEvents;
  return {
    id: d.id,
    eventId: d.eventId,
    eventType: ev.type,
    endpointId: d.endpointId,
    redeliveryOf: d.redeliveryOf,
    status: d.status,
    attempt: d.attempt,
    nextAttemptAt: d.nextAttemptAt,
    responseStatus: d.responseStatus,
    responseMs: d.responseMs,
    error: d.error,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
};

async function listDeliveries(
  event: APIGatewayProxyEventV2,
  endpoint: schema.WebhookEndpoint,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseListParams(event, {
    sortable: ['createdAt'],
    defaultSort: 'createdAt',
    statusValues: DELIVERY_STATUSES,
  });
  if ('error' in parsed) return parsed.error;
  const d = schema.webhookDeliveries;
  const where = and(eq(d.endpointId, endpoint.id), parsed.status ? eq(d.status, parsed.status) : undefined);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(d).where(where);
  const rows = await db
    .select(deliveryColumns())
    .from(d)
    .innerJoin(schema.webhookEvents, eq(schema.webhookEvents.id, d.eventId))
    .where(where)
    .orderBy(parsed.order === 'asc' ? d.createdAt : desc(d.createdAt))
    .limit(parsed.limit)
    .offset(parsed.offset);
  return ok({ deliveries: rows, page: pageMeta(parsed, Number(total ?? 0)) });
}

async function findDelivery(endpoint: schema.WebhookEndpoint, deliveryId: string | undefined) {
  if (!deliveryId || !/^[0-9a-f-]{36}$/i.test(deliveryId)) return undefined;
  const [row] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(and(eq(schema.webhookDeliveries.id, deliveryId), eq(schema.webhookDeliveries.endpointId, endpoint.id)));
  return row;
}

async function getDelivery(
  endpoint: schema.WebhookEndpoint,
  deliveryId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  const delivery = await findDelivery(endpoint, deliveryId);
  if (!delivery) return notFound(`Delivery "${deliveryId}" not found`);
  const [ev] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, delivery.eventId));
  return ok({
    delivery: {
      ...delivery,
      event: ev
        ? {
            id: ev.id,
            type: ev.type,
            apiVersion: WEBHOOK_API_VERSION,
            createdAt: ev.createdAt,
            organizationId: ev.organizationId,
            workspaceId: ev.workspaceId,
            data: ev.data,
          }
        : null,
    },
  });
}

async function redeliver(
  endpoint: schema.WebhookEndpoint,
  deliveryId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  const original = await findDelivery(endpoint, deliveryId);
  if (!original) return notFound(`Delivery "${deliveryId}" not found`);
  if (!endpoint.enabled) return conflict('This endpoint is disabled; enable it before redelivering');
  const [row] = await db
    .insert(schema.webhookDeliveries)
    .values({
      eventId: original.eventId,
      endpointId: endpoint.id,
      redeliveryOf: original.id,
      status: 'pending',
      attempt: 0,
      nextAttemptAt: sql`now() + make_interval(secs => ${sql.raw(String(LEASE_SECONDS))})`,
    })
    .returning();
  const enqueued = await enqueueDelivery({ deliveryId: row.id, attempt: 0 });
  return accepted({ delivery: row, enqueued });
}

const restHandler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const route = canonicalRouteKey(event);
  const method = event.requestContext.http.method;

  if (route.endsWith(' /devices/{id}/webhooks')) return deviceWebhooksHandler(event);

  if (route === 'GET /webhook-event-types') {
    try {
      await requireOrgContext(event);
    } catch (err) {
      if (err instanceof AuthError) return authErrorResponse(err);
      throw err;
    }
    return ok({ apiVersion: WEBHOOK_API_VERSION, eventTypes: WEBHOOK_EVENT_CATALOG });
  }

  let auth: OrgAuthContext;
  try {
    auth = await requireOrgWideContext(event, method === 'GET' ? undefined : ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  if (route === 'GET /webhooks') return listEndpoints(event, auth);
  if (route === 'POST /webhooks') return createEndpoint(event, auth);

  const id = event.pathParameters?.id ?? '';
  const endpoint = await findEndpoint(auth.organizationId, id);
  if (!endpoint) return notFound(`Webhook endpoint "${id}" not found`);
  const deliveryId = event.pathParameters?.deliveryId;

  switch (route) {
    case 'GET /webhooks/{id}':
      return getEndpoint(endpoint);
    case 'PATCH /webhooks/{id}':
      return patchEndpoint(event, endpoint);
    case 'DELETE /webhooks/{id}':
      return deleteEndpoint(endpoint);
    case 'POST /webhooks/{id}/test':
      return testEndpoint(endpoint);
    case 'POST /webhooks/{id}/rotate-secret':
      return rotateSecret(endpoint);
    case 'GET /webhooks/{id}/deliveries':
      return listDeliveries(event, endpoint);
    case 'GET /webhooks/{id}/deliveries/{deliveryId}':
      return getDelivery(endpoint, deliveryId);
    case 'POST /webhooks/{id}/deliveries/{deliveryId}/redeliver':
      return redeliver(endpoint, deliveryId);
    default:
      return methodNotAllowed(method, 'GET, POST, PATCH, DELETE');
  }
};

export const handler = apiHandler(restHandler);

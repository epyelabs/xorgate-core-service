import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, methodNotAllowed, notFound, ok } from '../utils/responses';
import { tsParam } from '../utils/sql';

/**
 * Telemetry history (P4). Two org-scoped read routes on one handler:
 *
 *   GET /devices/{id}/telemetry?from&to[&metric][&interval]  — telemetry_readings over [from, to)
 *   GET /devices/{id}/telemetry/latest                        — device_latest rows
 *
 * With `interval` (seconds) the range is downsampled server-side by epoch
 * bucketing — floor(extract(epoch from ts)/B)*B GROUP BY (bucket, metric) with
 * avg(value) — since there is no TimescaleDB time_bucket. Without it, raw rows
 * are returned up to a hard cap, with `truncated` signalling an incomplete page.
 *
 * ⚠ aws-data-api/pg: the Data API binds params as stringValue, which silently
 * breaks `ts >= $param` on timestamptz — both range bounds MUST go through
 * tsParam() (see src/utils/sql.ts). The validated integer `interval` is inlined
 * with sql.raw for the same reason.
 */

const RAW_LIMIT = 5_000;
const BUCKETED_LIMIT = 10_000;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000; // one month of partitions per query
const MAX_METRICS = 20;
const METRIC_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

async function projectIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.projects.findMany({
    where: eq(schema.projects.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

interface HistoryQuery {
  fromIso: string;
  toIso: string;
  metrics: string[] | null;
  interval: number | null;
}

type ParsedHistoryQuery =
  | { ok: true; query: HistoryQuery }
  | { ok: false; response: APIGatewayProxyResultV2 };

function parseHistoryQuery(event: APIGatewayProxyEventV2): ParsedHistoryQuery {
  const fail = (message: string): ParsedHistoryQuery => ({ ok: false, response: badRequest(message) });
  const qs = event.queryStringParameters ?? {};

  const fromMs = Date.parse(qs.from ?? '');
  const toMs = Date.parse(qs.to ?? '');
  if (Number.isNaN(fromMs)) return fail('Query param "from" must be a valid ISO-8601 timestamp');
  if (Number.isNaN(toMs)) return fail('Query param "to" must be a valid ISO-8601 timestamp');
  if (fromMs >= toMs) return fail('"from" must be earlier than "to"');
  if (toMs - fromMs > MAX_RANGE_MS) return fail('Range must not exceed 31 days');

  let metrics: string[] | null = null;
  if (qs.metric) {
    metrics = qs.metric.split(',').map((m) => m.trim()).filter(Boolean);
    if (metrics.length === 0 || metrics.length > MAX_METRICS) {
      return fail(`"metric" must list 1-${MAX_METRICS} metrics (comma-separated)`);
    }
    const bad = metrics.find((m) => !METRIC_RE.test(m));
    if (bad) return fail(`Invalid metric name "${bad}" (expected "group.field")`);
  }

  let interval: number | null = null;
  if (qs.interval !== undefined) {
    if (!/^\d+$/.test(qs.interval)) return fail('"interval" must be a positive integer (seconds)');
    interval = Number(qs.interval);
    if (interval < 1 || interval > 86_400) return fail('"interval" must be between 1 and 86400 seconds');
    if ((toMs - fromMs) / 1000 / interval > RAW_LIMIT) {
      return fail('"interval" is too small for the requested range');
    }
  }

  return {
    ok: true,
    query: {
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      metrics,
      interval,
    },
  };
}

function rangeWhere(deviceId: string, q: HistoryQuery): SQL | undefined {
  const t = schema.telemetryReadings;
  return and(
    eq(t.deviceId, deviceId),
    // tsParam casts are load-bearing — see the header comment.
    sql`${t.ts} >= ${tsParam(q.fromIso)} and ${t.ts} < ${tsParam(q.toIso)}`,
    q.metrics ? inArray(t.metric, q.metrics) : undefined,
  );
}

async function handleHistory(
  deviceId: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseHistoryQuery(event);
  if (!parsed.ok) return parsed.response;
  const q = parsed.query;

  const t = schema.telemetryReadings;
  const where = rangeWhere(deviceId, q);

  if (q.interval !== null) {
    // Validated integer — safe to inline; avoids a stringValue bind.
    const b = sql.raw(String(q.interval));
    // ::bigint epoch keeps the Data API result a longValue (no timestamp
    // string-format round-trip); avg(float8) stays float8 → doubleValue.
    const bucketEpoch = sql<number>`(floor(extract(epoch from ${t.ts}) / ${b}) * ${b})::bigint`;
    const rows = await db
      .select({
        tsEpoch: bucketEpoch,
        metric: t.metric,
        value: sql<number | null>`avg(${t.value})`,
        unit: sql<string | null>`min(${t.unit})`,
      })
      .from(t)
      .where(where)
      .groupBy(bucketEpoch, t.metric)
      .orderBy(bucketEpoch, asc(t.metric))
      .limit(BUCKETED_LIMIT + 1);

    const truncated = rows.length > BUCKETED_LIMIT;
    const readings = rows.slice(0, BUCKETED_LIMIT).map((r) => ({
      ts: new Date(Number(r.tsEpoch) * 1000).toISOString(),
      metric: r.metric,
      value: r.value,
      unit: r.unit,
    }));
    return ok({ readings, bucketSeconds: q.interval, truncated });
  }

  const rows = await db
    .select({ ts: t.ts, metric: t.metric, value: t.value, unit: t.unit })
    .from(t)
    .where(where)
    .orderBy(asc(t.ts), asc(t.metric))
    .limit(RAW_LIMIT + 1);

  const truncated = rows.length > RAW_LIMIT;
  const readings = rows.slice(0, RAW_LIMIT).map((r) => ({
    ts: r.ts.toISOString(),
    metric: r.metric,
    value: r.value,
    unit: r.unit,
  }));
  return ok({ readings, bucketSeconds: null, truncated });
}

async function handleLatest(deviceId: string): Promise<APIGatewayProxyResultV2> {
  const rows = await db.query.deviceLatest.findMany({
    where: eq(schema.deviceLatest.deviceId, deviceId),
    orderBy: [asc(schema.deviceLatest.metric)],
    columns: { metric: true, value: true, unit: true, ts: true },
  });
  return ok({
    latest: rows.map((r) => ({
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      ts: r.ts.toISOString(),
    })),
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'GET') return methodNotAllowed(method, 'GET');

  const id = event.pathParameters?.id;
  if (!id) return notFound('Device "" not found');

  let auth;
  try {
    auth = await requireOrgContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgProjectIds = await projectIdsForOrg(auth.organizationId);
  if (orgProjectIds.length === 0) return notFound(`Device "${id}" not found`);

  // Org-ownership check (same pattern as devices.ts): the device must belong to
  // a project in the caller's organization.
  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, id),
      inArray(schema.devices.projectId, orgProjectIds),
    ),
    columns: { id: true },
  });
  if (!device) return notFound(`Device "${id}" not found`);

  return event.rawPath.endsWith('/telemetry/latest')
    ? handleLatest(id)
    : handleHistory(id, event);
};

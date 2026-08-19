import { requestPath } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { badRequest, methodNotAllowed, notFound, ok } from '../utils/responses';
import {
  boundedTotalQuery,
  capTotal,
  READINGS_TOTAL_CAP,
  type BoundedTotalRow,
} from '../services/telemetry-readings';
import {
  historyColumnKeys,
  orderColumnsByModel,
  pivotRows,
} from '../services/telemetry-columns';
import { tsParam } from '../utils/sql';

/**
 * Telemetry history (P4). Two org-scoped read routes on one handler:
 *
 *   GET /devices/{id}/telemetry?from&to[&metric][&interval]  — telemetry_readings over [from, to)
 *   GET /devices/{id}/telemetry/latest                        — device_latest rows
 *   GET /devices/{id}/telemetry/recent[&metric][&limit]       — the most recent N rows
 *   GET /devices/{id}/telemetry/readings[&...]                — raw rows, paginated by ts
 *
 * The /readings variant backs the Telemetry History table: raw (un-averaged)
 * rows paginated over DISTINCT timestamps (one sample = one display row), so a
 * page boundary never splits a sample's metrics across two pages. It accepts
 * `limit`/`offset` (in timestamps), `order` (asc|desc by ts), and optional
 * `from`/`to`/`metric` filters, and returns a `page` block with the
 * distinct-timestamp count for pagination.
 *
 * ⚠ That count is BOUNDED at READINGS_TOTAL_CAP, and offsets past the cap
 * short-circuit to an empty page — an exact total over this table's volume
 * costs > 45 s and used to return 500. See services/telemetry-readings.ts for
 * the measurements, the rejected alternatives, and what `total` now means.
 *
 * /readings serves TWO response shapes, selected by `?shape=`:
 *
 * - **`table` (the DEFAULT)** — the table being displayed: an ordered `columns`
 *   list with authoritative units, and one `rows` entry per timestamp whose `v`
 *   is POSITIONAL against `columns`. The server derives the column set from the
 *   device model's io_capabilities, so it no longer depends on what one page
 *   happened to contain.
 * - **`flat`** — the original `readings: [{ts, metric, value, unit}]` rows, the
 *   generic raw-rows contract shared with /telemetry and /telemetry/recent.
 *
 * The flat shape is unchanged and still available; it is no longer the default
 * (product decision, 2026-08-04). Three defects motivated the table shape, and
 * all three are properties of the flat shape rather than bugs in the client:
 *
 * 1. **Payload.** ~89 % of a flat page is the strings "ts"/"metric"/"value"/
 *    "unit" and a re-serialised ISO timestamp repeated once per reading, and
 *    this API does not gzip (HTTP APIs have no compression setting). Measured
 *    141 814 B for a 100-timestamp page against 14 998 B pivoted.
 * 2. **Round-trips.** The column set used to be derived client-side from the
 *    device model, so the table needed getDevice → getDeviceModel → readings
 *    before rendering a single row. The join here costs one indexed PK lookup
 *    on a query the ownership check already had to run.
 * 3. **Stability.** Units were scraped from whatever the page contained, so a
 *    metric that was all-null on one page lost its unit and the header changed
 *    as you paged. Units now come from device_latest.
 *
 * The /recent variant orders by ts DESC and returns the newest `limit` rows
 * (chronological in the response), so callers see the latest samples regardless
 * of when they arrived — even if the device last reported weeks ago. Unlike
 * /telemetry it takes no time window, so it never misses recent-but-old data.
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
const RECENT_DEFAULT = 500; // rows returned by /recent when no limit is given
const RECENT_MAX = 5_000;
const READINGS_DEFAULT_LIMIT = 100; // timestamps per page for /readings
const READINGS_MAX_LIMIT = 500;

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

// GET /devices/{id}/telemetry/recent — the newest `limit` rows for the device,
// optionally filtered to specific metrics. Ordered ts DESC in SQL (so the index
// on (device_id, ts, metric) drives it and Postgres can stop early across
// partitions), then reversed to chronological for chart-friendly output.
async function handleRecent(
  deviceId: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const qs = event.queryStringParameters ?? {};

  let metrics: string[] | null = null;
  if (qs.metric) {
    metrics = qs.metric.split(',').map((m) => m.trim()).filter(Boolean);
    if (metrics.length === 0 || metrics.length > MAX_METRICS) {
      return badRequest(`"metric" must list 1-${MAX_METRICS} metrics (comma-separated)`);
    }
    const bad = metrics.find((m) => !METRIC_RE.test(m));
    if (bad) return badRequest(`Invalid metric name "${bad}" (expected "group.field")`);
  }

  let limit = RECENT_DEFAULT;
  if (qs.limit !== undefined) {
    if (!/^\d+$/.test(qs.limit)) return badRequest('"limit" must be a positive integer');
    limit = Number(qs.limit);
    if (limit < 1 || limit > RECENT_MAX) {
      return badRequest(`"limit" must be between 1 and ${RECENT_MAX}`);
    }
  }

  const t = schema.telemetryReadings;
  // No ts bind here, so the tsParam timestamptz workaround is unnecessary.
  const where = and(
    eq(t.deviceId, deviceId),
    metrics ? inArray(t.metric, metrics) : undefined,
  );
  const rows = await db
    .select({ ts: t.ts, metric: t.metric, value: t.value, unit: t.unit })
    .from(t)
    .where(where)
    .orderBy(desc(t.ts), asc(t.metric))
    .limit(limit);

  const truncated = rows.length >= limit;
  // rows are newest-first; reverse to chronological for the chart.
  const readings = rows.reverse().map((r) => ({
    ts: r.ts.toISOString(),
    metric: r.metric,
    value: r.value,
    unit: r.unit,
  }));
  return ok({ readings, bucketSeconds: null, truncated });
}

/**
 * Authoritative units for the table shape's column headers.
 *
 * device_latest holds one row per (device, metric) — at most ~42 for a device —
 * behind a unique index, so this is a point lookup, not a scan of the history
 * table. Sourcing units here rather than from the page's rows is what stops the
 * header changing as you page: a metric that is all-null on the current page
 * keeps its unit.
 */
async function latestUnits(deviceId: string, metrics: string[]): Promise<Map<string, string>> {
  const units = new Map<string, string>();
  if (metrics.length === 0) return units;
  const rows = await db
    .select({ metric: schema.deviceLatest.metric, unit: schema.deviceLatest.unit })
    .from(schema.deviceLatest)
    .where(
      and(
        eq(schema.deviceLatest.deviceId, deviceId),
        inArray(schema.deviceLatest.metric, metrics),
      ),
    );
  for (const r of rows) if (r.unit) units.set(r.metric, r.unit);
  return units;
}

// GET /devices/{id}/telemetry/readings — one page of the history table,
// paginated over DISTINCT timestamps. We first pull the page's distinct
// timestamps (ordered, limit/offset), then fetch every row within that page's
// [minTs, maxTs] window: because the page is a contiguous ordered slice of the
// distinct-ts set, no other matching timestamp falls between its bounds, so this
// returns exactly the page's samples without splitting one across pages.
//
// `?shape=table` (default) returns columns + positional rows; `?shape=flat`
// returns the original raw rows. See the header comment.
async function handleReadings(
  deviceId: string,
  event: APIGatewayProxyEventV2,
  ioCapabilities: unknown,
): Promise<APIGatewayProxyResultV2> {
  const qs = event.queryStringParameters ?? {};

  let shape: 'table' | 'flat' = 'table';
  if (qs.shape !== undefined) {
    if (qs.shape !== 'table' && qs.shape !== 'flat') {
      return badRequest('"shape" must be "table" or "flat"');
    }
    shape = qs.shape;
  }

  let limit = READINGS_DEFAULT_LIMIT;
  if (qs.limit !== undefined) {
    if (!/^\d+$/.test(qs.limit)) return badRequest('"limit" must be a positive integer');
    limit = Number(qs.limit);
    if (limit < 1 || limit > READINGS_MAX_LIMIT) {
      return badRequest(`"limit" must be between 1 and ${READINGS_MAX_LIMIT}`);
    }
  }

  let offset = 0;
  if (qs.offset !== undefined) {
    if (!/^\d+$/.test(qs.offset)) return badRequest('"offset" must be a non-negative integer');
    offset = Number(qs.offset);
  }

  let order: 'asc' | 'desc' = 'desc';
  if (qs.order !== undefined) {
    if (qs.order !== 'asc' && qs.order !== 'desc') return badRequest('"order" must be "asc" or "desc"');
    order = qs.order;
  }

  let metrics: string[] | null = null;
  if (qs.metric) {
    metrics = qs.metric.split(',').map((m) => m.trim()).filter(Boolean);
    if (metrics.length === 0 || metrics.length > MAX_METRICS) {
      return badRequest(`"metric" must list 1-${MAX_METRICS} metrics (comma-separated)`);
    }
    const bad = metrics.find((m) => !METRIC_RE.test(m));
    if (bad) return badRequest(`Invalid metric name "${bad}" (expected "group.field")`);
  }

  // from/to are both optional here (default = latest, no time window).
  let fromIso: string | null = null;
  let toIso: string | null = null;
  if (qs.from !== undefined) {
    const ms = Date.parse(qs.from);
    if (Number.isNaN(ms)) return badRequest('Query param "from" must be a valid ISO-8601 timestamp');
    fromIso = new Date(ms).toISOString();
  }
  if (qs.to !== undefined) {
    const ms = Date.parse(qs.to);
    if (Number.isNaN(ms)) return badRequest('Query param "to" must be a valid ISO-8601 timestamp');
    toIso = new Date(ms).toISOString();
  }
  if (fromIso && toIso && Date.parse(fromIso) >= Date.parse(toIso)) {
    return badRequest('"from" must be earlier than "to"');
  }

  // ⚠ Column/filter coupling. For the table shape the displayed columns and the
  // `metric=` filter applied to the query are ONE value, resolved here and used
  // for both. If they ever diverge the table renders columns that can never have
  // data, or silently drops data it already paid to fetch.
  //
  //   request — the caller named metrics explicitly; we honour them and only
  //             order them the way the model would present them
  //   model   — derived from the device model's io_capabilities (the UI default)
  //   data    — the model declares nothing usable, so columns are discovered
  //             from the page's own rows. Reported so a client can tell this
  //             apart from "there is no data".
  let columnSource: 'request' | 'model' | 'data' = 'data';
  let columns: string[] = [];
  if (shape === 'table') {
    if (metrics) {
      columns = orderColumnsByModel(metrics, ioCapabilities);
      metrics = columns;
      columnSource = 'request';
    } else {
      const derived = historyColumnKeys(ioCapabilities);
      if (derived.length > 0) {
        // A server-derived list is not a client error, so clamp rather than 400
        // — but say so, because the tail is silently unreachable.
        if (derived.length > MAX_METRICS) {
          console.warn(
            `[telemetry/readings] device ${deviceId}: model declares ${derived.length} history columns, clamped to ${MAX_METRICS}`,
          );
        }
        columns = derived.slice(0, MAX_METRICS);
        metrics = columns;
        columnSource = 'model';
      }
      // else: no usable capabilities — leave `metrics` null (fetch everything)
      // and discover the columns from the rows below.
    }
  }

  const t = schema.telemetryReadings;
  // tsParam casts are load-bearing on the Data API — see the header comment.
  const where = and(
    eq(t.deviceId, deviceId),
    fromIso ? sql`${t.ts} >= ${tsParam(fromIso)}` : undefined,
    toIso ? sql`${t.ts} < ${tsParam(toIso)}` : undefined,
    metrics ? inArray(t.metric, metrics) : undefined,
  );
  const orderTs = order === 'asc' ? asc(t.ts) : desc(t.ts);

  // Distinct timestamps matching the filter, counted only up to the cap, plus
  // the span they cover. `where`/`orderTs` are passed by reference so the count
  // and the page query can never diverge.
  //
  // The unit lookup is independent of the count, so it rides along rather than
  // adding a round-trip: the bounded count is ~140 ms of Data API time and the
  // device_latest point lookup is a few ms behind it.
  const [bounded, units] = await Promise.all([
    db.execute<BoundedTotalRow>(boundedTotalQuery(where, order)),
    shape === 'table' ? latestUnits(deviceId, columns) : Promise.resolve(new Map<string, string>()),
  ]);
  const boundedRow = bounded.rows[0];
  const { total, totalIsCapped } = capTotal(Number(boundedRow?.total ?? 0));
  const page = {
    limit,
    offset,
    order,
    total,
    totalIsCapped,
    ...(boundedRow?.covered_from ? { coveredFrom: boundedRow.covered_from } : {}),
    ...(boundedRow?.covered_to ? { coveredTo: boundedRow.covered_to } : {}),
  };

  // Deep offsets are the second way this endpoint dies: offset 20 000 costs
  // 273 ms but offset 100 000 exceeds 45 s, because the planner flips from
  // Unique-over-index to a seq scan with a disk sort. Nothing past the cap is
  // addressable anyway, so a stale bookmark short-circuits to an empty page
  // rather than asking the DB. 200, not 400 — it should render an empty table,
  // not an error toast.
  // An empty page still carries the column set: the table keeps its headers (and
  // their units) instead of collapsing to nothing while the user pages past the
  // end or picks a range with no data.
  const emptyPage = (): APIGatewayProxyResultV2 =>
    shape === 'flat'
      ? ok({ readings: [], page })
      : ok({
          columns: columns.map((key) => ({ key, unit: units.get(key) ?? null })),
          rows: [],
          columnSource,
          page,
        });

  if (offset >= READINGS_TOTAL_CAP) {
    return emptyPage();
  }

  // Never let a page reach past the addressable window. `total` says only
  // READINGS_TOTAL_CAP timestamps exist and coveredFrom/coveredTo describe
  // exactly that slice, so an overrunning page would both show rows the pager
  // claims are not there and falsify the covered span.
  const pageLimit = Math.min(limit, READINGS_TOTAL_CAP - offset);

  // The page's distinct timestamps.
  const tsRows = await db
    .selectDistinct({ ts: t.ts })
    .from(t)
    .where(where)
    .orderBy(orderTs)
    .limit(pageLimit)
    .offset(offset);

  if (tsRows.length === 0) {
    return emptyPage();
  }

  const epochs = tsRows.map((r) => r.ts.getTime());
  const minTs = new Date(Math.min(...epochs)).toISOString();
  const maxTs = new Date(Math.max(...epochs)).toISOString();

  const rows = await db
    .select({ ts: t.ts, metric: t.metric, value: t.value, unit: t.unit })
    .from(t)
    .where(
      and(
        eq(t.deviceId, deviceId),
        sql`${t.ts} >= ${tsParam(minTs)} and ${t.ts} <= ${tsParam(maxTs)}`,
        metrics ? inArray(t.metric, metrics) : undefined,
      ),
    )
    .orderBy(orderTs, asc(t.metric));

  if (shape === 'flat') {
    const readings = rows.map((r) => ({
      ts: r.ts.toISOString(),
      metric: r.metric,
      value: r.value,
      unit: r.unit,
    }));
    return ok({ readings, page });
  }

  // No usable capabilities: discover the columns from the page itself. Only
  // metrics that carried a value become columns — matching what the client used
  // to do — and they are sorted for determinism, since without the model there
  // is no declared order to follow.
  if (columnSource === 'data') {
    const present = new Set<string>();
    for (const r of rows) if (r.value !== null) present.add(r.metric);
    columns = [...present].sort();
  }

  return ok({
    columns: columns.map((key) => ({
      key,
      // device_latest is authoritative; fall back to the page's own rows for a
      // metric it has never seen (batch-ingested history writes readings but
      // deliberately never touches device_latest).
      unit: units.get(key) ?? rows.find((r) => r.metric === key && r.unit)?.unit ?? null,
    })),
    rows: pivotRows(rows, columns),
    columnSource,
    page,
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

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);

  // Org-ownership check (same pattern as devices.ts): the device must belong to
  // a workspace in the caller's organization.
  //
  // The model's io_capabilities come along for the ride, because /readings
  // derives the history table's column set from them (?shape=table). Folding it
  // into a check that had to run anyway costs one join on an indexed PK instead
  // of a second Data API round-trip. leftJoin, not innerJoin: a device must
  // never 404 because its model row is missing.
  const [device] = await db
    .select({
      id: schema.devices.id,
      ioCapabilities: schema.deviceModels.ioCapabilities,
    })
    .from(schema.devices)
    .leftJoin(schema.deviceModels, eq(schema.devices.deviceModelId, schema.deviceModels.id))
    .where(
      and(eq(schema.devices.id, id), inArray(schema.devices.workspaceId, orgWorkspaceIds)),
    )
    .limit(1);
  if (!device) return notFound(`Device "${id}" not found`);

  const path = requestPath(event);
  if (path.endsWith('/telemetry/latest')) return handleLatest(id);
  if (path.endsWith('/telemetry/recent')) return handleRecent(id, event);
  if (path.endsWith('/telemetry/readings')) {
    return handleReadings(id, event, device.ioCapabilities);
  }
  return handleHistory(id, event);
};

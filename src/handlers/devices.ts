import { routeKey as canonicalRouteKey } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { teardownDevices } from '../services/device-teardown';
import {
  badRequest,
  created,
  errorResponse,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import {
  deviceDeclaresObd,
  deviceHardwareBlock,
  publishDeviceConfig,
} from '../services/device-config';
import {
  applyConfigPatch,
  CONFIG_NAMESPACES,
  initialConfigDocument,
  parseUiPrefsPatch,
  validateConfigPatch,
  validateNamespaceValue,
  type DeviceConfigDocument,
  type NamespaceGateFacts,
  OBD_ONLY_NAMESPACES,
  CAMERA_SENSORS_ONLY_NAMESPACES,
  cameraSensorsEligibility,
  declaredCameraPorts,
} from '../config-registry/index';
import { legacyConfigColumns, legacyUiPrefColumns } from '../config-registry/legacy-columns';
import { apiHandler } from '../utils/api-handler';
import { deviceResponse, type DeviceRow } from '../services/device-view';
import { handleDevicePurgeRoutes } from './device-purges';

const VALID_STATUSES = ['provisioned', 'online', 'offline', 'decommissioned'] as const;

/**
 * Legacy `PUT /devices/{id}` body field -> config namespace, for the transition
 * window. A pre-Phase-2 client (or a script) may still send `recordingConfig`
 * etc.; they are validated through the SAME registry schema and forwarded into
 * `config`, with a deprecation log line. New clients use
 * `PATCH /devices/{id}/config`.
 */
const LEGACY_PUT_FIELDS: { field: string; namespace: string }[] = CONFIG_NAMESPACES.filter(
  (ns) => ns.legacyPutField,
).map((ns) => ({ field: ns.legacyPutField as string, namespace: ns.key }));

/** Old cloud-only PUT fields, now `PATCH /devices/{id}/ui-prefs`. */
const LEGACY_UI_PREF_FIELDS = ['activeStreamsViewType', 'imuView'] as const;

/** True when a PATCH body names a model-gated namespace (so the model read is worth doing). */
function hasObdNamespace(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body).some((k) => OBD_ONLY_NAMESPACES.includes(k));
}

/** True when a PATCH body names the device-gated camera namespace. */
function hasCameraSensorsNamespace(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body).some((k) => CAMERA_SENSORS_ONLY_NAMESPACES.includes(k));
}

async function findDevice(id: string, orgWorkspaceIds: string[]): Promise<DeviceRow | undefined> {
  if (orgWorkspaceIds.length === 0) return undefined;
  return db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, id),
      inArray(schema.devices.workspaceId, orgWorkspaceIds),
    ),
  });
}

/**
 * Write a new config document: bump `config_rev`, dual-write the legacy
 * columns, publish the retained message.
 *
 * Publish failure still 502s (the DB row is already updated, so the operator
 * must know the device was NOT told immediately) — but it is no longer a dead
 * end. Since Phase 3 the device reports its applied `rev` and
 * `handlers/device-config-report.ts` republishes whenever
 * `config_rev > reported.rev`, so the divergence closes on the device's own
 * next report (connect, or the hourly heartbeat) with no operator action.
 */
async function writeConfig(
  id: string,
  orgWorkspaceIds: string[],
  nextConfig: DeviceConfigDocument,
  extra: { updates?: Record<string, unknown>; uiPrefs?: Record<string, unknown> } = {},
): Promise<APIGatewayProxyResultV2> {
  const now = new Date();
  const updated = await db
    .update(schema.devices)
    .set({
      ...(extra.updates ?? {}),
      config: nextConfig,
      configRev: sql`${schema.devices.configRev} + 1`,
      configUpdatedAt: now,
      updatedAt: now,
      ...legacyConfigColumns(nextConfig),
      ...(extra.uiPrefs
        ? { uiPrefs: extra.uiPrefs, ...legacyUiPrefColumns(extra.uiPrefs) }
        : {}),
    })
    .where(
      and(
        eq(schema.devices.id, id),
        inArray(schema.devices.workspaceId, orgWorkspaceIds),
      ),
    )
    .returning();
  if (updated.length === 0) return notFound(`Device "${id}" not found`);

  const row = updated[0];
  try {
    await publishDeviceConfig(id, row.config, row.configRev);
  } catch (err) {
    console.error('device config publish failed', {
      deviceId: id,
      rev: row.configRev,
      err,
    });
    return errorResponse(
      502,
      'CONFIG_PUBLISH_FAILED',
      'Setting saved, but delivering it to the device failed. It will be delivered ' +
        'automatically the next time the device reports in.',
    );
  }
  return ok({ device: deviceResponse(row) });
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event); // e.g. "PATCH /devices/{id}/config"
  const id = event.pathParameters?.id;

  // The purge sub-resource carries its own gates (the POST is organization-
  // wide, like a transfer), so it is dispatched before the generic one below.
  if (routeKey === 'POST /devices/{id}/purges' || routeKey.startsWith('GET /devices/{id}/purges')) {
    return handleDevicePurgeRoutes(event, routeKey, id);
  }

  let auth;
  try {
    const writeMethod =
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    // Deleting is the one write that takes recordings and telemetry with it,
    // so it sits with the other destructive operations (session delete,
    // workspace delete) at owner|admin; members keep every other write.
    auth = await requireOrgContext(
      event,
      method === 'DELETE' ? ['owner', 'admin'] : writeMethod ? ['owner', 'admin', 'member'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);

  // ---- Sub-resource routes (config / ui-prefs) -------------------------------
  if (routeKey === 'PATCH /devices/{id}/config') {
    if (!id) return badRequest('device id required in path');
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return badRequest('Invalid JSON body');
    }
    const device = await findDevice(id, orgWorkspaceIds);
    if (!device) return notFound(`Device "${id}" not found`);

    // Validated against THIS device: the `simulation` namespace exists only
    // for devices created as simulated, and real hardware must never be able
    // to receive it (plans/xorgate-device-simulator, README §3.3); `obd` only
    // for a device whose model declares `peripherals.obd`
    // (plans/obd2-bluetooth-integration, P3). The model read is skipped unless
    // the body actually carries a gated namespace.
    const obd = hasObdNamespace(body) ? await deviceDeclaresObd(id) : false;
    const facts: NamespaceGateFacts = { simulated: device.simulated, obd };
    // `cameraSensors` (plans/support-other-camera-models): only a real device
    // on a Rust agent that has never reported or reports `camera.sensors`. A
    // device that does not qualify gets a 400 naming the agent version needed,
    // never a stored value its agent would ignore. For one that does, the
    // model's camera ports bound the keys (read only then).
    if (hasCameraSensorsNamespace(body)) {
      facts.cameraSensors = cameraSensorsEligibility(device);
      if (facts.cameraSensors.allowed) {
        facts.cameraPorts = declaredCameraPorts(await deviceHardwareBlock(id));
      }
    }
    const parsed = validateConfigPatch(body, facts);
    if ('error' in parsed) return badRequest(parsed.error);

    const nextConfig = applyConfigPatch(device.config, parsed.value) as DeviceConfigDocument;
    return writeConfig(id, orgWorkspaceIds, nextConfig);
  }

  if (routeKey === 'PATCH /devices/{id}/ui-prefs') {
    if (!id) return badRequest('device id required in path');
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return badRequest('Invalid JSON body');
    }
    const parsed = parseUiPrefsPatch(body);
    if ('error' in parsed) return badRequest(parsed.error);

    const device = await findDevice(id, orgWorkspaceIds);
    if (!device) return notFound(`Device "${id}" not found`);

    // Cloud-only: no publish, and deliberately NO config_rev bump — nothing
    // here ever reaches a device, so it must not make one look out of date.
    const nextPrefs: Record<string, unknown> = { ...(device.uiPrefs ?? {}) };
    for (const [key, value] of Object.entries(parsed.value)) {
      if (value === null) delete nextPrefs[key];
      else nextPrefs[key] = value;
    }
    const now = new Date();
    const updated = await db
      .update(schema.devices)
      .set({
        uiPrefs: nextPrefs,
        updatedAt: now,
        // Transition window: keep the old cloud-only columns in step.
        ...legacyUiPrefColumns(nextPrefs),
      })
      .where(
        and(
          eq(schema.devices.id, id),
          inArray(schema.devices.workspaceId, orgWorkspaceIds),
        ),
      )
      .returning();
    if (updated.length === 0) return notFound(`Device "${id}" not found`);
    return ok({ device: deviceResponse(updated[0]) });
  }

  switch (method) {
    case 'GET': {
      if (id) {
        if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);
        const row = await findDevice(id, orgWorkspaceIds);
        if (!row) return notFound(`Device "${id}" not found`);
        return ok({ device: deviceResponse(row) });
      }
      // Standardized list dialect (utils/list-params): limit/offset/order/sort/
      // status, plus a `page` block. Default order preserves the prior behaviour
      // (most-recently-updated first).
      const parsed = parseListParams(event, {
        sortable: ['updatedAt', 'createdAt', 'lastSeenAt', 'serial', 'name'],
        defaultSort: 'updatedAt',
        statusValues: VALID_STATUSES,
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy, status } = parsed;

      const emptyPage = ok({ devices: [], page: pageMeta(parsed, 0) });
      if (orgWorkspaceIds.length === 0) return emptyPage;

      // Scope to the active workspace when the header is present (and valid),
      // else the whole org.
      const headerWorkspaceId =
        event.headers['x-workspace-id'] ?? event.headers['X-Workspace-Id'];
      let wsFilter = orgWorkspaceIds;
      if (headerWorkspaceId) {
        if (!orgWorkspaceIds.includes(headerWorkspaceId)) return emptyPage;
        wsFilter = [headerWorkspaceId];
      }

      // `?simulated=true|false` (plans/xorgate-device-simulator): the console's
      // Simulated filter. Absent = every device, exactly as before.
      const simulatedParam = event.queryStringParameters?.simulated;
      if (simulatedParam !== undefined && simulatedParam !== 'true' && simulatedParam !== 'false') {
        return badRequest('simulated must be true or false');
      }

      const where = and(
        inArray(schema.devices.workspaceId, wsFilter),
        status ? eq(schema.devices.status, status) : undefined,
        simulatedParam !== undefined
          ? eq(schema.devices.simulated, simulatedParam === 'true')
          : undefined,
      );

      const sortCol =
        sortBy === 'createdAt'
          ? schema.devices.createdAt
          : sortBy === 'lastSeenAt'
            ? schema.devices.lastSeenAt
            : sortBy === 'serial'
              ? schema.devices.serial
              : sortBy === 'name'
                ? schema.devices.name
                : schema.devices.updatedAt;

      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.devices)
        .where(where);
      const total = Number(totalRows[0]?.total ?? 0);

      const rows = await db.query.devices.findMany({
        where,
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });
      return ok({ devices: rows.map(deviceResponse), page: pageMeta(parsed, total) });
    }
    case 'POST': {
      let body: {
        workspaceId?: string;
        deviceModelId?: string;
        serial?: string;
        name?: string;
        status?: string;
        simulated?: unknown;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      // A simulated device needs its provision bundle stored and a sim host
      // told about it; a bare row flagged `simulated` would be neither.
      if (body.simulated !== undefined && body.simulated !== false) {
        return badRequest('register a simulated device with POST /device-simulations');
      }
      if (!body.workspaceId) return badRequest('workspaceId is required');
      if (!body.deviceModelId) return badRequest('deviceModelId is required');
      if (!body.serial) return badRequest('serial is required');

      if (!orgWorkspaceIds.includes(body.workspaceId)) {
        return badRequest('workspaceId does not belong to the active organization');
      }
      const status = body.status ?? 'provisioned';
      if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
        return badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
      }

      const [row] = await db
        .insert(schema.devices)
        .values({
          workspaceId: body.workspaceId,
          deviceModelId: body.deviceModelId,
          serial: body.serial,
          name: body.name ?? null,
          // No `agentVersion` here on purpose: it is mirrored from the device's
          // config report, so a claimed device fills it in for itself and an
          // operator-supplied value could only ever be a guess.
          status,
          config: initialConfigDocument(),
          configRev: 1,
          configUpdatedAt: new Date(),
          uiPrefs: {},
        })
        .returning();

      // Publish the initial retained config so a device that connects before
      // anyone opens the settings page still converges (previously the topic
      // stayed empty until the first save, and the agent had nothing to apply).
      // A publish failure must NOT fail the create — the row exists, the
      // registration flow continues, and any later save (or Phase 3's
      // reported-rev self-heal) republishes.
      try {
        await publishDeviceConfig(row.id, row.config, row.configRev);
      } catch (err) {
        console.error('initial device config publish failed', {
          deviceId: row.id,
          rev: row.configRev,
          err,
        });
      }
      return created({ device: deviceResponse(row) });
    }
    case 'PUT': {
      if (!id) return badRequest('device id required in path');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
      } catch {
        return badRequest('Invalid JSON body');
      }

      // PUT is metadata-only now (design.md Q3: status is machine-managed by
      // telemetry ingest / LWT / the offline sweeper, and `lastSeenAt` is
      // ingest-owned — nothing legitimate set either through this API).
      if (body.status !== undefined) {
        return badRequest(
          'status is not settable via the API — it is derived from device connectivity',
        );
      }
      if (body.lastSeenAt !== undefined) {
        return badRequest('lastSeenAt is not settable via the API — telemetry ingest owns it');
      }
      if (body.simulated !== undefined) {
        return badRequest(
          'simulated is fixed at creation — register a simulated device with POST /device-simulations',
        );
      }

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) {
        if (body.name !== null && typeof body.name !== 'string') {
          return badRequest('name must be a string or null');
        }
        updates.name = body.name;
      }
      // Model reassignment (cm4-support plan): resolves a `needs_model` device
      // (D3) or corrects a wrong model (D7). Clears the flag and — below —
      // republishes the device's config with a bumped rev so the new model's
      // hardware block reaches the device and the agent re-renders pipelines.
      // Deliberately does NOT re-mint KVS channels: channel provisioning
      // happens at claim (matching the existing "changing ioCapabilities does
      // not retro-provision" contract); orphan channels are deleted explicitly.
      let touchesModel = false;
      if (body.deviceModelId !== undefined) {
        if (typeof body.deviceModelId !== 'string') {
          return badRequest('deviceModelId must be a string');
        }
        const model = await db.query.deviceModels.findFirst({
          where: eq(schema.deviceModels.id, body.deviceModelId),
        });
        if (!model) return badRequest(`Device model "${body.deviceModelId}" not found`);
        updates.deviceModelId = model.id;
        updates.needsModel = false;
        touchesModel = true;
      }
      // `firmwareVersion`/`agentVersion` are deliberately NOT settable: the
      // column is now mirrored from the device's config report (README §2.3), so
      // an operator write would be overwritten by the device's next report and
      // is only ever misinformation in the meantime. Nothing in the frontend
      // ever wrote it; a request carrying it falls through to the unknown-field
      // check below and 400s.

      // ---- Transition window: legacy config fields on PUT ---------------------
      const configPatch: Record<string, unknown> = {};
      const deprecated: string[] = [];
      for (const { field, namespace } of LEGACY_PUT_FIELDS) {
        if (body[field] === undefined) continue;
        const parsed = validateNamespaceValue(namespace, body[field], field);
        if ('error' in parsed) return badRequest(parsed.error);
        configPatch[namespace] = parsed.value;
        deprecated.push(field);
      }
      const uiPrefsPatch: Record<string, unknown> = {};
      for (const field of LEGACY_UI_PREF_FIELDS) {
        if (body[field] === undefined) continue;
        const parsed = parseUiPrefsPatch({ [field]: body[field] });
        if ('error' in parsed) return badRequest(parsed.error);
        Object.assign(uiPrefsPatch, parsed.value);
        deprecated.push(field);
      }

      const unknownFields = Object.keys(body).filter(
        (k) =>
          k !== 'name' &&
          k !== 'deviceModelId' &&
          !LEGACY_PUT_FIELDS.some((f) => f.field === k) &&
          !(LEGACY_UI_PREF_FIELDS as readonly string[]).includes(k),
      );
      if (unknownFields.length > 0) {
        return badRequest(`unknown field(s): ${unknownFields.join(', ')}`);
      }

      const touchesConfig = Object.keys(configPatch).length > 0;
      const touchesPrefs = Object.keys(uiPrefsPatch).length > 0;
      if (Object.keys(updates).length === 0 && !touchesConfig && !touchesPrefs) {
        return badRequest('No updatable fields provided');
      }

      if (deprecated.length > 0) {
        console.warn('deprecated config fields on PUT /devices/{id}', {
          deviceId: id,
          fields: deprecated,
          hint: 'use PATCH /devices/{id}/config and /ui-prefs',
        });
      }

      if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);

      if (!touchesConfig && !touchesPrefs && !touchesModel) {
        updates.updatedAt = new Date();
        const updated = await db
          .update(schema.devices)
          .set(updates)
          .where(
            and(
              eq(schema.devices.id, id),
              inArray(schema.devices.workspaceId, orgWorkspaceIds),
            ),
          )
          .returning();
        if (updated.length === 0) return notFound(`Device "${id}" not found`);
        return ok({ device: deviceResponse(updated[0]) });
      }

      const device = await findDevice(id, orgWorkspaceIds);
      if (!device) return notFound(`Device "${id}" not found`);

      const nextPrefs: Record<string, unknown> = { ...(device.uiPrefs ?? {}) };
      for (const [key, value] of Object.entries(uiPrefsPatch)) {
        if (value === null) delete nextPrefs[key];
        else nextPrefs[key] = value;
      }

      if (!touchesConfig && !touchesModel) {
        updates.updatedAt = new Date();
        updates.uiPrefs = nextPrefs;
        Object.assign(updates, legacyUiPrefColumns(nextPrefs));
        const updated = await db
          .update(schema.devices)
          .set(updates)
          .where(
            and(
              eq(schema.devices.id, id),
              inArray(schema.devices.workspaceId, orgWorkspaceIds),
            ),
          )
          .returning();
        if (updated.length === 0) return notFound(`Device "${id}" not found`);
        return ok({ device: deviceResponse(updated[0]) });
      }

      // A model change with no config edit still goes through writeConfig: the
      // config document is unchanged but the rev bump + republish are the
      // delivery mechanism for the new model's hardware block.
      const nextConfig = touchesConfig
        ? (applyConfigPatch(device.config, configPatch) as DeviceConfigDocument)
        : ((device.config ?? {}) as DeviceConfigDocument);
      return writeConfig(id, orgWorkspaceIds, nextConfig, {
        updates,
        ...(touchesPrefs ? { uiPrefs: nextPrefs } : {}),
      });
    }
    case 'DELETE': {
      if (!id) return badRequest('device id required in path');
      if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);
      const target = await db.query.devices.findFirst({
        where: and(eq(schema.devices.id, id), inArray(schema.devices.workspaceId, orgWorkspaceIds)),
        columns: { id: true, workspaceId: true, serial: true },
      });
      if (!target) return notFound(`Device "${id}" not found`);
      // AWS side and FK-less rows first: the identifiers live on rows that
      // cascade away with the device. See services/device-teardown.ts.
      const teardown = await teardownDevices(
        [{ ...target, serial: target.serial ?? null, organizationId: auth.organizationId }],
        auth.userId ?? auth.apiKeyId ?? 'unknown',
      );
      if (teardown.errors.length) {
        console.warn(`[devices] delete ${id}: ${teardown.errors.length} teardown error(s)`);
      }
      const deleted = await db
        .delete(schema.devices)
        .where(
          and(
            eq(schema.devices.id, id),
            inArray(schema.devices.workspaceId, orgWorkspaceIds),
          ),
        )
        .returning({ id: schema.devices.id });
      if (deleted.length === 0) return notFound(`Device "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, PATCH, DELETE');
  }
};

export const handler = apiHandler(restHandler);

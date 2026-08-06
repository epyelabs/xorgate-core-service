import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  created,
  errorResponse,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { publishDeviceConfig } from '../services/device-config';
import {
  applyConfigPatch,
  CONFIG_NAMESPACES,
  initialConfigDocument,
  parseUiPrefsPatch,
  validateConfigPatch,
  validateNamespaceValue,
  type DeviceConfigDocument,
} from '../config-registry/index';

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

/**
 * The pre-consolidation columns are DUAL-WRITTEN alongside `config` /
 * `ui_prefs` for the whole transition window: the deployed frontend and any
 * out-of-band script still read them off `GET /devices/{id}`. A follow-up
 * migration drops both the columns and these two functions (cf. drizzle/0022,
 * which dropped the pre-recording columns the same way).
 *
 * Each mirrors ONLY its own half, and is called only when that half is actually
 * being written — mirroring ui_prefs on a config-only write would reset
 * `active_streams_view_type` to its default for any row whose ui_prefs had not
 * been backfilled.
 */
function legacyConfigColumns(config: DeviceConfigDocument): Record<string, unknown> {
  return {
    gnssAntBias: config.gnssAntBias ?? false,
    imuMount: config.imuMount ?? null,
    recordingConfig: config.recording ?? null,
    lteRecoveryConfig: config.lteRecovery ?? null,
    timeSyncConfig: config.timeSync ?? null,
  };
}

function legacyUiPrefColumns(uiPrefs: Record<string, unknown>): Record<string, unknown> {
  return {
    activeStreamsViewType: (uiPrefs.activeStreamsViewType as string | undefined) ?? 'card',
    imuView: (uiPrefs.imuView as DeviceRow['imuView']) ?? null,
  };
}

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

type DeviceRow = typeof schema.devices.$inferSelect;

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
 * must know the device was NOT told). Phase 3 replaces the "re-save to retry"
 * crutch: the device reports its applied `rev` and the mirror Lambda
 * republishes whenever `config_rev > reported.rev`.
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
      'Setting saved, but delivering it to the device failed. Re-save to retry.',
    );
  }
  return ok({ device: row });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey; // e.g. "PATCH /devices/{id}/config"
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod =
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    auth = await requireOrgContext(
      event,
      writeMethod ? ['owner', 'admin', 'member'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);

  // ---- Sub-resource routes (config / ui-prefs) -------------------------------
  if (routeKey === 'PATCH /devices/{id}/config') {
    if (!id) return badRequest('device id required in path');
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return badRequest('Invalid JSON body');
    }
    const parsed = validateConfigPatch(body);
    if ('error' in parsed) return badRequest(parsed.error);

    const device = await findDevice(id, orgWorkspaceIds);
    if (!device) return notFound(`Device "${id}" not found`);

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
    return ok({ device: updated[0] });
  }

  switch (method) {
    case 'GET': {
      if (id) {
        if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);
        const row = await findDevice(id, orgWorkspaceIds);
        if (!row) return notFound(`Device "${id}" not found`);
        return ok({ device: row });
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

      const where = and(
        inArray(schema.devices.workspaceId, wsFilter),
        status ? eq(schema.devices.status, status) : undefined,
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
      return ok({ devices: rows, page: pageMeta(parsed, total) });
    }
    case 'POST': {
      let body: {
        workspaceId?: string;
        deviceModelId?: string;
        serial?: string;
        name?: string;
        firmwareVersion?: string;
        status?: string;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
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
          firmwareVersion: body.firmwareVersion ?? null,
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
      return created({ device: row });
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

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) {
        if (body.name !== null && typeof body.name !== 'string') {
          return badRequest('name must be a string or null');
        }
        updates.name = body.name;
      }
      if (body.firmwareVersion !== undefined) {
        if (body.firmwareVersion !== null && typeof body.firmwareVersion !== 'string') {
          return badRequest('firmwareVersion must be a string or null');
        }
        updates.firmwareVersion = body.firmwareVersion;
      }

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
          k !== 'firmwareVersion' &&
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

      if (!touchesConfig && !touchesPrefs) {
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
        return ok({ device: updated[0] });
      }

      const device = await findDevice(id, orgWorkspaceIds);
      if (!device) return notFound(`Device "${id}" not found`);

      const nextPrefs: Record<string, unknown> = { ...(device.uiPrefs ?? {}) };
      for (const [key, value] of Object.entries(uiPrefsPatch)) {
        if (value === null) delete nextPrefs[key];
        else nextPrefs[key] = value;
      }

      if (!touchesConfig) {
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
        return ok({ device: updated[0] });
      }

      const nextConfig = applyConfigPatch(device.config, configPatch) as DeviceConfigDocument;
      return writeConfig(id, orgWorkspaceIds, nextConfig, {
        updates,
        ...(touchesPrefs ? { uiPrefs: nextPrefs } : {}),
      });
    }
    case 'DELETE': {
      if (!id) return badRequest('device id required in path');
      if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);
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

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

const VALID_STATUSES = ['provisioned', 'online', 'offline', 'decommissioned'] as const;
const VALID_VIEW_TYPES = ['card', 'map'] as const;

interface ImuMountBody {
  enabled: boolean;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

interface ImuViewBody {
  azimuthDeg: number;
  elevationDeg: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// null clears the setting; 'invalid' rejects the request. Mirrors the device
// agent's parseImuMount so both ends accept exactly the same shape.
function parseImuMountBody(v: unknown): ImuMountBody | null | 'invalid' {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return 'invalid';
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return 'invalid';
  if (!finite(o.rollDeg) || !finite(o.pitchDeg) || !finite(o.yawDeg)) return 'invalid';
  return { enabled: o.enabled, rollDeg: o.rollDeg, pitchDeg: o.pitchDeg, yawDeg: o.yawDeg };
}

function parseImuViewBody(v: unknown): ImuViewBody | null | 'invalid' {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return 'invalid';
  const o = v as Record<string, unknown>;
  if (!finite(o.azimuthDeg) || !finite(o.elevationDeg)) return 'invalid';
  // Clamp elevation shy of the poles: at ±90° the view's look-at up-vector
  // degenerates and the camera flips.
  const elevationDeg = Math.max(-85, Math.min(85, o.elevationDeg));
  return { azimuthDeg: o.azimuthDeg, elevationDeg };
}

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'PUT' || method === 'DELETE';
    auth = await requireOrgContext(
      event,
      writeMethod ? ['owner', 'admin', 'member'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);

  switch (method) {
    case 'GET': {
      if (id) {
        if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);
        const row = await db.query.devices.findFirst({
          where: and(
            eq(schema.devices.id, id),
            inArray(schema.devices.workspaceId, orgWorkspaceIds),
          ),
        });
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
        })
        .returning();
      return created({ device: row });
    }
    case 'PUT': {
      if (!id) return badRequest('device id required in path');
      let body: {
        name?: string;
        firmwareVersion?: string;
        status?: string;
        lastSeenAt?: string;
        persistTelemetry?: boolean;
        autoRecord?: boolean;
        gnssAntBias?: boolean;
        activeStreamsViewType?: string;
        imuMount?: unknown;
        imuView?: unknown;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }

      if (body.status !== undefined &&
          !VALID_STATUSES.includes(body.status as (typeof VALID_STATUSES)[number])) {
        return badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
      }

      if (body.persistTelemetry !== undefined &&
          typeof body.persistTelemetry !== 'boolean') {
        return badRequest('persistTelemetry must be a boolean');
      }

      if (body.autoRecord !== undefined && typeof body.autoRecord !== 'boolean') {
        return badRequest('autoRecord must be a boolean');
      }

      if (body.gnssAntBias !== undefined && typeof body.gnssAntBias !== 'boolean') {
        return badRequest('gnssAntBias must be a boolean');
      }

      if (body.activeStreamsViewType !== undefined &&
          !VALID_VIEW_TYPES.includes(body.activeStreamsViewType as (typeof VALID_VIEW_TYPES)[number])) {
        return badRequest(`activeStreamsViewType must be one of: ${VALID_VIEW_TYPES.join(', ')}`);
      }

      let imuMount: ImuMountBody | null | undefined;
      if (body.imuMount !== undefined) {
        const parsed = parseImuMountBody(body.imuMount);
        if (parsed === 'invalid') {
          return badRequest(
            'imuMount must be null or { enabled: boolean, rollDeg, pitchDeg, yawDeg: finite numbers }',
          );
        }
        imuMount = parsed;
      }

      let imuView: ImuViewBody | null | undefined;
      if (body.imuView !== undefined) {
        const parsed = parseImuViewBody(body.imuView);
        if (parsed === 'invalid') {
          return badRequest(
            'imuView must be null or { azimuthDeg, elevationDeg: finite numbers }',
          );
        }
        imuView = parsed;
      }

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.firmwareVersion !== undefined) updates.firmwareVersion = body.firmwareVersion;
      if (body.status !== undefined) updates.status = body.status;
      if (body.lastSeenAt !== undefined) updates.lastSeenAt = new Date(body.lastSeenAt);
      if (body.persistTelemetry !== undefined) updates.persistTelemetry = body.persistTelemetry;
      if (body.autoRecord !== undefined) updates.autoRecord = body.autoRecord;
      if (body.gnssAntBias !== undefined) updates.gnssAntBias = body.gnssAntBias;
      if (body.activeStreamsViewType !== undefined) updates.activeStreamsViewType = body.activeStreamsViewType;
      if (imuMount !== undefined) updates.imuMount = imuMount;
      if (imuView !== undefined) updates.imuView = imuView;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);
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

      // Deliver device-facing settings (GNSS antenna power, IMU mount) as a
      // retained MQTT config message (thing name = device id). Retained means
      // an offline device picks it up on next connect. The message always
      // carries the FULL device config from the updated row, so publishing on
      // either field's change keeps the retained copy complete. Publish
      // failure is surfaced as a 502 so the operator knows the device was NOT
      // told — the DB row is already updated; re-saving retries the publish.
      if (body.gnssAntBias !== undefined || imuMount !== undefined) {
        try {
          await publishDeviceConfig(id, {
            gnssAntBias: updated[0].gnssAntBias,
            imuMount: updated[0].imuMount,
          });
        } catch (err) {
          console.error('device config publish failed', { deviceId: id, err });
          return errorResponse(
            502,
            'CONFIG_PUBLISH_FAILED',
            'Setting saved, but delivering it to the device failed. Re-save to retry.',
          );
        }
      }
      return ok({ device: updated[0] });
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
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

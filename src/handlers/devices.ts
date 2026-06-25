import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  created,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';

const VALID_STATUSES = ['provisioned', 'online', 'offline', 'decommissioned'] as const;

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
      if (orgWorkspaceIds.length === 0) return ok({ devices: [] });
      const headerWorkspaceId =
        event.headers['x-workspace-id'] ?? event.headers['X-Workspace-Id'];
      if (headerWorkspaceId) {
        if (!orgWorkspaceIds.includes(headerWorkspaceId)) {
          return ok({ devices: [] });
        }
        const rows = await db.query.devices.findMany({
          where: eq(schema.devices.workspaceId, headerWorkspaceId),
          orderBy: [desc(schema.devices.updatedAt)],
        });
        return ok({ devices: rows });
      }
      const rows = await db.query.devices.findMany({
        where: inArray(schema.devices.workspaceId, orgWorkspaceIds),
        orderBy: [desc(schema.devices.updatedAt)],
      });
      return ok({ devices: rows });
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

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.firmwareVersion !== undefined) updates.firmwareVersion = body.firmwareVersion;
      if (body.status !== undefined) updates.status = body.status;
      if (body.lastSeenAt !== undefined) updates.lastSeenAt = new Date(body.lastSeenAt);
      if (body.persistTelemetry !== undefined) updates.persistTelemetry = body.persistTelemetry;
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

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { asc, desc, eq, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requirePrincipal,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  created,
  forbidden,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { apiHandler } from '../utils/api-handler';

// device_models is a platform-wide catalog: any authenticated caller can read,
// including an API-key caller (`requirePrincipal`, not `requireAuth`) — the
// catalog is org-blind data a consumer legitimately needs before registering a
// device. Mutations require `users.role === 'admin'` (platform admin),
// regardless of org membership, and an API-key principal is always platform
// role `'user'`, so writes stay closed to keys with no extra check.
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    auth = await requirePrincipal(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const requirePlatformAdmin = (): APIGatewayProxyResultV2 | null =>
    auth.role === 'admin' ? null : forbidden('Platform admin role required');

  switch (method) {
    case 'GET': {
      if (id) {
        const row = await db.query.deviceModels.findFirst({
          where: eq(schema.deviceModels.id, id),
        });
        if (!row) return notFound(`Device model "${id}" not found`);
        return ok({ device_model: row });
      }
      // Standardized list dialect (utils/list-params). Default order preserves
      // the prior behaviour (newest first).
      const parsed = parseListParams(event, {
        sortable: ['createdAt', 'name'],
        defaultSort: 'createdAt',
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy } = parsed;

      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.deviceModels);
      const total = Number(totalRows[0]?.total ?? 0);

      const sortCol =
        sortBy === 'name' ? schema.deviceModels.name : schema.deviceModels.createdAt;
      const rows = await db.query.deviceModels.findMany({
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });
      return ok({ device_models: rows, page: pageMeta(parsed, total) });
    }
    case 'POST': {
      const denial = requirePlatformAdmin();
      if (denial) return denial;
      let body: {
        name?: string;
        sku?: string;
        ioCapabilities?: unknown;
        firmwareChannel?: string;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const name = body.name?.trim();
      const sku = body.sku?.trim();
      if (!name || !sku) return badRequest('name and sku are required');

      const [row] = await db
        .insert(schema.deviceModels)
        .values({
          name,
          sku,
          ioCapabilities: body.ioCapabilities ?? null,
          firmwareChannel: body.firmwareChannel ?? null,
        })
        .returning();
      return created({ device_model: row });
    }
    case 'PUT': {
      const denial = requirePlatformAdmin();
      if (denial) return denial;
      if (!id) return badRequest('device_model id required in path');
      let body: {
        name?: string;
        sku?: string;
        ioCapabilities?: unknown;
        firmwareChannel?: string;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.sku !== undefined) updates.sku = body.sku;
      if (body.ioCapabilities !== undefined) {
        updates.ioCapabilities = body.ioCapabilities;
      }
      if (body.firmwareChannel !== undefined) updates.firmwareChannel = body.firmwareChannel;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      const updated = await db
        .update(schema.deviceModels)
        .set(updates)
        .where(eq(schema.deviceModels.id, id))
        .returning();
      if (updated.length === 0) return notFound(`Device model "${id}" not found`);
      return ok({ device_model: updated[0] });
    }
    case 'DELETE': {
      const denial = requirePlatformAdmin();
      if (denial) return denial;
      if (!id) return badRequest('device_model id required in path');
      const deleted = await db
        .delete(schema.deviceModels)
        .where(eq(schema.deviceModels.id, id))
        .returning({ id: schema.deviceModels.id });
      if (deleted.length === 0) return notFound(`Device model "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

export const handler = apiHandler(restHandler);

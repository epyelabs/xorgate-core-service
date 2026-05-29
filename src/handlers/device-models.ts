import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { desc, eq } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireAuth,
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

// device_models is a platform-wide catalog: any authenticated user can read.
// Mutations require `users.role === 'admin'` (platform admin), regardless of org membership.
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    auth = await requireAuth(event);
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
      const rows = await db.query.deviceModels.findMany({
        orderBy: [desc(schema.deviceModels.createdAt)],
      });
      return ok({ device_models: rows });
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

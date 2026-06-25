import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq } from 'drizzle-orm';
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

  switch (method) {
    case 'GET': {
      if (id) {
        const row = await db.query.workspaces.findFirst({
          where: and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.organizationId, auth.organizationId),
          ),
        });
        if (!row) return notFound(`Workspace "${id}" not found`);
        return ok({ workspace: row });
      }
      const rows = await db.query.workspaces.findMany({
        where: eq(schema.workspaces.organizationId, auth.organizationId),
        orderBy: [desc(schema.workspaces.updatedAt)],
      });
      return ok({ workspaces: rows });
    }
    case 'POST': {
      let body: { name?: string; slug?: string; description?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const name = body.name?.trim();
      const slug = body.slug?.trim();
      if (!name || !slug) return badRequest('name and slug are required');

      const [row] = await db
        .insert(schema.workspaces)
        .values({
          organizationId: auth.organizationId,
          name,
          slug,
          description: body.description ?? null,
        })
        .returning();
      return created({ workspace: row });
    }
    case 'PUT': {
      if (!id) return badRequest('workspace id required in path');
      let body: { name?: string; slug?: string; description?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (body.description !== undefined) updates.description = body.description;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      const updated = await db
        .update(schema.workspaces)
        .set(updates)
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.organizationId, auth.organizationId),
          ),
        )
        .returning();
      if (updated.length === 0) return notFound(`Workspace "${id}" not found`);
      return ok({ workspace: updated[0] });
    }
    case 'DELETE': {
      if (!id) return badRequest('workspace id required in path');
      const deleted = await db
        .delete(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.organizationId, auth.organizationId),
          ),
        )
        .returning({ id: schema.workspaces.id });
      if (deleted.length === 0) return notFound(`Workspace "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

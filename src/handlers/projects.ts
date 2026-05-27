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
        const row = await db.query.projects.findFirst({
          where: and(
            eq(schema.projects.id, id),
            eq(schema.projects.organizationId, auth.organizationId),
          ),
        });
        if (!row) return notFound(`Project "${id}" not found`);
        return ok({ project: row });
      }
      const rows = await db.query.projects.findMany({
        where: eq(schema.projects.organizationId, auth.organizationId),
        orderBy: [desc(schema.projects.updatedAt)],
      });
      return ok({ projects: rows });
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
        .insert(schema.projects)
        .values({
          organizationId: auth.organizationId,
          name,
          slug,
          description: body.description ?? null,
        })
        .returning();
      return created({ project: row });
    }
    case 'PUT': {
      if (!id) return badRequest('project id required in path');
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
        .update(schema.projects)
        .set(updates)
        .where(
          and(
            eq(schema.projects.id, id),
            eq(schema.projects.organizationId, auth.organizationId),
          ),
        )
        .returning();
      if (updated.length === 0) return notFound(`Project "${id}" not found`);
      return ok({ project: updated[0] });
    }
    case 'DELETE': {
      if (!id) return badRequest('project id required in path');
      const deleted = await db
        .delete(schema.projects)
        .where(
          and(
            eq(schema.projects.id, id),
            eq(schema.projects.organizationId, auth.organizationId),
          ),
        )
        .returning({ id: schema.projects.id });
      if (deleted.length === 0) return notFound(`Project "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

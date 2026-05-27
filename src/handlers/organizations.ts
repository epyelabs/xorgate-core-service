import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { eq, inArray } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireAuth,
  requireOrgContext,
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

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  // POST without id = bootstrap a new org (no active-org required).
  // Other routes require an active org context.
  if (method === 'POST' && !id) {
    let auth;
    try {
      auth = await requireAuth(event);
    } catch (err) {
      if (err instanceof AuthError) return authErrorResponse(err);
      throw err;
    }

    let body: { name?: string; slug?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return badRequest('Invalid JSON body');
    }

    const name = body.name?.trim();
    const slug = body.slug?.trim();
    if (!name || !slug) return badRequest('name and slug are required');

    const [org] = await db
      .insert(schema.organizations)
      .values({ name, slug })
      .returning();

    await db
      .insert(schema.memberships)
      .values({ userId: auth.userId, organizationId: org.id, role: 'owner' });

    return created({ organization: org });
  }

  // GET /organizations without id = list orgs the caller is a member of.
  if (method === 'GET' && !id) {
    let auth;
    try {
      auth = await requireAuth(event);
    } catch (err) {
      if (err instanceof AuthError) return authErrorResponse(err);
      throw err;
    }

    const userMemberships = await db.query.memberships.findMany({
      where: eq(schema.memberships.userId, auth.userId),
    });

    const orgs = userMemberships.length
      ? await db.query.organizations.findMany({
          where: inArray(
            schema.organizations.id,
            userMemberships.map((m) => m.organizationId),
          ),
        })
      : [];

    return ok({ organizations: orgs });
  }

  // Everything else requires an active org context with appropriate role.
  let auth;
  try {
    const writeMethod = method === 'PUT' || method === 'DELETE';
    auth = await requireOrgContext(
      event,
      writeMethod ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  switch (method) {
    case 'GET': {
      if (id !== auth.organizationId) {
        return notFound(`Organization "${id}" not found`);
      }
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, id),
      });
      if (!org) return notFound(`Organization "${id}" not found`);
      return ok({ organization: org });
    }
    case 'PUT': {
      if (id !== auth.organizationId) return forbidden('Cannot edit other organizations');
      let body: { name?: string; slug?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      const [updated] = await db
        .update(schema.organizations)
        .set(updates)
        .where(eq(schema.organizations.id, id!))
        .returning();
      if (!updated) return notFound(`Organization "${id}" not found`);
      return ok({ organization: updated });
    }
    case 'DELETE': {
      if (id !== auth.organizationId) return forbidden('Cannot delete other organizations');
      if (auth.membershipRole !== 'owner') {
        return forbidden('Only owners can delete an organization');
      }
      const deleted = await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, id!))
        .returning({ id: schema.organizations.id });
      if (deleted.length === 0) return notFound(`Organization "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

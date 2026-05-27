import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import type { MembershipRole } from '../types/index';
import {
  badRequest,
  created,
  forbidden,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';

const VALID_ROLES: MembershipRole[] = ['owner', 'admin', 'member', 'viewer'];

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'DELETE';
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
      const rows = await db.query.memberships.findMany({
        where: eq(schema.memberships.organizationId, auth.organizationId),
      });
      return ok({ memberships: rows });
    }
    case 'POST': {
      let body: { userId?: string; email?: string; role?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const role = (body.role ?? 'member') as MembershipRole;
      if (!VALID_ROLES.includes(role)) {
        return badRequest(`role must be one of: ${VALID_ROLES.join(', ')}`);
      }

      let userId = body.userId;
      if (!userId && body.email) {
        const u = await db.query.users.findFirst({
          where: eq(schema.users.email, body.email),
        });
        if (!u) return notFound(`No user found with email "${body.email}"`);
        userId = u.id;
      }
      if (!userId) return badRequest('userId or email required');

      const existing = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.organizationId, auth.organizationId),
        ),
      });
      if (existing) {
        return badRequest('User is already a member of this organization');
      }

      const [m] = await db
        .insert(schema.memberships)
        .values({ userId, organizationId: auth.organizationId, role })
        .returning();
      return created({ membership: m });
    }
    case 'DELETE': {
      if (!id) return badRequest('membership id required in path');

      const m = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.id, id),
          eq(schema.memberships.organizationId, auth.organizationId),
        ),
      });
      if (!m) return notFound(`Membership "${id}" not found`);

      if (m.role === 'owner') {
        const owners = await db.query.memberships.findMany({
          where: and(
            eq(schema.memberships.organizationId, auth.organizationId),
            eq(schema.memberships.role, 'owner'),
          ),
        });
        if (owners.length <= 1) {
          return forbidden('Cannot remove the last owner of an organization');
        }
      }

      await db.delete(schema.memberships).where(eq(schema.memberships.id, id));
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, DELETE');
  }
};

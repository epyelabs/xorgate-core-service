import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireAuth } from '../middleware/auth';
import { db, schema } from '../db/index';
import { methodNotAllowed, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'GET') return methodNotAllowed(method, 'GET');

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

  return ok({
    user: {
      id: auth.userId,
      email: auth.email,
      name: auth.name,
      tier: auth.tier,
      role: auth.role,
    },
    memberships: userMemberships,
    organizations: orgs,
  });
};

export const handler = apiHandler(restHandler);

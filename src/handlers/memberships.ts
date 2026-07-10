import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
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

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

// Lazily constructed so importing this module (e.g. in tests) needs no creds.
let cognitoClient: CognitoIdentityProviderClient | undefined;
function getCognito(): CognitoIdentityProviderClient {
  if (!cognitoClient) cognitoClient = new CognitoIdentityProviderClient({});
  return cognitoClient;
}

function subFromAttributes(attrs: AttributeType[] | undefined): string | undefined {
  return attrs?.find((a) => a.Name === 'sub')?.Value;
}

// Provisions a Cognito account for an invited email that has no user yet, and
// mirrors it into our users table. Cognito emails a temporary password; the
// invitee sets a real one on first sign-in (the NEW_PASSWORD_REQUIRED challenge
// handled in the web app). Returns the new user's id (its Cognito sub) and
// whether an invitation email was actually sent (false when the Cognito account
// already existed but had no users row yet).
async function provisionInvitedUser(
  email: string,
): Promise<{ userId: string; emailed: boolean }> {
  if (!USER_POOL_ID) {
    throw new Error('COGNITO_USER_POOL_ID is not configured');
  }
  const client = getCognito();
  let sub: string | undefined;
  let emailed = false;
  try {
    const res = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        // Self-signup uses the email as the username (email is a sign-in alias),
        // so admin-created invitees are created the same way for consistency.
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    sub = subFromAttributes(res.User?.Attributes);
    emailed = true;
  } catch (err) {
    // Cognito account already exists (e.g. they signed up but never hit an
    // authed endpoint, so no users row was created). Reuse it — no new email.
    if (err instanceof UsernameExistsException) {
      const got = await client.send(
        new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email }),
      );
      sub = subFromAttributes(got.UserAttributes);
    } else {
      throw err;
    }
  }
  if (!sub) {
    throw new Error('Could not resolve the Cognito user id for the invitee');
  }
  // Mirror the identity into our users table so the roster resolves immediately
  // and the membership FK is satisfied. requireAuth also does this on the
  // invitee's first authenticated request; onConflictDoNothing makes it a no-op
  // if that already happened.
  await db.insert(schema.users).values({ id: sub, email }).onConflictDoNothing();
  return { userId: sub, emailed };
}

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
        orderBy: [asc(schema.memberships.createdAt)],
      });
      // Enrich each membership with its member's identity (name/email) so the
      // roster UI can render without a second round-trip. Memberships reference
      // users by id; resolve them in one inArray query and merge. No drizzle
      // relations are defined, so this mirrors the me/organizations handlers.
      const userIds = [...new Set(rows.map((m) => m.userId))];
      const usersById = new Map<
        string,
        { id: string; email: string; name: string | null }
      >();
      if (userIds.length) {
        const userRows = await db.query.users.findMany({
          where: inArray(schema.users.id, userIds),
        });
        for (const u of userRows) {
          usersById.set(u.id, { id: u.id, email: u.email, name: u.name ?? null });
        }
      }
      const memberships = rows.map((m) => ({
        ...m,
        user: usersById.get(m.userId) ?? null,
      }));
      return ok({ memberships });
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
      // True when we created a brand-new Cognito account and emailed an invite,
      // so the client can tell "added existing user" from "invited new user".
      let invited = false;
      if (!userId && body.email) {
        const email = body.email.trim();
        if (!email) return badRequest('email must not be empty');
        const u = await db.query.users.findFirst({
          where: eq(schema.users.email, email),
        });
        if (u) {
          userId = u.id;
        } else {
          // No account for this email yet — provision one (Cognito emails a
          // temporary password) instead of rejecting the invite.
          const provisioned = await provisionInvitedUser(email);
          userId = provisioned.userId;
          invited = provisioned.emailed;
        }
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
      return created({ membership: m, invited });
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

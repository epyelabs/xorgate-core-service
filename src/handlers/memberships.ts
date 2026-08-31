import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
  requireOrgWideContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { revokeLiveAccessForUser } from '../services/live-access';
import { brandContext, sendEmail } from '../services/email';
import { addedToOrganizationEmail } from '../email/templates';
import type { MembershipRole } from '../types/index';
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
// mirrors it into our users table. Cognito emails a temporary password, in
// xorgate's own template (the CustomMessage trigger, src/email/templates.ts,
// which reads the organization and inviter out of ClientMetadata); the invitee
// sets a real password on first sign-in (the NEW_PASSWORD_REQUIRED challenge
// handled in the web app). Returns the new user's id (its Cognito sub) and
// whether an invitation email was actually sent (false when the Cognito account
// already existed but had no users row yet).
async function provisionInvitedUser(
  email: string,
  invite: { organizationName: string; inviterName?: string | null },
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
        // Surfaces in the CustomMessage trigger as `clientMetadata`, which is
        // the only way the invitation email can name the organization and the
        // person who sent it. Cognito never persists these.
        ClientMetadata: {
          organizationName: invite.organizationName,
          ...(invite.inviterName ? { inviterName: invite.inviterName } : {}),
        },
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

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'PATCH' || method === 'DELETE';
    auth = await requireOrgWideContext(
      event,
      writeMethod ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  switch (method) {
    case 'GET': {
      // Standardized list dialect (utils/list-params). Default order stays
      // ascending-by-join-date, the roster order the UI always showed.
      const parsed = parseListParams(event, {
        defaultOrder: 'asc',
        sortable: ['createdAt', 'role'],
        defaultSort: 'createdAt',
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy } = parsed;

      const where = eq(schema.memberships.organizationId, auth.organizationId);
      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.memberships)
        .where(where);
      const total = Number(totalRows[0]?.total ?? 0);

      const sortCol =
        sortBy === 'role' ? schema.memberships.role : schema.memberships.createdAt;
      const rows = await db.query.memberships.findMany({
        where,
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
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
      return ok({ memberships, page: pageMeta(parsed, total) });
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

      // Both emails this endpoint can send name the organization, and the
      // invitation carries it into Cognito as ClientMetadata, so resolve it up
      // front rather than once per branch.
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, auth.organizationId),
      });
      // Null for an API key, which has no human behind it; the templates then
      // say "an administrator" rather than naming nobody.
      const inviterName = auth.name ?? auth.email;

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
          const provisioned = await provisionInvitedUser(email, {
            organizationName: org?.name ?? 'your organization',
            inviterName,
          });
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

      // Cognito already mailed a brand-new account its temporary password. An
      // account that already existed gets no credential, so it hears about the
      // membership from us instead — otherwise being added is completely
      // silent. Best-effort (services/email.ts swallows failures): the
      // membership row is the fact, the email a courtesy.
      if (!invited && org) {
        const member = await db.query.users.findFirst({
          where: eq(schema.users.id, userId),
        });
        if (member) {
          await sendEmail(
            member.email,
            addedToOrganizationEmail(brandContext(), {
              email: member.email,
              name: member.name ?? null,
              organizationName: org.name,
              inviterName,
            }),
          );
        }
      }

      return created({ membership: m, invited });
    }
    case 'PATCH': {
      // Change a member's role in place. Before this existed the only way to
      // change a role was remove-and-reinvite (N6 6f).
      if (!id) return badRequest('membership id required in path');

      let body: { role?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const role = body.role as MembershipRole | undefined;
      if (!role || !VALID_ROLES.includes(role)) {
        return badRequest(`role must be one of: ${VALID_ROLES.join(', ')}`);
      }

      const m = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.id, id),
          eq(schema.memberships.organizationId, auth.organizationId),
        ),
      });
      if (!m) return notFound(`Membership "${id}" not found`);

      // The extra owner check, same precedent as DELETE /organizations/{id}:
      // the middleware gate is owner|admin, and owner-level changes need owner.
      // Without this an admin could promote themselves (or an accomplice) to
      // owner, or demote an owner, both privilege escalations past the gate.
      if ((m.role === 'owner' || role === 'owner') && auth.membershipRole !== 'owner') {
        return forbidden('Only owners can grant or revoke the owner role');
      }

      // Demoting the last owner would lock the organization out of itself:
      // every owner-gated operation (including this one) would become
      // permanently unreachable. Same guard as DELETE.
      if (m.role === 'owner' && role !== 'owner') {
        const owners = await db.query.memberships.findMany({
          where: and(
            eq(schema.memberships.organizationId, auth.organizationId),
            eq(schema.memberships.role, 'owner'),
          ),
        });
        if (owners.length <= 1) {
          return forbidden('Cannot demote the last owner of an organization');
        }
      }

      if (role === m.role) return ok({ membership: m });

      const [updated] = await db
        .update(schema.memberships)
        .set({ role })
        .where(eq(schema.memberships.id, id))
        .returning();
      return ok({ membership: updated });
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

      // Removing the last membership must also revoke live-plane access. The
      // browser IoT policy is attached to the user's Cognito IDENTITY, not to
      // their membership, so without this it survives the removal forever and a
      // former member keeps subscribing to telemetry for as long as they can
      // mint a token. Only on the LAST membership: the policy is org-blind, so
      // a user still in another org is still entitled to it.
      //
      // Best-effort. The membership is already gone and re-running the DELETE
      // is not possible (404), so failing the response here would leave the
      // caller unable to retry the part that did not happen. The sweep this
      // needs as a backstop is not built; noted in the phase handoff.
      const remaining = await db.query.memberships.findFirst({
        where: eq(schema.memberships.userId, m.userId),
      });
      if (!remaining) {
        try {
          const detached = await revokeLiveAccessForUser(m.userId);
          if (detached.length) {
            console.log(
              `[memberships] revoked live access for ${m.userId}: ${detached.join(', ')}`,
            );
          }
        } catch (err) {
          console.error('[memberships] live-access revoke failed', err);
        }
      }

      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PATCH, DELETE');
  }
};

export const handler = apiHandler(restHandler);

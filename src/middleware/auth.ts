import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { memberships, users } from '../db/schema';
import type {
  AuthContext,
  MembershipRole,
  OrgAuthContext,
  UserRole,
  UserTier,
} from '../types/index';

export class AuthError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 401, code = 'UNAUTHORIZED') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.COGNITO_CLIENT_ID!,
});

export async function requireAuth(event: APIGatewayProxyEventV2): Promise<AuthContext> {
  const authHeader = event.headers['authorization'] ?? event.headers['Authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = await verifier.verify(token);
  } catch {
    throw new AuthError('Invalid or expired token');
  }

  const sub = payload.sub;
  const email = payload.email as string;
  const name = (payload.name as string | undefined) ?? null;

  let user = await db.query.users.findFirst({ where: eq(users.id, sub) });

  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({ id: sub, email, name })
      .returning();
    user = newUser;
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name ?? null,
    tier: (user.tier ?? 'free') as UserTier,
    role: user.role as UserRole,
  };
}

// Resolves the active organization for the caller.
// Order of resolution:
//   1. `X-Organization-Id` header (if present, must match a membership row)
//   2. Sole membership (if the user belongs to exactly one org)
//   3. Otherwise — error
export async function requireOrgContext(
  event: APIGatewayProxyEventV2,
  requiredRoles?: MembershipRole[],
): Promise<OrgAuthContext> {
  const auth = await requireAuth(event);

  const headerOrgId =
    event.headers['x-organization-id'] ?? event.headers['X-Organization-Id'];

  let membership;
  if (headerOrgId) {
    membership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, auth.userId),
        eq(memberships.organizationId, headerOrgId),
      ),
    });
    if (!membership) {
      throw new AuthError(
        `Not a member of organization "${headerOrgId}"`,
        403,
        'FORBIDDEN',
      );
    }
  } else {
    const userMemberships = await db.query.memberships.findMany({
      where: eq(memberships.userId, auth.userId),
    });
    if (userMemberships.length === 0) {
      throw new AuthError(
        'No organization for this user. Create one via POST /organizations.',
        403,
        'NO_ORGANIZATION',
      );
    }
    if (userMemberships.length > 1) {
      throw new AuthError(
        'Multiple organizations available. Send X-Organization-Id header.',
        400,
        'ORGANIZATION_REQUIRED',
      );
    }
    membership = userMemberships[0];
  }

  const membershipRole = membership.role as MembershipRole;
  if (requiredRoles && !requiredRoles.includes(membershipRole)) {
    throw new AuthError(
      `Requires one of: ${requiredRoles.join(', ')}. You have: ${membershipRole}.`,
      403,
      'INSUFFICIENT_ROLE',
    );
  }

  return {
    ...auth,
    organizationId: membership.organizationId,
    membershipRole,
  };
}

/**
 * Authenticate, and require the caller to belong to at least ONE organization
 * without caring which.
 *
 * For endpoints whose effect is org-blind, this is the honest gate.
 * `requireOrgContext` would be wrong twice over: it rejects a multi-org caller
 * who sent no `X-Organization-Id` (a 400 for a request that needs no org), and
 * it implies a per-org effect the endpoint does not have. The live-plane grant
 * is the case in point — the browser IoT policy is one shared, org-blind policy
 * until Phase 4 narrows it, so "is this person still a member of anything?" is
 * exactly the question worth asking.
 */
export async function requireAnyMembership(
  event: APIGatewayProxyEventV2,
): Promise<AuthContext> {
  const auth = await requireAuth(event);
  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.userId, auth.userId),
  });
  if (!membership) {
    throw new AuthError(
      'No organization for this user. Create one via POST /organizations.',
      403,
      'NO_ORGANIZATION',
    );
  }
  return auth;
}

export function unauthorizedResponse(message = 'Unauthorized'): APIGatewayProxyResultV2 {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message } }),
  };
}

export function authErrorResponse(err: AuthError): APIGatewayProxyResultV2 {
  return {
    statusCode: err.statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: err.code, message: err.message } }),
  };
}

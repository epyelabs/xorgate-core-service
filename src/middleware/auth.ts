import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { memberships, users } from '../db/schema';
import { classifyCredential, touchApiKey, verifyApiKey } from '../services/api-key-auth';
import type {
  AuthContext,
  MembershipRole,
  OrgAuthContext,
  UserAuthContext,
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

/** The bearer token, or an `AuthError` if there is not one. */
function bearerToken(event: APIGatewayProxyEventV2): string {
  const authHeader = event.headers['authorization'] ?? event.headers['Authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header');
  }

  return authHeader.slice(7);
}

/**
 * Phase 3 mints `xgs_` session tokens. Until then they are rejected with their
 * own code rather than falling through to the Cognito verifier, which would
 * answer the misleading "Invalid or expired token".
 */
function rejectSessionToken(): never {
  throw new AuthError(
    'Session tokens are not accepted yet. Use an API key or a Cognito ID token.',
    401,
    'SESSION_TOKEN_UNSUPPORTED',
  );
}

/** Verify a Cognito ID token and return its user, creating the row on first sight. */
async function authenticateJwt(token: string): Promise<UserAuthContext> {
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
    principal: 'user',
    apiKeyId: null,
  };
}

/**
 * Authenticate a **user**. Cognito ID tokens only.
 *
 * An `xg_` key is refused here with its own code rather than a generic 401,
 * because the refusal is deliberate rather than a verification failure: this is
 * the gate for endpoints that need a person. `GET /me` describes a user,
 * `POST /organizations` makes one an owner, and the live-plane routes resolve a
 * Cognito identity — none of those mean anything for a credential that has no
 * user behind it. Endpoints that only need a principal use `requirePrincipal`;
 * org-scoped endpoints use `requireOrgContext`, which accepts both.
 */
export async function requireAuth(event: APIGatewayProxyEventV2): Promise<UserAuthContext> {
  const token = bearerToken(event);

  switch (classifyCredential(token)) {
    case 'sessionToken':
      return rejectSessionToken();
    case 'apiKey':
      throw new AuthError(
        'This endpoint requires a signed-in user; an API key cannot be used here.',
        401,
        'USER_CREDENTIAL_REQUIRED',
      );
    case 'jwt':
      return authenticateJwt(token);
  }
}

/**
 * Authenticate whoever is calling, user or API key, with no organization
 * resolution and no role check.
 *
 * For endpoints over platform-wide data that any authenticated caller may read.
 * `GET /device-models` is the only one today. Note that an API-key principal
 * always carries platform role `'user'`, so a handler gating writes on
 * `auth.role === 'admin'` stays closed to keys without doing anything extra.
 */
export async function requirePrincipal(event: APIGatewayProxyEventV2): Promise<AuthContext> {
  const token = bearerToken(event);

  switch (classifyCredential(token)) {
    case 'sessionToken':
      return rejectSessionToken();
    case 'apiKey': {
      const verdict = await verifyApiKey(token);
      if (!verdict.ok) throw new AuthError(verdict.message, 401, verdict.code);
      touchApiKey(verdict.apiKeyId);
      return apiKeyAuthContext(verdict.apiKeyId);
    }
    case 'jwt':
      return authenticateJwt(token);
  }
}

/** The identity half of an API-key principal: no user, never a platform admin. */
function apiKeyAuthContext(apiKeyId: string): AuthContext {
  return {
    userId: null,
    email: null,
    name: null,
    tier: 'free',
    role: 'user',
    principal: 'apiKey',
    apiKeyId,
  };
}

// Resolves the active organization for the caller.
//
// Two credential paths, discriminated on the token itself:
//
//   `Bearer xg_…`  — an API key. Org-scoped by its own row, so
//                    `X-Organization-Id` is redundant; sending a DIFFERENT one
//                    is a 403 rather than an ignored header, because a consumer
//                    that believes it is switching tenants and is not has a bug
//                    worth being told about. The key's `role` column stands in
//                    for a membership role, so every existing role gate applies
//                    unchanged.
//   `Bearer xgs_…` — a session token. Phase 3. 401 for now.
//   anything else  — a Cognito ID token, exactly as before.
//
// Cognito resolution order, unchanged:
//   1. `X-Organization-Id` header (if present, must match a membership row)
//   2. Sole membership (if the user belongs to exactly one org)
//   3. Otherwise — error
export async function requireOrgContext(
  event: APIGatewayProxyEventV2,
  requiredRoles?: MembershipRole[],
): Promise<OrgAuthContext> {
  const token = bearerToken(event);

  const kind = classifyCredential(token);
  if (kind === 'sessionToken') rejectSessionToken();
  if (kind === 'apiKey') return apiKeyOrgContext(event, token, requiredRoles);

  const auth = await authenticateJwt(token);

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
 * The API-key half of `requireOrgContext`. Resolves to the same shape, which is
 * what lets every handler stay as it is: `organizationId` comes from the key's
 * row instead of a membership row, and `membershipRole` comes from the key's
 * `role` column instead of the membership's.
 */
async function apiKeyOrgContext(
  event: APIGatewayProxyEventV2,
  token: string,
  requiredRoles?: MembershipRole[],
): Promise<OrgAuthContext> {
  const verdict = await verifyApiKey(token);
  if (!verdict.ok) throw new AuthError(verdict.message, 401, verdict.code);

  const headerOrgId =
    event.headers['x-organization-id'] ?? event.headers['X-Organization-Id'];
  if (headerOrgId && headerOrgId !== verdict.organizationId) {
    throw new AuthError(
      `This API key is scoped to a different organization than "${headerOrgId}".`,
      403,
      'FORBIDDEN',
    );
  }

  if (requiredRoles && !requiredRoles.includes(verdict.role)) {
    throw new AuthError(
      `Requires one of: ${requiredRoles.join(', ')}. This API key has: ${verdict.role}.`,
      403,
      'INSUFFICIENT_ROLE',
    );
  }

  // Stamped only after the key is known good and authorized, so a rejected
  // request never advances `lastUsedAt`. Fire-and-forget by design.
  touchApiKey(verdict.apiKeyId);

  return {
    ...apiKeyAuthContext(verdict.apiKeyId),
    organizationId: verdict.organizationId,
    membershipRole: verdict.role,
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
 *
 * Users only, by way of `requireAuth`. Its one caller attaches an IoT policy to
 * the caller's Cognito identity, and an API key does not have one, so a key here
 * is a 401 rather than a membership question. Revisit if Phase 4 gives keys a
 * live-plane path of their own; it would want its own gate, not this one.
 */
export async function requireAnyMembership(
  event: APIGatewayProxyEventV2,
): Promise<UserAuthContext> {
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

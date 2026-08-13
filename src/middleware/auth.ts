import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { memberships, users } from '../db/schema';
import { classifyCredential, touchApiKey, verifyApiKey } from '../services/api-key-auth';
import { verifySessionToken } from '../services/session-token-auth';
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
 * A session token where a PERSON is required.
 *
 * Same shape and same reasoning as the API-key refusal beside it, and refused on
 * the prefix without any lookup: a token is exchanged from a key, so it has no
 * user and no Cognito identity either. A valid and an invalid token are
 * therefore indistinguishable here, which is correct.
 */
function rejectSessionTokenForUserEndpoint(): never {
  throw new AuthError(
    'This endpoint requires a signed-in user; a session token cannot be used here.',
    401,
    'USER_CREDENTIAL_REQUIRED',
  );
}

/** The identity half of a session-token principal: no user, never a platform admin. */
function sessionTokenAuthContext(
  sessionTokenId: string,
  apiKeyId: string,
  allowedWorkspaceId: string | null,
): AuthContext {
  return {
    userId: null,
    email: null,
    name: null,
    tier: 'free',
    role: 'user',
    principal: 'sessionToken',
    apiKeyId,
    sessionTokenId,
    allowedWorkspaceId,
  };
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
    sessionTokenId: null,
    allowedWorkspaceId: null,
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
 * user behind it. A session token is refused for exactly the same reason, and
 * with the same code: it is exchanged FROM a key, so it inherits the key's
 * userlessness. Endpoints that only need a principal use `requirePrincipal`;
 * org-scoped endpoints use `requireOrgContext`, which accepts all three.
 */
export async function requireAuth(event: APIGatewayProxyEventV2): Promise<UserAuthContext> {
  const token = bearerToken(event);

  switch (classifyCredential(token)) {
    case 'sessionToken':
      return rejectSessionTokenForUserEndpoint();
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
 * Authenticate whoever is calling — user, API key or session token — with no
 * organization resolution and no role check.
 *
 * For endpoints over platform-wide data that any authenticated caller may read.
 * `GET /device-models` is the only one today. Note that an API-key or
 * session-token principal always carries platform role `'user'`, so a handler
 * gating writes on `auth.role === 'admin'` stays closed to both without doing
 * anything extra.
 *
 * **A session token is accepted here, including a workspace-scoped one.** The
 * decision is not obvious and is worth stating: the device-model catalog is
 * org-blind platform data with no tenant dimension at all, it is the metadata
 * behind a `deviceModelId` the caller can already read off any device it can
 * see, and Phase 2 opened it to keys for the same reason. Refusing it would
 * mean a third-party browser could render a device and not the name of its
 * hardware. There is nothing here for a workspace boundary to separate.
 */
export async function requirePrincipal(event: APIGatewayProxyEventV2): Promise<AuthContext> {
  const token = bearerToken(event);

  switch (classifyCredential(token)) {
    case 'sessionToken': {
      const verdict = await verifySessionToken(token);
      if (!verdict.ok) throw new AuthError(verdict.message, 401, verdict.code);
      touchApiKey(verdict.apiKeyId);
      return sessionTokenAuthContext(
        verdict.sessionTokenId,
        verdict.apiKeyId,
        verdict.workspaceId,
      );
    }
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
    sessionTokenId: null,
    allowedWorkspaceId: null,
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
//   `Bearer xgs_…` — a session token, exchanged from a key by
//                    `POST /auth/session-tokens`. Org-scoped by the minting key
//                    exactly as the key is, and OPTIONALLY narrowed to one
//                    workspace, which is the one thing no other credential can
//                    be. That narrowing lands in `allowedWorkspaceId` and is
//                    enforced by `services/workspace-scope.ts`, not here.
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
  if (kind === 'sessionToken') return sessionTokenOrgContext(event, token, requiredRoles);
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
 * The session-token half of `requireOrgContext`. Resolves to the same shape as
 * the other two, plus `allowedWorkspaceId`.
 *
 * The `X-Organization-Id` rule is the key's, inherited: the token's org is fixed
 * by the row, so the header is redundant and a DIFFERENT one is 403 rather than
 * a silent override.
 *
 * `X-Workspace-Id` gets the same treatment one level down, and this is the only
 * place it needs to happen. For every other caller that header is an advisory
 * FILTER (`GET /devices` and `GET /workflow-runs` narrow with it;
 * `POST /device-registrations` requires it), and an out-of-scope value yields an
 * empty page rather than an error. For a workspace-scoped token it is a claim
 * about tenancy, and a claim that contradicts the credential is a bug in the
 * caller: answering with an empty page would let a consumer ship a broken tenant
 * switcher and never find out. Checking it here rather than at the three header
 * reads means a fourth reader added later cannot forget.
 */
async function sessionTokenOrgContext(
  event: APIGatewayProxyEventV2,
  token: string,
  requiredRoles?: MembershipRole[],
): Promise<OrgAuthContext> {
  const verdict = await verifySessionToken(token);
  if (!verdict.ok) throw new AuthError(verdict.message, 401, verdict.code);

  const headerOrgId =
    event.headers['x-organization-id'] ?? event.headers['X-Organization-Id'];
  if (headerOrgId && headerOrgId !== verdict.organizationId) {
    throw new AuthError(
      `This session token is scoped to a different organization than "${headerOrgId}".`,
      403,
      'FORBIDDEN',
    );
  }

  const headerWorkspaceId =
    event.headers['x-workspace-id'] ?? event.headers['X-Workspace-Id'];
  if (
    verdict.workspaceId !== null &&
    headerWorkspaceId &&
    headerWorkspaceId !== verdict.workspaceId
  ) {
    throw new AuthError(
      `This session token is scoped to workspace "${verdict.workspaceId}", not "${headerWorkspaceId}".`,
      403,
      'WORKSPACE_MISMATCH',
    );
  }

  if (requiredRoles && !requiredRoles.includes(verdict.role)) {
    throw new AuthError(
      `Requires one of: ${requiredRoles.join(', ')}. This session token has: ${verdict.role}.`,
      403,
      'INSUFFICIENT_ROLE',
    );
  }

  // The token's own liveness is its `expires_at`; what `last_used_at` is for is
  // telling an operator whether the KEY is still in service, and a token
  // exchange is exactly that. Stamped only after the token is known good and
  // authorized, same rule as the key path.
  touchApiKey(verdict.apiKeyId);

  return {
    ...sessionTokenAuthContext(verdict.sessionTokenId, verdict.apiKeyId, verdict.workspaceId),
    organizationId: verdict.organizationId,
    membershipRole: verdict.role,
  };
}

/**
 * `requireOrgContext`, and additionally refuse a **workspace-scoped** session
 * token.
 *
 * For the organization-wide surfaces: memberships, API keys, organization
 * settings and credentials, the workflow/AI surface, the agent distribution, and
 * workspace WRITES. A workspace-scoped token is a tenant-bound credential held
 * by a browser somewhere out in a consumer's product; none of those resources
 * have a workspace dimension to filter on, so there is nothing to narrow and the
 * honest answer is a refusal rather than a filtered view.
 *
 * `403`, not `401`: the credential is perfectly valid, it is the SCOPE that does
 * not reach. And the refusal is independent of role, so an `owner` token is
 * refused exactly as a `viewer` one is — the boundary is tenancy, not privilege.
 *
 * An ORG-scoped session token (no `workspaceId`) passes straight through, as do
 * API keys and Cognito users. So this gate is invisible to every caller that
 * exists today.
 */
export async function requireOrgWideContext(
  event: APIGatewayProxyEventV2,
  requiredRoles?: MembershipRole[],
): Promise<OrgAuthContext> {
  const auth = await requireOrgContext(event, requiredRoles);
  assertOrgWideScope(auth);
  return auth;
}

/**
 * The refusal itself, split out so a handler that is org-wide for only SOME of
 * its methods (`workspaces.ts` reads are scoped, its writes are not) can apply
 * it without a second authentication.
 *
 * Throws `AuthError`, so call it inside the same try/catch that already wraps
 * the `requireOrgContext` call — a throw outside it becomes a 500.
 */
export function assertOrgWideScope(auth: OrgAuthContext): void {
  if (auth.allowedWorkspaceId === null) return;
  throw new AuthError(
    'This session token is scoped to a single workspace; this operation is ' +
      'organization-wide. Use the API key that minted the token.',
    403,
    'WORKSPACE_SCOPED',
  );
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

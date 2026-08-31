export type UserTier = 'free' | 'pro' | 'team';
export type UserRole = 'user' | 'admin';
export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

/**
 * What kind of credential authenticated the request.
 *
 * `'user'` is a Cognito ID token and always carries a `users` row.
 * `'apiKey'` is an `xg_` key (Phase 2) and carries no user at all: keys are
 * minted against an organization, not a person, so `userId` and `email` are
 * null and no membership query will ever find one.
 * `'sessionToken'` is an `xgs_` token (Phase 3): a short-lived credential
 * exchanged FROM a key, so it has no user either, and it is the only kind that
 * can be narrowed to a single workspace.
 */
export type PrincipalKind = 'user' | 'apiKey' | 'sessionToken';

export interface AuthContext {
  /** Cognito sub. Null for an API-key or session-token principal. */
  userId: string | null;
  /** Null for an API-key or session-token principal. */
  email: string | null;
  name: string | null;
  tier: UserTier;
  /**
   * PLATFORM role (`users.role`), not the membership role. An API-key or
   * session-token principal is always `'user'`: neither can be a platform
   * admin, which is what keeps device-model writes closed to both.
   */
  role: UserRole;
  principal: PrincipalKind;
  /**
   * `api_keys.id`. Set for an API-key principal, and ALSO for a session token,
   * where it names the key the token was minted from — attribution follows the
   * key, since that is the credential a human actually issued.
   */
  apiKeyId: string | null;
  /** `session_tokens.id` for a session-token principal, null otherwise. */
  sessionTokenId: string | null;
  /**
   * The single workspace this credential may act inside, or null for the whole
   * organization. Only a workspace-scoped session token ever sets it.
   *
   * This is an ENFORCED boundary, not the advisory `X-Workspace-Id` filter:
   * `services/workspace-scope.ts` intersects it into the workspace-id set every
   * device-scoped handler already filters on, and organization-wide handlers
   * refuse the caller outright. Adding a handler that reads org-wide data
   * without consulting it is the mistake this field exists to make visible;
   * `test/workspace-scope-coverage.test.ts` fails the build if one appears.
   */
  allowedWorkspaceId: string | null;
}

/**
 * The narrower context `requireAuth` and `requireAnyMembership` return: a real
 * Cognito user, so `userId` and `email` are known. Use this as the parameter
 * type wherever a handler genuinely needs a person (anything writing a NOT NULL
 * user foreign key, anything resolving a Cognito identity).
 */
export interface UserAuthContext extends AuthContext {
  userId: string;
  email: string;
  /**
   * `users.avatar_key`, the S3 key of the profile picture, or null for none.
   * Carried here rather than re-read per request because `authenticateJwt`
   * already has the row in hand; only `GET /me` and the avatar routes read it.
   */
  avatarKey: string | null;
  principal: 'user';
  apiKeyId: null;
  sessionTokenId: null;
  allowedWorkspaceId: null;
}

export interface OrgAuthContext extends AuthContext {
  organizationId: string;
  membershipRole: MembershipRole;
}

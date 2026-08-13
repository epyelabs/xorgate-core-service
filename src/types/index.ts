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
 */
export type PrincipalKind = 'user' | 'apiKey';

export interface AuthContext {
  /** Cognito sub. Null for an API-key principal, which has no user. */
  userId: string | null;
  /** Null for an API-key principal. */
  email: string | null;
  name: string | null;
  tier: UserTier;
  /**
   * PLATFORM role (`users.role`), not the membership role. An API-key principal
   * is always `'user'`: a key can never be a platform admin, which is what keeps
   * device-model writes closed to keys.
   */
  role: UserRole;
  principal: PrincipalKind;
  /** `api_keys.id` for an API-key principal, null otherwise. */
  apiKeyId: string | null;
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
  principal: 'user';
  apiKeyId: null;
}

export interface OrgAuthContext extends AuthContext {
  organizationId: string;
  membershipRole: MembershipRole;
}

export type UserTier = 'free' | 'pro' | 'team';
export type UserRole = 'user' | 'admin';
export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface AuthContext {
  userId: string;
  email: string;
  name: string | null;
  tier: UserTier;
  role: UserRole;
}

export interface OrgAuthContext extends AuthContext {
  organizationId: string;
  membershipRole: MembershipRole;
}

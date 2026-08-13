import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { isMembershipRole, SESSION_TOKEN_PREFIX } from './api-key-auth';
import type { MembershipRole } from '../types/index';

/**
 * Session-token verification: the public-client credential (Phase 3).
 *
 * Sits beside `api-key-auth.ts` and follows its split deliberately.
 * `middleware/auth.ts` owns WHICH credential path a request takes; this module
 * owns what an `xgs_` token means once that decision is made, and nothing here
 * touches `APIGatewayProxyEventV2`, so the reject rules and the role arithmetic
 * are unit-testable against plain objects with no fake HTTP event and no
 * database.
 *
 * The token is DB-backed and hashed rather than a stateless signed blob. That
 * is what makes revocation a row update and what lets the minting key's
 * lifecycle cascade: the verify path INNER JOINs `api_keys`, so a key that has
 * been deleted, revoked, expired or downgraded takes its live tokens with it in
 * the same single statement.
 */

/** Default TTL when the caller does not ask for one. */
export const DEFAULT_TTL_SECONDS = 900;
/** Ceiling. A token is a browser-held credential; an hour is already generous. */
export const MAX_TTL_SECONDS = 3600;
/** Floor, so a caller cannot mint something dead on arrival. */
export const MIN_TTL_SECONDS = 60;

/** The stored form of a token. SHA-256 hex, same construction as an API key. */
export function hashSessionToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** `xgs_` plus 24 random bytes base64url, the same entropy an API key carries. */
export function generateSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/**
 * Membership roles as a rank, so "never more privileged than the minting key"
 * is one comparison. Same ladder `handlers/api-keys.ts` uses for the minting
 * escalation guard.
 */
const ROLE_RANK: Record<MembershipRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

/** The lower of two roles. Used to fold the key's CURRENT role into the token's. */
export function lowerRole(a: MembershipRole, b: MembershipRole): MembershipRole {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/**
 * The joined row the verification path needs: the token, plus the reject-rule
 * fields of the key that minted it. Declared structurally so the rules below can
 * be tested against plain objects.
 */
export interface VerifiableSessionToken {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  role: string;
  createdByKeyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** The minting key's own state, from the join. */
  keyRole: string;
  keyRevokedAt: Date | null;
  keyExpiresAt: Date | null;
}

export type SessionTokenRejection =
  | { ok: false; code: 'INVALID_SESSION_TOKEN'; message: string }
  | { ok: false; code: 'SESSION_TOKEN_REVOKED'; message: string }
  | { ok: false; code: 'SESSION_TOKEN_EXPIRED'; message: string };

export type SessionTokenVerdict =
  | {
      ok: true;
      sessionTokenId: string;
      organizationId: string;
      /** NULL means org-scoped. Set means an ENFORCED workspace boundary. */
      workspaceId: string | null;
      apiKeyId: string;
      role: MembershipRole;
    }
  | SessionTokenRejection;

/**
 * The reject rules, in the order a caller most needs to hear them.
 *
 * Three properties are deliberate:
 *
 * 1. **The minting key's state is folded in rather than reported separately.**
 *    A token whose key was revoked reads as `SESSION_TOKEN_REVOKED`, not
 *    `API_KEY_REVOKED`: the holder of a session token is a browser that has
 *    never seen the key and can do nothing about it. What it needs to know is
 *    "go ask your backend for a new token", which is what the token-shaped code
 *    says. The consumer's backend learns the real reason when its own next
 *    request 401s with `API_KEY_REVOKED`.
 * 2. **The effective role is the LOWER of the token's and the key's.** The
 *    token's `role` is a snapshot from mint time; the key's is current.
 *    Downgrading a key must not leave hour-old tokens acting at the old role,
 *    and the token can never be elevated by upgrading the key either.
 * 3. **An unrecognised role on either row is an invalid token**, not a
 *    downgraded one, matching `evaluateApiKey`. Only reachable by writing the
 *    column directly; guessing at intent is how privilege bugs happen.
 */
export function evaluateSessionToken(
  row: VerifiableSessionToken | undefined,
  now: Date,
): SessionTokenVerdict {
  if (!row) {
    return { ok: false, code: 'INVALID_SESSION_TOKEN', message: 'Session token not recognized.' };
  }
  if (row.revokedAt !== null) {
    return { ok: false, code: 'SESSION_TOKEN_REVOKED', message: 'This session token was revoked.' };
  }
  if (row.keyRevokedAt !== null) {
    return {
      ok: false,
      code: 'SESSION_TOKEN_REVOKED',
      message: 'The API key this session token was minted from is no longer valid.',
    };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: 'SESSION_TOKEN_EXPIRED',
      message: `This session token expired at ${row.expiresAt.toISOString()}. Mint another.`,
    };
  }
  if (row.keyExpiresAt !== null && row.keyExpiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: 'SESSION_TOKEN_EXPIRED',
      message: 'The API key this session token was minted from has expired.',
    };
  }
  if (!isMembershipRole(row.role) || !isMembershipRole(row.keyRole)) {
    return { ok: false, code: 'INVALID_SESSION_TOKEN', message: 'Session token not recognized.' };
  }
  return {
    ok: true,
    sessionTokenId: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    apiKeyId: row.createdByKeyId,
    role: lowerRole(row.role, row.keyRole),
  };
}

/**
 * Look the presented token up by hash, joined to its minting key, and apply the
 * reject rules.
 *
 * ONE statement. The join is what makes key-revocation cascade free: checking
 * `createdByKeyId` in a second query would be a second Data API round trip on
 * every request, and the row is on the same index page anyway. The join is
 * INNER, so a token whose key row was hard-deleted (which is what
 * `DELETE /api-keys/{id}` does) matches nothing and reads as
 * `INVALID_SESSION_TOKEN` — though in practice the FK's ON DELETE CASCADE has
 * already removed the token row itself.
 *
 * A token whose organization was deleted cannot be found either:
 * `organization_id` is ON DELETE CASCADE, so the row went with it.
 */
export async function verifySessionToken(
  plaintext: string,
  now = new Date(),
): Promise<SessionTokenVerdict> {
  const rows = await db
    .select({
      id: schema.sessionTokens.id,
      organizationId: schema.sessionTokens.organizationId,
      workspaceId: schema.sessionTokens.workspaceId,
      role: schema.sessionTokens.role,
      createdByKeyId: schema.sessionTokens.createdByKeyId,
      expiresAt: schema.sessionTokens.expiresAt,
      revokedAt: schema.sessionTokens.revokedAt,
      keyRole: schema.apiKeys.role,
      keyRevokedAt: schema.apiKeys.revokedAt,
      keyExpiresAt: schema.apiKeys.expiresAt,
    })
    .from(schema.sessionTokens)
    .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.sessionTokens.createdByKeyId))
    .where(eq(schema.sessionTokens.hashedToken, hashSessionToken(plaintext)))
    .limit(1);

  return evaluateSessionToken(rows[0], now);
}

// ---- minting ---------------------------------------------------------------

export type MintRejection =
  | { ok: false; code: 'BAD_REQUEST'; message: string }
  | { ok: false; code: 'FORBIDDEN'; message: string };

/**
 * Validate and normalize a requested TTL. Out-of-range values are REJECTED
 * rather than clamped: unlike a list `limit` (which the API clamps silently),
 * a credential lifetime the caller believes it got and did not is a bug that
 * surfaces as mysterious 401s an hour later.
 */
export function resolveTtlSeconds(value: unknown): { ok: true; ttlSeconds: number } | MintRejection {
  if (value === undefined || value === null) return { ok: true, ttlSeconds: DEFAULT_TTL_SECONDS };
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, code: 'BAD_REQUEST', message: 'ttlSeconds must be an integer' };
  }
  if (value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `ttlSeconds must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
    };
  }
  return { ok: true, ttlSeconds: value };
}

/**
 * Confirm a requested `workspaceId` belongs to the minting key's organization.
 *
 * A workspace in ANOTHER organization is `403`, matching Phase 2's rule for a
 * mismatched `X-Organization-Id`: a consumer that believes it is minting a
 * tenant-scoped credential and is not has a bug worth being told about. A
 * workspace that does not exist at all is the same 403 rather than a 404,
 * because distinguishing them would confirm the existence of other
 * organizations' workspace ids.
 */
export async function assertWorkspaceInOrg(
  workspaceId: string,
  organizationId: string,
): Promise<MintRejection | null> {
  const row = await db.query.workspaces.findFirst({
    where: and(
      eq(schema.workspaces.id, workspaceId),
      eq(schema.workspaces.organizationId, organizationId),
    ),
    columns: { id: true },
  });
  if (row) return null;
  return {
    ok: false,
    code: 'FORBIDDEN',
    message: `Workspace "${workspaceId}" is not in this API key's organization.`,
  };
}

/** Delete tokens that expired more than this long ago. See `offline-sweeper.ts`. */
export const EXPIRED_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

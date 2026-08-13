import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import type { MembershipRole } from '../types/index';

/**
 * API-key verification: the credential half of design note N1.
 *
 * `middleware/auth.ts` owns the decision of WHICH credential path to take; this
 * module owns what an `xg_` key means once that decision is made. Everything
 * here is deliberately free of `APIGatewayProxyEventV2` so the interesting parts
 * (classification, the reject rules, the throttle) are unit-testable without a
 * fake HTTP event or a database.
 */

/** An API key. Minted by `POST /api-keys`, verified here. */
export const API_KEY_PREFIX = 'xg_';
/** A session token. Phase 3 mints and verifies these; Phase 2 only rejects them. */
export const SESSION_TOKEN_PREFIX = 'xgs_';

/** How many leading characters of the plaintext are stored for display. */
export const KEY_PREFIX_LENGTH = 8;

export type CredentialKind = 'apiKey' | 'sessionToken' | 'jwt';

/**
 * Which credential a bearer token is, decided on the token itself rather than on
 * a header. The two xorgate prefixes cannot collide (`xgs_` does not start with
 * `xg_`), but the session-token test runs first anyway so that adding a third
 * prefix later cannot silently reorder into ambiguity.
 *
 * Anything that is not one of ours is a JWT, which keeps the Cognito path the
 * default and unchanged: a Cognito ID token is three base64url segments joined
 * by dots and can never begin with `xg`.
 */
export function classifyCredential(token: string): CredentialKind {
  if (token.startsWith(SESSION_TOKEN_PREFIX)) return 'sessionToken';
  if (token.startsWith(API_KEY_PREFIX)) return 'apiKey';
  return 'jwt';
}

/** The stored form of a key. SHA-256 hex, matching how `POST /api-keys` mints. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** The display prefix stored alongside the hash: `xg_` plus five characters. */
export function apiKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX_LENGTH);
}

/**
 * The subset of an `api_keys` row the verification path needs. Declared
 * structurally so the rules below can be tested against plain objects.
 */
export interface VerifiableApiKey {
  id: string;
  organizationId: string;
  role: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export type ApiKeyRejection =
  | { ok: false; code: 'INVALID_API_KEY'; message: string }
  | { ok: false; code: 'API_KEY_REVOKED'; message: string }
  | { ok: false; code: 'API_KEY_EXPIRED'; message: string };

export type ApiKeyVerdict =
  | { ok: true; organizationId: string; apiKeyId: string; role: MembershipRole }
  | ApiKeyRejection;

const MEMBERSHIP_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'member', 'viewer'];

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/**
 * The reject rules, in the order a caller most needs to hear them. Revoked and
 * expired are distinguished from unknown on purpose: you had to present a valid
 * key to reach either, so the extra detail leaks nothing you did not already
 * hold, and "revoked" versus "expired" versus "wrong key entirely" are three
 * different things to go fix.
 *
 * A row whose `role` is not a recognised membership role is treated as an
 * invalid key rather than silently downgraded. That can only happen if something
 * wrote the column directly, and quietly granting it `viewer` (or `member`)
 * would be a guess about intent.
 */
export function evaluateApiKey(row: VerifiableApiKey | undefined, now: Date): ApiKeyVerdict {
  if (!row) {
    return { ok: false, code: 'INVALID_API_KEY', message: 'API key not recognized.' };
  }
  if (row.revokedAt !== null) {
    return { ok: false, code: 'API_KEY_REVOKED', message: 'This API key was revoked.' };
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: 'API_KEY_EXPIRED',
      message: `This API key expired at ${row.expiresAt.toISOString()}.`,
    };
  }
  if (!isMembershipRole(row.role)) {
    return {
      ok: false,
      code: 'INVALID_API_KEY',
      message: 'API key not recognized.',
    };
  }
  return {
    ok: true,
    organizationId: row.organizationId,
    apiKeyId: row.id,
    role: row.role,
  };
}

/**
 * Look the presented key up by hash and apply the reject rules.
 *
 * The lookup is on `api_keys_hashed_key_idx`, a unique index, so this is a
 * single-row fetch. A key whose organization was deleted cannot be found at all:
 * `organization_id` is `ON DELETE CASCADE`, so the key row went with it and this
 * returns `INVALID_API_KEY`, which is the honest answer.
 */
export async function verifyApiKey(plaintext: string, now = new Date()): Promise<ApiKeyVerdict> {
  const row = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.hashedKey, hashApiKey(plaintext)),
    columns: {
      id: true,
      organizationId: true,
      role: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  return evaluateApiKey(row, now);
}

// ---- lastUsedAt ------------------------------------------------------------

/** Do not stamp the same key more than once per this many milliseconds. */
export const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Bound on distinct keys remembered per Lambda container. Far above any real
 * organization's key count; it exists so a container that somehow sees an
 * unbounded stream of keys cannot grow this map without limit.
 */
const THROTTLE_CACHE_MAX = 1_000;

const lastStampedAt = new Map<string, number>();

/** Test seam. */
export function resetLastUsedThrottle(): void {
  lastStampedAt.clear();
}

/**
 * Decide whether this request should stamp `last_used_at`, and record the
 * decision. Pure bookkeeping over an in-memory map, so it throttles PER LAMBDA
 * CONTAINER rather than globally: with N warm containers the true write rate is
 * up to N per key per minute. That is the intended trade. The alternative
 * (a conditional UPDATE ... WHERE last_used_at < now() - interval) is one
 * database round trip per request, which is exactly the cost the throttle exists
 * to avoid, and `last_used_at` is a liveness hint, not an audit log.
 */
export function shouldStampLastUsed(
  apiKeyId: string,
  nowMs: number,
  throttleMs = LAST_USED_THROTTLE_MS,
): boolean {
  const previous = lastStampedAt.get(apiKeyId);
  if (previous !== undefined && nowMs - previous < throttleMs) return false;
  if (lastStampedAt.size >= THROTTLE_CACHE_MAX && previous === undefined) {
    lastStampedAt.clear();
  }
  lastStampedAt.set(apiKeyId, nowMs);
  return true;
}

/**
 * Stamp `last_used_at`, at most once per key per minute per container.
 *
 * Deliberately NOT awaited by the caller and deliberately swallowing its own
 * errors: a failed bookkeeping write must never turn a good request into a 500.
 * The cost of not awaiting is that a Lambda freeze can cut the statement short,
 * so `last_used_at` is "roughly when this key was last seen", never an exact
 * record. Documented as such.
 */
export function touchApiKey(apiKeyId: string, nowMs = Date.now()): void {
  if (!shouldStampLastUsed(apiKeyId, nowMs)) return;
  void db
    .update(schema.apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(schema.apiKeys.id, apiKeyId))
    .catch((err) => {
      console.warn('[api-key] last_used_at update failed', {
        apiKeyId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  API_KEY_PREFIX,
  KEY_PREFIX_LENGTH,
  LAST_USED_THROTTLE_MS,
  SESSION_TOKEN_PREFIX,
  apiKeyPrefix,
  classifyCredential,
  evaluateApiKey,
  hashApiKey,
  isMembershipRole,
  resetLastUsedThrottle,
  shouldStampLastUsed,
  type VerifiableApiKey,
} from '../src/services/api-key-auth';

/**
 * The credential half of Phase 2, tested where it is pure. The DB lookup and the
 * `APIGatewayProxyEventV2` plumbing live in `verifyApiKey` and
 * `middleware/auth.ts`; everything that decides what a credential MEANS is here
 * and needs neither.
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const KEY_ID = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-08-13T12:00:00.000Z');

function key(partial: Partial<VerifiableApiKey> = {}): VerifiableApiKey {
  return {
    id: KEY_ID,
    organizationId: ORG,
    role: 'member',
    revokedAt: null,
    expiresAt: null,
    ...partial,
  };
}

describe('classifyCredential', () => {
  // The whole design rests on these three being unambiguous, because the
  // discriminator is the token itself rather than a header.
  it('routes an xg_ key to the API-key path', () => {
    expect(classifyCredential('xg_A1b2C3d4E5f6')).toBe('apiKey');
  });

  it('routes an xgs_ token to the session-token path, not the key path', () => {
    // `xgs_` does not start with `xg_`, so this cannot collide — but the
    // session check runs first anyway, and this test is what keeps that true if
    // a fourth prefix is ever added.
    expect(classifyCredential('xgs_A1b2C3d4E5f6')).toBe('sessionToken');
    expect(SESSION_TOKEN_PREFIX.startsWith(API_KEY_PREFIX)).toBe(false);
  });

  it('routes everything else to the Cognito path', () => {
    // A Cognito ID token is three base64url segments joined by dots and can
    // never begin with `xg`. These are the shapes that must keep working
    // byte-for-byte.
    expect(classifyCredential('eyJraWQiOiJhYmMifQ.eyJzdWIiOiIxIn0.sig')).toBe('jwt');
    expect(classifyCredential('')).toBe('jwt');
    expect(classifyCredential('xg')).toBe('jwt');
    expect(classifyCredential('xgsomething')).toBe('jwt');
    expect(classifyCredential('XG_uppercase')).toBe('jwt');
  });
});

describe('hashApiKey / apiKeyPrefix', () => {
  it('hashes the way POST /api-keys stored it', () => {
    // If these two ever diverge, keys mint fine and verify never — silently.
    const plaintext = 'xg_abcdefghijklmnopqrstuvwxyz012345';
    expect(hashApiKey(plaintext)).toBe(
      createHash('sha256').update(plaintext).digest('hex'),
    );
  });

  it('stores xg_ plus five characters as the display prefix', () => {
    expect(apiKeyPrefix('xg_A1b2C3d4E5f6')).toBe('xg_A1b2C');
    expect(apiKeyPrefix('xg_A1b2C3d4E5f6')).toHaveLength(KEY_PREFIX_LENGTH);
  });
});

describe('evaluateApiKey', () => {
  it('accepts a live key and resolves its organization and role', () => {
    const verdict = evaluateApiKey(key(), NOW);
    expect(verdict).toEqual({ ok: true, organizationId: ORG, apiKeyId: KEY_ID, role: 'member' });
  });

  it('rejects a key nothing matched', () => {
    // Also the answer for a key whose organization was deleted: the row went
    // with it (ON DELETE CASCADE), so there is nothing to find.
    expect(evaluateApiKey(undefined, NOW)).toMatchObject({
      ok: false,
      code: 'INVALID_API_KEY',
    });
  });

  it('rejects a revoked key with its own code', () => {
    const verdict = evaluateApiKey(key({ revokedAt: new Date('2026-08-01T00:00:00Z') }), NOW);
    expect(verdict).toMatchObject({ ok: false, code: 'API_KEY_REVOKED' });
  });

  it('rejects an expired key, and treats the expiry instant as already past', () => {
    expect(evaluateApiKey(key({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toMatchObject({
      ok: false,
      code: 'API_KEY_EXPIRED',
    });
    expect(evaluateApiKey(key({ expiresAt: NOW }), NOW)).toMatchObject({
      ok: false,
      code: 'API_KEY_EXPIRED',
    });
  });

  it('accepts a key that expires in the future', () => {
    expect(
      evaluateApiKey(key({ expiresAt: new Date(NOW.getTime() + 1) }), NOW),
    ).toMatchObject({ ok: true });
  });

  it('checks revocation before expiry', () => {
    // Both true: the more actionable answer wins.
    const verdict = evaluateApiKey(
      key({ revokedAt: new Date('2026-08-01T00:00:00Z'), expiresAt: new Date('2026-08-02T00:00:00Z') }),
      NOW,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'API_KEY_REVOKED' });
  });

  it('refuses a key whose role column is not a role, rather than guessing one', () => {
    // Only reachable by writing the column directly. Downgrading it to `viewer`
    // or `member` would be a guess about intent, and a guess in the permissive
    // direction is how privilege bugs happen.
    expect(evaluateApiKey(key({ role: 'superuser' }), NOW)).toMatchObject({
      ok: false,
      code: 'INVALID_API_KEY',
    });
    expect(evaluateApiKey(key({ role: '' }), NOW)).toMatchObject({ ok: false });
  });

  it('carries each valid role through unchanged', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      expect(isMembershipRole(role)).toBe(true);
      expect(evaluateApiKey(key({ role }), NOW)).toMatchObject({ ok: true, role });
    }
  });
});

describe('shouldStampLastUsed', () => {
  beforeEach(resetLastUsedThrottle);

  it('stamps the first request and then throttles for a minute', () => {
    const t0 = 1_000_000;
    expect(shouldStampLastUsed(KEY_ID, t0)).toBe(true);
    expect(shouldStampLastUsed(KEY_ID, t0 + 1)).toBe(false);
    expect(shouldStampLastUsed(KEY_ID, t0 + LAST_USED_THROTTLE_MS - 1)).toBe(false);
    expect(shouldStampLastUsed(KEY_ID, t0 + LAST_USED_THROTTLE_MS)).toBe(true);
  });

  it('throttles per key, not globally', () => {
    const t0 = 1_000_000;
    expect(shouldStampLastUsed('key-a', t0)).toBe(true);
    expect(shouldStampLastUsed('key-b', t0)).toBe(true);
    expect(shouldStampLastUsed('key-a', t0 + 1)).toBe(false);
  });

  it('does not grow without bound', () => {
    // A container that somehow sees an endless stream of distinct keys drops
    // its bookkeeping rather than its memory. Worst case is an extra write.
    for (let i = 0; i < 2_500; i += 1) {
      expect(shouldStampLastUsed(`key-${i}`, 1_000_000)).toBe(true);
    }
  });
});

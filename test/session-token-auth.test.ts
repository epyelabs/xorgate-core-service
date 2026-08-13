import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  evaluateSessionToken,
  generateSessionToken,
  hashSessionToken,
  lowerRole,
  resolveTtlSeconds,
  type VerifiableSessionToken,
} from '../src/services/session-token-auth';
import { classifyCredential, SESSION_TOKEN_PREFIX } from '../src/services/api-key-auth';

/**
 * The parts of the session-token credential that are pure. The middleware test
 * exercises these through `requireOrgContext` against a faked database; this
 * file pins the rules themselves, so a change in intent fails here with a name
 * rather than three doors away.
 */

const NOW = new Date('2026-08-13T12:00:00Z');

function row(overrides: Partial<VerifiableSessionToken> = {}): VerifiableSessionToken {
  return {
    id: 'token-1',
    organizationId: 'org-1',
    workspaceId: null,
    role: 'member',
    createdByKeyId: 'key-1',
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    keyRole: 'member',
    keyRevokedAt: null,
    keyExpiresAt: null,
    ...overrides,
  };
}

describe('generated tokens', () => {
  it('carry the prefix, classify as session tokens, and are unique', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(classifyCredential(a)).toBe('sessionToken');
    expect(a).not.toEqual(b);
    // 24 bytes base64url = 32 characters, matching an API key's entropy.
    expect(a.length - SESSION_TOKEN_PREFIX.length).toBe(32);
  });

  it('hash to a stable SHA-256 hex, and never to the plaintext', () => {
    const t = generateSessionToken();
    expect(hashSessionToken(t)).toEqual(hashSessionToken(t));
    expect(hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t)).not.toContain(t);
  });
});

describe('evaluateSessionToken', () => {
  it('accepts a live token', () => {
    expect(evaluateSessionToken(row(), NOW)).toEqual({
      ok: true,
      sessionTokenId: 'token-1',
      organizationId: 'org-1',
      workspaceId: null,
      apiKeyId: 'key-1',
      role: 'member',
    });
  });

  it('passes the workspace through untouched', () => {
    const verdict = evaluateSessionToken(row({ workspaceId: 'ws-1' }), NOW);
    expect(verdict.ok && verdict.workspaceId).toBe('ws-1');
  });

  it('rejects an unknown token', () => {
    expect(evaluateSessionToken(undefined, NOW)).toMatchObject({
      ok: false,
      code: 'INVALID_SESSION_TOKEN',
    });
  });

  it('rejects revoked before expired, so the more specific reason wins', () => {
    const verdict = evaluateSessionToken(
      row({ revokedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) }),
      NOW,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'SESSION_TOKEN_REVOKED' });
  });

  it('treats expiry as inclusive: exactly at expiresAt is expired', () => {
    expect(evaluateSessionToken(row({ expiresAt: NOW }), NOW)).toMatchObject({
      ok: false,
      code: 'SESSION_TOKEN_EXPIRED',
    });
    expect(evaluateSessionToken(row({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toMatchObject(
      { ok: true },
    );
  });

  it('reports the minting key state as a TOKEN problem', () => {
    // The holder of a session token has never seen the key and cannot act on it.
    // Its useful next step is "ask for a new token", either way.
    expect(evaluateSessionToken(row({ keyRevokedAt: NOW }), NOW)).toMatchObject({
      ok: false,
      code: 'SESSION_TOKEN_REVOKED',
    });
    expect(
      evaluateSessionToken(row({ keyExpiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toMatchObject({ ok: false, code: 'SESSION_TOKEN_EXPIRED' });
  });

  it('ignores a key expiry in the future', () => {
    expect(
      evaluateSessionToken(row({ keyExpiresAt: new Date(NOW.getTime() + 60_000) }), NOW),
    ).toMatchObject({ ok: true });
  });

  it('folds the key CURRENT role in, taking the lower', () => {
    expect(evaluateSessionToken(row({ role: 'admin', keyRole: 'viewer' }), NOW)).toMatchObject({
      ok: true,
      role: 'viewer',
    });
    expect(evaluateSessionToken(row({ role: 'viewer', keyRole: 'owner' }), NOW)).toMatchObject({
      ok: true,
      role: 'viewer',
    });
  });

  it('rejects an unrecognised role on either row rather than guessing', () => {
    expect(evaluateSessionToken(row({ role: 'root' }), NOW)).toMatchObject({
      ok: false,
      code: 'INVALID_SESSION_TOKEN',
    });
    expect(evaluateSessionToken(row({ keyRole: 'root' }), NOW)).toMatchObject({
      ok: false,
      code: 'INVALID_SESSION_TOKEN',
    });
  });
});

describe('lowerRole', () => {
  it('orders the ladder and is commutative', () => {
    expect(lowerRole('owner', 'admin')).toBe('admin');
    expect(lowerRole('admin', 'owner')).toBe('admin');
    expect(lowerRole('member', 'viewer')).toBe('viewer');
    expect(lowerRole('member', 'member')).toBe('member');
  });
});

describe('resolveTtlSeconds', () => {
  it('defaults when absent', () => {
    expect(resolveTtlSeconds(undefined)).toEqual({ ok: true, ttlSeconds: DEFAULT_TTL_SECONDS });
    expect(resolveTtlSeconds(null)).toEqual({ ok: true, ttlSeconds: DEFAULT_TTL_SECONDS });
  });

  it('accepts the bounds inclusively', () => {
    expect(resolveTtlSeconds(MIN_TTL_SECONDS)).toEqual({ ok: true, ttlSeconds: MIN_TTL_SECONDS });
    expect(resolveTtlSeconds(MAX_TTL_SECONDS)).toEqual({ ok: true, ttlSeconds: MAX_TTL_SECONDS });
  });

  it('REJECTS out of range rather than clamping', () => {
    // Deliberately unlike the list `limit`, which clamps: a credential lifetime
    // you believe you got and did not surfaces as mysterious 401s much later.
    expect(resolveTtlSeconds(MAX_TTL_SECONDS + 1)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(resolveTtlSeconds(MIN_TTL_SECONDS - 1)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(resolveTtlSeconds(0)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(resolveTtlSeconds(-900)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });

  it('rejects non-integers and non-numbers', () => {
    expect(resolveTtlSeconds(900.5)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(resolveTtlSeconds('900')).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(resolveTtlSeconds(Number.NaN)).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });
});

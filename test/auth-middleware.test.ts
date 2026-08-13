import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `requireOrgContext` is the shared entry point of every handler, so this is the
 * one place where "the Cognito path is unchanged" can be asserted rather than
 * believed. The matrix is the one design note N1 asked for, widened to the
 * cases Phase 2 actually introduced: session-token stub, role gates, and the
 * mismatched-tenancy header.
 *
 * Both dependencies are faked at the module boundary: the JWT verifier (so no
 * Cognito) and the drizzle handle (so no database). Everything in between is the
 * real middleware.
 */

const verify = vi.fn();
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: (token: string) => verify(token) }) },
}));

interface FakeUser {
  id: string;
  email: string;
  name: string | null;
  tier: string | null;
  role: string;
}
interface FakeMembership {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
}
interface FakeApiKey {
  id: string;
  organizationId: string;
  role: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  hashedKey: string;
}
interface FakeSessionToken {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  role: string;
  createdByKeyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  hashedToken: string;
}
interface FakeWorkspace {
  id: string;
  organizationId: string;
}

const store = {
  users: [] as FakeUser[],
  memberships: [] as FakeMembership[],
  apiKeys: [] as FakeApiKey[],
  sessionTokens: [] as FakeSessionToken[],
  workspaces: [] as FakeWorkspace[],
};
/** Every `where` the middleware builds, in call order, for assertions below. */
const lookups: string[] = [];
const updates: string[] = [];

vi.mock('../src/db/index', async () => {
  // The real table definitions, so `eq(schema.apiKeys.hashedKey, …)` still
  // builds a real expression. Only the connection is fake.
  const realSchema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  // The middleware only ever calls findFirst/findMany with an `eq`/`and` of
  // columns we can identify by name, so the fake matches on the rendered SQL
  // parameters rather than reimplementing drizzle.
  const matcher = (where: unknown) => {
    const values: unknown[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.queryChunks)) node.queryChunks.forEach(walk);
      if (node.value !== undefined && typeof node.value !== 'object') values.push(node.value);
      if (Array.isArray(node)) node.forEach(walk);
    };
    walk(where);
    return values.map(String);
  };
  const table = <T extends Record<string, unknown>>(
    rows: () => T[],
    name: string,
    fields: (keyof T)[],
  ) => ({
    findFirst: async ({ where }: { where: unknown }) => {
      const values = matcher(where);
      lookups.push(`${name}:${values.join(',')}`);
      return rows().find((row) => values.every((v) => fields.some((f) => String(row[f]) === v)));
    },
    findMany: async ({ where }: { where: unknown }) => {
      const values = matcher(where);
      lookups.push(`${name}:${values.join(',')}`);
      return rows().filter((row) => values.every((v) => fields.some((f) => String(row[f]) === v)));
    },
  });

  // `verifySessionToken` is the one query in the middleware that is a builder
  // chain rather than a relational `findFirst`, because it JOINs the minting key
  // (that join is what makes key revocation cascade without a second round
  // trip). Faked as a chain that ignores everything except the `where`, which is
  // always the token hash.
  const selectChain = () => ({
    from: () => ({
      innerJoin: () => ({
        where: (where: unknown) => {
          const values = matcher(where);
          lookups.push(`sessionTokens:${values.join(',')}`);
          return {
            limit: async () => {
              const token = store.sessionTokens.find((t) =>
                values.every((v) => String(t.hashedToken) === v),
              );
              if (!token) return [];
              const key = store.apiKeys.find((k) => k.id === token.createdByKeyId);
              // INNER JOIN: no key row, no result. This is the hard-delete path.
              if (!key) return [];
              return [
                {
                  id: token.id,
                  organizationId: token.organizationId,
                  workspaceId: token.workspaceId,
                  role: token.role,
                  createdByKeyId: token.createdByKeyId,
                  expiresAt: token.expiresAt,
                  revokedAt: token.revokedAt,
                  keyRole: key.role,
                  keyRevokedAt: key.revokedAt,
                  keyExpiresAt: key.expiresAt,
                },
              ];
            },
          };
        },
      }),
    }),
  });

  return {
    db: {
      select: selectChain,
      query: {
        users: table(() => store.users, 'users', ['id']),
        memberships: table(() => store.memberships, 'memberships', ['userId', 'organizationId']),
        apiKeys: table(() => store.apiKeys, 'apiKeys', ['hashedKey']),
        workspaces: table(() => store.workspaces, 'workspaces', ['id', 'organizationId']),
      },
      insert: () => ({
        values: (row: FakeUser) => ({
          returning: async () => {
            store.users.push({ tier: 'free', role: 'user', name: null, ...row });
            return [store.users[store.users.length - 1]];
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: (where: unknown) => {
            updates.push(`update:${matcher(where).join(',')}`);
            return Promise.resolve([]);
          },
        }),
      }),
    },
    schema: realSchema,
  };
});

const {
  assertOrgWideScope,
  AuthError,
  requireAuth,
  requireOrgContext,
  requireOrgWideContext,
  requirePrincipal,
} = await import('../src/middleware/auth');
const { hashApiKey, resetLastUsedThrottle } = await import('../src/services/api-key-auth');
const { hashSessionToken } = await import('../src/services/session-token-auth');
const { isWorkspaceScoped, resolveWorkspaceScope } = await import(
  '../src/services/workspace-scope'
);

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000000';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000000';
const KEY_ID = 'kkkkkkkk-0000-0000-0000-000000000000';
const PLAINTEXT = 'xg_TestKeyTestKeyTestKeyTestKeyTe';
// Two workspaces on ORG_A. A scoping test with one workspace proves nothing:
// every filter looks correct when there is nothing to exclude.
const WS_1 = '11111111-0000-0000-0000-000000000000';
const WS_2 = '22222222-0000-0000-0000-000000000000';
const TOKEN_ID = 'tttttttt-0000-0000-0000-000000000000';
/** Org-scoped: no workspace. Behaves exactly like the key that minted it. */
const ORG_TOKEN = 'xgs_OrgScopedOrgScopedOrgScopedOrgS';
/** Workspace-scoped to WS_1, and provably unable to see WS_2. */
const WS_TOKEN = 'xgs_WorkspaceScopedWorkspaceScopedW';

function event(token?: string, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  } as unknown as APIGatewayProxyEventV2;
}

/** Assert an AuthError with a given status and code, and return it. */
async function refusal(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err, 'expected a refusal, got a result').toBeInstanceOf(AuthError);
  expect({ statusCode: err.statusCode, code: err.code }).toEqual({ statusCode: status, code });
  return err as InstanceType<typeof AuthError>;
}

beforeEach(() => {
  store.users = [
    { id: 'sub-1', email: 'one@example.test', name: 'One', tier: 'free', role: 'user' },
  ];
  store.memberships = [{ id: 'm1', userId: 'sub-1', organizationId: ORG_A, role: 'admin' }];
  store.apiKeys = [
    {
      id: KEY_ID,
      organizationId: ORG_A,
      role: 'member',
      revokedAt: null,
      expiresAt: null,
      hashedKey: hashApiKey(PLAINTEXT),
    },
  ];
  store.workspaces = [
    { id: WS_1, organizationId: ORG_A },
    { id: WS_2, organizationId: ORG_A },
    // A workspace in the OTHER organization, so "the org filter still applies"
    // is a claim the fixture can actually falsify.
    { id: '33333333-0000-0000-0000-000000000000', organizationId: ORG_B },
  ];
  store.sessionTokens = [
    {
      id: TOKEN_ID,
      organizationId: ORG_A,
      workspaceId: null,
      role: 'member',
      createdByKeyId: KEY_ID,
      expiresAt: new Date(Date.now() + 900_000),
      revokedAt: null,
      hashedToken: hashSessionToken(ORG_TOKEN),
    },
    {
      id: 'ssssssss-0000-0000-0000-000000000000',
      organizationId: ORG_A,
      workspaceId: WS_1,
      role: 'member',
      createdByKeyId: KEY_ID,
      expiresAt: new Date(Date.now() + 900_000),
      revokedAt: null,
      hashedToken: hashSessionToken(WS_TOKEN),
    },
  ];
  lookups.length = 0;
  updates.length = 0;
  verify.mockReset();
  verify.mockImplementation(async (token: string) => {
    if (token !== 'good-jwt') throw new Error('bad token');
    return { sub: 'sub-1', email: 'one@example.test', name: 'One' };
  });
  resetLastUsedThrottle();
});

describe('the Cognito path is unchanged', () => {
  it('resolves a sole membership with no header', async () => {
    const auth = await requireOrgContext(event('good-jwt'));
    expect(auth).toMatchObject({
      userId: 'sub-1',
      email: 'one@example.test',
      organizationId: ORG_A,
      membershipRole: 'admin',
      principal: 'user',
      apiKeyId: null,
    });
  });

  it('resolves X-Organization-Id when it matches a membership', async () => {
    const auth = await requireOrgContext(event('good-jwt', { 'x-organization-id': ORG_A }));
    expect(auth.organizationId).toBe(ORG_A);
  });

  it('403 FORBIDDEN on an organization the user does not belong to', async () => {
    await refusal(
      requireOrgContext(event('good-jwt', { 'x-organization-id': ORG_B })),
      403,
      'FORBIDDEN',
    );
  });

  it('403 NO_ORGANIZATION with no memberships', async () => {
    store.memberships = [];
    await refusal(requireOrgContext(event('good-jwt')), 403, 'NO_ORGANIZATION');
  });

  it('400 ORGANIZATION_REQUIRED with more than one and no header', async () => {
    store.memberships.push({ id: 'm2', userId: 'sub-1', organizationId: ORG_B, role: 'member' });
    await refusal(requireOrgContext(event('good-jwt')), 400, 'ORGANIZATION_REQUIRED');
  });

  it('403 INSUFFICIENT_ROLE below the required role', async () => {
    store.memberships[0]!.role = 'viewer';
    await refusal(requireOrgContext(event('good-jwt'), ['owner', 'admin']), 403, 'INSUFFICIENT_ROLE');
  });

  it('401 on a token the verifier rejects', async () => {
    await refusal(requireOrgContext(event('expired-jwt')), 401, 'UNAUTHORIZED');
  });

  it('401 with no Authorization header at all', async () => {
    await refusal(requireOrgContext(event()), 401, 'UNAUTHORIZED');
  });

  it('creates the user row on first sight, exactly as before', async () => {
    store.users = [];
    const auth = await requireOrgContext(event('good-jwt'));
    expect(store.users).toHaveLength(1);
    expect(auth.userId).toBe('sub-1');
  });

  it('never touches api_keys for a JWT caller', async () => {
    await requireOrgContext(event('good-jwt'));
    expect(lookups.filter((l) => l.startsWith('apiKeys:'))).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe('the API-key path', () => {
  it('resolves the organization and role from the key row', async () => {
    const auth = await requireOrgContext(event(PLAINTEXT));
    expect(auth).toMatchObject({
      organizationId: ORG_A,
      membershipRole: 'member',
      principal: 'apiKey',
      apiKeyId: KEY_ID,
      userId: null,
      email: null,
      role: 'user',
    });
  });

  it('never runs a membership query', async () => {
    // The point of the design: a key resolves without a user, so nothing about
    // memberships is consulted.
    await requireOrgContext(event(PLAINTEXT));
    expect(lookups.filter((l) => l.startsWith('memberships:'))).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('ignores a matching X-Organization-Id and refuses a different one', async () => {
    expect((await requireOrgContext(event(PLAINTEXT, { 'x-organization-id': ORG_A }))).organizationId)
      .toBe(ORG_A);
    const err = await refusal(
      requireOrgContext(event(PLAINTEXT, { 'x-organization-id': ORG_B })),
      403,
      'FORBIDDEN',
    );
    expect(err.message).toContain(ORG_B);
  });

  it('applies the same role gates a membership would', async () => {
    await refusal(requireOrgContext(event(PLAINTEXT), ['owner', 'admin']), 403, 'INSUFFICIENT_ROLE');
    store.apiKeys[0]!.role = 'admin';
    expect((await requireOrgContext(event(PLAINTEXT), ['owner', 'admin'])).membershipRole).toBe(
      'admin',
    );
  });

  it('401s a revoked key, an expired key, and a key nothing matches', async () => {
    store.apiKeys[0]!.revokedAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requireOrgContext(event(PLAINTEXT)), 401, 'API_KEY_REVOKED');

    store.apiKeys[0]!.revokedAt = null;
    store.apiKeys[0]!.expiresAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requireOrgContext(event(PLAINTEXT)), 401, 'API_KEY_EXPIRED');

    store.apiKeys[0]!.expiresAt = null;
    await refusal(requireOrgContext(event('xg_not-a-real-key')), 401, 'INVALID_API_KEY');
  });

  it('401s a key whose organization was deleted', async () => {
    // `api_keys.organization_id` is ON DELETE CASCADE, so the key row is gone
    // with the organization and reads as unknown.
    store.apiKeys = [];
    await refusal(requireOrgContext(event(PLAINTEXT)), 401, 'INVALID_API_KEY');
  });

  it('401s a malformed xg_ string without ever reaching the JWT verifier', async () => {
    await refusal(requireOrgContext(event('xg_')), 401, 'INVALID_API_KEY');
    expect(verify).not.toHaveBeenCalled();
  });

  it('stamps lastUsedAt once, and never on a refusal', async () => {
    await requireOrgContext(event(PLAINTEXT));
    await requireOrgContext(event(PLAINTEXT));
    expect(updates).toHaveLength(1);

    updates.length = 0;
    resetLastUsedThrottle();
    await refusal(requireOrgContext(event(PLAINTEXT), ['owner']), 403, 'INSUFFICIENT_ROLE');
    await refusal(requireOrgContext(event('xg_nope')), 401, 'INVALID_API_KEY');
    expect(updates).toEqual([]);
  });
});

describe('the session-token path', () => {
  it('resolves the organization and role from the token row', async () => {
    const auth = await requireOrgContext(event(ORG_TOKEN));
    expect(auth).toMatchObject({
      organizationId: ORG_A,
      membershipRole: 'member',
      principal: 'sessionToken',
      sessionTokenId: TOKEN_ID,
      // Attribution follows the KEY: it is the credential a human issued, and it
      // is what `device_registrations.created_by_api_key_id` should record.
      apiKeyId: KEY_ID,
      userId: null,
      email: null,
      role: 'user',
      allowedWorkspaceId: null,
    });
  });

  it('never runs a membership query and never reaches the JWT verifier', async () => {
    await requireOrgContext(event(ORG_TOKEN));
    expect(lookups.filter((l) => l.startsWith('memberships:'))).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('carries the workspace when it has one', async () => {
    const auth = await requireOrgContext(event(WS_TOKEN));
    expect(auth.allowedWorkspaceId).toBe(WS_1);
    expect(isWorkspaceScoped(auth)).toBe(true);
  });

  it('applies the same role gates a key would', async () => {
    await refusal(requireOrgContext(event(ORG_TOKEN), ['owner', 'admin']), 403, 'INSUFFICIENT_ROLE');
    store.apiKeys[0]!.role = 'admin';
    store.sessionTokens[0]!.role = 'admin';
    expect((await requireOrgContext(event(ORG_TOKEN), ['owner', 'admin'])).membershipRole).toBe(
      'admin',
    );
  });

  it('401s a revoked token, an expired token, and a token nothing matches', async () => {
    store.sessionTokens[0]!.revokedAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requireOrgContext(event(ORG_TOKEN)), 401, 'SESSION_TOKEN_REVOKED');

    store.sessionTokens[0]!.revokedAt = null;
    store.sessionTokens[0]!.expiresAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requireOrgContext(event(ORG_TOKEN)), 401, 'SESSION_TOKEN_EXPIRED');

    await refusal(requireOrgContext(event('xgs_nothing-matches-this')), 401, 'INVALID_SESSION_TOKEN');
    await refusal(requireOrgContext(event('xgs_')), 401, 'INVALID_SESSION_TOKEN');
    expect(verify).not.toHaveBeenCalled();
  });

  it('ignores a matching X-Organization-Id and refuses a different one', async () => {
    expect(
      (await requireOrgContext(event(ORG_TOKEN, { 'x-organization-id': ORG_A }))).organizationId,
    ).toBe(ORG_A);
    await refusal(
      requireOrgContext(event(ORG_TOKEN, { 'x-organization-id': ORG_B })),
      403,
      'FORBIDDEN',
    );
  });

  it('stamps the MINTING KEY lastUsedAt, and never on a refusal', async () => {
    // The token's own liveness is its expiry; `last_used_at` answers "is this
    // key still in service", and an exchange-and-use is exactly that.
    await requireOrgContext(event(ORG_TOKEN));
    expect(updates).toEqual([`update:${KEY_ID}`]);

    updates.length = 0;
    resetLastUsedThrottle();
    await refusal(requireOrgContext(event(ORG_TOKEN), ['owner']), 403, 'INSUFFICIENT_ROLE');
    await refusal(requireOrgContext(event('xgs_nope')), 401, 'INVALID_SESSION_TOKEN');
    expect(updates).toEqual([]);
  });
});

describe('the minting key cascades into its tokens', () => {
  it('dies with a revoked key, reported as a token problem', async () => {
    store.apiKeys[0]!.revokedAt = new Date('2026-01-01T00:00:00Z');
    // Not API_KEY_REVOKED: the browser holding this never saw the key and can do
    // nothing about it. "Get a new token" is the actionable answer.
    const err = await refusal(
      requireOrgContext(event(ORG_TOKEN)),
      401,
      'SESSION_TOKEN_REVOKED',
    );
    expect(err.message).toMatch(/API key/i);
  });

  it('dies with an expired key', async () => {
    store.apiKeys[0]!.expiresAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requireOrgContext(event(ORG_TOKEN)), 401, 'SESSION_TOKEN_EXPIRED');
  });

  it('dies with a DELETED key, which is the real revocation story', async () => {
    // `DELETE /api-keys/{id}` is a hard delete. The FK is ON DELETE CASCADE so
    // in Postgres the token row is gone too; the INNER JOIN makes the outcome
    // the same either way, which is what this asserts.
    store.apiKeys = [];
    await refusal(requireOrgContext(event(ORG_TOKEN)), 401, 'INVALID_SESSION_TOKEN');
  });

  it('takes the LOWER of the token role and the key CURRENT role', async () => {
    store.sessionTokens[0]!.role = 'admin';
    store.apiKeys[0]!.role = 'admin';
    expect((await requireOrgContext(event(ORG_TOKEN))).membershipRole).toBe('admin');

    // The key is downgraded after the token was minted. The hour-old token must
    // not keep acting as an admin.
    store.apiKeys[0]!.role = 'viewer';
    expect((await requireOrgContext(event(ORG_TOKEN))).membershipRole).toBe('viewer');
    await refusal(requireOrgContext(event(ORG_TOKEN), ['owner', 'admin']), 403, 'INSUFFICIENT_ROLE');

    // And the reverse: upgrading the key does not elevate a token minted below it.
    store.sessionTokens[0]!.role = 'viewer';
    store.apiKeys[0]!.role = 'owner';
    expect((await requireOrgContext(event(ORG_TOKEN))).membershipRole).toBe('viewer');
  });

  it('treats an unrecognised role on either row as an invalid token', async () => {
    store.sessionTokens[0]!.role = 'superuser';
    await refusal(requireOrgContext(event(ORG_TOKEN)), 401, 'INVALID_SESSION_TOKEN');
    store.sessionTokens[0]!.role = 'member';
    store.apiKeys[0]!.role = 'superuser';
    await refusal(requireOrgContext(event(ORG_TOKEN)), 401, 'INVALID_SESSION_TOKEN');
  });
});

describe('workspace scope is a boundary, not a filter', () => {
  it('an org-scoped caller sees every workspace in its organization and no others', async () => {
    for (const credential of ['good-jwt', PLAINTEXT, ORG_TOKEN]) {
      const auth = await requireOrgContext(event(credential));
      const ids = await resolveWorkspaceScope(auth);
      expect(ids.sort()).toEqual([WS_1, WS_2].sort());
    }
  });

  it('a workspace-scoped token sees ONLY its own workspace', async () => {
    const auth = await requireOrgContext(event(WS_TOKEN));
    const ids = await resolveWorkspaceScope(auth);
    expect(ids).toEqual([WS_1]);
    // The negative half, which is the half that matters: WS_2 exists, is in the
    // same organization, and is still not in the set.
    expect(ids).not.toContain(WS_2);
  });

  it('resolves to the empty set if the scoped workspace was deleted', async () => {
    // Never trust `allowedWorkspaceId` as a filter without re-reading it: a
    // dangling id must fail closed, not open.
    const auth = await requireOrgContext(event(WS_TOKEN));
    store.workspaces = store.workspaces.filter((w) => w.id !== WS_1);
    expect(await resolveWorkspaceScope(auth)).toEqual([]);
  });

  it('403s an X-Workspace-Id that contradicts the token, and allows the matching one', async () => {
    const auth = await requireOrgContext(event(WS_TOKEN, { 'x-workspace-id': WS_1 }));
    expect(auth.allowedWorkspaceId).toBe(WS_1);

    const err = await refusal(
      requireOrgContext(event(WS_TOKEN, { 'x-workspace-id': WS_2 })),
      403,
      'WORKSPACE_MISMATCH',
    );
    expect(err.message).toContain(WS_2);
  });

  it('leaves X-Workspace-Id alone for every other credential', async () => {
    // For a user or a key the header is still an advisory filter; an out-of-scope
    // value yields an empty page in the handler, not an error here.
    expect((await requireOrgContext(event('good-jwt', { 'x-workspace-id': WS_2 }))).organizationId)
      .toBe(ORG_A);
    expect((await requireOrgContext(event(PLAINTEXT, { 'x-workspace-id': WS_2 }))).organizationId)
      .toBe(ORG_A);
    expect((await requireOrgContext(event(ORG_TOKEN, { 'x-workspace-id': WS_2 }))).organizationId)
      .toBe(ORG_A);
  });

  it('refuses a workspace-scoped token on organization-wide operations, at any role', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      store.apiKeys[0]!.role = role;
      store.sessionTokens[1]!.role = role;
      await refusal(requireOrgWideContext(event(WS_TOKEN)), 403, 'WORKSPACE_SCOPED');
    }
  });

  it('lets every other credential through the organization-wide gate', async () => {
    for (const credential of ['good-jwt', PLAINTEXT, ORG_TOKEN]) {
      expect((await requireOrgWideContext(event(credential))).organizationId).toBe(ORG_A);
    }
  });

  it('applies the role gate BEFORE the scope gate is reached, not instead of it', async () => {
    // A viewer workspace-scoped token on an owner/admin route gets the role
    // refusal; the same token on an unrestricted org-wide route still gets the
    // scope refusal. Neither can swallow the other.
    store.sessionTokens[1]!.role = 'viewer';
    store.apiKeys[0]!.role = 'viewer';
    await refusal(
      requireOrgWideContext(event(WS_TOKEN), ['owner', 'admin']),
      403,
      'INSUFFICIENT_ROLE',
    );
    await refusal(requireOrgWideContext(event(WS_TOKEN)), 403, 'WORKSPACE_SCOPED');
  });

  it('assertOrgWideScope is the same refusal, usable per-method', async () => {
    // `workspaces.ts` reads are scoped and its writes are not, so it applies the
    // refusal itself rather than choosing a gate for the whole handler.
    const scoped = await requireOrgContext(event(WS_TOKEN));
    expect(() => assertOrgWideScope(scoped)).toThrow(AuthError);
    const orgWide = await requireOrgContext(event(ORG_TOKEN));
    expect(() => assertOrgWideScope(orgWide)).not.toThrow();
  });
});

describe('a session token is not a person', () => {
  it('requireAuth refuses it on shape alone, with the same code a key gets', async () => {
    const err = await refusal(requireAuth(event(WS_TOKEN)), 401, 'USER_CREDENTIAL_REQUIRED');
    expect(err.message).toMatch(/session token/i);
    // No lookup: a valid and an invalid token are indistinguishable here, and it
    // must not read as "your token expired".
    expect(lookups).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('requirePrincipal accepts a session token', () => {
  it('resolves it with no organization and never platform admin', async () => {
    const auth = await requirePrincipal(event(WS_TOKEN));
    expect(auth).toMatchObject({
      principal: 'sessionToken',
      apiKeyId: KEY_ID,
      userId: null,
      allowedWorkspaceId: WS_1,
    });
    // The PLATFORM role. Device-model writes gate on it, so a token being 'user'
    // is what keeps that endpoint closed to tokens.
    expect(auth.role).toBe('user');
    expect(auth).not.toHaveProperty('organizationId');
  });

  it('still enforces token validity and the key cascade', async () => {
    store.sessionTokens[1]!.revokedAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requirePrincipal(event(WS_TOKEN)), 401, 'SESSION_TOKEN_REVOKED');
    store.sessionTokens[1]!.revokedAt = null;
    store.apiKeys[0]!.revokedAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requirePrincipal(event(WS_TOKEN)), 401, 'SESSION_TOKEN_REVOKED');
  });
});

describe('requireAuth stays user-only', () => {
  it('accepts a Cognito user', async () => {
    expect((await requireAuth(event('good-jwt'))).userId).toBe('sub-1');
  });

  it('refuses an API key with a code that says why', async () => {
    const err = await refusal(requireAuth(event(PLAINTEXT)), 401, 'USER_CREDENTIAL_REQUIRED');
    expect(err.message).toMatch(/API key/i);
    // Refused on shape alone: no lookup, so a valid key and an invalid one are
    // indistinguishable here, which is correct.
    expect(lookups).toEqual([]);
  });
});

describe('requirePrincipal accepts both', () => {
  it('resolves a user', async () => {
    const auth = await requirePrincipal(event('good-jwt'));
    expect(auth).toMatchObject({ principal: 'user', userId: 'sub-1', role: 'user' });
  });

  it('resolves a key, with no organization and never platform admin', async () => {
    const auth = await requirePrincipal(event(PLAINTEXT));
    expect(auth).toMatchObject({ principal: 'apiKey', apiKeyId: KEY_ID, userId: null });
    // `role` here is the PLATFORM role. Device-model writes gate on it, so a key
    // being 'user' is what keeps that endpoint closed to keys.
    expect(auth.role).toBe('user');
    expect(auth).not.toHaveProperty('organizationId');
  });

  it('still enforces key validity', async () => {
    store.apiKeys[0]!.revokedAt = new Date('2026-01-01T00:00:00Z');
    await refusal(requirePrincipal(event(PLAINTEXT)), 401, 'API_KEY_REVOKED');
  });
});

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

const store = {
  users: [] as FakeUser[],
  memberships: [] as FakeMembership[],
  apiKeys: [] as FakeApiKey[],
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

  return {
    db: {
      query: {
        users: table(() => store.users, 'users', ['id']),
        memberships: table(() => store.memberships, 'memberships', ['userId', 'organizationId']),
        apiKeys: table(() => store.apiKeys, 'apiKeys', ['hashedKey']),
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

const { AuthError, requireAuth, requireOrgContext, requirePrincipal } = await import(
  '../src/middleware/auth'
);
const { hashApiKey, resetLastUsedThrottle } = await import('../src/services/api-key-auth');

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000000';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000000';
const KEY_ID = 'kkkkkkkk-0000-0000-0000-000000000000';
const PLAINTEXT = 'xg_TestKeyTestKeyTestKeyTestKeyTe';

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

describe('session tokens are stubbed, not fallen through', () => {
  it('401 SESSION_TOKEN_UNSUPPORTED from every gate', async () => {
    const token = 'xgs_whatever';
    await refusal(requireOrgContext(event(token)), 401, 'SESSION_TOKEN_UNSUPPORTED');
    await refusal(requireAuth(event(token)), 401, 'SESSION_TOKEN_UNSUPPORTED');
    await refusal(requirePrincipal(event(token)), 401, 'SESSION_TOKEN_UNSUPPORTED');
    // The point of the stub: it must not read as "your token expired".
    expect(verify).not.toHaveBeenCalled();
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

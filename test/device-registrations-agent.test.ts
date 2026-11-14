import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DA2 (registrations half): `agent` on POST /device-registrations, the view,
 * the same-agent reuse rule (Q-8.2), the stage flag (D5/F4), and the claim
 * copying the REGISTRATION's agent onto the device row (D2).
 *
 * The db is a small in-memory fake. Its registration lookup renders the
 * handler's real drizzle WHERE clause to SQL and honours the agent filter, so
 * "reuse only the same agent" is tested against the query the handler builds,
 * not against a stub that returns whatever the test wants.
 */

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

vi.mock('../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
    '../src/middleware/auth',
  );
  return {
    ...actual,
    requireOrgContext: async () => ({
      userId: 'user-1',
      apiKeyId: null,
      organizationId: 'org-1',
      membershipRole: 'owner',
      allowedWorkspaceId: null,
    }),
  };
});

const WS = '0199a1b2-0000-7000-8000-000000000001';
const WS_OTHER = '0199a1b2-0000-7000-8000-000000000002';
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => [WS, WS_OTHER],
}));

vi.mock('../src/services/iot-provisioning', () => ({
  provisionDevice: vi.fn(async () => ({
    thingName: 'dev-1',
    certificatePem: 'CERT',
    privateKey: 'KEY',
    caUrl: 'ca',
    dataEndpoint: 'ats.example',
    credentialEndpoint: 'cred.example',
    roleAlias: 'Alias',
    region: 'us-east-1',
    channels: [{ streamKey: 'cam0', channelName: 'dev-1-cam0', channelArn: 'arn:cam0' }],
  })),
  deleteThing: vi.fn(async () => undefined),
}));
vi.mock('../src/services/device-config', () => ({ publishDeviceConfig: vi.fn(async () => undefined) }));

type Row = Record<string, unknown>;
let registrations: Row[];
let deviceInserts: Row[];
let regInserts: Row[];
let regUpdates: Row[];
let claimReturns: Row | undefined;

const dialect = new PgDialect();
function rendered(where: SQL | undefined): { sql: string; params: unknown[] } {
  if (!where) return { sql: '', params: [] };
  return dialect.sqlToQuery(where);
}

let seq = 0;
vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    query: {
      deviceModels: {
        findFirst: async (q?: { where?: unknown }) =>
          q?.where ? { id: 'model-pinned', sku: 'PIN' } : { id: 'model-fallback', sku: 'FB' },
        findMany: async () => [],
      },
      deviceRegistrations: {
        findFirst: async (q: { where: SQL }) => {
          const { sql, params } = rendered(q.where);
          // The reuse lookup: workspace + pending + (agent) + unexpired.
          const agentFiltered = /"device_registrations"\."agent" = \$\d/.test(sql);
          const agentParam = params.find((p) => p === 'js' || p === 'rust');
          const candidates = registrations.filter(
            (r) =>
              r.workspaceId === params[0] &&
              r.status === 'pending' &&
              (!agentFiltered || r.agent === agentParam),
          );
          return candidates.at(-1);
        },
      },
      devices: { findFirst: async () => undefined },
    },
    insert: (table: unknown) => ({
      values: (v: Row) => ({
        returning: async () => {
          if (table === schema.devices) {
            deviceInserts.push(v);
            return [{ id: 'device-1', config: {}, configRev: 1, name: v.name ?? null, ...v }];
          }
          regInserts.push(v);
          const row = { id: `reg-${++seq}`, status: 'pending', deviceId: null, ...v };
          registrations.push(row);
          return [row];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (v: Row) => ({
        where: (_w: unknown) => {
          const p = {
            returning: async () => {
              if (table !== schema.deviceRegistrations) return [];
              if (v.status === 'claimed') return claimReturns ? [claimReturns] : [];
              regUpdates.push(v);
              const target = registrations.at(-1)!;
              Object.assign(target, v);
              return [target];
            },
            then: (res: (x: unknown) => unknown) => Promise.resolve(undefined).then(res),
            catch: () => p,
          };
          return p;
        },
      }),
    }),
    delete: () => ({ where: () => ({ catch: async () => undefined }) }),
  };
  return { db, schema };
});

const { handler } = await import('../src/handlers/device-registrations');

type Res = Exclude<APIGatewayProxyResultV2, string>;

function createEvent(body?: unknown, ws: string | null = WS): APIGatewayProxyEventV2 {
  return {
    requestContext: { http: { method: 'POST', path: '/v1/device-registrations' }, requestId: 'r' },
    rawPath: '/v1/device-registrations',
    headers: ws ? { 'x-workspace-id': ws } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

function claimEvent(code: string, body: unknown): APIGatewayProxyEventV2 {
  return {
    requestContext: {
      http: { method: 'POST', path: `/v1/device-registrations/${code}/claim` },
      requestId: 'r',
    },
    rawPath: `/v1/device-registrations/${code}/claim`,
    pathParameters: { code },
    headers: {},
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

async function create(body?: unknown, ws: string | null = WS) {
  const res = (await handler(createEvent(body, ws))) as Res;
  return { status: res.statusCode, body: JSON.parse(res.body as string) };
}

const savedFlag = process.env.RUST_AGENT_REGISTRATION;
beforeEach(() => {
  registrations = [];
  deviceInserts = [];
  regInserts = [];
  regUpdates = [];
  claimReturns = undefined;
  process.env.API_BASE_URL = 'https://api.example';
  process.env.RUST_AGENT_REGISTRATION = 'on';
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.RUST_AGENT_REGISTRATION;
  else process.env.RUST_AGENT_REGISTRATION = savedFlag;
});

describe('POST /device-registrations: agent', () => {
  it('absent agent → js, echoed in the view', async () => {
    const r = await create({});
    expect(r.status).toBe(200);
    expect(r.body.agent).toBe('js');
    expect(regInserts[0].agent).toBe('js');
    expect(Object.keys(r.body).sort()).toEqual(
      ['agent', 'code', 'deviceId', 'expiresAt', 'installUrl', 'status'].sort(),
    );
  });

  it('no body at all → js', async () => {
    const r = await create(undefined);
    expect(r.status).toBe(200);
    expect(r.body.agent).toBe('js');
  });

  it('agent "rust" → a rust registration', async () => {
    const r = await create({ agent: 'rust' });
    expect(r.status).toBe(200);
    expect(r.body.agent).toBe('rust');
    expect(regInserts[0].agent).toBe('rust');
    expect(r.body.installUrl).toBe(`https://api.example/v1/get/${r.body.code}`);
  });

  it.each([['RUST'], ['node'], [''], [null], [1], [{}]])('invalid agent %j → 400 INVALID_AGENT', async (a) => {
    const r = await create({ agent: a });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_AGENT');
    expect(regInserts).toHaveLength(0);
  });

  it.each([['off'], [''], ['ON'], ['yes'], ['allow:'], ['allow:not-a-uuid']])(
    'flag %j → rust is 409 AGENT_NOT_ENABLED, js still works',
    async (flag) => {
      process.env.RUST_AGENT_REGISTRATION = flag;
      const r = await create({ agent: 'rust' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('AGENT_NOT_ENABLED');
      expect(regInserts).toHaveLength(0);
      expect((await create({ agent: 'js' })).status).toBe(200);
      expect((await create({})).status).toBe(200);
    },
  );

  it('flag unset → rust is 409 (fails closed)', async () => {
    delete process.env.RUST_AGENT_REGISTRATION;
    expect((await create({ agent: 'rust' })).status).toBe(409);
  });

  it('allow:<ws> enables only that workspace', async () => {
    process.env.RUST_AGENT_REGISTRATION = `allow:${WS}`;
    expect((await create({ agent: 'rust' }, WS)).status).toBe(200);
    expect((await create({ agent: 'rust' }, WS_OTHER)).status).toBe(409);
  });

  it('reuses a pending code only for the SAME agent; an agent change mints a new code', async () => {
    const js1 = await create({});
    const js2 = await create({ agent: 'js' });
    expect(js2.body.code).toBe(js1.body.code);

    const rs1 = await create({ agent: 'rust' });
    expect(rs1.body.code).not.toBe(js1.body.code);
    expect(rs1.body.agent).toBe('rust');

    const rs2 = await create({ agent: 'rust' });
    expect(rs2.body.code).toBe(rs1.body.code);

    // Back to JS: the JS code is still pending, so it comes back, untouched.
    const js3 = await create({});
    expect(js3.body.code).toBe(js1.body.code);
    expect(js3.body.agent).toBe('js');
    expect(regInserts).toHaveLength(2);
  });

  it('a model pick re-pins the same-agent code in place and keeps its agent', async () => {
    const rs1 = await create({ agent: 'rust' });
    const rs2 = await create({ agent: 'rust', deviceModelId: 'model-pinned' });
    expect(rs2.body.code).toBe(rs1.body.code);
    expect(rs2.body.agent).toBe('rust');
    expect(regUpdates).toEqual([{ deviceModelId: 'model-pinned', modelPinned: true }]);
  });

  it('a legacy pending row with no agent value reads as js', async () => {
    registrations.push({
      id: 'legacy',
      code: 'legacycode',
      workspaceId: WS,
      status: 'pending',
      deviceId: null,
      expiresAt: new Date(Date.now() + 60_000),
      agent: 'js',
    });
    const r = await create({});
    expect(r.body.code).toBe('legacycode');
    expect(r.body.agent).toBe('js');
  });
});

describe('POST /device-registrations/{code}/claim: devices.agent = reg.agent', () => {
  function reg(agent: unknown): Row {
    return {
      id: 'reg-x',
      code: 'c0de',
      workspaceId: WS,
      deviceModelId: 'model-pinned',
      modelPinned: true,
      status: 'claimed',
      agent,
    };
  }

  it('a rust registration creates a rust device', async () => {
    claimReturns = reg('rust');
    const res = (await handler(claimEvent('c0de', { serial: 's1', agent: 'rust' }))) as Res;
    expect(res.statusCode).toBe(200);
    expect(deviceInserts[0].agent).toBe('rust');
  });

  it('a js registration creates a js device (the JS installer sends no agent)', async () => {
    claimReturns = reg('js');
    const res = (await handler(claimEvent('c0de', { serial: 's1' }))) as Res;
    expect(res.statusCode).toBe(200);
    expect(deviceInserts[0].agent).toBe('js');
  });

  it('a mismatching body agent is logged and the registration agent kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    claimReturns = reg('js');
    await handler(claimEvent('c0de', { serial: 's1', agent: 'rust' }));
    expect(deviceInserts[0].agent).toBe('js');
    expect(warn).toHaveBeenCalledWith(
      'claim agent mismatch; keeping the registration agent',
      expect.objectContaining({ registrationAgent: 'js', claimedAgent: 'rust' }),
    );
    warn.mockRestore();
  });

  it('the claim response shape is agent-independent', async () => {
    claimReturns = reg('rust');
    const rust = JSON.parse(((await handler(claimEvent('c0de', { serial: 's1' }))) as Res).body as string);
    claimReturns = reg('js');
    const js = JSON.parse(((await handler(claimEvent('c0de', { serial: 's1' }))) as Res).body as string);
    expect(Object.keys(rust).sort()).toEqual(Object.keys(js).sort());
    expect(rust).not.toHaveProperty('agent');
  });
});

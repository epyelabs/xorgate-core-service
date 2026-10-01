import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/sim-hosts/*` (plans/xorgate-device-simulator, Phase 3): the host plane's
 * own credential and the contract `device/xorgate-sim-host` calls.
 */

const TOKEN = 'a'.repeat(40);
let secretString: string | undefined;
let secretError: Error | null;
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send() {
      if (secretError) throw secretError;
      return { SecretString: secretString };
    }
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

let sims: { deviceId: string; hostId: string | null; hostReportedAt: Date | null }[];
let desiredRows: { sim: Record<string, unknown>; config: unknown }[];
const updatesSet: Record<string, unknown>[] = [];
let updateMatches: boolean;

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ orderBy: async () => desiredRows }),
        }),
      }),
    }),
    query: {
      deviceSimulations: {
        findFirst: async ({ columns }: { columns: Record<string, boolean> }) =>
          columns.hostId ? undefined : sims[0],
      },
    },
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updatesSet.push(vals);
            return updateMatches ? [{ deviceId: 'x' }] : [];
          },
        }),
      }),
    }),
  };
  return { db, schema };
});

const presignAssetPack = vi.fn(async () => ({
  files: { 'catalog.json': 'https://s3/catalog?sig' },
  expiresAt: 123,
}));
const readSimBundle = vi.fn(async (id: string) => ({ deviceId: id, privateKey: 'k' }));
vi.mock('../src/services/device-simulations', async () => {
  const actual = await vi.importActual<typeof import('../src/services/device-simulations')>(
    '../src/services/device-simulations',
  );
  return { ...actual, presignAssetPack, readSimBundle };
});

const { handler } = await import('../src/handlers/sim-hosts');

const DEVICE = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function event(
  method: string,
  path: string,
  opts: { token?: string | null; hostId?: string | null; body?: unknown; query?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.hostId !== null) headers['x-sim-host-id'] = opts.hostId ?? 'homelab-dev';
  return {
    // The deployed shape: one proxy route, the real path in rawPath.
    routeKey: 'ANY /v1/sim-hosts/{proxy+}',
    rawPath: `/v1${path}`,
    headers,
    pathParameters: { proxy: path.replace('/sim-hosts/', '') },
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    requestContext: { http: { method, path: `/v1${path}` }, requestId: 'r' },
  } as unknown as APIGatewayProxyEventV2;
}

async function call(e: APIGatewayProxyEventV2) {
  const res = (await handler(e, {} as never, () => undefined)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

let tokenSeq = 0;
beforeEach(() => {
  // The handler caches accepted digests for 5 min; a fresh module-level cache
  // per test would need a re-import, so each test uses the time-travel below.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 1) + (tokenSeq += 1) * 10 * 60 * 1000));
  secretString = TOKEN;
  secretError = null;
  sims = [{ deviceId: DEVICE, hostId: null, hostReportedAt: null }];
  desiredRows = [];
  updatesSet.length = 0;
  updateMatches = true;
  vi.clearAllMocks();
});

describe('sim-host auth', () => {
  it('refuses a missing or wrong token, and a user-shaped credential', async () => {
    expect((await call(event('GET', '/sim-hosts/desired', { token: null }))).status).toBe(401);
    expect((await call(event('GET', '/sim-hosts/desired', { token: 'b'.repeat(40) }))).status).toBe(401);
    expect((await call(event('GET', '/sim-hosts/desired', { token: 'xg_live_123' }))).status).toBe(401);
  });

  it('accepts current AND previous during a rotation', async () => {
    secretString = JSON.stringify({ current: 'c'.repeat(40), previous: TOKEN });
    expect((await call(event('GET', '/sim-hosts/desired'))).status).toBe(200);
    expect((await call(event('GET', '/sim-hosts/desired', { token: 'c'.repeat(40) }))).status).toBe(200);
  });

  it('never accepts a short secret, even when it matches', async () => {
    secretString = 'short';
    expect((await call(event('GET', '/sim-hosts/desired', { token: 'short' }))).status).toBe(401);
  });

  it('is 503 (not 401, not open) when the secret cannot be read', async () => {
    secretError = Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' });
    expect((await call(event('GET', '/sim-hosts/desired'))).status).toBe(503);
  });

  it('requires X-Sim-Host-Id', async () => {
    expect((await call(event('GET', '/sim-hosts/desired', { hostId: null }))).status).toBe(400);
    expect((await call(event('GET', '/sim-hosts/desired', { hostId: 'bad host' }))).status).toBe(400);
  });
});

describe('GET /sim-hosts/desired', () => {
  it('returns the contract shape: live scenario, epoch-ms start edge', async () => {
    desiredRows = [
      {
        sim: { deviceId: DEVICE, scenarioId: 'city-2026-09-27', desiredState: 'running', startRequestedAt: new Date(5000) },
        config: { simulation: { scenarioId: 'parked-2026-09-17', loop: true, gapSeconds: 30 } },
      },
      {
        sim: { deviceId: 'other', scenarioId: 'urban-2026-09-18', desiredState: 'stopped', startRequestedAt: null },
        config: {},
      },
    ];
    const res = await call(event('GET', '/sim-hosts/desired'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sims: [
        { deviceId: DEVICE, scenarioId: 'parked-2026-09-17', desiredState: 'running', assetsVersion: 'v1', startRequestedAt: 5000 },
        { deviceId: 'other', scenarioId: 'urban-2026-09-18', desiredState: 'stopped', assetsVersion: 'v1' },
      ],
    });
  });
});

describe('GET /sim-hosts/scenarios', () => {
  it('presigns the requested pack and refuses a malformed version', async () => {
    const res = await call(event('GET', '/sim-hosts/scenarios', { query: { assetsVersion: 'v1' } }));
    expect(res.body).toEqual({ assetsVersion: 'v1', expiresAt: 123, files: { 'catalog.json': 'https://s3/catalog?sig' } });
    expect((await call(event('GET', '/sim-hosts/scenarios', { query: { assetsVersion: '../x' } }))).status).toBe(400);
  });
});

describe('GET /sim-hosts/bundles/{deviceId}', () => {
  it('serves the bundle of a live simulation only', async () => {
    const ok = await call(event('GET', `/sim-hosts/bundles/${DEVICE}`));
    expect(ok.status).toBe(200);
    expect(ok.body.deviceId).toBe(DEVICE);

    sims = [];
    const gone = await call(event('GET', `/sim-hosts/bundles/${DEVICE}`));
    expect(gone.status).toBe(404);
    expect(readSimBundle).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-uuid id before touching anything', async () => {
    const res = await call(event('GET', '/sim-hosts/bundles/..%2F..%2Fx'));
    expect(res.status).toBe(404);
    expect(readSimBundle).not.toHaveBeenCalled();
  });
});

describe('POST /sim-hosts/heartbeat', () => {
  const report = (sims: unknown[]) => ({
    v: 1,
    hostId: 'homelab-dev',
    stage: 'dev',
    version: '0.1.0',
    reportedAt: 1,
    capacity: { max: 8, running: 1 },
    assets: { v1: { state: 'ready', message: '' } },
    sims,
  });

  it('records hostState/message per sim and stamps the host', async () => {
    const res = await call(
      event('POST', '/sim-hosts/heartbeat', {
        body: report([{ deviceId: DEVICE, hostState: 'running', message: 'connected', containerId: 'c1', startedAt: 9 }]),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 1, unknown: [], conflicts: [] });
    expect(updatesSet[0]).toMatchObject({ hostId: 'homelab-dev', hostState: 'running', hostMessage: 'connected' });
    expect(updatesSet[0].hostReportedAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown hostState and a hostId that contradicts the header', async () => {
    expect(
      (await call(event('POST', '/sim-hosts/heartbeat', { body: report([{ deviceId: DEVICE, hostState: 'zombie' }]) }))).status,
    ).toBe(400);
    expect(
      (await call(event('POST', '/sim-hosts/heartbeat', { hostId: 'other-host', body: report([]) }))).status,
    ).toBe(400);
  });

  it('reports a sim it cannot update as unknown, without failing the beat', async () => {
    updateMatches = false;
    const res = await call(
      event('POST', '/sim-hosts/heartbeat', { body: report([{ deviceId: DEVICE, hostState: 'running' }, { deviceId: 'nope', hostState: 'error' }]) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 0, unknown: [DEVICE, 'nope'], conflicts: [] });
  });

  it('truncates a runaway message', async () => {
    await call(event('POST', '/sim-hosts/heartbeat', { body: report([{ deviceId: DEVICE, hostState: 'error', message: 'x'.repeat(5000) }]) }));
    expect((updatesSet[0].hostMessage as string).length).toBe(1000);
  });
});

describe('the proxy route', () => {
  it('404s an unknown sub-path and 405s a known one with the wrong method, after auth', async () => {
    expect((await call(event('GET', '/sim-hosts/nope'))).status).toBe(404);
    expect((await call(event('POST', '/sim-hosts/desired'))).status).toBe(405);
    expect((await call(event('GET', '/sim-hosts/heartbeat'))).status).toBe(405);
    // Unauthenticated callers learn nothing about which paths exist.
    expect((await call(event('GET', '/sim-hosts/nope', { token: null }))).status).toBe(401);
  });
});

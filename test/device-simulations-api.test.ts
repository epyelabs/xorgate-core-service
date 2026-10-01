import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /device-simulations` (plans/xorgate-device-simulator, README §3.2): the
 * create ORDER is the contract — row → provision → config publish (after the
 * thing exists, gotcha 8) → bundle secret → simulation row — and every failure
 * after the row exists must leave nothing behind.
 */

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

let role: string;
const { AuthError } = await vi.importActual<typeof import('../src/middleware/auth')>('../src/middleware/auth');
vi.mock('../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth')>('../src/middleware/auth');
  return {
    ...actual,
    requireOrgContext: async (_e: unknown, roles?: string[]) => {
      if (roles && !roles.includes(role)) throw new AuthError('role', 403, 'INSUFFICIENT_ROLE');
      return { userId: 'user-1', apiKeyId: null, organizationId: 'org-1', membershipRole: role };
    },
  };
});

const WS = '0199a1b2-0000-7000-8000-000000000001';
vi.mock('../src/services/workspace-scope', () => ({ resolveWorkspaceScope: async () => [WS] }));

const steps: string[] = [];
let failAt: string | null;
const failIf = (step: string) => {
  steps.push(step);
  if (failAt === step) throw new Error(`${step} failed`);
};

vi.mock('../src/services/iot-provisioning', () => ({
  provisionDevice: vi.fn(async () => {
    failIf('provision');
    return {
      thingName: 'dev-1',
      certificatePem: 'CERT',
      privateKey: 'KEY',
      caUrl: 'ca',
      dataEndpoint: 'ats.example',
      credentialEndpoint: 'cred.example',
      roleAlias: 'Alias',
      region: 'us-east-1',
      channels: [{ streamKey: 'cam0', channelName: 'dev-1-cam0', channelArn: 'arn:cam0' }],
    };
  }),
}));
const publishDeviceConfig = vi.fn(async () => failIf('publish'));
vi.mock('../src/services/device-config', () => ({ publishDeviceConfig }));
const teardownDevices = vi.fn(async () => {
  steps.push('teardown');
  return { devices: 1, s3Drained: 1, s3Pending: 0, errors: [] };
});
vi.mock('../src/services/device-teardown', () => ({ teardownDevices }));

let counts: { org: number; global: number };
const writeSimBundle = vi.fn(async (_b: unknown) => failIf('secret'));
vi.mock('../src/services/device-simulations', async () => {
  const actual = await vi.importActual<typeof import('../src/services/device-simulations')>(
    '../src/services/device-simulations',
  );
  return {
    ...actual,
    readCatalog: async () => ({
      v: 1,
      scenarios: [{ id: 'city-2026-09-27', title: 'City' }, { id: 'parked-2026-09-17', title: 'Parked' }],
    }),
    countSimulations: async () => counts,
    writeSimBundle,
    deleteSimBundle: async () => {
      steps.push('delete-secret');
    },
  };
});

const insertedDevices: Record<string, unknown>[] = [];
const insertedSims: Record<string, unknown>[] = [];
let deletedRows = 0;
vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    query: { deviceModels: { findFirst: async () => ({ id: 'model-cm5', sku: 'XG-RPI-REF-1' }) } },
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          if (table === schema.deviceSimulations) {
            failIf('sim-row');
            insertedSims.push(v);
            return [{ startRequestedAt: null, hostId: null, hostState: 'pending', hostMessage: null, hostReportedAt: null, createdAt: new Date(0), ...v }];
          }
          steps.push('device-row');
          insertedDevices.push(v);
          return [{ id: 'dev-1', agentVersion: null, ...v }];
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        deletedRows += 1;
      },
    }),
  };
  return { db, schema };
});

const { handler } = await import('../src/handlers/device-simulations');

function post(body: unknown, route = 'POST /v1/device-simulations'): APIGatewayProxyEventV2 {
  const [method, path] = route.split(' ');
  return {
    routeKey: route,
    rawPath: path,
    headers: { authorization: 'Bearer t' },
    body: JSON.stringify(body),
    requestContext: { http: { method, path }, requestId: 'r' },
  } as unknown as APIGatewayProxyEventV2;
}

async function call(e: APIGatewayProxyEventV2) {
  const res = (await handler(e, {} as never, () => undefined)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
  role = 'owner';
  failAt = null;
  counts = { org: 0, global: 0 };
  steps.length = 0;
  insertedDevices.length = 0;
  insertedSims.length = 0;
  deletedRows = 0;
  vi.clearAllMocks();
});

describe('POST /device-simulations', () => {
  it('creates in the README §3.2 order and returns {device, simulation}', async () => {
    const res = await call(post({ workspaceId: WS, scenarioId: 'parked-2026-09-17' }));
    expect(res.status).toBe(201);
    expect(steps).toEqual(['device-row', 'provision', 'publish', 'secret', 'sim-row']);

    const device = insertedDevices[0];
    expect(device.simulated).toBe(true);
    expect(device.deviceModelId).toBe('model-cm5');
    expect(device.serial).toMatch(/^SIM-[0-9a-f]{8}$/);
    expect(device.name).toBe(`Simulator ${device.serial}`);
    expect(device.configRev).toBe(1);
    expect(device.config).toEqual({
      recording: { video: { cameras: { cam1: false } } },
      simulation: { scenarioId: 'parked-2026-09-17', loop: true, gapSeconds: 30 },
    });
    expect(insertedSims[0]).toMatchObject({ scenarioId: 'parked-2026-09-17', desiredState: 'running', createdBy: 'user-1' });

    // The bundle is exactly what the sim host writes into /creds.
    expect(writeSimBundle.mock.calls[0][0]).toEqual({
      deviceId: 'dev-1',
      iotDataEndpoint: 'ats.example',
      ...(process.env.BUCKET_NAME ? { uploadBucket: process.env.BUCKET_NAME } : {}),
      certificatePem: 'CERT',
      privateKey: 'KEY',
      kvs: {
        region: 'us-east-1',
        credentialEndpoint: 'cred.example',
        roleAlias: 'Alias',
        channels: [{ streamKey: 'cam0', channelName: 'dev-1-cam0', channelArn: 'arn:cam0' }],
      },
    });
    expect(res.body.device.simulated).toBe(true);
    expect(res.body.simulation).toMatchObject({ deviceId: 'dev-1', scenarioId: 'parked-2026-09-17', hostState: 'pending' });
  });

  it('defaults the scenario and honours a name', async () => {
    const res = await call(post({ workspaceId: WS, name: '  Demo car  ' }));
    expect(res.status).toBe(201);
    expect(insertedDevices[0].name).toBe('Demo car');
    expect(insertedSims[0].scenarioId).toBe('city-2026-09-27');
  });

  it('is owner/admin only', async () => {
    role = 'member';
    expect((await call(post({ workspaceId: WS }))).status).toBe(403);
    expect(steps).toEqual([]);
  });

  it('refuses a scenario the catalog does not carry, an unknown field, a foreign workspace', async () => {
    expect((await call(post({ workspaceId: WS, scenarioId: 'mars-2030-01-01' }))).status).toBe(400);
    expect((await call(post({ workspaceId: WS, scenarioId: 'Bad Id' }))).status).toBe(400);
    expect((await call(post({ workspaceId: WS, simulated: false }))).status).toBe(400);
    expect((await call(post({ workspaceId: '0199a1b2-0000-7000-8000-00000000dead' }))).status).toBe(400);
    expect(steps).toEqual([]);
  });

  it('enforces the org and global quotas before creating anything', async () => {
    counts = { org: 2, global: 2 };
    const org = await call(post({ workspaceId: WS }));
    expect(org.status).toBe(409);
    expect(org.body.error.code).toBe('SIMULATION_QUOTA_EXCEEDED');
    expect(org.body.error.details).toMatchObject({ scope: 'organization', limit: 2 });

    counts = { org: 0, global: 8 };
    const global = await call(post({ workspaceId: WS }));
    expect(global.status).toBe(409);
    expect(global.body.error.details).toMatchObject({ scope: 'global', limit: 8 });
    expect(steps).toEqual([]);
  });

  it('rolls everything back when provisioning fails', async () => {
    failAt = 'provision';
    const res = await call(post({ workspaceId: WS }));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SIMULATION_PROVISION_FAILED');
    expect(steps).toEqual(['device-row', 'provision', 'teardown', 'delete-secret']);
    expect(deletedRows).toBe(1);
  });

  it('rolls everything back when the bundle secret cannot be written (the key exists nowhere else)', async () => {
    failAt = 'secret';
    const res = await call(post({ workspaceId: WS }));
    expect(res.status).toBe(502);
    expect(steps).toEqual(['device-row', 'provision', 'publish', 'secret', 'teardown', 'delete-secret']);
    expect(deletedRows).toBe(1);
    expect(insertedSims).toEqual([]);
  });

  it('survives a failed config publish (the first report republishes)', async () => {
    failAt = 'publish';
    const res = await call(post({ workspaceId: WS }));
    expect(res.status).toBe(201);
    expect(steps).toEqual(['device-row', 'provision', 'publish', 'secret', 'sim-row']);
  });
});

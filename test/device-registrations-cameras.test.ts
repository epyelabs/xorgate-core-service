import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';
import { resolveModel } from '../src/services/model-probe';

/**
 * The registration carry of the camera sensor choice
 * (plans/support-other-camera-models, Phase 2):
 *
 *   POST /device-registrations   `cameras` on the body, the view, the re-pin
 *   POST …/{code}/claim          for an installer that declares `camera.sensors`:
 *                                drop undeclared ports, seed `cameraSensors`
 *                                from the choice else the model default, echo
 *                                it; for any other installer: nothing new;
 *                                count hint for the model probe
 *
 * and, as important, what must NOT change: a JS registration and a JS claim
 * store, publish and answer exactly what they did before.
 *
 * The db is the in-memory fake of `device-registrations-agent.test.ts`, with
 * real `io_capabilities` on the models so the claim derives a real hardware
 * block.
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
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => [WS],
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

const publishDeviceConfig = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../src/services/device-config', () => ({
  publishDeviceConfig: (...args: unknown[]) => publishDeviceConfig(...args),
}));

// ── models ───────────────────────────────────────────────────────────────────
const v2 = (platform: string, video: { key: string; connector: string; sensor: string }[]) => ({
  schemaVersion: 2,
  system: { platform, fields: [] },
  media: { video: video.map((v) => ({ ...v, codec: 'h264' })) },
});
const CM5_DUAL = {
  id: 'model-cm5-dual',
  sku: 'CM5-2',
  name: 'CM5 dual',
  ioCapabilities: v2('rpi-cm5', [
    { key: 'cam0', connector: 'csi0', sensor: 'imx290' },
    { key: 'cam1', connector: 'csi1', sensor: 'imx290' },
  ]),
};
const CM5_SINGLE = {
  id: 'model-cm5-single',
  sku: 'CM5-1',
  name: 'CM5 single',
  ioCapabilities: v2('rpi-cm5', [{ key: 'cam0', connector: 'csi0', sensor: 'imx290' }]),
};
const CM4_SINGLE = {
  id: 'model-cm4',
  sku: 'CM4-1',
  name: 'CM4',
  ioCapabilities: v2('rpi-cm4', [{ key: 'cam0', connector: 'csi0', sensor: 'imx290' }]),
};
/** A model whose sensor the catalog does not know. */
const CM5_ODD = {
  id: 'model-odd',
  sku: 'ODD',
  name: 'Odd',
  ioCapabilities: v2('rpi-cm5', [
    { key: 'cam0', connector: 'csi0', sensor: 'ov5647' },
    { key: 'cam1', connector: 'csi1', sensor: 'imx219' },
  ]),
};
/** schemaVersion 1: no hardware block, so no declared ports. */
const V1_MODEL = {
  id: 'model-v1',
  sku: 'V1',
  name: 'Legacy',
  ioCapabilities: { schemaVersion: 1, media: { video: [{ key: 'cam0', codec: 'h264' }] } },
};
let models: Record<string, unknown>[];

type Row = Record<string, unknown>;
let registrations: Row[];
let deviceInserts: Row[];
let regInserts: Row[];
let regUpdates: Row[];
let claimReturns: Row | undefined;

const dialect = new PgDialect();
const rendered = (where: SQL | undefined) =>
  where ? dialect.sqlToQuery(where) : { sql: '', params: [] as unknown[] };

let seq = 0;
vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    query: {
      deviceModels: {
        findFirst: async (q?: { where?: SQL }) => {
          if (!q?.where) return models.at(-1);
          const { params } = rendered(q.where);
          return models.find((m) => m.id === params[0]);
        },
        findMany: async () => models,
      },
      deviceRegistrations: {
        findFirst: async (q: { where: SQL }) => {
          const { sql, params } = rendered(q.where);
          const agentFiltered = /"device_registrations"\."agent" = \$\d/.test(sql);
          const agentParam = params.find((p) => p === 'js' || p === 'rust');
          return registrations
            .filter(
              (r) =>
                r.workspaceId === params[0] &&
                r.status === 'pending' &&
                (!agentFiltered || r.agent === agentParam),
            )
            .at(-1);
        },
      },
      devices: { findFirst: async () => undefined },
    },
    insert: (table: unknown) => ({
      values: (v: Row) => ({
        returning: async () => {
          if (table === schema.devices) {
            deviceInserts.push(v);
            return [{ id: 'device-1', name: v.name ?? null, ...v }];
          }
          regInserts.push(v);
          // `cameras` is a nullable column with no default: an insert that does
          // not name it reads back NULL.
          const row = { id: `reg-${++seq}`, status: 'pending', deviceId: null, cameras: null, ...v };
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

function createEvent(body?: unknown): APIGatewayProxyEventV2 {
  return {
    requestContext: { http: { method: 'POST', path: '/v1/device-registrations' }, requestId: 'r' },
    rawPath: '/v1/device-registrations',
    headers: { 'x-workspace-id': WS },
    body: body === undefined ? undefined : JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

function claimEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    requestContext: {
      http: { method: 'POST', path: '/v1/device-registrations/c0de/claim' },
      requestId: 'r',
    },
    rawPath: '/v1/device-registrations/c0de/claim',
    pathParameters: { code: 'c0de' },
    headers: {},
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

async function create(body?: unknown) {
  const res = (await handler(createEvent(body))) as Res;
  return { status: res.statusCode, body: JSON.parse(res.body as string), raw: res.body as string };
}

/** The body the 0.2.0 Rust provisioner sends: it declares what it can act on. */
const CAPABLE = { serial: 's1', agent: 'rust', capabilities: ['camera.sensors'] };

async function claim(
  reg: Row,
  body: unknown = reg.agent === 'rust' ? CAPABLE : { serial: 's1' },
) {
  claimReturns = { id: 'reg-x', code: 'c0de', workspaceId: WS, status: 'claimed', ...reg };
  const res = (await handler(claimEvent(body))) as Res;
  return { status: res.statusCode, body: JSON.parse(res.body as string), raw: res.body as string };
}

const CM5_DT = 'Raspberry Pi Compute Module 5 Rev 1.0';
const CM4_DT = 'Raspberry Pi Compute Module 4 Rev 1.1';

const savedFlag = process.env.RUST_AGENT_REGISTRATION;
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  registrations = [];
  deviceInserts = [];
  regInserts = [];
  regUpdates = [];
  claimReturns = undefined;
  models = [CM5_DUAL];
  publishDeviceConfig.mockClear();
  process.env.API_BASE_URL = 'https://api.example';
  process.env.RUST_AGENT_REGISTRATION = 'on';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
  if (savedFlag === undefined) delete process.env.RUST_AGENT_REGISTRATION;
  else process.env.RUST_AGENT_REGISTRATION = savedFlag;
});

const JS_VIEW_KEYS = ['code', 'status', 'deviceId', 'expiresAt', 'installUrl', 'agent'];
const JS_CLAIM_KEYS = [
  'deviceId',
  'thingName',
  'dataEndpoint',
  'certPem',
  'privateKey',
  'caUrl',
  'name',
  'region',
  'credentialEndpoint',
  'roleAlias',
  'channels',
  'uploadBucket',
  'modelId',
  'modelName',
  'needsModel',
  'hardware',
];

describe('POST /device-registrations: cameras (Rust)', () => {
  it('stores the choice and returns it', async () => {
    const cameras = { cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } };
    const r = await create({ agent: 'rust', cameras });
    expect(r.status).toBe(200);
    expect(r.body.cameras).toEqual(cameras);
    expect(regInserts[0].cameras).toEqual(cameras);
    expect(Object.keys(r.body)).toEqual([...JS_VIEW_KEYS, 'cameras']);
  });

  it('stores options, normalized by the catalog', async () => {
    const r = await create({
      agent: 'rust',
      cameras: {
        cam0: { sensor: 'imx290', options: { clockFrequency: 74250000 } },
        cam1: { sensor: 'imx219', options: {} },
      },
    });
    expect(r.status).toBe(200);
    expect(regInserts[0].cameras).toEqual({
      cam0: { sensor: 'imx290', options: { clockFrequency: 74250000 } },
      cam1: { sensor: 'imx219' },
    });
  });

  it('a Rust registration with no choice: cameras is null, and the insert names no column', async () => {
    const r = await create({ agent: 'rust' });
    expect(r.status).toBe(200);
    expect(r.body.cameras).toBeNull();
    expect(regInserts[0]).not.toHaveProperty('cameras');
  });

  it('null and {} both mean "no choice"', async () => {
    expect((await create({ agent: 'rust', cameras: null })).body.cameras).toBeNull();
    expect(regInserts[0]).not.toHaveProperty('cameras');
    registrations = [];
    expect((await create({ agent: 'rust', cameras: {} })).body.cameras).toBeNull();
  });

  it.each([
    [{ cam0: { sensor: 'imx999' } }, 'cameras.cam0.sensor: "imx999" is not a known camera sensor'],
    [{ cam1: { sensor: 'none', options: {} } }, 'cameras.cam1.options: a port declared empty'],
    [
      { cam0: { sensor: 'imx290', options: { clockFrequency: 1 } } },
      'cameras.cam0.options.clockFrequency: must be one of 37125000, 74250000 Hz',
    ],
    [{ cam0: { sensor: 'imx219', options: { lanes: 4 } } }, 'cameras.cam0.options: imx219 has no option "lanes"'],
    [{ 'cam 0': { sensor: 'imx290' } }, 'cameras.cam 0: must be a stream key'],
    [{ cam0: 'imx290' }, 'cameras.cam0: '],
    [{ cam0: { sensor: 'imx290', rotation: 180 } }, 'cameras.cam0: '],
    ['imx290', 'cameras: must be an object keyed by stream key'],
    [[{ sensor: 'imx290' }], 'cameras: must be an object keyed by stream key'],
    [7, 'cameras: must be an object keyed by stream key'],
  ])('invalid cameras %j → 400 INVALID_CAMERAS naming the port', async (cameras, text) => {
    const r = await create({ agent: 'rust', cameras });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_CAMERAS');
    expect(r.body.error.message).toContain(text);
    expect(regInserts).toHaveLength(0);
  });

  it('re-pins the choice in place on the pending code, like the model pick', async () => {
    const first = await create({ agent: 'rust', cameras: { cam0: { sensor: 'imx290' } } });
    const second = await create({ agent: 'rust', cameras: { cam0: { sensor: 'imx708' } } });
    expect(second.body.code).toBe(first.body.code);
    expect(second.body.cameras).toEqual({ cam0: { sensor: 'imx708' } });
    expect(regInserts).toHaveLength(1);
    expect(regUpdates).toEqual([{ cameras: { cam0: { sensor: 'imx708' } } }]);
  });

  it('the same choice again writes nothing (key order does not count)', async () => {
    await create({ agent: 'rust', cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } } });
    await create({ agent: 'rust', cameras: { cam1: { sensor: 'none' }, cam0: { sensor: 'imx708' } } });
    expect(regUpdates).toEqual([]);
  });

  it('a request that does not speak about cameras keeps the stored choice', async () => {
    await create({ agent: 'rust', cameras: { cam0: { sensor: 'imx708' } } });
    const again = await create({ agent: 'rust' });
    expect(again.body.cameras).toEqual({ cam0: { sensor: 'imx708' } });
    expect(regUpdates).toEqual([]);
  });

  it('null clears a stored choice in place', async () => {
    await create({ agent: 'rust', cameras: { cam0: { sensor: 'imx708' } } });
    const cleared = await create({ agent: 'rust', cameras: null });
    expect(cleared.body.cameras).toBeNull();
    expect(regUpdates).toEqual([{ cameras: null }]);
  });

  it('a model pick and a camera choice re-pin together, in one update', async () => {
    await create({ agent: 'rust' });
    const r = await create({
      agent: 'rust',
      deviceModelId: CM5_DUAL.id,
      cameras: { cam1: { sensor: 'imx219' } },
    });
    expect(r.status).toBe(200);
    expect(regUpdates).toEqual([
      { deviceModelId: CM5_DUAL.id, modelPinned: true, cameras: { cam1: { sensor: 'imx219' } } },
    ]);
  });

  it('a model-only re-pin writes exactly what it always wrote', async () => {
    await create({ agent: 'rust', cameras: { cam0: { sensor: 'imx708' } } });
    await create({ agent: 'rust', deviceModelId: CM5_DUAL.id });
    expect(regUpdates).toEqual([{ deviceModelId: CM5_DUAL.id, modelPinned: true }]);
  });
});

// Every test in the two "JS is unchanged" groups also passes, unmodified,
// against the tree BEFORE this change (b59d7d4): run with
// `-t "JS is unchanged"` there. That is the proof that they pin old behaviour
// and not the new code's own output.
describe('POST /device-registrations: JS is unchanged', () => {
  it('the view has exactly the keys it had, in the order it had them', async () => {
    const r = await create({});
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(JS_VIEW_KEYS);
    expect(r.raw).not.toContain('cameras');
    const explicit = await create({ agent: 'js' });
    expect(Object.keys(explicit.body)).toEqual(JS_VIEW_KEYS);
  });

  it('the response body is byte-for-byte what the old view serialized to', async () => {
    const r = await create({});
    const row = registrations[0];
    expect(r.raw).toBe(
      JSON.stringify({
        code: row.code,
        status: 'pending',
        deviceId: null,
        expiresAt: (row.expiresAt as Date).toISOString(),
        installUrl: `https://api.example/v1/get/${row.code}`,
        agent: 'js',
      }),
    );
  });

  it('the insert names exactly the columns it named before', async () => {
    await create({});
    expect(Object.keys(regInserts[0]).sort()).toEqual(
      [
        'agent',
        'code',
        'createdByApiKeyId',
        'createdByUserId',
        'deviceModelId',
        'expiresAt',
        'modelPinned',
        'organizationId',
        'workspaceId',
      ].sort(),
    );
  });

  it('a JS row that somehow holds a cameras value still shows none', async () => {
    registrations.push({
      id: 'odd',
      code: 'oddcode',
      workspaceId: WS,
      status: 'pending',
      deviceId: null,
      expiresAt: new Date(Date.now() + 60_000),
      agent: 'js',
      cameras: { cam0: { sensor: 'imx708' } },
    });
    const r = await create({});
    expect(r.body.code).toBe('oddcode');
    expect(Object.keys(r.body)).toEqual(JS_VIEW_KEYS);
  });
});

describe('POST /device-registrations: the one deliberate change for a JS caller', () => {
  // Before the field existed an unknown body key was ignored. `cameras` is new,
  // so nothing sends it today; a JS registration that does is told why it
  // cannot have it instead of being answered 200 and ignored.
  it('cameras on a JS registration is refused, not stored and ignored', async () => {
    for (const body of [
      { cameras: { cam0: { sensor: 'imx290' } } },
      { agent: 'js', cameras: { cam0: { sensor: 'imx290' } } },
      { agent: 'js', cameras: null },
    ]) {
      const r = await create(body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_CAMERAS');
      expect(r.body.error.message).toBe(
        'cameras applies only to Rust agent registrations (agent: "rust"); the JS agent does ' +
          'not manage camera sensors',
      );
    }
    expect(regInserts).toHaveLength(0);
  });
});

describe('POST /device-registrations/{code}/claim: Rust seeding (an installer that declares camera.sensors)', () => {
  const rustReg = (extra: Row = {}): Row => ({
    agent: 'rust',
    deviceModelId: CM5_DUAL.id,
    modelPinned: true,
    cameras: null,
    ...extra,
  });

  it('seeds from the choice, echoes it, and the first publish carries it', async () => {
    const cameras = {
      cam0: { sensor: 'imx708' },
      cam1: { sensor: 'imx290', options: { clockFrequency: 74250000 } },
    };
    const r = await claim(rustReg({ cameras }));
    expect(r.status).toBe(200);
    const expected = { cameras };
    expect(deviceInserts[0].config).toEqual({ cameraSensors: expected });
    expect(r.body.cameraSensors).toEqual(expected);
    // Last key of the response, after everything the JS claim returns.
    expect(Object.keys(r.body)).toEqual([...JS_CLAIM_KEYS, 'cameraSensors']);
    // Step 5 publishes the row's own document at rev 1.
    expect(publishDeviceConfig).toHaveBeenCalledWith('device-1', { cameraSensors: expected }, 1);
  });

  it('with no choice, seeds every declared port from the model default', async () => {
    const r = await claim(rustReg());
    const expected = { cameras: { cam0: { sensor: 'imx290' }, cam1: { sensor: 'imx290' } } };
    expect(deviceInserts[0].config).toEqual({ cameraSensors: expected });
    expect(r.body.cameraSensors).toEqual(expected);
  });

  it('a partial choice: the chosen port from the choice, the other from the model', async () => {
    const r = await claim(rustReg({ cameras: { cam1: { sensor: 'none' } } }));
    expect(r.body.cameraSensors).toEqual({
      cameras: { cam0: { sensor: 'imx290' }, cam1: { sensor: 'none' } },
    });
    // Model order, not the order of the choice.
    expect(Object.keys(r.body.cameraSensors.cameras)).toEqual(['cam0', 'cam1']);
  });

  it('drops a choice for a port the resolved model does not declare', async () => {
    models = [CM5_SINGLE];
    const r = await claim(
      rustReg({
        deviceModelId: CM5_SINGLE.id,
        cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx219' } },
      }),
    );
    expect(r.body.cameraSensors).toEqual({ cameras: { cam0: { sensor: 'imx708' } } });
    expect(deviceInserts[0].config).toEqual({
      cameraSensors: { cameras: { cam0: { sensor: 'imx708' } } },
    });
    expect(warn).toHaveBeenCalledWith(
      'claim: camera choice dropped for ports the resolved model does not declare',
      expect.objectContaining({ dropped: ['cam1'], modelPorts: ['cam0'] }),
    );
  });

  it('a stored choice the catalog no longer accepts falls back to the model default', async () => {
    const r = await claim(rustReg({ cameras: { cam0: { sensor: 'imx999' } } }));
    expect(r.body.cameraSensors).toEqual({
      cameras: { cam0: { sensor: 'imx290' }, cam1: { sensor: 'imx290' } },
    });
  });

  it('a model sensor the catalog does not know leaves that port UNMANAGED (absent)', async () => {
    models = [CM5_ODD];
    const r = await claim(rustReg({ deviceModelId: CM5_ODD.id }));
    expect(r.body.cameraSensors).toEqual({ cameras: { cam1: { sensor: 'imx219' } } });
    expect('cam0' in r.body.cameraSensors.cameras).toBe(false);
  });

  it('a model with no hardware block: nothing seeded, no key in the response', async () => {
    models = [V1_MODEL];
    const r = await claim(rustReg({ deviceModelId: V1_MODEL.id, cameras: { cam0: { sensor: 'imx708' } } }));
    expect(r.status).toBe(200);
    expect(deviceInserts[0].config).toEqual({});
    expect(Object.keys(r.body)).toEqual(JS_CLAIM_KEYS);
    expect(r.body.hardware).toBeNull();
  });

  it('the hardware block in the response is untouched by the choice', async () => {
    const r = await claim(rustReg({ cameras: { cam0: { sensor: 'imx708' } } }));
    // The model's sensor stays the model's: the block is model-derived.
    expect(r.body.hardware.video.map((v: { sensor: string }) => v.sensor)).toEqual([
      'imx290',
      'imx290',
    ]);
  });
});

describe('POST /device-registrations/{code}/claim: a Rust installer that does NOT declare camera.sensors', () => {
  // Every v0.1.1 provisioner. Seeding for it would store a value its agent
  // ignores and the report mirror then has to delete: the withdrawal would be
  // the normal path of every registration instead of the safety net.
  //
  // The two tests that pin the response and the stored document, and every
  // "treated as not declared" case, also pass unmodified against the tree
  // before the namespace (b59d7d4): the literal below is that tree's output.
  const rustReg = (extra: Row = {}): Row => ({
    agent: 'rust',
    deviceModelId: CM5_DUAL.id,
    modelPinned: true,
    cameras: null,
    ...extra,
  });
  const OLD_INSTALLER = { serial: 's1', hostname: 'pi', agent: 'rust' };

  /** The response of this claim as `b59d7d4` serialized it, field by field. */
  const BEFORE = JSON.stringify({
    deviceId: 'device-1',
    thingName: 'dev-1',
    dataEndpoint: 'ats.example',
    certPem: 'CERT',
    privateKey: 'KEY',
    caUrl: 'ca',
    name: 'pi',
    region: 'us-east-1',
    credentialEndpoint: 'cred.example',
    roleAlias: 'Alias',
    channels: [{ streamKey: 'cam0', channelName: 'dev-1-cam0' }],
    uploadBucket: process.env.BUCKET_NAME ?? null,
    modelId: CM5_DUAL.id,
    modelName: 'CM5 dual',
    needsModel: false,
    hardware: {
      v: 2,
      platform: 'rpi-cm5',
      encoder: 'sw-h264',
      rails: false,
      statusLed: null,
      imu: null,
      video: [
        { key: 'cam0', connector: 'csi0', sensor: 'imx290', codec: 'h264' },
        { key: 'cam1', connector: 'csi1', sensor: 'imx290', codec: 'h264' },
      ],
    },
  });

  it('no seed, no echo: the response is byte-for-byte the b59d7d4 one', async () => {
    const r = await claim(rustReg(), OLD_INSTALLER);
    expect(r.status).toBe(200);
    expect(r.raw).toBe(BEFORE);
    expect(Object.keys(r.body)).toEqual(JS_CLAIM_KEYS);
  });

  it('stores an empty document and publishes it, as before the namespace existed', async () => {
    await claim(rustReg(), OLD_INSTALLER);
    expect(deviceInserts[0].config).toEqual({});
    expect(deviceInserts[0].agent).toBe('rust');
    expect(publishDeviceConfig).toHaveBeenCalledWith('device-1', {}, 1);
    expect(Object.keys(deviceInserts[0]).sort()).toEqual(
      [
        'agent',
        'config',
        'configRev',
        'configUpdatedAt',
        'deviceModelId',
        'name',
        'needsModel',
        'serial',
        'workspaceId',
      ].sort(),
    );
  });

  it('a choice on the registration is NOT applied, and the same bytes come back', async () => {
    const r = await claim(
      rustReg({ cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } } }),
      OLD_INSTALLER,
    );
    expect(r.raw).toBe(BEFORE);
    expect(deviceInserts[0].config).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      'claim: camera choice not applied, the installer did not declare camera.sensors',
      expect.objectContaining({ ports: ['cam0', 'cam1'] }),
    );
    // The choice is not erased from the registration row by the claim.
    expect(regUpdates.every((u) => !('cameras' in u))).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty list', []],
    ['only strings this backend does not know', ['sms.read', 'obd.scan', 'camera.sensor', 'CAMERA.SENSORS']],
    ['a bare string', 'camera.sensors'],
    ['an object', { 'camera.sensors': true }],
    ['an object posing as a list', { length: 1, 0: 'camera.sensors' }],
    ['a number', 1],
    ['true', true],
    ['the string nested in a list', [['camera.sensors']]],
    ['the string as an object item', [{ name: 'camera.sensors' }]],
    ['the string padded', [' camera.sensors ']],
    ['a list longer than 32 that does contain it', [...Array.from({ length: 32 }, (_, i) => `x.${i}`), 'camera.sensors']],
    ['a 200 KB item', ['x'.repeat(200_000)]],
  ])('capabilities %s → treated as not declared: 200, no seed, the same bytes', async (_name, capabilities) => {
    const r = await claim(rustReg(), { ...OLD_INSTALLER, capabilities });
    expect(r.status).toBe(200);
    expect(r.raw).toBe(BEFORE);
    expect(deviceInserts[0].config).toEqual({});
  });

  it.each([
    ['alone', ['camera.sensors']],
    ['among strings this backend does not know', ['sms.read', 'future.thing', 'camera.sensors']],
    ['beside items that are not strings or are too long', [1, null, {}, 'y'.repeat(65), 'camera.sensors']],
    ['in a list of exactly 32', [...Array.from({ length: 31 }, (_, i) => `x.${i}`), 'camera.sensors']],
    ['twice', ['camera.sensors', 'camera.sensors']],
  ])('capabilities with camera.sensors %s → seeded and echoed', async (_name, capabilities) => {
    const r = await claim(rustReg(), { ...OLD_INSTALLER, capabilities });
    expect(r.status).toBe(200);
    const expected = { cameras: { cam0: { sensor: 'imx290' }, cam1: { sensor: 'imx290' } } };
    expect(r.body.cameraSensors).toEqual(expected);
    expect(deviceInserts[0].config).toEqual({ cameraSensors: expected });
    // Everything before the new key is the old response.
    const { cameraSensors: _added, ...rest } = r.body;
    expect(JSON.stringify(rest)).toBe(BEFORE);
  });

  it('the count hint still uses the choice, with or without the capability', async () => {
    models = [CM5_SINGLE, CM5_DUAL];
    const r = await claim(
      rustReg({ modelPinned: false, cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx219' } } }),
      { serial: 's1', agent: 'rust', dtModel: CM5_DT, cameras: 0 },
    );
    expect(r.body.modelId).toBe(CM5_DUAL.id);
    expect(r.body.needsModel).toBe(false);
    expect('cameraSensors' in r.body).toBe(false);
    expect(deviceInserts[0].config).toEqual({});
  });
});

describe('POST /device-registrations/{code}/claim: the camera count hint', () => {
  const unpinned = (extra: Row = {}): Row => ({
    agent: 'rust',
    deviceModelId: CM5_DUAL.id,
    modelPinned: false,
    cameras: null,
    ...extra,
  });

  it('probe count 0 + two declared sensors picks the two-camera model', async () => {
    models = [CM5_SINGLE, CM5_DUAL];
    const r = await claim(
      unpinned({ cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx219' } } }),
      { ...CAPABLE, dtModel: CM5_DT, cameras: 0 },
    );
    expect(r.body.modelId).toBe(CM5_DUAL.id);
    expect(r.body.needsModel).toBe(false);
  });

  it('probe count 0 + one declared sensor (the other "none") picks the one-camera model', async () => {
    models = [CM5_SINGLE, CM5_DUAL];
    const r = await claim(
      unpinned({ cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } } }),
      { ...CAPABLE, dtModel: CM5_DT },
    );
    expect(r.body.modelId).toBe(CM5_SINGLE.id);
    expect(r.body.needsModel).toBe(false);
    // …and the choice for the port that model lacks is dropped.
    expect(r.body.cameraSensors).toEqual({ cameras: { cam0: { sensor: 'imx708' } } });
  });

  it('probe count 0 and no choice stays ambiguous, exactly as before', async () => {
    models = [CM5_SINGLE, CM5_DUAL];
    const r = await claim(unpinned(), { serial: 's1', agent: 'rust', dtModel: CM5_DT, cameras: 0 });
    expect(r.body.needsModel).toBe(true);
    expect(r.body.modelId).toBe(CM5_DUAL.id); // the registration's fallback
  });

  it('a count the probe measured wins over the declared one', async () => {
    models = [CM5_SINGLE, CM5_DUAL];
    const r = await claim(
      unpinned({ cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx219' } } }),
      { serial: 's1', agent: 'rust', dtModel: CM5_DT, cameras: 1 },
    );
    expect(r.body.modelId).toBe(CM5_SINGLE.id);
  });

  it('resolveModel: the rule by itself', () => {
    const cat = [CM5_SINGLE, CM5_DUAL, CM4_SINGLE] as never[];
    const fb = CM5_DUAL as never;
    const pick = (probe: Parameters<typeof resolveModel>[2]) => resolveModel(cat, fb, probe);
    expect(pick({ dtModel: CM5_DT, cameras: 0, declaredCameras: 2 })).toMatchObject({
      model: CM5_DUAL,
      needsModel: false,
      reason: 'probe matched CM5-2 (platform=rpi-cm5, cameras=2 declared)',
    });
    expect(pick({ dtModel: CM5_DT, declaredCameras: 1 }).model).toBe(CM5_SINGLE);
    // Nothing declared, or a declared count of 0 (every port "none"): unknown.
    expect(pick({ dtModel: CM5_DT, declaredCameras: 0 }).needsModel).toBe(true);
    expect(pick({ dtModel: CM5_DT, declaredCameras: null }).needsModel).toBe(true);
    expect(pick({ dtModel: CM5_DT }).needsModel).toBe(true);
    // A declared count matching no model is non-narrowing, like a probed one.
    expect(pick({ dtModel: CM5_DT, declaredCameras: 5 }).needsModel).toBe(true);
    // Measured counts: the text and the result are what they were.
    expect(pick({ dtModel: CM5_DT, cameras: 2, declaredCameras: 1 })).toMatchObject({
      model: CM5_DUAL,
      reason: 'probe matched CM5-2 (platform=rpi-cm5, cameras=2)',
    });
    // One model on the platform: resolved by platform, no count in the reason.
    expect(pick({ dtModel: CM4_DT, declaredCameras: 2 })).toMatchObject({
      model: CM4_SINGLE,
      reason: 'probe matched CM4-1 (platform=rpi-cm4, cameras=2 declared)',
    });
    expect(pick({ dtModel: CM4_DT }).reason).toBe('probe matched CM4-1 (platform=rpi-cm4)');
  });
});

describe('POST /device-registrations/{code}/claim: JS is unchanged', () => {
  const jsReg = (extra: Row = {}): Row => ({
    agent: 'js',
    deviceModelId: CM5_DUAL.id,
    modelPinned: true,
    cameras: null,
    ...extra,
  });

  it('stores an empty document, publishes it, and answers with the same keys as before', async () => {
    const r = await claim(jsReg(), { serial: 's1' });
    expect(r.status).toBe(200);
    expect(deviceInserts[0].config).toEqual({});
    expect(publishDeviceConfig).toHaveBeenCalledWith('device-1', {}, 1);
    expect(Object.keys(r.body)).toEqual(JS_CLAIM_KEYS);
    expect(r.raw).not.toContain('cameraSensors');
  });

  it('the response body is byte-for-byte what the old handler serialized', async () => {
    const r = await claim(jsReg(), { serial: 's1', hostname: 'pi' });
    // The pre-change `ok({...})` literal, rebuilt here field by field.
    expect(r.raw).toBe(
      JSON.stringify({
        deviceId: 'device-1',
        thingName: 'dev-1',
        dataEndpoint: 'ats.example',
        certPem: 'CERT',
        privateKey: 'KEY',
        caUrl: 'ca',
        name: 'pi',
        region: 'us-east-1',
        credentialEndpoint: 'cred.example',
        roleAlias: 'Alias',
        channels: [{ streamKey: 'cam0', channelName: 'dev-1-cam0' }],
        uploadBucket: process.env.BUCKET_NAME ?? null,
        modelId: CM5_DUAL.id,
        modelName: 'CM5 dual',
        needsModel: false,
        hardware: {
          v: 2,
          platform: 'rpi-cm5',
          encoder: 'sw-h264',
          rails: false,
          statusLed: null,
          imu: null,
          video: [
            { key: 'cam0', connector: 'csi0', sensor: 'imx290', codec: 'h264' },
            { key: 'cam1', connector: 'csi1', sensor: 'imx290', codec: 'h264' },
          ],
        },
      }),
    );
  });

  it('a JS claim that sends capabilities is ignored, not refused: the same bytes', async () => {
    const plain = await claim(jsReg(), { serial: 's1', hostname: 'pi' });
    deviceInserts = [];
    const withCaps = await claim(jsReg(), {
      serial: 's1',
      hostname: 'pi',
      capabilities: ['camera.sensors'],
    });
    expect(withCaps.status).toBe(200);
    expect(withCaps.raw).toBe(plain.raw);
    expect(deviceInserts[0].config).toEqual({});
  });

  it('a JS registration row holding a cameras value seeds nothing and hints nothing', async () => {
    models = [CM5_SINGLE, CM5_DUAL];
    const r = await claim(
      jsReg({ modelPinned: false, cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx219' } } }),
      { serial: 's1', dtModel: CM5_DT, cameras: 0 },
    );
    expect(deviceInserts[0].config).toEqual({});
    expect(Object.keys(r.body)).toEqual(JS_CLAIM_KEYS);
    // No count hint for JS: two CM5 models and a probe count of 0 stay ambiguous.
    expect(r.body.needsModel).toBe(true);
  });

  it('the device insert names exactly the columns it named before', async () => {
    await claim(jsReg(), { serial: 's1' });
    expect(Object.keys(deviceInserts[0]).sort()).toEqual(
      [
        'agent',
        'config',
        'configRev',
        'configUpdatedAt',
        'deviceModelId',
        'name',
        'needsModel',
        'serial',
        'workspaceId',
      ].sort(),
    );
  });
});

describe('the registration column and its migration (the order hazard)', () => {
  const MIGRATION = join(__dirname, '..', 'drizzle/manual/042_registration_cameras.sql');
  // Read inside the tests, not at collection, so the JS-unchanged groups above
  // can be run by name against a tree that predates the migration.
  const migration = () => readFileSync(MIGRATION, 'utf8');
  const statementsOf = (sql: string) =>
    sql
      .split('\n')
      .filter((line) => !line.startsWith('--') && line.trim() !== '')
      .join('\n');

  it('is ONE additive, idempotent statement: a nullable jsonb column, no default', () => {
    expect(statementsOf(migration())).toBe(
      'ALTER TABLE "device_registrations" ADD COLUMN IF NOT EXISTS "cameras" jsonb;',
    );
  });

  it('carries the apply-before-deploying warning the agent column migration carries', () => {
    // HAZARD: every registration query selects the column by name (drizzle's
    // findFirst / returning()), so code deployed BEFORE this migration makes
    // every registration route 500, the JS installer download included. This
    // test cannot enforce the order; it keeps the warning from being edited
    // away, in this file and in the migration it mirrors.
    const sql = migration();
    expect(sql).toContain('ORDER MATTERS: apply BEFORE deploying the code.');
    expect(sql).toContain('`GET /v1/get/{code}`');
    expect(sql).toContain('The reverse order is safe');
    const agentMigration = readFileSync(
      join(__dirname, '..', 'drizzle/manual/041_device_agent.sql'),
      'utf8',
    );
    expect(agentMigration).toContain('ORDER MATTERS: apply BEFORE deploying the code.');
  });

  it('is the next manual migration after 041', () => {
    expect(MIGRATION.endsWith('042_registration_cameras.sql')).toBe(true);
  });

  it('matches the drizzle column: nullable, no default, on device_registrations only', () => {
    const column = getTableConfig(realSchema.deviceRegistrations).columns.find(
      (c) => c.name === 'cameras',
    )!;
    expect(column).toBeDefined();
    expect(column.notNull).toBe(false);
    expect(column.hasDefault).toBe(false);
    expect(column.getSQLType()).toBe('jsonb');
    // The namespace lives in `devices.config`: no new column on `devices`.
    expect(getTableConfig(realSchema.devices).columns.some((c) => c.name === 'cameras')).toBe(false);
  });
});

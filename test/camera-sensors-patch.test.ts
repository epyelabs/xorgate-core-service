import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';

/**
 * `PATCH /devices/{id}/config` with `cameraSensors`, through the real handler
 * (plans/support-other-camera-models, Phase 2): the gate facts are read off
 * the device row, a device that does not qualify gets a 400 with the reason
 * and NOTHING is written or published, and a device that does gets its keys
 * bounded by its model's camera ports.
 *
 * The pure rules are in `camera-sensors-config.test.ts`; this file proves the
 * handler supplies them.
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
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => ['ws-1'],
}));
vi.mock('../src/services/device-teardown', () => ({ teardownDevices: vi.fn() }));
vi.mock('../src/handlers/device-purges', () => ({ handleDevicePurgeRoutes: vi.fn() }));

const publishDeviceConfig = vi.fn(async (..._a: unknown[]) => undefined);
const deviceHardwareBlock = vi.fn(async (..._a: unknown[]) => HARDWARE as unknown);
const deviceDeclaresObd = vi.fn(async () => false);
vi.mock('../src/services/device-config', () => ({
  publishDeviceConfig: (...a: unknown[]) => publishDeviceConfig(...a),
  deviceHardwareBlock: (...a: unknown[]) => deviceHardwareBlock(...a),
  deviceDeclaresObd: () => deviceDeclaresObd(),
}));

const HARDWARE = {
  v: 2,
  platform: 'rpi-cm5',
  video: [
    { key: 'cam0', connector: 'csi0', sensor: 'imx290', codec: 'h264' },
    { key: 'cam1', connector: 'csi1', sensor: 'imx290', codec: 'h264' },
  ],
};

type Row = Record<string, unknown>;
let device: Row;
const writes: Row[] = [];

vi.mock('../src/db/index', () => ({
  schema: realSchema,
  db: {
    query: { devices: { findFirst: async () => device } },
    update: () => ({
      set: (values: Row) => ({
        where: () => ({
          returning: async () => {
            writes.push(values);
            device = { ...device, config: values.config, configRev: (device.configRev as number) + 1 };
            return [device];
          },
        }),
      }),
    }),
  },
}));

const { handler } = await import('../src/handlers/devices');

type Res = Exclude<APIGatewayProxyResultV2, string>;
const ID = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';

async function patch(body: unknown) {
  const res = (await handler({
    routeKey: 'PATCH /v1/devices/{id}/config',
    rawPath: `/v1/devices/${ID}/config`,
    requestContext: { http: { method: 'PATCH', path: `/v1/devices/${ID}/config` }, requestId: 'r' },
    pathParameters: { id: ID },
    headers: {},
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2)) as Res;
  return { status: res.statusCode, body: JSON.parse(res.body as string) };
}

const OLD_CAPS = ['sms.read', 'sms.clear', 'obd.scan', 'obd.forget'];
const reported = (capabilities: string[]) => ({
  v: 1,
  rev: 3,
  origin: 'boot',
  effective: { agent: { mode: 'real', capabilities, runtime: 'rust' } },
  status: {},
});

const base = (extra: Row): Row => ({
  id: ID,
  workspaceId: 'ws-1',
  agent: 'rust',
  simulated: false,
  reportedConfig: null,
  agentVersion: null,
  config: { gnssAntBias: true },
  configRev: 3,
  uiPrefs: null,
  ...extra,
});

const BODY = { cameraSensors: { cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } } } };

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
});

describe('PATCH /devices/{id}/config { cameraSensors }: refused devices', () => {
  it.each([
    [
      'a JS device',
      base({ agent: 'js', reportedConfig: reported(OLD_CAPS), agentVersion: 'v0.0.6' }),
      'config namespace cameraSensors needs the Rust device agent, version 0.2.0 or newer; this ' +
        'device runs the JS agent, which does not manage camera sensors',
    ],
    [
      'a JS device that has never reported',
      base({ agent: 'js' }),
      'config namespace cameraSensors needs the Rust device agent, version 0.2.0 or newer; this ' +
        'device runs the JS agent, which does not manage camera sensors',
    ],
    [
      'a simulator',
      base({ simulated: true }),
      'config namespace cameraSensors does not apply to simulated devices: a simulator has no ' +
        'camera ports',
    ],
    [
      'a Rust device on agent v0.1.1',
      base({ reportedConfig: reported(OLD_CAPS), agentVersion: 'v0.1.1' }),
      'config namespace cameraSensors needs Rust agent 0.2.0 or newer; this device last reported ' +
        'agent build "v0.1.1" that does not support it (no "camera.sensors" capability). Update ' +
        'the agent on the device, then save again',
    ],
  ])('%s → 400 with the reason; nothing written, nothing published', async (_name, row, message) => {
    device = row;
    const r = await patch(BODY);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('BAD_REQUEST');
    expect(r.body.error.message).toBe(message);
    expect(writes).toHaveLength(0);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
    // The model is not even read for a device that does not qualify.
    expect(deviceHardwareBlock).not.toHaveBeenCalled();
  });

  it('a refused cameraSensors takes the rest of the request with it (all-or-nothing)', async () => {
    device = base({ agent: 'js' });
    const r = await patch({ timeSync: { offlineSources: false }, ...BODY });
    expect(r.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('the same refused device still saves every other namespace, as before', async () => {
    device = base({ agent: 'js', reportedConfig: reported(OLD_CAPS) });
    const r = await patch({ cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } });
    expect(r.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].config).toEqual({
      gnssAntBias: true,
      cameraMount: { cameras: { cam0: { rotationDeg: 180 } } },
    });
    // No camera gate work for a request that does not name the namespace.
    expect(deviceHardwareBlock).not.toHaveBeenCalled();
    expect(publishDeviceConfig).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /devices/{id}/config { cameraSensors }: accepted devices', () => {
  it.each([
    ['a Rust device that has never reported', base({})],
    [
      'a Rust device reporting camera.sensors',
      base({ reportedConfig: reported([...OLD_CAPS, 'camera.sensors']), agentVersion: 'v0.2.0' }),
    ],
  ])('%s → stored whole, rev bumped, published, served', async (_name, row) => {
    device = row;
    const r = await patch(BODY);
    expect(r.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].config).toEqual({ gnssAntBias: true, ...BODY });
    expect(publishDeviceConfig).toHaveBeenCalledWith(ID, { gnssAntBias: true, ...BODY }, 4);
    expect(r.body.device.config.cameraSensors).toEqual(BODY.cameraSensors);
    expect(deviceHardwareBlock).toHaveBeenCalledWith(ID);
  });

  it('a port the model does not declare → 400 naming the port and the ports there are', async () => {
    device = base({});
    const r = await patch({ cameraSensors: { cameras: { cam2: { sensor: 'imx219' } } } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(
      'cameraSensors.cameras.cam2: this device\'s model has no camera port "cam2" ' +
        '(its camera ports: cam0, cam1)',
    );
    expect(writes).toHaveLength(0);
  });

  it('a one-camera model refuses cam1', async () => {
    device = base({});
    deviceHardwareBlock.mockResolvedValueOnce({ ...HARDWARE, video: [HARDWARE.video[0]] });
    const r = await patch(BODY);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('has no camera port "cam1" (its camera ports: cam0)');
  });

  it('a model with no hardware block: ports unknown, the catalog is all that is checked', async () => {
    device = base({});
    deviceHardwareBlock.mockResolvedValueOnce(null);
    const r = await patch({ cameraSensors: { cameras: { cam3: { sensor: 'imx219' } } } });
    expect(r.status).toBe(200);
  });

  it('an invalid value → 400 naming the port and what is allowed', async () => {
    device = base({});
    const r = await patch({ cameraSensors: { cameras: { cam0: { sensor: 'imx477' } } } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(
      'cameraSensors.cameras.cam0.sensor: "imx477" is not a known camera sensor ' +
        '(known: imx290, imx219, imx708, imx335); or "none" for a port with no camera',
    );
    expect(writes).toHaveLength(0);
  });

  it('null clears it (stored as the cleared marker, stripped from the response)', async () => {
    device = base({ config: { gnssAntBias: true, ...BODY } });
    const r = await patch({ cameraSensors: null });
    expect(r.status).toBe(200);
    expect(writes[0].config).toEqual({ gnssAntBias: true, cameraSensors: null });
    expect('cameraSensors' in r.body.device.config).toBe(false);
  });

  it('replaces the namespace whole: a port left out becomes unmanaged, never defaulted', async () => {
    device = base({ config: BODY });
    const r = await patch({ cameraSensors: { cameras: { cam1: { sensor: 'imx219' } } } });
    expect(r.status).toBe(200);
    expect(writes[0].config).toEqual({ cameraSensors: { cameras: { cam1: { sensor: 'imx219' } } } });
  });
});

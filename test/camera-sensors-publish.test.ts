import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The retained publish and `cameraSensors`, through the real
 * `publishDeviceConfig` (plans/support-other-camera-models, Phase 2).
 *
 * Two things are proved here that the pure `buildDeviceConfigMessage` tests
 * cannot: the publisher reads the gate facts off the device ROW, and a publish
 * of a document that does not hold the key (every JS device, every device
 * fielded before the namespace) runs the same single model read and puts the
 * same bytes on the wire as before.
 */

const published: { topic: string; retain: boolean; payload: string }[] = [];
class PublishCommand {
  constructor(public input: { topic: string; retain: boolean; payload: Buffer }) {}
}
vi.mock('@aws-sdk/client-iot-data-plane', () => ({ PublishCommand }));
vi.mock('../src/services/iot-data', () => ({
  iotDataClient: async () => ({
    send: async (cmd: PublishCommand) => {
      published.push({
        topic: cmd.input.topic,
        retain: cmd.input.retain,
        payload: cmd.input.payload.toString('utf8'),
      });
      return {};
    },
  }),
}));
vi.mock('../src/services/device-scope', () => ({
  deviceScope: async () => null,
  ensureThingScopeAttributes: async () => 'unchanged',
}));

/** Every `db.select(cols)` the publisher makes, by the keys it selected. */
const selects: string[][] = [];
let deviceRow: Record<string, unknown> | undefined;
vi.mock('../src/db/index', async () => {
  const schema = await import('../src/db/schema');
  return {
    schema,
    db: {
      select: (cols: Record<string, unknown>) => {
        selects.push(Object.keys(cols));
        const self: Record<string, unknown> = {};
        for (const k of ['from', 'innerJoin', 'where']) self[k] = () => self;
        self.limit = async () => (deviceRow ? [deviceRow] : []);
        return self;
      },
    },
  };
});

const { publishDeviceConfig, buildDeviceConfigMessage } = await import(
  '../src/services/device-config'
);
const { deriveHardwareBlock } = await import('../src/schemas/capabilities');

const ID = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const TS = 1_800_000_000_000;
const CAPS = {
  schemaVersion: 2,
  system: { platform: 'rpi-cm5', fields: [] },
  media: {
    video: [
      { key: 'cam0', codec: 'h264', connector: 'csi0', sensor: 'imx290' },
      { key: 'cam1', codec: 'h264', connector: 'csi1', sensor: 'imx290' },
    ],
  },
};
const OLD_CAPS = ['sms.read', 'sms.clear', 'obd.scan', 'obd.forget'];
const reported = (capabilities: string[]) => ({
  v: 1,
  effective: { agent: { mode: 'real', capabilities } },
});
const SENSORS = { cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } } };

const savedBucket = process.env.BUCKET_NAME;
beforeEach(() => {
  published.length = 0;
  selects.length = 0;
  deviceRow = undefined;
  delete process.env.BUCKET_NAME;
  vi.useFakeTimers();
  vi.setSystemTime(TS);
});
afterEach(() => {
  vi.useRealTimers();
  if (savedBucket !== undefined) process.env.BUCKET_NAME = savedBucket;
});

describe('publishDeviceConfig: a document WITHOUT cameraSensors', () => {
  const doc = {
    gnssAntBias: true,
    recording: { video: { enabled: true } },
    cameraMount: { cameras: { cam0: { rotationDeg: 180 as const } } },
  };

  it('runs the one model read it always ran: the row facts are not selected', async () => {
    deviceRow = { caps: CAPS, agent: 'js', simulated: false, reportedConfig: reported(OLD_CAPS) };
    await publishDeviceConfig(ID, doc, 42);
    expect(selects).toEqual([['caps']]);
  });

  it('puts the same bytes on the wire as the pre-namespace publisher', async () => {
    deviceRow = { caps: CAPS, agent: 'js', simulated: false, reportedConfig: reported(OLD_CAPS) };
    await publishDeviceConfig(ID, doc, 42);
    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe(`xorgate/devices/${ID}/config`);
    expect(published[0].retain).toBe(true);
    // The five-argument call is the publisher as it was before this namespace.
    const before = JSON.stringify(
      buildDeviceConfigMessage(doc, 42, TS, null, deriveHardwareBlock(CAPS)),
    );
    expect(published[0].payload).toBe(before);
    expect(published[0].payload).toBe(
      '{"v":1,"rev":42,"gnssAntBias":true,"recording":{"video":{"enabled":true}},' +
        '"cameraMount":{"cameras":{"cam0":{"rotationDeg":180}}},' +
        '"hardware":{"v":2,"platform":"rpi-cm5","encoder":"sw-h264","rails":false,"statusLed":null,' +
        '"imu":null,"video":[{"key":"cam0","connector":"csi0","sensor":"imx290","codec":"h264"},' +
        '{"key":"cam1","connector":"csi1","sensor":"imx290","codec":"h264"}]},' +
        `"ts":${TS}}`,
    );
  });

  it('the same for the empty document of a brand-new JS device', async () => {
    deviceRow = { caps: CAPS, agent: 'js', simulated: false, reportedConfig: null };
    await publishDeviceConfig(ID, {}, 1);
    expect(selects).toEqual([['caps']]);
    expect(JSON.parse(published[0].payload)).toMatchObject({ v: 1, rev: 1, gnssAntBias: false });
    expect(published[0].payload).not.toContain('cameraSensors');
  });
});

describe('publishDeviceConfig: a document WITH cameraSensors', () => {
  const doc = { gnssAntBias: false, cameraSensors: SENSORS } as never;

  it('reads the gate facts off the row, in the same single read as the model', async () => {
    deviceRow = { caps: CAPS, agent: 'rust', simulated: false, reportedConfig: null };
    await publishDeviceConfig(ID, doc, 1);
    expect(selects).toEqual([['caps', 'agent', 'simulated', 'reportedConfig', 'agentVersion']]);
  });

  it('a Rust device that has never reported (the claim publish): carried', async () => {
    deviceRow = { caps: CAPS, agent: 'rust', simulated: false, reportedConfig: null };
    await publishDeviceConfig(ID, doc, 1);
    const msg = JSON.parse(published[0].payload);
    expect(msg.cameraSensors).toEqual(SENSORS);
    expect(Object.keys(msg)).toEqual(['v', 'rev', 'gnssAntBias', 'cameraSensors', 'hardware', 'ts']);
  });

  it('a Rust device reporting camera.sensors: carried', async () => {
    deviceRow = {
      caps: CAPS,
      agent: 'rust',
      simulated: false,
      reportedConfig: reported([...OLD_CAPS, 'camera.sensors']),
    };
    await publishDeviceConfig(ID, doc, 5);
    expect(JSON.parse(published[0].payload).cameraSensors).toEqual(SENSORS);
  });

  it.each([
    ['a Rust agent without the capability', { agent: 'rust', simulated: false, reportedConfig: reported(OLD_CAPS) }],
    ['a JS device', { agent: 'js', simulated: false, reportedConfig: null }],
    ['a JS device that reported', { agent: 'js', simulated: false, reportedConfig: reported(OLD_CAPS) }],
    ['a simulator', { agent: 'rust', simulated: true, reportedConfig: null }],
  ])('%s: NOT carried, and the bytes equal a publish of the document without the key', async (_n, facts) => {
    deviceRow = { caps: CAPS, ...facts };
    await publishDeviceConfig(ID, doc, 5);
    await publishDeviceConfig(ID, { gnssAntBias: false }, 5);
    expect(published).toHaveLength(2);
    expect(published[0].payload).not.toContain('cameraSensors');
    expect(published[0].payload).toBe(published[1].payload);
  });

  it('a device that is gone: nothing gated is published', async () => {
    deviceRow = undefined;
    await publishDeviceConfig(ID, doc, 5);
    expect(published[0].payload).not.toContain('cameraSensors');
    expect(published[0].payload).not.toContain('hardware');
  });
});

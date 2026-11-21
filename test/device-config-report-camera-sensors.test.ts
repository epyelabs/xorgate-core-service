import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';

/**
 * The report mirror and `cameraSensors` (plans/support-other-camera-models,
 * Phase 2): the version-skew rule and the local-change fence.
 *
 * VERSION SKEW. The namespace may be stored while a device has never reported
 * (a Rust registration's choice is seeded at claim). If the agent that then
 * connects cannot act on it, the mirror WITHDRAWS it: the key leaves the
 * desired document, the rev is bumped, the retained message is republished
 * without it. An agent that cannot act on the setting is then never shown as
 * holding it, and nothing springs back to life when it is updated later.
 *
 * `db` and the publisher are mocked exactly as in `device-config-report.test.ts`;
 * the updates are a queue so each test states what every write returns.
 */

type Returned = Record<string, unknown>[];
let queue: Returned[];
const sets: Record<string, unknown>[] = [];
const update = vi.fn(() => ({
  set: (values: Record<string, unknown>) => {
    sets.push(values);
    return { where: () => ({ returning: async () => queue.shift() ?? [] }) };
  },
}));

vi.mock('../src/db/index', () => ({ db: { update }, schema: realSchema }));

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

const { handler, republishGuard } = await import('../src/handlers/device-config-report');

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const OLD_CAPS = ['sms.read', 'sms.clear', 'obd.scan', 'obd.forget'];
const NEW_CAPS = [...OLD_CAPS, 'camera.sensors'];
const SEED = { cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx290' } } };

const agentBlock = (capabilities: unknown, version = 'v0.1.1') => ({
  mode: 'real',
  build: { version, channel: 'prod', builtAt: null, packageVersion: version.replace(/^v/, '') },
  capabilities,
  runtime: 'rust',
});

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topicDeviceId: DEVICE,
    v: 1,
    deviceId: DEVICE,
    ts: 1_800_000_000_000,
    rev: 1,
    origin: 'boot',
    effective: { gnssAntBias: false, agent: agentBlock(OLD_CAPS) },
    status: {},
    ...overrides,
  };
}

/** What the first UPDATE (the report mirror) returns: the device row. */
const row = (config: unknown, configRev = 1, extra: Record<string, unknown> = {}) => ({
  config,
  configRev,
  simulated: false,
  agent: 'rust',
  ...extra,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  sets.length = 0;
  queue = [];
  republishGuard.reset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('version skew: a seeded cameraSensors meets an agent that cannot act on it', () => {
  it('the first report of a v0.1.1 Rust device withdraws the seed and republishes without it', async () => {
    // Claimed and seeded at rev 1; the agent applied rev 1 and reports level.
    queue = [
      [row({ cameraSensors: SEED })],
      [{ config: {}, configRev: 2 }], // the withdrawal's own UPDATE … RETURNING
    ];
    await handler(report());

    expect(update).toHaveBeenCalledTimes(2);
    const withdrawal = sets[1];
    expect(withdrawal.config).toEqual({});
    expect('cameraSensors' in (withdrawal.config as object)).toBe(false);
    expect(withdrawal).toHaveProperty('configRev'); // rev + 1, a SQL expression
    expect(withdrawal).toHaveProperty('configUpdatedAt');

    // The retained message is rewritten from the row as it now is.
    expect(publishDeviceConfig).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, {}, 2);
    expect(warn).toHaveBeenCalledWith(
      'device-config-report: cameraSensors withdrawn, the reporting agent does not support it',
      expect.objectContaining({
        agentVersion: 'v0.1.1',
        needsAgent: '0.2.0',
        // The whole choice, as text, so the log line keeps every level of it.
        withdrawn: JSON.stringify(SEED),
      }),
    );
  });

  it('keeps every other namespace of the document', async () => {
    const doc = {
      gnssAntBias: true,
      cameraMount: { cameras: { cam0: { rotationDeg: 180 } } },
      cameraSensors: SEED,
    };
    queue = [[row(doc, 5)], [{ config: {}, configRev: 6 }]];
    await handler(report({ rev: 5 }));
    expect(sets[1].config).toEqual({
      gnssAntBias: true,
      cameraMount: { cameras: { cam0: { rotationDeg: 180 } } },
    });
  });

  it('withdraws a cleared marker too (the key must not stay on the row)', async () => {
    queue = [[row({ cameraSensors: null })], [{ config: {}, configRev: 2 }]];
    await handler(report());
    expect(update).toHaveBeenCalledTimes(2);
    expect(sets[1].config).toEqual({});
  });

  it('a device that is also BEHIND gets one publish, not two', async () => {
    queue = [[row({ cameraSensors: SEED }, 4)], [{ config: {}, configRev: 5 }]];
    await handler(report({ rev: 2 }));
    expect(publishDeviceConfig).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, {}, 5);
  });

  it('a Rust agent that reports camera.sensors keeps its value: one write, no publish', async () => {
    queue = [[row({ cameraSensors: SEED })]];
    await handler(report({ effective: { agent: agentBlock(NEW_CAPS, 'v0.2.0') } }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('a report with no agent block proves nothing and removes nothing', async () => {
    // The agent builds the `agent` block only when it knows its mode.
    for (const effective of [{}, { gnssAntBias: true }, { agent: { mode: 'real' } }, undefined]) {
      sets.length = 0;
      update.mockClear();
      queue = [[row({ cameraSensors: SEED })]];
      await handler(report({ effective }));
      expect(update, JSON.stringify(effective)).toHaveBeenCalledTimes(1);
    }
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('a downgrade: a capable device that reports again WITHOUT the capability loses it', async () => {
    queue = [[row({ cameraSensors: SEED }, 9)], [{ config: {}, configRev: 10 }]];
    await handler(report({ rev: 9, origin: 'cloud' }));
    expect(update).toHaveBeenCalledTimes(2);
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, {}, 10);
  });

  it('a JS agent reporting on a row that holds the key (a reverted device) loses it', async () => {
    queue = [[row({ cameraSensors: SEED }, 3, { agent: 'js' })], [{ config: {}, configRev: 4 }]];
    await handler(
      report({ rev: 3, effective: { agent: { mode: 'real', capabilities: OLD_CAPS } } }),
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(sets[1].config).toEqual({});
  });

  it('losing the race with a cloud write changes nothing and does not publish', async () => {
    queue = [[row({ cameraSensors: SEED })], []]; // the guarded UPDATE matched no row
    await handler(report());
    expect(update).toHaveBeenCalledTimes(2);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'device-config-report: cameraSensors withdrawal lost a race with a cloud write',
      expect.anything(),
    );
  });

  it('a failed republish does not throw: the next report repairs it', async () => {
    queue = [[row({ cameraSensors: SEED })], [{ config: {}, configRev: 2 }]];
    publishDeviceConfig.mockRejectedValueOnce(new Error('iot down'));
    await expect(handler(report())).resolves.toBeUndefined();
  });

  it('after the withdrawal there is nothing left to withdraw (no loop)', async () => {
    queue = [[row({}, 2)]];
    await handler(report({ rev: 2 }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });
});

describe('devices that never held the key: the mirror does exactly what it did', () => {
  it('a JS device: one write (the report), nothing else', async () => {
    queue = [[row({ gnssAntBias: true, cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }, 12, { agent: 'js' })]];
    await handler(
      report({ rev: 12, origin: 'cloud', effective: { agent: { mode: 'real', capabilities: OLD_CAPS } } }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
    expect(deviceHardwareBlock).not.toHaveBeenCalled();
    // The stored report is the report: nothing camera-related was added to it.
    expect(Object.keys(sets[0]).sort()).toEqual(['reportedAt', 'reportedConfig']);
  });

  it('an old Rust device with no seed: one write, and the republish-when-behind is untouched', async () => {
    queue = [[row({ gnssAntBias: true }, 12)]];
    await handler(report({ rev: 12 }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();

    sets.length = 0;
    update.mockClear();
    queue = [[row({ gnssAntBias: true }, 12)]];
    await handler(report({ rev: 9 }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, { gnssAntBias: true }, 12);
  });

  it('a row with a null config (never configured) does not trip the withdrawal', async () => {
    queue = [[row(null, 0)]];
    await expect(handler(report({ rev: 0 }))).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('a local change of cameraSensors (xorgate-rs set) folding back', () => {
  const local = (changed: unknown, effective: unknown = { agent: agentBlock(NEW_CAPS, 'v0.2.0') }) =>
    report({ origin: 'local', rev: 7, changed, effective });
  const NEXT = { cameras: { cam0: { sensor: 'imx219' } } };

  it('a capable Rust device: merged into the desired document and republished', async () => {
    queue = [[row({ gnssAntBias: true }, 7)], [{ config: { gnssAntBias: true, cameraSensors: NEXT }, configRev: 8 }]];
    await handler(local({ cameraSensors: NEXT }));
    expect(update).toHaveBeenCalledTimes(2);
    expect(sets[1].config).toEqual({ gnssAntBias: true, cameraSensors: NEXT });
    expect(publishDeviceConfig).toHaveBeenCalledWith(
      DEVICE,
      { gnssAntBias: true, cameraSensors: NEXT },
      8,
    );
    // The model's ports were read to bound the keys.
    expect(deviceHardwareBlock).toHaveBeenCalledWith(DEVICE);
  });

  it('a local "none" and a local removal (null) are merged as well', async () => {
    queue = [[row({}, 7)], [{ config: {}, configRev: 8 }]];
    await handler(local({ cameraSensors: { cameras: { cam1: { sensor: 'none' } } } }));
    expect(sets[1].config).toEqual({ cameraSensors: { cameras: { cam1: { sensor: 'none' } } } });

    sets.length = 0;
    queue = [[row({ cameraSensors: NEXT }, 7)], [{ config: {}, configRev: 8 }]];
    await handler(local({ cameraSensors: null }));
    expect(sets[1].config).toEqual({ cameraSensors: null });
  });

  it('a port the model does not declare is rejected by the registry and skipped', async () => {
    queue = [[row({}, 7)]];
    await handler(local({ cameraSensors: { cameras: { cam2: { sensor: 'imx219' } } } }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'device-config-report: local change rejected by the registry, skipping',
      expect.objectContaining({
        namespace: 'cameraSensors',
        error:
          'cameraSensors.cameras.cam2: this device\'s model has no camera port "cam2" ' +
          '(its camera ports: cam0, cam1)',
      }),
    );
  });

  it('a sensor the catalog does not know is rejected and skipped; the rest of the change survives', async () => {
    queue = [[row({}, 7)], [{ config: { timeSync: { offlineSources: false } }, configRev: 8 }]];
    await handler(
      local({
        cameraSensors: { cameras: { cam0: { sensor: 'imx999' } } },
        timeSync: { offlineSources: false },
      }),
    );
    expect(sets[1].config).toEqual({ timeSync: { offlineSources: false } });
  });

  it('with no hardware block the ports are unknown and only the catalog is checked', async () => {
    deviceHardwareBlock.mockResolvedValueOnce(null);
    queue = [[row({}, 7)], [{ config: {}, configRev: 8 }]];
    await handler(local({ cameraSensors: { cameras: { cam5: { sensor: 'imx219' } } } }));
    expect(sets[1].config).toEqual({ cameraSensors: { cameras: { cam5: { sensor: 'imx219' } } } });
  });

  it.each([
    ['a Rust agent without the capability', { agent: 'rust' }, { agent: agentBlock(OLD_CAPS) }],
    ['a JS device', { agent: 'js' }, { agent: { mode: 'real', capabilities: NEW_CAPS } }],
    ['a simulator', { agent: 'rust', simulated: true }, { agent: agentBlock(NEW_CAPS) }],
  ])('%s: the local edit never becomes cloud desired state', async (_name, rowExtra, effective) => {
    queue = [[row({}, 7, rowExtra)]];
    await handler(local({ cameraSensors: NEXT }, effective));
    expect(update).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
    expect(deviceHardwareBlock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'device-config-report: gated namespace on a device that does not qualify, skipping',
      expect.objectContaining({ namespace: 'cameraSensors' }),
    );
  });

  it('a local edit of ANOTHER namespace still folds back from an old agent, then the seed goes', async () => {
    // The order matters: the withdrawal bumps the rev, and a local report is
    // discarded when its rev no longer matches. So the merge runs first.
    const merged = { cameraSensors: SEED, timeSync: { offlineSources: false } };
    queue = [
      [row({ cameraSensors: SEED }, 7)],
      [{ config: merged, configRev: 8 }], // the local merge
      [{ config: { timeSync: { offlineSources: false } }, configRev: 9 }], // the withdrawal
    ];
    await handler(local({ timeSync: { offlineSources: false } }, { agent: agentBlock(OLD_CAPS) }));
    expect(update).toHaveBeenCalledTimes(3);
    expect(sets[1].config).toEqual(merged);
    expect(sets[2].config).toEqual({ timeSync: { offlineSources: false } });
    expect(publishDeviceConfig).toHaveBeenLastCalledWith(
      DEVICE,
      { timeSync: { offlineSources: false } },
      9,
    );
  });
});

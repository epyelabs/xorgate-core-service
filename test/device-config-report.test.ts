import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';

/**
 * The mirror Lambda (improve_device_settings_management, Phase 3): IoT rule ->
 * `devices.reported_config` (+ republish the retained desired document when the
 * device is behind).
 *
 * `db` is mocked because the handler talks to the RDS Data API; the real
 * drizzle schema is reused so the update target is the genuine table object.
 * `publishDeviceConfig` is mocked because the republish is the behaviour under
 * test and would otherwise reach IoT.
 */

let returning: () => Promise<{ config: unknown; configRev: number }[]>;
const where = vi.fn(() => ({ returning: () => returning() }));
const set = vi.fn(() => ({ where }));
const update = vi.fn(() => ({ set }));

vi.mock('../src/db/index', () => ({
  db: { update },
  schema: realSchema,
}));

const publishDeviceConfig = vi.fn(async () => undefined);
vi.mock('../src/services/device-config', () => ({
  publishDeviceConfig: (...args: unknown[]) =>
    (publishDeviceConfig as unknown as (...a: unknown[]) => Promise<void>)(...args),
}));

const { handler } = await import('../src/handlers/device-config-report');

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topicDeviceId: DEVICE,
    v: 1,
    deviceId: DEVICE,
    ts: 1_800_000_000_000,
    rev: 12,
    origin: 'cloud',
    effective: { gnssAntBias: true, recording: { video: { enabled: true } } },
    status: { recording: { state: 'applied', at: 1_800_000_000_000 } },
    ...overrides,
  };
}

/** Default: the row exists and the cloud is at the rev the device reported. */
function rowAt(configRev: number, config: unknown = { gnssAntBias: true }): void {
  returning = async () => [{ config, configRev }];
}

beforeEach(() => {
  vi.clearAllMocks();
  rowAt(12);
});

describe('device-config-report: mirroring', () => {
  it('stores the whole report against the device from the topic', async () => {
    await handler(report());
    expect(update).toHaveBeenCalledWith(realSchema.devices);
    const written = set.mock.calls[0][0] as { reportedConfig: Record<string, unknown> };
    expect(written.reportedConfig).toMatchObject({
      v: 1,
      deviceId: DEVICE,
      rev: 12,
      origin: 'cloud',
      effective: { gnssAntBias: true },
    });
    // `topicDeviceId` is rule plumbing, not part of the device's report.
    expect(written.reportedConfig).not.toHaveProperty('topicDeviceId');
  });

  it('defaults the optional halves so a stored report is never partly undefined', async () => {
    await handler(report({ effective: undefined, status: undefined }));
    const written = set.mock.calls[0][0] as { reportedConfig: Record<string, unknown> };
    expect(written.reportedConfig.effective).toEqual({});
    expect(written.reportedConfig.status).toEqual({});
  });

  it('mirrors an effective value the cloud registry itself would reject', async () => {
    // The device clamp range is deliberately WIDER than the cloud's accepted
    // range, so a locally-set value can sit outside it. Refusing to store that
    // would hide the very divergence this plane exists to surface.
    await handler(
      report({ effective: { recording: { telemetry: { rateHz: 20, bogusLocalKey: 1 } } } }),
    );
    const written = set.mock.calls[0][0] as { reportedConfig: Record<string, unknown> };
    expect(written.reportedConfig.effective).toEqual({
      recording: { telemetry: { rateHz: 20, bogusLocalKey: 1 } },
    });
  });

  it('drops a payload whose body deviceId contradicts the topic', async () => {
    await handler(report({ deviceId: 'someone-else' }));
    expect(update).not.toHaveBeenCalled();
  });

  it('drops a payload with no topic deviceId', async () => {
    await handler(report({ topicDeviceId: undefined }));
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-v1 envelope', { v: 2 }],
    ['an unknown origin', { origin: 'wherever' }],
    ['a negative rev', { rev: -1 }],
    ['a bad namespace state', { status: { recording: { state: 'maybe' } } }],
    ['a missing ts', { ts: undefined }],
  ])('drops %s instead of storing it', async (_label, overrides) => {
    await handler(report(overrides));
    expect(update).not.toHaveBeenCalled();
  });

  it('drops an implausibly large report rather than growing the row', async () => {
    const huge = { recording: { junk: 'x'.repeat(40_000) } };
    await handler(report({ effective: huge }));
    expect(update).not.toHaveBeenCalled();
  });
});

describe('device-config-report: self-heal republish', () => {
  it('republishes the desired document when the device is behind', async () => {
    rowAt(15, { gnssAntBias: true, timeSync: { offlineSources: true } });
    await handler(report({ rev: 12 }));
    expect(publishDeviceConfig).toHaveBeenCalledWith(
      DEVICE,
      { gnssAntBias: true, timeSync: { offlineSources: true } },
      15,
    );
  });

  it('does not republish when the device is level with the cloud', async () => {
    rowAt(12);
    await handler(report({ rev: 12 }));
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('does not republish over a local edit (that mirroring is Phase 4)', async () => {
    rowAt(15);
    await handler(report({ rev: 12, origin: 'local' }));
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('still stores a local-origin report', async () => {
    rowAt(15);
    await handler(report({ rev: 12, origin: 'local' }));
    expect(update).toHaveBeenCalled();
  });

  it('republishes for a device that has never received a config (rev 0)', async () => {
    rowAt(3);
    await handler(report({ rev: 0, origin: 'boot' }));
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, { gnssAntBias: true }, 3);
  });

  it('skips both the republish and a throw when no row matched', async () => {
    // Unknown/deleted device, or a report older than the stored one.
    returning = async () => [];
    await expect(handler(report({ rev: 0 }))).resolves.toBeUndefined();
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('swallows a republish failure — the report is already mirrored', async () => {
    rowAt(15);
    publishDeviceConfig.mockRejectedValueOnce(new Error('iot down') as never);
    await expect(handler(report({ rev: 12 }))).resolves.toBeUndefined();
  });

  it('lets a DB failure throw so the async-retry path can recover it', async () => {
    returning = async () => {
      throw new Error('data api timeout');
    };
    await expect(handler(report())).rejects.toThrow('data api timeout');
  });
});

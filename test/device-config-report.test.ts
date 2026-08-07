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

/**
 * Phase 4: a local writer on the box (`xorgate set`, the manage TUI, vim) is
 * folded back into the DESIRED document, so it stops being reverted on the next
 * reconnect and starts showing up in the web UI.
 */
describe('device-config-report: origin=local mirroring', () => {
  /** Queue per-update-call results: [0] = the report store, [1] = the merge. */
  function rows(...results: { config: unknown; configRev: number }[][]): void {
    let i = 0;
    returning = async () => results[Math.min(i++, results.length - 1)];
  }

  function local(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return report({ origin: 'local', rev: 12, ...overrides });
  }

  /** The second `set()` call is the config merge; the first stored the report. */
  function mergeWrite(): Record<string, unknown> | undefined {
    return set.mock.calls[1]?.[0] as Record<string, unknown> | undefined;
  }

  it('merges the changed namespace, bumps the rev and republishes', async () => {
    rows(
      [{ config: { gnssAntBias: true }, configRev: 12 }],
      [{ config: { gnssAntBias: false }, configRev: 13 }],
    );
    await handler(local({ changed: { gnssAntBias: false } }));

    expect(mergeWrite()).toMatchObject({ config: { gnssAntBias: false } });
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, { gnssAntBias: false }, 13);
  });

  it('dual-writes the legacy columns the settings UI still reads', async () => {
    rows(
      [{ config: {}, configRev: 12 }],
      [{ config: { timeSync: { offlineSources: false } }, configRev: 13 }],
    );
    await handler(local({ changed: { timeSync: { offlineSources: false } } }));
    expect(mergeWrite()).toMatchObject({ timeSyncConfig: { offlineSources: false } });
  });

  it('treats null as "revert this namespace to device defaults"', async () => {
    rows(
      [{ config: { gnssAntBias: true, timeSync: { offlineSources: true } }, configRev: 12 }],
      [{ config: { gnssAntBias: true, timeSync: null }, configRev: 13 }],
    );
    await handler(local({ changed: { timeSync: null } }));
    // Stored as the cleared marker rather than deleted (settings_sync_hardening
    // finding 2): the operator deleted the key on the box, so the cloud now
    // records a deliberate revert and republishes it as `{}`. The legacy column
    // still nulls, exactly as it did when the key was deleted outright.
    const write = mergeWrite();
    expect(write?.config).toEqual({ gnssAntBias: true, timeSync: null });
    expect(write).toMatchObject({ timeSyncConfig: null });
  });

  it('does not write or republish when the merge changes nothing (loop guard)', async () => {
    // The round trip that ends the exchange: we republished, the device applied
    // a JSON-equal document. Without this the two would trade messages forever.
    rows([{ config: { gnssAntBias: true }, configRev: 12 }]);
    await handler(local({ changed: { gnssAntBias: true } }));
    expect(set).toHaveBeenCalledTimes(1); // the report store only
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('discards a local change that a newer cloud rev already overtook', async () => {
    // The documented conflict rule: cloud PATCH wins ties via rev ordering.
    rows([{ config: { gnssAntBias: true }, configRev: 15 }]);
    await handler(local({ rev: 12, changed: { gnssAntBias: false } }));
    expect(set).toHaveBeenCalledTimes(1);
    // …and the device is behind, so the authoritative document is re-sent.
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, { gnssAntBias: true }, 15);
  });

  it('skips a namespace the registry rejects but keeps the rest', async () => {
    // The device clamps where the cloud rejects, so a locally-set value can sit
    // outside the accepted range. It must not poison the desired document.
    rows(
      [{ config: {}, configRev: 12 }],
      [{ config: { gnssAntBias: false }, configRev: 13 }],
    );
    await handler(
      local({
        changed: {
          gnssAntBias: false,
          recording: { telemetry: { rateHz: 9999 } },
        },
      }),
    );
    expect(mergeWrite()?.config).toEqual({ gnssAntBias: false });
  });

  it('ignores an unknown namespace entirely', async () => {
    rows([{ config: { gnssAntBias: true }, configRev: 12 }]);
    await handler(local({ changed: { somethingNew: { a: 1 } } }));
    expect(set).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('stands down when a cloud write lands between the read and the merge', async () => {
    // The optimistic `configRev` guard on the update matched no row.
    rows([{ config: {}, configRev: 12 }], []);
    await expect(handler(local({ changed: { gnssAntBias: false } }))).resolves.toBeUndefined();
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('swallows a republish failure after a successful merge', async () => {
    rows(
      [{ config: {}, configRev: 12 }],
      [{ config: { gnssAntBias: false }, configRev: 13 }],
    );
    publishDeviceConfig.mockRejectedValueOnce(new Error('iot down') as never);
    await expect(handler(local({ changed: { gnssAntBias: false } }))).resolves.toBeUndefined();
  });

  it('stores a local report from an agent that sends no `changed` at all', async () => {
    rows([{ config: { gnssAntBias: true }, configRev: 12 }]);
    await handler(local());
    expect(set).toHaveBeenCalledTimes(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyConfigPatch,
  CONFIG_NAMESPACE_KEYS,
  initialConfigDocument,
  parseUiPrefsPatch,
  validateConfigPatch,
  validateNamespaceValue,
} from '../src/config-registry/index';
import { buildDeviceConfigMessage } from '../src/services/device-config';

describe('config registry — namespaces', () => {
  it('carries exactly the five wire namespaces, in wire order', () => {
    // Order is the published key order; the names are load-bearing (the modem
    // daemon greps them out of settings.json) and must never be renamed.
    expect(CONFIG_NAMESPACE_KEYS).toEqual([
      'gnssAntBias',
      'imuMount',
      'recording',
      'lteRecovery',
      'timeSync',
    ]);
  });

  it('rejects an unknown namespace', () => {
    expect(validateConfigPatch({ media: { enabled: true } })).toHaveProperty('error');
    // Q4: there is deliberately no `agent` namespace — `mode` is reported-only
    // and `mediaEnabled` was removed as a setting.
    expect(validateConfigPatch({ agent: { mode: 'sim' } })).toHaveProperty('error');
  });

  it('rejects an empty patch and a non-object body', () => {
    expect(validateConfigPatch({})).toHaveProperty('error');
    expect(validateConfigPatch(null)).toHaveProperty('error');
    expect(validateConfigPatch([{ recording: {} }])).toHaveProperty('error');
  });

  it('is all-or-nothing: one invalid namespace fails the whole patch', () => {
    const r = validateConfigPatch({
      timeSync: { offlineSources: false },
      recording: { telemetry: { rateHz: 999 } },
    });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('recording.telemetry.rateHz');
  });

  it('validates the scalar namespace as a bare value', () => {
    expect(validateNamespaceValue('gnssAntBias', true)).toEqual({ value: true });
    expect(validateNamespaceValue('gnssAntBias', 'on')).toHaveProperty('error');
    // A scalar has no "empty object" case; null still means revert.
    expect(validateNamespaceValue('gnssAntBias', null)).toEqual({ value: null });
  });

  it('range-checks imuMount (the hand-rolled parser never did)', () => {
    const ok = { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 90 };
    expect(validateNamespaceValue('imuMount', ok)).toEqual({ value: ok });
    expect(
      validateNamespaceValue('imuMount', { ...ok, yawDeg: 361 }),
    ).toHaveProperty('error');
    expect(
      validateNamespaceValue('imuMount', { ...ok, yawDeg: Number.NaN }),
    ).toHaveProperty('error');
    // Unknown keys were silently persisted before.
    expect(
      validateNamespaceValue('imuMount', { ...ok, rolldeg: 5 }),
    ).toHaveProperty('error');
    // Partial is rejected: the namespace is replaced whole.
    expect(validateNamespaceValue('imuMount', { enabled: true })).toHaveProperty('error');
  });

  it('accepts the thermal-shed keys (the drift this registry exists to kill)', () => {
    const value = { powerShedding: { cpuTempC: 82, cpuTempRestoreC: 73, cpuTempSecs: 20 } };
    expect(validateNamespaceValue('recording', value)).toEqual({ value });
  });
});

describe('config registry — patch application', () => {
  it('replaces a namespace whole, leaves others untouched', () => {
    const doc = {
      gnssAntBias: true,
      recording: { telemetry: { enabled: true, rateHz: 1 } },
      timeSync: { offlineSources: true },
    };
    const next = applyConfigPatch(doc, { recording: { video: { enabled: true } } });
    expect(next).toEqual({
      gnssAntBias: true,
      recording: { video: { enabled: true } },
      timeSync: { offlineSources: true },
    });
  });

  it('null deletes the namespace (revert to device defaults)', () => {
    const doc = { gnssAntBias: true, timeSync: { offlineSources: false } };
    expect(applyConfigPatch(doc, { timeSync: null })).toEqual({ gnssAntBias: true });
  });

  it('does not mutate the input document', () => {
    const doc = { gnssAntBias: false };
    applyConfigPatch(doc, { gnssAntBias: true });
    expect(doc).toEqual({ gnssAntBias: false });
  });

  it('starts a new device from an empty document (defaults are not frozen in)', () => {
    expect(initialConfigDocument()).toEqual({});
  });
});

describe('ui prefs', () => {
  it('accepts the two known prefs and rejects anything else', () => {
    expect(parseUiPrefsPatch({ activeStreamsViewType: 'map' })).toEqual({
      value: { activeStreamsViewType: 'map' },
    });
    expect(parseUiPrefsPatch({ activeStreamsViewType: 'grid' })).toHaveProperty('error');
    expect(parseUiPrefsPatch({ theme: 'dark' })).toHaveProperty('error');
    expect(parseUiPrefsPatch({})).toHaveProperty('error');
  });

  it('rejects an out-of-range elevation instead of silently clamping it', () => {
    expect(parseUiPrefsPatch({ imuView: { azimuthDeg: -90, elevationDeg: 24 } })).toEqual({
      value: { imuView: { azimuthDeg: -90, elevationDeg: 24 } },
    });
    const r = parseUiPrefsPatch({ imuView: { azimuthDeg: 0, elevationDeg: 90 } });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('imuView.elevationDeg');
  });

  it('null resets a pref', () => {
    expect(parseUiPrefsPatch({ imuView: null })).toEqual({ value: { imuView: null } });
  });
});

describe('retained config message', () => {
  it('is byte-compatible v1 plus rev', () => {
    const doc = {
      gnssAntBias: true,
      imuMount: { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 90 },
      recording: { telemetry: { enabled: false } },
      lteRecovery: { deadZoneProfile: 'balanced' as const },
      timeSync: { offlineSources: true },
    };
    const msg = buildDeviceConfigMessage(doc, 42, 1_700_000_000_000);
    expect(msg).toEqual({ v: 1, rev: 42, ...doc, ts: 1_700_000_000_000 });
    // Key order matters only for readable journal diffs on the device, but it
    // is cheap to keep stable.
    expect(Object.keys(msg)).toEqual([
      'v',
      'rev',
      'gnssAntBias',
      'imuMount',
      'recording',
      'lteRecovery',
      'timeSync',
      'ts',
    ]);
  });

  it('always carries gnssAntBias, even for an empty document', () => {
    // It has been present on this topic since day one and the modem daemon
    // reads it unconditionally — omitting it would be the one non-additive
    // change in an otherwise byte-compatible message.
    const msg = buildDeviceConfigMessage({}, 1, 1_700_000_000_000);
    expect(msg).toEqual({ v: 1, rev: 1, gnssAntBias: false, ts: 1_700_000_000_000 });
  });

  it('omits namespaces the document does not carry', () => {
    const msg = buildDeviceConfigMessage({ timeSync: { offlineSources: false } }, 7);
    expect(msg.recording).toBeUndefined();
    expect(msg.imuMount).toBeUndefined();
    expect(msg.lteRecovery).toBeUndefined();
    expect(msg.timeSync).toEqual({ offlineSources: false });
  });

  it('carries uploadBucket from the environment when set', () => {
    const prev = process.env.BUCKET_NAME;
    process.env.BUCKET_NAME = 'xorgate-dev-bucket';
    try {
      expect(buildDeviceConfigMessage({}, 1).uploadBucket).toBe('xorgate-dev-bucket');
    } finally {
      if (prev === undefined) delete process.env.BUCKET_NAME;
      else process.env.BUCKET_NAME = prev;
    }
  });
});

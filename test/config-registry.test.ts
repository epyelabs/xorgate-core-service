import { describe, expect, it } from 'vitest';
import {
  applyConfigPatch,
  CONFIG_NAMESPACE_KEYS,
  initialConfigDocument,
  parseUiPrefsPatch,
  publicConfigDocument,
  validateConfigPatch,
  validateNamespaceValue,
} from '../src/config-registry/index';
import { legacyConfigColumns } from '../src/config-registry/legacy-columns';
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

  // settings_sync_hardening finding 2. `null` used to DELETE the key, which
  // made "the operator reverted this" and "never configured" the same stored
  // state — and since the publisher omits what it does not have, the device
  // never heard about the revert.
  it('null stores a cleared marker (revert to device defaults)', () => {
    const doc = { gnssAntBias: true, timeSync: { offlineSources: false } };
    expect(applyConfigPatch(doc, { timeSync: null })).toEqual({
      gnssAntBias: true,
      timeSync: null,
    });
  });

  it('the marker survives a later patch to a different namespace', () => {
    // The publisher rebuilds the whole message every time, so a cleared
    // namespace has to stay cleared on the wire until someone sets a value.
    const cleared = applyConfigPatch({ timeSync: { offlineSources: false } }, { timeSync: null });
    const next = applyConfigPatch(cleared, { gnssAntBias: true });
    expect(next.timeSync).toBeNull();
    expect(buildDeviceConfigMessage(next, 3).timeSync).toEqual({});
  });

  it('setting a value again clears the marker', () => {
    const cleared = applyConfigPatch({ timeSync: { offlineSources: false } }, { timeSync: null });
    const next = applyConfigPatch(cleared, { timeSync: { offlineSources: true } });
    expect(next).toEqual({ timeSync: { offlineSources: true } });
  });

  it('hides the marker from every reader — cleared reads exactly like absent', () => {
    const cleared = publicConfigDocument({ gnssAntBias: true, timeSync: null });
    expect(cleared).toEqual({ gnssAntBias: true });
    expect('timeSync' in cleared).toBe(false);
  });

  it('maps a cleared namespace to the same legacy column value as an absent one', () => {
    expect(legacyConfigColumns({ imuMount: null, gnssAntBias: null })).toEqual(
      legacyConfigColumns({}),
    );
    expect(legacyConfigColumns({ recording: null, lteRecovery: null, timeSync: null })).toEqual(
      legacyConfigColumns({}),
    );
  });

  it('accepts the marker on read-back — the registry must not reject it', () => {
    for (const ns of CONFIG_NAMESPACE_KEYS) {
      expect(validateNamespaceValue(ns, null)).toEqual({ value: null });
    }
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

  // ---- cleared vs never-configured (settings_sync_hardening finding 2) ------
  //
  // ⚠️ This pair is the whole safety property of the phase. Emitting `{}` for a
  // namespace nobody configured would tell EVERY device in the fleet, on the
  // next publish, to wipe settings the cloud never managed.

  it('NEVER emits {} for a namespace that was never configured', () => {
    const msg = buildDeviceConfigMessage({}, 1, 1_700_000_000_000) as Record<string, unknown>;
    for (const ns of CONFIG_NAMESPACE_KEYS) {
      if (ns === 'gnssAntBias') continue; // always emitted, always a boolean
      expect(msg[ns]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(msg, ns)).toBe(false);
    }
    // Belt and braces: nothing anywhere in the payload is an empty object.
    expect(Object.values(msg).some((v) => v !== null && typeof v === 'object' &&
      !Array.isArray(v) && Object.keys(v as object).length === 0)).toBe(false);
  });

  it('emits {} for an explicitly cleared object namespace', () => {
    const msg = buildDeviceConfigMessage(
      { imuMount: null, recording: null, lteRecovery: null, timeSync: null },
      9,
      1_700_000_000_000,
    );
    // The device's tolerant parser reads an empty object as "drop your local
    // key and fall back to defaults" — see agent/cloud-config.ts.
    expect(msg).toEqual({
      v: 1,
      rev: 9,
      gnssAntBias: false,
      imuMount: {},
      recording: {},
      lteRecovery: {},
      timeSync: {},
      ts: 1_700_000_000_000,
    });
  });

  it('reverts a cleared scalar namespace to the registry default, not {}', () => {
    // gnssAntBias is a bare boolean on the wire; `{}` would just be an invalid
    // value the device drops. It is already seeded with the default, which IS
    // the revert — and is why nulling it has always worked.
    const msg = buildDeviceConfigMessage({ gnssAntBias: null }, 4, 1_700_000_000_000);
    expect(msg).toEqual({ v: 1, rev: 4, gnssAntBias: false, ts: 1_700_000_000_000 });
  });

  it('keeps cleared and configured namespaces apart in one document', () => {
    const msg = buildDeviceConfigMessage(
      { imuMount: null, timeSync: { offlineSources: false } },
      5,
      1_700_000_000_000,
    );
    expect(msg.imuMount).toEqual({});
    expect(msg.timeSync).toEqual({ offlineSources: false });
    expect(msg.recording).toBeUndefined();
    expect(msg.lteRecovery).toBeUndefined();
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

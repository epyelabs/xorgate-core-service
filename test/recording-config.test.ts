import { describe, expect, it } from 'vitest';
import { validateNamespaceValue, VIDEO_PRESET_NAMES } from '../src/config-registry/index';

// The `recording` namespace validator, labelled as the legacy PUT body field so
// the error-path assertions below still read the way an API client sees them
// (`PATCH /config` labels the same errors `recording.*`).
const parseRecordingConfigBody = (v: unknown) =>
  validateNamespaceValue('recording', v, 'recordingConfig');

describe('parseRecordingConfigBody', () => {
  it('accepts null (clears the column)', () => {
    expect(parseRecordingConfigBody(null)).toEqual({ value: null });
  });

  it('accepts the full README shape', () => {
    const full = {
      telemetry: { enabled: true, rateHz: 10 },
      video: { enabled: true, preset: '1080p15-2mbps', segmentSeconds: 60 },
      upload: { mode: 'auto' },
      retention: { maxBytes: 10737418240, minFreeBytes: 2147483648 },
    };
    expect(parseRecordingConfigBody(full)).toEqual({ value: full });
  });

  it('accepts a partial config (device merges over defaults)', () => {
    const partial = { video: { enabled: true } };
    expect(parseRecordingConfigBody(partial)).toEqual({ value: partial });
  });

  // Phase 2 rule (design.md §3): `{}` is NOT an erase — `null` is. Before, an
  // all-invalid namespace could reach the device as an empty object and wipe
  // its local state.
  it('rejects an empty namespace object (null is the erase)', () => {
    expect(parseRecordingConfigBody({})).toHaveProperty('error');
    expect(parseRecordingConfigBody(null)).toEqual({ value: null });
  });

  it('rejects unknown top-level keys', () => {
    const r = parseRecordingConfigBody({ vide0: { enabled: true } });
    expect(r).toHaveProperty('error');
  });

  it('rejects unknown nested keys', () => {
    const r = parseRecordingConfigBody({ video: { enabled: true, bitrate: 4000 } });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('recordingConfig.video');
  });

  it('rejects a preset outside the closed table', () => {
    const r = parseRecordingConfigBody({ video: { preset: '4k60-20mbps' } });
    expect(r).toHaveProperty('error');
  });

  it.each(VIDEO_PRESET_NAMES)('accepts preset %s', (preset) => {
    expect(parseRecordingConfigBody({ video: { preset } })).toEqual({
      value: { video: { preset } },
    });
  });

  it.each([0, 21, 2.5, -1])('rejects rateHz %p', (rateHz) => {
    expect(parseRecordingConfigBody({ telemetry: { rateHz } })).toHaveProperty('error');
  });

  it.each([1, 20])('accepts boundary rateHz %p', (rateHz) => {
    expect(parseRecordingConfigBody({ telemetry: { rateHz } })).toEqual({
      value: { telemetry: { rateHz } },
    });
  });

  it.each([9, 301, 59.5])('rejects segmentSeconds %p', (segmentSeconds) => {
    expect(parseRecordingConfigBody({ video: { segmentSeconds } })).toHaveProperty('error');
  });

  it('accepts the Phase 2 boot staging knobs (bounds included)', () => {
    const video = {
      bootDefer: 'always',
      bootDeferMaxSecs: 90,
      bootDeferMinBudgetMa: 5000,
      spawnStaggerSecs: 4,
    };
    expect(parseRecordingConfigBody({ video })).toEqual({ value: { video } });
    // 0 is meaningful: feature off / no stagger.
    expect(
      parseRecordingConfigBody({ video: { bootDeferMaxSecs: 0, spawnStaggerSecs: 0 } }),
    ).toEqual({ value: { video: { bootDeferMaxSecs: 0, spawnStaggerSecs: 0 } } });
  });

  it.each([
    { video: { bootDefer: 'sometimes' } },
    { video: { bootDeferMaxSecs: 601 } },
    { video: { bootDeferMaxSecs: -1 } },
    { video: { bootDeferMinBudgetMa: 10001 } },
    { video: { spawnStaggerSecs: 31 } },
    { video: { spawnStaggerSecs: 2.5 } },
  ])('rejects out-of-bounds boot staging value %j', (body) => {
    expect(parseRecordingConfigBody(body)).toHaveProperty('error');
  });

  it('accepts the Phase 7 GPS/LTE gate knobs', () => {
    const video = { gpsGate: 'always' as const, gpsGateMaxSecs: 900 };
    expect(parseRecordingConfigBody({ video })).toEqual({ value: { video } });
    // 0 is meaningful: no time cap at all (Q8) — the other release conditions
    // still bound the gate.
    expect(parseRecordingConfigBody({ video: { gpsGateMaxSecs: 0 } })).toEqual({
      value: { video: { gpsGateMaxSecs: 0 } },
    });
  });

  it.each([
    { video: { gpsGate: 'sometimes' } },
    { video: { gpsGateMaxSecs: 3601 } },
    { video: { gpsGateMaxSecs: -1 } },
    { video: { gpsGateMaxSecs: 60.5 } },
    { video: { gpsGateMinBudgetMa: 5000 } },
  ])('rejects out-of-bounds / unknown gate value %j', (body) => {
    expect(parseRecordingConfigBody(body)).toHaveProperty('error');
  });

  it('accepts the Phase 3 powerShedding knobs (bounds included)', () => {
    const powerShedding = {
      enabled: true,
      uvSamples: 3,
      uvWindowSecs: 30,
      railLowVolts: 4.85,
      railLowSecs: 15,
      escalateDwellSecs: 60,
      escalateDutyPct: 70,
      restoreSecs: 120,
      railRestoreVolts: 4.95,
      maxShedsPerHour: 4,
    };
    expect(parseRecordingConfigBody({ powerShedding })).toEqual({ value: { powerShedding } });
    // Voltages are non-integers by nature; 0 sheds-per-hour = park on first shed.
    expect(
      parseRecordingConfigBody({ powerShedding: { railLowVolts: 4.5, maxShedsPerHour: 0 } }),
    ).toEqual({ value: { powerShedding: { railLowVolts: 4.5, maxShedsPerHour: 0 } } });
  });

  it('accepts the thermal-arm knobs (power_management_improvements Phase 1)', () => {
    const powerShedding = { cpuTempC: 80, cpuTempRestoreC: 70, cpuTempSecs: 15 };
    expect(parseRecordingConfigBody({ powerShedding })).toEqual({ value: { powerShedding } });
    // Temperatures are non-integers by nature, like the rail voltages.
    expect(parseRecordingConfigBody({ powerShedding: { cpuTempC: 78.5 } })).toEqual({
      value: { powerShedding: { cpuTempC: 78.5 } },
    });
  });

  it.each([
    { powerShedding: { cpuTempC: 49 } },
    { powerShedding: { cpuTempC: 91 } },
    { powerShedding: { cpuTempRestoreC: 39 } },
    { powerShedding: { cpuTempRestoreC: 86 } },
    { powerShedding: { cpuTempSecs: 4 } },
    { powerShedding: { cpuTempSecs: 121 } },
    { powerShedding: { cpuTempSecs: 15.5 } },
    // Deliberately NOT built: rung 2 stays barred to thermal (D4 / PROGRESS Q8).
    { powerShedding: { cpuTempCriticalC: 95 } },
  ])('rejects out-of-bounds/unknown thermal value %j', (body) => {
    expect(parseRecordingConfigBody(body)).toHaveProperty('error');
  });

  it.each([
    { powerShedding: { uvSamples: 0 } },
    { powerShedding: { uvSamples: 61 } },
    { powerShedding: { uvWindowSecs: 4 } },
    { powerShedding: { railLowVolts: 3.9 } },
    { powerShedding: { railLowVolts: 5.3 } },
    { powerShedding: { railLowSecs: 121 } },
    { powerShedding: { escalateDwellSecs: 601 } },
    { powerShedding: { escalateDutyPct: 49 } },
    { powerShedding: { escalateDutyPct: 101 } },
    { powerShedding: { restoreSecs: 9 } },
    { powerShedding: { railRestoreVolts: 5.5 } },
    { powerShedding: { maxShedsPerHour: 61 } },
    { powerShedding: { uvSamples: 2.5 } },
    { powerShedding: { flapGuard: true } },
  ])('rejects out-of-bounds/unknown powerShedding value %j', (body) => {
    expect(parseRecordingConfigBody(body)).toHaveProperty('error');
  });

  it('accepts per-camera enables keyed by stream key (Phase 6)', () => {
    const cameras = { cam0: true, cam1: false };
    expect(parseRecordingConfigBody({ video: { cameras } })).toEqual({
      value: { video: { cameras } },
    });
    // An empty map is valid: it means "every detected camera" (the default).
    expect(parseRecordingConfigBody({ video: { cameras: {} } })).toEqual({
      value: { video: { cameras: {} } },
    });
  });

  it.each([
    { video: { cameras: { 'cam 0': true } } },
    { video: { cameras: { cam0: 'off' } } },
    { video: { cameras: [true] } },
    { video: { cameras: { cam0: true, cam1: true, cam2: true, cam3: true, cam4: true, cam5: true, cam6: true, cam7: true, cam8: true, cam9: true, cam10: true, cam11: true, cam12: true, cam13: true, cam14: true, cam15: true, cam16: true } } },
  ])('rejects malformed video.cameras %j', (body) => {
    expect(parseRecordingConfigBody(body)).toHaveProperty('error');
  });

  it('rejects out-of-bounds retention', () => {
    expect(
      parseRecordingConfigBody({ retention: { maxBytes: 1024 } }), // < 512 MiB
    ).toHaveProperty('error');
    expect(
      parseRecordingConfigBody({ retention: { minFreeBytes: -1 } }),
    ).toHaveProperty('error');
  });

  it.each(['on', 1, true])('rejects mistyped upload.mode %p', (mode) => {
    expect(parseRecordingConfigBody({ upload: { mode } })).toHaveProperty('error');
  });

  it('rejects non-object bodies', () => {
    expect(parseRecordingConfigBody('enabled')).toHaveProperty('error');
    expect(parseRecordingConfigBody(true)).toHaveProperty('error');
    expect(parseRecordingConfigBody([])).toHaveProperty('error');
  });

  it('reports a readable field path in the error', () => {
    const r = parseRecordingConfigBody({ telemetry: { rateHz: 99 } });
    expect((r as { error: string }).error).toMatch(/recordingConfig\.telemetry\.rateHz/);
  });
});

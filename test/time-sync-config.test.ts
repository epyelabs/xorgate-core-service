import { describe, expect, it } from 'vitest';
import { parseTimeSyncConfigBody } from '../src/schemas/time-sync-config';

describe('parseTimeSyncConfigBody', () => {
  it('accepts null (clears the column)', () => {
    expect(parseTimeSyncConfigBody(null)).toEqual({ value: null });
  });

  it('accepts the full shape', () => {
    const full = { offlineSources: false, stepThresholdSecs: 30, maxStepsPerBoot: 2 };
    expect(parseTimeSyncConfigBody(full)).toEqual({ value: full });
  });

  it('accepts a partial config (device defaults fill the rest)', () => {
    expect(parseTimeSyncConfigBody({ offlineSources: true })).toEqual({
      value: { offlineSources: true },
    });
    expect(parseTimeSyncConfigBody({})).toEqual({ value: {} });
  });

  it('rejects out-of-range values (reject posture — device clamps, cloud 400s)', () => {
    for (const bad of [
      { stepThresholdSecs: 1 },
      { stepThresholdSecs: 601 },
      { stepThresholdSecs: 10.5 },
      { maxStepsPerBoot: 0 },
      { maxStepsPerBoot: 21 },
    ]) {
      const r = parseTimeSyncConfigBody(bad);
      expect(r).toHaveProperty('error');
      expect((r as { error: string }).error).toContain('timeSyncConfig.');
    }
  });

  it('rejects unknown keys and mistyped values', () => {
    expect(parseTimeSyncConfigBody({ offlineSource: false })).toHaveProperty('error');
    expect(parseTimeSyncConfigBody({ offlineSources: 'off' })).toHaveProperty('error');
  });

  it('rejects non-object bodies', () => {
    expect(parseTimeSyncConfigBody('on')).toHaveProperty('error');
    expect(parseTimeSyncConfigBody(1)).toHaveProperty('error');
  });
});

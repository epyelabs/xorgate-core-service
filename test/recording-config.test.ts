import { describe, expect, it } from 'vitest';
import {
  parseRecordingConfigBody,
  VIDEO_PRESET_NAMES,
} from '../src/schemas/recording-config';

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

  it('accepts an empty object', () => {
    expect(parseRecordingConfigBody({})).toEqual({ value: {} });
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

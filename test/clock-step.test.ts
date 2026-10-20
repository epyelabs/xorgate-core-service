import { describe, expect, it } from 'vitest';
import {
  detectMediaClockStep,
  detectTelemetryClockSteps,
  isStaleStraggler,
  nominalSegmentMs,
  telemetryShiftOffsets,
  totalTelemetryShiftMs,
} from '../src/services/clock-step';

const MIN = 10_000;

describe('nominalSegmentMs', () => {
  it('reads the device recording config, else the registry default (60 s)', () => {
    expect(nominalSegmentMs({ video: { segmentSeconds: 30 } })).toBe(30_000);
    expect(nominalSegmentMs({ video: {} })).toBe(60_000);
    expect(nominalSegmentMs(null)).toBe(60_000);
    expect(nominalSegmentMs({ video: { segmentSeconds: 0 } })).toBe(60_000);
  });
});

describe('detectMediaClockStep', () => {
  it('leaves normal segments alone (real durations drift a few seconds, never 10 s)', () => {
    expect(detectMediaClockStep({ durationMs: 59_981, finalized: true }, 60_000, MIN)).toBeNull();
    expect(detectMediaClockStep({ durationMs: 67_729, finalized: true }, 60_000, MIN)).toBeNull();
    expect(detectMediaClockStep({ durationMs: 70_000, finalized: true }, 60_000, MIN)).toBeNull();
    expect(detectMediaClockStep({ durationMs: 41_983, finalized: false }, 60_000, MIN)).toBeNull();
  });

  it('Tacloban 04 seq 1: 4 012 833 ms → a 3 952 833 ms step, duration clamped to nominal', () => {
    expect(detectMediaClockStep({ durationMs: 4_012_833, finalized: true }, 60_000, MIN)).toEqual({
      stepMs: 3_952_833,
      durationMs: 60_000,
      rawDurationMs: 4_012_833,
      clampedOnly: false,
    });
  });

  it('a crash-cut inflated segment is clamped only (D5)', () => {
    expect(detectMediaClockStep({ durationMs: 4_012_833, finalized: false }, 60_000, MIN)).toEqual({
      stepMs: 0,
      durationMs: 60_000,
      rawDurationMs: 4_012_833,
      clampedOnly: true,
    });
  });

  it('disabled thresholds detect nothing', () => {
    expect(detectMediaClockStep({ durationMs: 4_012_833, finalized: true }, 60_000, 0)).toBeNull();
    expect(detectMediaClockStep({ durationMs: 4_012_833, finalized: true }, 0, MIN)).toBeNull();
  });
});

describe('detectTelemetryClockSteps', () => {
  const sec = (i: number) => i * 1_000_000_000; // mono ns
  const base = 1_792_227_000_000;

  it('a steady 1 Hz series has no step', () => {
    const s = Array.from({ length: 5 }, (_, i) => ({ ts: base + i * 1000, mono: sec(i) }));
    expect(detectTelemetryClockSteps(s, MIN)).toEqual([]);
  });

  it('finds a forward step between samples 2 and 3 (Δts 66 min, Δmono 1 s)', () => {
    const step = 65 * 60_000;
    const s = [
      { ts: base, mono: sec(0) },
      { ts: base + 1000, mono: sec(1) },
      { ts: base + 2000, mono: sec(2) },
      { ts: base + 3000 + step, mono: sec(3) },
      { ts: base + 4000 + step, mono: sec(4) },
    ];
    expect(detectTelemetryClockSteps(s, MIN)).toEqual([{ atIndex: 3, jumpMs: step }]);
    expect(telemetryShiftOffsets(s.length, [{ atIndex: 3, jumpMs: step }])).toEqual([step, step, step, 0, 0]);
    expect(totalTelemetryShiftMs([{ atIndex: 3, jumpMs: step }])).toBe(step);
  });

  it('a backward step is reported with a negative jump (D12)', () => {
    const s = [
      { ts: base + 50_000, mono: sec(0) },
      { ts: base + 1000, mono: sec(1) },
    ];
    expect(detectTelemetryClockSteps(s, MIN)).toEqual([{ atIndex: 1, jumpMs: -50_000 }]);
  });

  it('two steps accumulate on the earliest samples', () => {
    const steps = [
      { atIndex: 1, jumpMs: 20_000 },
      { atIndex: 3, jumpMs: 15_000 },
    ];
    expect(telemetryShiftOffsets(4, steps)).toEqual([35_000, 15_000, 15_000, 0]);
    expect(totalTelemetryShiftMs(steps)).toBe(35_000);
  });

  it('samples without mono break the chain; a mono reset (new boot) is not a step', () => {
    const s = [
      { ts: base, mono: sec(0) },
      { ts: base + 1000 },
      { ts: base + 100_000, mono: sec(2) },
      { ts: base + 101_000, mono: sec(0) },
    ];
    expect(detectTelemetryClockSteps(s, MIN)).toEqual([]);
  });

  it('jitter below the threshold is ignored', () => {
    const s = [
      { ts: base, mono: sec(0) },
      { ts: base + 1000 + 9_999, mono: sec(1) },
    ];
    expect(detectTelemetryClockSteps(s, MIN)).toEqual([]);
  });
});

describe('isStaleStraggler', () => {
  const session = { clockCorrectionMs: 3_952_833, clockStaleBefore: new Date(1_792_227_910_471) };
  it('a raw stamp below clock_stale_before on a corrected session is stale', () => {
    expect(isStaleStraggler(1_792_227_850_471, session)).toBe(true);
    expect(isStaleStraggler(1_792_227_910_471, session)).toBe(false);
    expect(isStaleStraggler(1_792_227_850_471, { clockCorrectionMs: null, clockStaleBefore: null })).toBe(false);
  });
});

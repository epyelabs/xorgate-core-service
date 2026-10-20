import { RECORDING_DEFAULTS } from '../config-registry/recording';

/**
 * Clock-step correction, the pure half (plans/clock-step-correction/PLAN.md).
 *
 * A battery-less CM5 boots on the fake-hwclock restore stamp ("the last
 * power-off time") and NTP / GPS / NITZ steps the clock forward one to two
 * minutes into the boot. Everything the device stamped before the step is
 * late by exactly the step:
 *  - the video fragment open during the step reports
 *    `durationMs = mtime − birthtime = step + nominal` (D3/D4);
 *  - telemetry sample lines carry a monotonic `mono` (hrtime ns) beside `ts`,
 *    so between two consecutive samples `Δts − Δmono` IS the step (D6).
 * This module only decides and computes; handlers/media-segment-ingest.ts,
 * handlers/telemetry-batch-ingest.ts and the backfill script do the I/O.
 * Free of AWS/DB imports so it unit-tests directly (test/clock-step.test.ts).
 */

/** `devices.recording_config` as the schema types it (only the part read here). */
export interface RecordingConfigLike {
  video?: { segmentSeconds?: number | null } | null;
}

/** Nominal video segment length in ms for a device: its configured `segmentSeconds`, else the registry default. */
export function nominalSegmentMs(recordingConfig: RecordingConfigLike | null | undefined): number {
  const secs = recordingConfig?.video?.segmentSeconds;
  const n = typeof secs === 'number' && Number.isFinite(secs) && secs > 0 ? secs : RECORDING_DEFAULTS.video.segmentSeconds;
  return Math.round(n * 1000);
}

export interface MediaClockStep {
  /**
   * Forward shift to apply to this segment and every segment stamped before
   * it; 0 for a crash-cut segment, which is only clamped (D5: its real length
   * is unknown, so the step is only a lower bound).
   */
  stepMs: number;
  /** The duration to store instead of the sidecar's (= nominal). */
  durationMs: number;
  /** The sidecar's own values, kept in `meta.clockStep` for audit. */
  rawDurationMs: number;
  clampedOnly: boolean;
}

/**
 * D3/D4/D5: a finalized segment longer than `nominalMs + minStepMs` was open
 * across a clock step of `rawDurationMs − nominalMs`. A crash-cut one is
 * clamped without a shift. Anything else is left alone (null).
 */
export function detectMediaClockStep(
  segment: { durationMs: number; finalized: boolean },
  nominalMs: number,
  minStepMs: number,
): MediaClockStep | null {
  if (!(nominalMs > 0) || !(minStepMs > 0)) return null;
  if (segment.durationMs <= nominalMs + minStepMs) return null;
  const stepMs = segment.durationMs - nominalMs;
  if (!segment.finalized) {
    return { stepMs: 0, durationMs: nominalMs, rawDurationMs: segment.durationMs, clampedOnly: true };
  }
  return { stepMs, durationMs: nominalMs, rawDurationMs: segment.durationMs, clampedOnly: false };
}

/** A parsed telemetry sample line, as far as step detection needs it. */
export interface TelemetrySampleLike {
  ts: number;
  /** `process.hrtime.bigint()` as a number (ns); absent on hand-made files. */
  mono?: number | null;
}

export interface TelemetryClockStep {
  /** Index (into the input array) of the FIRST sample stamped after the step. */
  atIndex: number;
  /** `Δts − Δmono`, ms; positive = clock stepped forward (stale samples before it). */
  jumpMs: number;
}

/**
 * D6: walk consecutive samples that both carry `mono`; a wall-clock delta that
 * disagrees with the monotonic delta by at least `minStepMs` (either sign,
 * D12) is a step at the later sample. Samples without `mono` break the chain
 * (no detection across them) rather than guess.
 */
export function detectTelemetryClockSteps(samples: readonly TelemetrySampleLike[], minStepMs: number): TelemetryClockStep[] {
  const steps: TelemetryClockStep[] = [];
  if (!(minStepMs > 0)) return steps;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!isFiniteNumber(prev.mono) || !isFiniteNumber(cur.mono)) continue;
    const monoDeltaMs = (cur.mono - prev.mono) / 1e6;
    if (monoDeltaMs < 0) continue; // a new boot's mono frame: not a clock step
    const jumpMs = Math.round(cur.ts - prev.ts - monoDeltaMs);
    if (Math.abs(jumpMs) >= minStepMs) steps.push({ atIndex: i, jumpMs });
  }
  return steps;
}

/**
 * The per-sample forward shift that makes the series monotonic with `mono`:
 * every sample BEFORE a step gets that step's jump added (cumulative when
 * several steps occurred). Returns one offset per input sample (0 for samples
 * after the last step), so callers can re-stamp rows and re-serialise lines.
 */
export function telemetryShiftOffsets(sampleCount: number, steps: readonly TelemetryClockStep[]): number[] {
  const offsets = new Array<number>(sampleCount).fill(0);
  for (const step of steps) {
    for (let i = 0; i < Math.min(step.atIndex, sampleCount); i++) offsets[i] += step.jumpMs;
  }
  return offsets;
}

/** Total forward shift of the earliest samples = what EARLIER files of the same session need (D7). */
export function totalTelemetryShiftMs(steps: readonly TelemetryClockStep[]): number {
  return steps.reduce((sum, s) => sum + s.jumpMs, 0);
}

/** D10: a raw (pre-shift) stamp below `clockStaleBefore` on a corrected session is still stale. */
export function isStaleStraggler(
  rawStartMs: number,
  session: { clockCorrectionMs: number | null; clockStaleBefore: Date | null },
): boolean {
  return (
    session.clockCorrectionMs !== null &&
    session.clockCorrectionMs > 0 &&
    session.clockStaleBefore !== null &&
    rawStartMs < session.clockStaleBefore.getTime()
  );
}

export function shiftTs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

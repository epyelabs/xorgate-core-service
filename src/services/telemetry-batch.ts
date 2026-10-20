import { z } from 'zod';
import type { NewTelemetryReading } from '../db/schema';
import { detectTelemetryClockSteps, telemetryShiftOffsets, type TelemetryClockStep } from './clock-step';

/**
 * Pure parsing/validation for batch telemetry ingest (offline recording plan,
 * Phase 2): S3 key → identifiers, and gunzipped JSONL segment → rows for
 * `telemetry_readings`. Kept free of AWS/DB imports so it unit-tests directly;
 * the Lambda in handlers/telemetry-batch-ingest.ts does the I/O.
 */

/** S3 key contract: telemetry/v1/<deviceId>/<sessionId>/<startTsMs>-<seq>.jsonl.gz */
const KEY_RE =
  /^telemetry\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{1,16})-(\d{1,10})\.jsonl\.gz$/;

export interface TelemetryObjectKey {
  deviceId: string;
  sessionId: string;
  startTsMs: number;
  seq: number;
}

/**
 * Artifacts WE write under a session's prefix (telemetry-session-artifacts
 * plan): `overview.v<n>.json.gz`, and any future sibling. Their Object Created
 * events reach the ingest rule (prefix match) and must be ignored quietly.
 */
const ARTIFACT_RE =
  /^telemetry\/v1\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[a-z][a-z0-9-]*\.v\d+\.[a-z0-9.]+$/;

export const isTelemetryArtifactKey = (key: string): boolean => ARTIFACT_RE.test(key);

export function parseTelemetryObjectKey(key: string): TelemetryObjectKey | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return {
    deviceId: m[1],
    sessionId: m[2],
    startTsMs: Number(m[3]),
    seq: Number(m[4]),
  };
}

// Segment line shapes (device src/recording/segments.ts). Loose by design:
// unknown extra fields are ignored, and a malformed line skips that line, not
// the file.
const numericLeaf = z.object({ value: z.number(), unit: z.string().optional() });
const sampleLine = z.object({
  ts: z.number().int().nonnegative(),
  // process.hrtime.bigint() as a number (ns): the clock-step detector's
  // monotonic reference (plans/clock-step-correction D6). Absent on hand-made files.
  mono: z.number().optional(),
  seq: z.number().int().nonnegative().optional(),
  metrics: z.record(z.record(numericLeaf)),
});
const headerLine = z.object({
  type: z.literal('header'),
  deviceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  // Optional on purpose: identity is what the ingest path needs; the rest is
  // provenance for the session index (Phase 1) and is absent on a hand-made file.
  bootId: z.string().optional(),
  timeSource: z.string().optional(),
  rateHz: z.number().positive().optional(),
  startedAt: z.number().int().nonnegative().optional(),
});

export type SegmentSampleLine = z.infer<typeof sampleLine>;
export type SegmentHeaderLine = z.infer<typeof headerLine>;

/**
 * `raw` is the line's exact text and `lineNo` its index in `text.split('\n')`,
 * so a corrected file can be re-serialised line for line (clock-step
 * correction: only a shifted sample's `ts` changes, see rebuildSegmentText).
 */
export type SegmentLine =
  | { kind: 'header'; header: SegmentHeaderLine; raw: string; lineNo: number }
  | { kind: 'sample'; sample: SegmentSampleLine; raw: string; lineNo: number }
  | { kind: 'invalid' };

/**
 * The segment line grammar, shared by the ingest parser below and the overview
 * builder (services/telemetry-overview.ts): one JSONL line in, one classified
 * line out. Malformed JSON or a line failing validation is `invalid` and skips
 * that line, never the file. Empty lines are not yielded.
 */
export function* iterateSegmentLines(text: string): Generator<SegmentLine> {
  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    if (raw.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      yield { kind: 'invalid' };
      continue;
    }
    if (typeof obj === 'object' && obj !== null && (obj as { type?: unknown }).type === 'header') {
      const header = headerLine.safeParse(obj);
      yield header.success ? { kind: 'header', header: header.data, raw, lineNo } : { kind: 'invalid' };
      continue;
    }
    const sample = sampleLine.safeParse(obj);
    yield sample.success ? { kind: 'sample', sample: sample.data, raw, lineNo } : { kind: 'invalid' };
  }
}

/**
 * Replace the TOP-LEVEL `ts` number of one sample line, leaving every other
 * byte as the device wrote it (clock-step correction, PLAN §4.3.1). A small
 * scanner finds the `"ts":` key at depth 1 (so a metric leaf that happens to
 * carry a `ts` is never touched) and swaps the number token. Anything
 * unexpected (escaped key, non-numeric value, a scan that does not round-trip)
 * falls back to re-serialising the parsed object with `ts` replaced in place,
 * which keeps the key order.
 */
export function replaceSampleTs(raw: string, ts: number): string {
  const targeted = replaceTopLevelTsToken(raw, ts);
  if (targeted !== null) {
    try {
      if ((JSON.parse(targeted) as { ts?: unknown }).ts === ts) return targeted;
    } catch {
      // fall through to the re-serialisation
    }
  }
  const obj = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...obj, ts });
}

const NUMBER_TOKEN_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function replaceTopLevelTsToken(raw: string, ts: number): string | null {
  let depth = 0;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c === '"') {
      const start = i + 1;
      i++;
      while (i < n && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
      const end = i;
      i++;
      if (depth !== 1) continue;
      let j = i;
      while (j < n && (raw[j] === ' ' || raw[j] === '\t')) j++;
      if (raw[j] !== ':') continue;
      if (raw.slice(start, end) !== 'ts') continue;
      j++;
      while (j < n && (raw[j] === ' ' || raw[j] === '\t')) j++;
      const m = NUMBER_TOKEN_RE.exec(raw.slice(j));
      if (!m) return null;
      return raw.slice(0, j) + String(ts) + raw.slice(j + m[0].length);
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return null;
}

/** `text` with the given lines (by `lineNo`) replaced; every other byte, separators included, unchanged. */
export function rebuildSegmentText(text: string, replacements: ReadonlyMap<number, string>): string {
  if (replacements.size === 0) return text;
  const lines = text.split('\n');
  for (const [lineNo, line] of replacements) lines[lineNo] = line;
  return lines.join('\n');
}

export interface ShiftedSegmentText {
  /** The file with every sample line's `ts` moved by `shiftMs` (headers and other lines byte-identical). */
  text: string;
  /** Min / max sample ts AFTER the shift; null when the file has no valid sample. */
  firstTs: number | null;
  lastTs: number | null;
  /** The ts values BEFORE the shift, in file order (what `telemetry_readings` holds for this file). */
  staleTs: number[];
  sampleLines: number;
}

/**
 * Whole-file shift (clock-step correction D7/D10): every valid sample line of
 * a file stamped entirely before a step (an earlier file of the session, or a
 * late straggler) moves by `shiftMs`. Pure; the I/O is in
 * services/telemetry-clock-step.ts.
 */
export function shiftSegmentText(text: string, shiftMs: number): ShiftedSegmentText {
  const replacements = new Map<number, string>();
  const staleTs: number[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const line of iterateSegmentLines(text)) {
    if (line.kind !== 'sample') continue;
    const raw = line.sample.ts;
    const ts = raw + shiftMs;
    staleTs.push(raw);
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
    if (shiftMs !== 0) replacements.set(line.lineNo, replaceSampleTs(line.raw, ts));
  }
  return { text: rebuildSegmentText(text, replacements), firstTs, lastTs, staleTs, sampleLines: staleTs.length };
}

/**
 * Clock-quality ranking, worst first: unsynced < rtc < nitz < gps < ntp. Same
 * ladder as media sidecars (services/media-segments.ts timeSourceRank); an
 * unknown label ranks below everything so it is what "worst" resolves to.
 */
const TIME_SOURCE_RANK: Record<string, number> = { unsynced: 0, rtc: 1, nitz: 2, gps: 3, ntp: 4 };

/** The worse of two time-source labels; `null`/`undefined` means "no information". */
export function worstTimeSource(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return (TIME_SOURCE_RANK[a] ?? -1) <= (TIME_SOURCE_RANK[b] ?? -1) ? a : b;
}

export interface ParseSegmentOptions {
  /** deviceId from the S3 key — the trustworthy identity (IAM-scoped upload). */
  deviceId: string;
  /** Ingest wall-clock (epoch ms). */
  now: number;
  /**
   * Accepted sample age window. `telemetry_readings` has pre-created monthly
   * RANGE(ts) partitions; a row outside the range fails the whole insert, so
   * out-of-window lines are skipped (counted) instead of inserted.
   */
  maxAgeMs: number;
  maxFutureMs: number;
  /**
   * Clock-step detection threshold (plans/clock-step-correction D6,
   * `recordingConfig.clockStepMinMs`). When > 0, a sample whose wall-clock
   * delta disagrees with its `mono` delta by at least this much is a step,
   * and every sample before it is re-stamped (rows, bounds and
   * `correctedText`). Absent or 0: no detection, output exactly as before.
   */
  clockStepMinMs?: number;
}

/** Provenance lifted from the segment's header line(s) for the session index. */
export interface SegmentHeaderInfo {
  rateHz: number | null;
  /** WORST time source seen across every header in the file (a mid-file re-emission can downgrade). */
  timeSource: string | null;
  startedAt: number | null;
  bootId: string | null;
}

/** Raw (device-stamped) ts values that a correction moved, grouped by the shift they got. */
export interface StaleTsGroup {
  shiftMs: number;
  ts: number[];
}

/** What clock-step detection found in one file; all-empty when nothing was found (or detection is off). */
export interface SegmentClockStepInfo {
  /** Steps found in the file (`atIndex` counts the file's valid sample lines, in file order). */
  clockSteps: TelemetryClockStep[];
  /** Min / max sample ts AS THE DEVICE WROTE THEM (pre-correction); null when there are none. */
  rawFirstTs: number | null;
  rawLastTs: number | null;
  /** Raw ts of every moved sample, file order (flat view of staleTsGroups). */
  staleTs: number[];
  staleTsGroups: StaleTsGroup[];
  /**
   * Raw ts of the first sample stamped after the (first) step: below it a
   * late file of this session is still stale (D10, `clock_stale_before`).
   */
  staleBefore: number | null;
  /**
   * The corrected JSONL (gzip-ready) when a step moved anything: only the
   * `ts` of the shifted sample lines differs from the input; every other
   * byte (headers, other samples, invalid lines, separators) is identical.
   */
  correctedText?: string;
}

export interface ParsedSegment extends SegmentClockStepInfo {
  rows: NewTelemetryReading[];
  /** Sample lines that produced rows (inside the partition-age window). */
  samples: number;
  /**
   * Every VALID sample line, age window or not. This is what the session index
   * records: a 91-day-old segment is still part of its session even though
   * none of its rows are insertable.
   */
  sampleLines: number;
  /** Lines dropped: malformed JSON / failed validation. */
  skippedInvalid: number;
  /** Sample lines dropped by the partition-age window. */
  skippedAge: number;
  /** Header deviceId contradicted the S3 key (whole file rejected upstream). */
  deviceIdMismatch: boolean;
  /** First header's provenance (time source worst-of across all headers); null when the file has none. */
  header: SegmentHeaderInfo | null;
  /**
   * Min / max `ts` over every valid sample line (age window or not), AFTER
   * any clock-step correction; null when there are none.
   */
  firstTs: number | null;
  lastTs: number | null;
}

export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 d — inside pre-created partitions
export const DEFAULT_MAX_FUTURE_MS = 45 * 24 * 60 * 60 * 1000; // partitions exist ~2 months ahead

interface ScannedSample {
  sample: SegmentSampleLine;
  raw: string;
  lineNo: number;
}

interface ScannedSegment {
  header: SegmentHeaderInfo | null;
  headerDeviceIds: string[];
  samples: ScannedSample[];
  invalidLines: number;
}

/** One pass over the line grammar: header provenance, valid samples in file order, invalid count. */
function scanSegment(text: string): ScannedSegment {
  const out: ScannedSegment = { header: null, headerDeviceIds: [], samples: [], invalidLines: 0 };
  for (const line of iterateSegmentLines(text)) {
    if (line.kind === 'invalid') {
      out.invalidLines++;
    } else if (line.kind === 'header') {
      const { header } = line;
      out.headerDeviceIds.push(header.deviceId);
      if (out.header === null) {
        out.header = {
          rateHz: header.rateHz ?? null,
          timeSource: header.timeSource ?? null,
          startedAt: header.startedAt ?? null,
          bootId: header.bootId ?? null,
        };
      } else {
        // Mid-file re-emissions exist to record a clock change; keep the worst.
        out.header.timeSource = worstTimeSource(out.header.timeSource, header.timeSource);
      }
    } else {
      out.samples.push({ sample: line.sample, raw: line.raw, lineNo: line.lineNo });
    }
  }
  return out;
}

/**
 * D6/D7 on a scanned file: detect steps over the valid samples (file order),
 * compute each sample's corrected ts and, when anything moved, the corrected
 * text plus the raw ts that moved. Pure.
 */
function correctScannedSamples(
  text: string,
  samples: readonly ScannedSample[],
  clockStepMinMs: number | undefined,
): { correctedTs: number[]; info: SegmentClockStepInfo } {
  const rawTs = samples.map((s) => s.sample.ts);
  const info: SegmentClockStepInfo = {
    clockSteps: [],
    rawFirstTs: minOf(rawTs),
    rawLastTs: maxOf(rawTs),
    staleTs: [],
    staleTsGroups: [],
    staleBefore: null,
  };
  if (!(clockStepMinMs !== undefined && clockStepMinMs > 0) || samples.length < 2) {
    return { correctedTs: rawTs, info };
  }
  const steps = detectTelemetryClockSteps(
    samples.map((s) => ({ ts: s.sample.ts, mono: s.sample.mono })),
    clockStepMinMs,
  );
  if (steps.length === 0) return { correctedTs: rawTs, info };

  const offsets = telemetryShiftOffsets(samples.length, steps);
  const correctedTs = rawTs.map((ts, i) => ts + offsets[i]);
  const replacements = new Map<number, string>();
  const groups = new Map<number, number[]>();
  for (let i = 0; i < samples.length; i++) {
    if (offsets[i] === 0) continue;
    replacements.set(samples[i].lineNo, replaceSampleTs(samples[i].raw, correctedTs[i]));
    info.staleTs.push(rawTs[i]);
    const group = groups.get(offsets[i]);
    if (group) group.push(rawTs[i]);
    else groups.set(offsets[i], [rawTs[i]]);
  }
  info.clockSteps = steps;
  info.staleTsGroups = [...groups].map(([shiftMs, ts]) => ({ shiftMs, ts }));
  info.staleBefore = rawTs[steps[0].atIndex];
  if (replacements.size > 0) info.correctedText = rebuildSegmentText(text, replacements);
  return { correctedTs, info };
}

/**
 * Parse one gunzipped JSONL segment into telemetry rows using the same
 * `<group>.<field>` metric-naming contract as the live path. Headers (initial +
 * mid-file timeSource re-emissions) are validated for identity and skipped.
 * With `clockStepMinMs`, rows and bounds carry the corrected ts (D6/D7) and
 * the partition-age window applies to the corrected ts (what is inserted).
 */
export function parseSegment(text: string, opts: ParseSegmentOptions): ParsedSegment {
  const scanned = scanSegment(text);
  const { correctedTs, info } = correctScannedSamples(text, scanned.samples, opts.clockStepMinMs);
  const out: ParsedSegment = {
    rows: [],
    samples: 0,
    sampleLines: scanned.samples.length,
    skippedInvalid: scanned.invalidLines,
    skippedAge: 0,
    deviceIdMismatch: scanned.headerDeviceIds.some((id) => id !== opts.deviceId),
    header: scanned.header,
    firstTs: minOf(correctedTs),
    lastTs: maxOf(correctedTs),
    ...info,
  };

  for (let i = 0; i < scanned.samples.length; i++) {
    const ts = correctedTs[i];
    if (ts < opts.now - opts.maxAgeMs || ts > opts.now + opts.maxFutureMs) {
      out.skippedAge++;
      continue;
    }
    const tsDate = new Date(ts);
    for (const [group, fields] of Object.entries(scanned.samples[i].sample.metrics)) {
      for (const [field, leaf] of Object.entries(fields)) {
        out.rows.push({
          deviceId: opts.deviceId,
          ts: tsDate,
          metric: `${group}.${field}`,
          value: leaf.value,
          unit: leaf.unit ?? null,
        });
      }
    }
    out.samples++;
  }

  return out;
}

function minOf(values: readonly number[]): number | null {
  let m: number | null = null;
  for (const v of values) if (m === null || v < m) m = v;
  return m;
}

function maxOf(values: readonly number[]): number | null {
  let m: number | null = null;
  for (const v of values) if (m === null || v > m) m = v;
  return m;
}

/**
 * A sample cannot postdate its own upload by more than this. Beyond it the
 * device clock is garbage (dev has two sessions whose second segment is
 * stamped 2080 by an RTC that jumped), and the object's ARRIVAL time is the
 * honest estimate of when it was recorded. A day of slack covers any real
 * skew an `rtc` boot shows (minutes, on the dev fleet) without touching it.
 */
export const INDEX_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** Sample ts for the session index: itself when plausible, else the arrival time (telemetry-session-artifacts P2). */
export function plausibleSampleTs(ts: number, arrivedAtMs: number, slackMs = INDEX_FUTURE_SLACK_MS): number {
  return ts > arrivedAtMs + slackMs ? arrivedAtMs : ts;
}

/** What the session index needs from a segment file, without building any rows. */
export interface SegmentSummary extends SegmentClockStepInfo {
  header: SegmentHeaderInfo | null;
  sampleLines: number;
  invalidLines: number;
  /** Bounds AFTER any clock-step correction (`rawFirstTs` / `rawLastTs` keep the device's). */
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Header + first/last ts + counts for one gunzipped segment (the backfill and
 * any re-index path). Same grammar as parseSegment, no partition-age window,
 * no rows. `clockStepMinMs` (> 0) runs the same detection and reports the
 * corrected bounds, the steps and `correctedText` (clock-step backfill, P3).
 */
export function summarizeSegment(text: string, opts: { clockStepMinMs?: number } = {}): SegmentSummary {
  const scanned = scanSegment(text);
  const { correctedTs, info } = correctScannedSamples(text, scanned.samples, opts.clockStepMinMs);
  return {
    header: scanned.header,
    sampleLines: scanned.samples.length,
    invalidLines: scanned.invalidLines,
    firstTs: minOf(correctedTs),
    lastTs: maxOf(correctedTs),
    ...info,
  };
}

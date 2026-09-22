import { z } from 'zod';
import type { NewTelemetryReading } from '../db/schema';

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

export type SegmentLine =
  | { kind: 'header'; header: SegmentHeaderLine }
  | { kind: 'sample'; sample: SegmentSampleLine }
  | { kind: 'invalid' };

/**
 * The segment line grammar, shared by the ingest parser below and the overview
 * builder (services/telemetry-overview.ts): one JSONL line in, one classified
 * line out. Malformed JSON or a line failing validation is `invalid` and skips
 * that line, never the file. Empty lines are not yielded.
 */
export function* iterateSegmentLines(text: string): Generator<SegmentLine> {
  for (const raw of text.split('\n')) {
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
      yield header.success ? { kind: 'header', header: header.data } : { kind: 'invalid' };
      continue;
    }
    const sample = sampleLine.safeParse(obj);
    yield sample.success ? { kind: 'sample', sample: sample.data } : { kind: 'invalid' };
  }
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
}

/** Provenance lifted from the segment's header line(s) for the session index. */
export interface SegmentHeaderInfo {
  rateHz: number | null;
  /** WORST time source seen across every header in the file (a mid-file re-emission can downgrade). */
  timeSource: string | null;
  startedAt: number | null;
  bootId: string | null;
}

export interface ParsedSegment {
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
  /** Min / max `ts` over every valid sample line (age window or not); null when there are none. */
  firstTs: number | null;
  lastTs: number | null;
}

export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 d — inside pre-created partitions
export const DEFAULT_MAX_FUTURE_MS = 45 * 24 * 60 * 60 * 1000; // partitions exist ~2 months ahead

/**
 * Parse one gunzipped JSONL segment into telemetry rows using the same
 * `<group>.<field>` metric-naming contract as the live path. Headers (initial +
 * mid-file timeSource re-emissions) are validated for identity and skipped.
 */
export function parseSegment(text: string, opts: ParseSegmentOptions): ParsedSegment {
  const out: ParsedSegment = {
    rows: [],
    samples: 0,
    sampleLines: 0,
    skippedInvalid: 0,
    skippedAge: 0,
    deviceIdMismatch: false,
    header: null,
    firstTs: null,
    lastTs: null,
  };

  for (const line of iterateSegmentLines(text)) {
    if (line.kind === 'invalid') {
      out.skippedInvalid++;
      continue;
    }

    if (line.kind === 'header') {
      const { header } = line;
      if (header.deviceId !== opts.deviceId) out.deviceIdMismatch = true;
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
      continue;
    }

    const { ts, metrics } = line.sample;
    out.sampleLines++;
    if (out.firstTs === null || ts < out.firstTs) out.firstTs = ts;
    if (out.lastTs === null || ts > out.lastTs) out.lastTs = ts;
    if (ts < opts.now - opts.maxAgeMs || ts > opts.now + opts.maxFutureMs) {
      out.skippedAge++;
      continue;
    }

    const tsDate = new Date(ts);
    for (const [group, fields] of Object.entries(metrics)) {
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

/** What the session index needs from a segment file, without building any rows. */
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

export interface SegmentSummary {
  header: SegmentHeaderInfo | null;
  sampleLines: number;
  invalidLines: number;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Header + first/last ts + counts for one gunzipped segment (the backfill and
 * any re-index path). Same grammar as parseSegment, no partition-age window,
 * no rows.
 */
export function summarizeSegment(text: string): SegmentSummary {
  const out: SegmentSummary = { header: null, sampleLines: 0, invalidLines: 0, firstTs: null, lastTs: null };
  for (const line of iterateSegmentLines(text)) {
    if (line.kind === 'invalid') {
      out.invalidLines++;
    } else if (line.kind === 'header') {
      const { header } = line;
      if (out.header === null) {
        out.header = {
          rateHz: header.rateHz ?? null,
          timeSource: header.timeSource ?? null,
          startedAt: header.startedAt ?? null,
          bootId: header.bootId ?? null,
        };
      } else {
        out.header.timeSource = worstTimeSource(out.header.timeSource, header.timeSource);
      }
    } else {
      const { ts } = line.sample;
      out.sampleLines++;
      if (out.firstTs === null || ts < out.firstTs) out.firstTs = ts;
      if (out.lastTs === null || ts > out.lastTs) out.lastTs = ts;
    }
  }
  return out;
}

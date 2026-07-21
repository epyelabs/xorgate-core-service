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
});

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

export interface ParsedSegment {
  rows: NewTelemetryReading[];
  /** Sample lines that produced rows. */
  samples: number;
  /** Lines dropped: malformed JSON / failed validation. */
  skippedInvalid: number;
  /** Sample lines dropped by the partition-age window. */
  skippedAge: number;
  /** Header deviceId contradicted the S3 key (whole file rejected upstream). */
  deviceIdMismatch: boolean;
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
    skippedInvalid: 0,
    skippedAge: 0,
    deviceIdMismatch: false,
  };

  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      out.skippedInvalid++;
      continue;
    }

    if (typeof obj === 'object' && obj !== null && (obj as { type?: unknown }).type === 'header') {
      const header = headerLine.safeParse(obj);
      if (!header.success) {
        out.skippedInvalid++;
      } else if (header.data.deviceId !== opts.deviceId) {
        out.deviceIdMismatch = true;
      }
      continue;
    }

    const parsed = sampleLine.safeParse(obj);
    if (!parsed.success) {
      out.skippedInvalid++;
      continue;
    }
    const { ts, metrics } = parsed.data;
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

import { gzipSync } from 'node:zlib';
import { iterateSegmentLines, worstTimeSource } from './telemetry-batch';
import {
  createInsightRun,
  type InsightSample,
  type InsightsV1,
} from './telemetry-insights/index';
import { acceptedFix, round } from './telemetry-insights/gps-accept';

/**
 * The pure overview builder (telemetry-session-artifacts plan, README D2, D4,
 * D5, §4.1): a session's gunzipped segments in, one `overview.v1` object out.
 * Free of AWS/DB imports; services/telemetry-sessions.ts does the I/O.
 *
 * STREAMING by design. Segments are fed one at a time in `seq` order; each
 * line goes to a per-group bucket grid (sum + count per (bucket, metric), so
 * the average is sum/count at the end) and to every insight computer, and is
 * then dropped. Nothing holds the samples: a 10 Hz, 24 h session (~860 k
 * lines) needs the grids, not gigabytes.
 *
 * Bucket width per group follows the client's own ladder (README D2): a
 * group with no more samples than its target ships at the native period (no
 * averaging); above it, the smallest ladder step that fits the target over
 * the group's span. Because the count is only known at the end, the grid
 * accumulates at the native period until the target is passed, then coarsens
 * itself to the 1 s rung and keeps going; `finish()` coarsens once more to the
 * final rung. Sum/count merges are exact, so the result is identical to a
 * single pass at the final width.
 */

export const OVERVIEW_V = 1 as const;
export const OVERVIEW_KIND = 'telemetry-overview' as const;
export const OVERVIEW_FORMAT = 'overview.v1' as const;
export const OVERVIEW_OBJECT_NAME = 'overview.v1.json.gz';

/** The client's interval ladder (sdk/xorgate-react replay-telemetry.ts INTERVAL_LADDER), seconds. */
export const BUCKET_LADDER_S: readonly number[] = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400,
];

/** Target buckets per group (README D2): GPS finer, as the hook asks today. */
export const BUCKET_TARGETS: Readonly<Record<string, number>> = { gps: 2000 };
export const BUCKET_TARGET_DEFAULT = 500;

export const bucketTarget = (group: string): number => BUCKET_TARGETS[group] ?? BUCKET_TARGET_DEFAULT;

/** Decimal places kept on an AVERAGED value (a native-period value passes through untouched). */
const AVG_DECIMALS = 6;

export interface OverviewSessionMeta {
  deviceId: string;
  sessionId: string;
  /** From the index row; a segment header overrides when the row has none. */
  rateHz?: number | null;
  timeSource?: string | null;
  /** Fallback window (epoch ms) when the segments carry no valid sample. */
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface OverviewSegmentInput {
  key: string;
  seq: number;
  /** Object size (gzipped bytes), for `source.bytes`. */
  bytes: number;
  /** Gunzipped JSONL. */
  text: string;
}

export interface OverviewGroupV1 {
  bucketMs: number;
  /** SPARSE: only buckets that had data, ascending. A hole is a recording hole. */
  ts: number[];
  units: Record<string, string>;
  /** Positionally aligned with `ts`; `null` = metric absent in that bucket. */
  values: Record<string, (number | null)[]>;
  /** [minLon, minLat, maxLon, maxLat] over accepted fixes; gps only, absent without one. */
  bbox?: [number, number, number, number];
}

export interface OverviewSourceV1 {
  segments: number;
  seqFrom: number | null;
  seqTo: number | null;
  samples: number;
  bytes: number;
  /** Segments the index knew of whose object was already gone (lifecycle). */
  missingSegments: number;
  invalidLines: number;
}

export interface OverviewV1 {
  v: typeof OVERVIEW_V;
  kind: typeof OVERVIEW_KIND;
  deviceId: string;
  sessionId: string;
  rateHz: number | null;
  /** Worst seen across the session's segment headers. */
  timeSource: string | null;
  from: number;
  to: number;
  builtAt: number;
  source: OverviewSourceV1;
  groups: Record<string, OverviewGroupV1>;
  insights: InsightsV1;
}

/** Choose the ladder rung for a group above its target: smallest step whose bucket count fits. */
export function chooseBucketMs(spanMs: number, target: number): number {
  const spanS = Math.max(1, Math.ceil(spanMs / 1000));
  for (const s of BUCKET_LADDER_S) {
    if (Math.ceil(spanS / s) <= target) return s * 1000;
  }
  return BUCKET_LADDER_S[BUCKET_LADDER_S.length - 1] * 1000;
}

/** Native sample period for a rate; 1 s when the rate is unknown. */
export const nativePeriodMs = (rateHz: number | null | undefined): number =>
  rateHz && rateHz > 0 ? Math.max(1, Math.round(1000 / rateHz)) : 1000;

interface Agg {
  sum: number;
  count: number;
}

class GroupGrid {
  bucketMs: number;
  /** bucket start -> metric -> agg. Insertion order is arrival order; sorted at finish. */
  readonly buckets = new Map<number, Map<string, Agg>>();
  readonly metrics = new Set<string>();
  readonly units: Record<string, string> = {};
  samples = 0;
  first: number | null = null;
  last: number | null = null;
  private coarsened = false;

  constructor(
    readonly group: string,
    nativeMs: number,
    private readonly target: number,
  ) {
    this.bucketMs = nativeMs;
  }

  feed(ts: number, fields: Record<string, { value: number; unit?: string }>): void {
    this.samples++;
    if (this.first === null || ts < this.first) this.first = ts;
    if (this.last === null || ts > this.last) this.last = ts;
    // Past the target at a sub-second native period: fold to the 1 s rung now
    // so the grid stays bounded (the final rung is at least this coarse).
    if (!this.coarsened && this.samples > this.target && this.bucketMs < 1000) {
      this.coarsen(1000);
      this.coarsened = true;
    }
    const start = Math.floor(ts / this.bucketMs) * this.bucketMs;
    let bucket = this.buckets.get(start);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(start, bucket);
    }
    for (const field in fields) {
      const leaf = fields[field];
      if (!Number.isFinite(leaf.value)) continue;
      const metric = `${this.group}.${field}`;
      if (!this.metrics.has(metric)) this.metrics.add(metric);
      if (leaf.unit && this.units[metric] === undefined) this.units[metric] = leaf.unit;
      const agg = bucket.get(metric);
      if (agg) {
        agg.sum += leaf.value;
        agg.count++;
      } else {
        bucket.set(metric, { sum: leaf.value, count: 1 });
      }
    }
  }

  coarsen(newBucketMs: number): void {
    if (newBucketMs === this.bucketMs) return;
    const merged = new Map<number, Map<string, Agg>>();
    for (const [start, bucket] of this.buckets) {
      const newStart = Math.floor(start / newBucketMs) * newBucketMs;
      let target = merged.get(newStart);
      if (!target) {
        target = new Map();
        merged.set(newStart, target);
      }
      for (const [metric, agg] of bucket) {
        const t = target.get(metric);
        if (t) {
          t.sum += agg.sum;
          t.count += agg.count;
        } else {
          target.set(metric, { sum: agg.sum, count: agg.count });
        }
      }
    }
    this.buckets.clear();
    for (const [k, v] of merged) this.buckets.set(k, v);
    this.bucketMs = newBucketMs;
  }

  finish(): OverviewGroupV1 {
    if (this.samples > this.target && this.first !== null && this.last !== null) {
      this.coarsen(chooseBucketMs(this.last - this.first, this.target));
    }
    const starts = [...this.buckets.keys()].sort((a, b) => a - b);
    const metrics = [...this.metrics].sort();
    const values: Record<string, (number | null)[]> = {};
    for (const m of metrics) values[m] = new Array<number | null>(starts.length).fill(null);
    starts.forEach((start, i) => {
      const bucket = this.buckets.get(start)!;
      for (const [metric, agg] of bucket) {
        values[metric][i] = agg.count === 1 ? agg.sum : round(agg.sum / agg.count, AVG_DECIMALS);
      }
    });
    const units: Record<string, string> = {};
    for (const m of metrics) if (this.units[m] !== undefined) units[m] = this.units[m];
    return { bucketMs: this.bucketMs, ts: starts, units, values };
  }
}

export class OverviewBuilder {
  private readonly grids = new Map<string, GroupGrid>();
  private readonly insights = createInsightRun();
  private readonly allMetrics = new Set<string>();
  private readonly allUnits: Record<string, string> = {};
  private rateHz: number | null;
  private timeSource: string | null;
  private readonly nativeMs: number;
  private from: number | null = null;
  private to: number | null = null;
  private bbox: [number, number, number, number] | null = null;
  private readonly source: OverviewSourceV1 = {
    segments: 0,
    seqFrom: null,
    seqTo: null,
    samples: 0,
    bytes: 0,
    missingSegments: 0,
    invalidLines: 0,
  };

  constructor(private readonly meta: OverviewSessionMeta) {
    this.rateHz = meta.rateHz ?? null;
    this.timeSource = meta.timeSource ?? null;
    this.nativeMs = nativePeriodMs(this.rateHz);
  }

  /** Feed one segment (in `seq` order). */
  feedSegment(segment: OverviewSegmentInput): void {
    this.source.segments++;
    this.source.bytes += segment.bytes;
    if (this.source.seqFrom === null || segment.seq < this.source.seqFrom) this.source.seqFrom = segment.seq;
    if (this.source.seqTo === null || segment.seq > this.source.seqTo) this.source.seqTo = segment.seq;

    for (const line of iterateSegmentLines(segment.text)) {
      if (line.kind === 'invalid') {
        this.source.invalidLines++;
        continue;
      }
      if (line.kind === 'header') {
        if (this.rateHz === null && line.header.rateHz) this.rateHz = line.header.rateHz;
        this.timeSource = worstTimeSource(this.timeSource, line.header.timeSource);
        continue;
      }
      this.feedSample(line.sample.ts, line.sample.metrics);
    }
  }

  /** A segment the index lists but whose object is gone (lifecycle): counted, not fed. */
  noteMissingSegment(): void {
    this.source.missingSegments++;
  }

  private feedSample(
    ts: number,
    metrics: Record<string, Record<string, { value: number; unit?: string }>>,
  ): void {
    this.source.samples++;
    if (this.from === null || ts < this.from) this.from = ts;
    if (this.to === null || ts > this.to) this.to = ts;

    const flat: Record<string, number> = {};
    for (const group in metrics) {
      const fields = metrics[group];
      let grid = this.grids.get(group);
      if (!grid) {
        grid = new GroupGrid(group, this.nativeMs, bucketTarget(group));
        this.grids.set(group, grid);
      }
      grid.feed(ts, fields);
      for (const field in fields) {
        const leaf = fields[field];
        if (!Number.isFinite(leaf.value)) continue;
        const metric = `${group}.${field}`;
        flat[metric] = leaf.value;
        this.allMetrics.add(metric);
        if (leaf.unit && this.allUnits[metric] === undefined) this.allUnits[metric] = leaf.unit;
      }
    }

    const sample: InsightSample = { ts, values: flat };
    this.insights.feed(sample);

    const fix = acceptedFix(sample);
    if (fix) {
      if (!this.bbox) this.bbox = [fix.lon, fix.lat, fix.lon, fix.lat];
      else {
        if (fix.lon < this.bbox[0]) this.bbox[0] = fix.lon;
        if (fix.lat < this.bbox[1]) this.bbox[1] = fix.lat;
        if (fix.lon > this.bbox[2]) this.bbox[2] = fix.lon;
        if (fix.lat > this.bbox[3]) this.bbox[3] = fix.lat;
      }
    }
  }

  finish(builtAt: number = Date.now()): OverviewV1 {
    const groups: Record<string, OverviewGroupV1> = {};
    for (const name of [...this.grids.keys()].sort()) {
      const out = this.grids.get(name)!.finish();
      if (name === 'gps' && this.bbox) out.bbox = this.bbox;
      groups[name] = out;
    }
    const from = this.from ?? this.meta.startedAt ?? builtAt;
    const to = this.to ?? this.meta.endedAt ?? from;
    const insights = this.insights.finish(
      { metrics: this.allMetrics, units: this.allUnits, rateHz: this.rateHz, from: this.from, to: this.to },
      builtAt,
    );
    return {
      v: OVERVIEW_V,
      kind: OVERVIEW_KIND,
      deviceId: this.meta.deviceId,
      sessionId: this.meta.sessionId,
      rateHz: this.rateHz,
      timeSource: this.timeSource,
      from,
      to,
      builtAt,
      source: { ...this.source },
      groups,
      insights,
    };
  }
}

/** Convenience for tests and one-shot callers: every segment in memory, sorted by seq. */
export function buildOverview(
  meta: OverviewSessionMeta,
  segments: OverviewSegmentInput[],
  builtAt?: number,
): OverviewV1 {
  const builder = new OverviewBuilder(meta);
  for (const seg of [...segments].sort((a, b) => a.seq - b.seq)) builder.feedSegment(seg);
  return builder.finish(builtAt);
}

/** Serialise (no pretty print) and gzip at level 9: the bytes that go to S3. */
export function gzipOverview(object: OverviewV1): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(object), 'utf8'), { level: 9 });
}

/** `telemetry/v1/<deviceId>/<sessionId>/overview.v1.json.gz`, next to the session's segments. */
export const overviewKeyFor = (deviceId: string, sessionId: string): string =>
  `telemetry/v1/${deviceId}/${sessionId}/${OVERVIEW_OBJECT_NAME}`;

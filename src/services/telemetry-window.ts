import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import { iterateSegmentLines } from './telemetry-batch';
import type { TelemetrySample } from '@xorgate/workflow-engine';

/**
 * The one sanctioned telemetry-history read for the v2 engine, shared by the
 * Lambda engine target (direct reads through the EngineSourceReader seam,
 * handlers/workflow-engine.ts) and the M4 dispatcher-side input
 * materialization for Fargate runs (workflow-engine-v2.ts), so the two paths
 * cannot drift: a fusion graph replayed on the container sees exactly the
 * samples the Lambda engine would have read. Raw stored values, no unit
 * conversion (M2 decision 6).
 *
 * Since telemetry-session-artifacts Phase 5 (README D1, D8, D9) it routes by
 * WINDOW AGE. `telemetry_readings` is a hot window (TELEMETRY_HOT_WINDOW_DAYS,
 * 90 by default, the same number partition-maintenance drops behind); the
 * record for recorded telemetry is the device's own gzipped segment objects
 * under `telemetry/v1/`, indexed by `telemetry_segments`.
 *
 *   - inside the hot window  -> Postgres, exactly as before.
 *   - older than the window  -> the S3 artifacts: list the device's indexed
 *     segments overlapping the window, GET + inflate them (bounded
 *     concurrency, seq order), filter to `metrics`, group per sample. Whatever
 *     rows Postgres still holds for that part (a month waits up to ~30 days
 *     past the window for its drop; rows older than the index have no
 *     objects at all) are read too and MERGED underneath, the artifact
 *     winning per signal. That is what makes the answer identical before and
 *     after a partition drop, and it is what keeps a pre-index month readable
 *     until it is dropped.
 *   - straddling the boundary -> both, concatenated (the ranges are disjoint,
 *     so the result stays ascending).
 *
 * Every path yields the same `{ ts, signals }` samples in ascending `ts` and
 * honours MAX_TELEMETRY_ROWS. `lastNWindow` (handlers/device-workflows.ts)
 * stays on Postgres on purpose: "newest N" is by definition inside the hot
 * window.
 */

// Memory guard for the in-process run; the history API serves at most 5k rows,
// so this is generous headroom, not a tuning knob. Counted in ROWS (one per
// sample per metric) on both paths so the ceiling means the same thing.
export const MAX_TELEMETRY_ROWS = 100_000;

/** Fallback when TELEMETRY_HOT_WINDOW_DAYS is unset: DEFAULT_RETENTION_DAYS. */
export const DEFAULT_HOT_WINDOW_DAYS = 90;

/** Segment objects fetched at once on the artifact path (S3, not the Data API). */
export const ARTIFACT_FETCH_CONCURRENCY = 6;

export interface TelemetryWindowQuery {
  deviceId: string;
  metrics: string[];
  window: { fromMs: number; toMs: number };
}

export type Window = { fromMs: number; toMs: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The readers' hot-window length, from the environment (api-stack commonEnv). */
export function hotWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TELEMETRY_HOT_WINDOW_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOT_WINDOW_DAYS;
}

/** Epoch ms of the boundary: samples at or after it are hot. */
export function hotWindowBoundaryMs(nowMs: number, days: number): number {
  return nowMs - days * DAY_MS;
}

/**
 * Split a half-open window [fromMs, toMs) at the boundary. `cold` is the part
 * strictly before the boundary, `hot` the rest; either is null when empty.
 */
export function splitWindow(window: Window, boundaryMs: number): { cold: Window | null; hot: Window | null } {
  const { fromMs, toMs } = window;
  if (toMs <= fromMs) return { cold: null, hot: null };
  if (fromMs >= boundaryMs) return { cold: null, hot: window };
  if (toMs <= boundaryMs) return { cold: window, hot: null };
  return { cold: { fromMs, toMs: boundaryMs }, hot: { fromMs: boundaryMs, toMs } };
}

// ---------------------------------------------------------------------------
// Postgres path (the pre-Phase-5 reader, unchanged)
// ---------------------------------------------------------------------------

export async function readTelemetryWindowFromPostgres(query: TelemetryWindowQuery): Promise<TelemetrySample[]> {
  const { deviceId, metrics, window } = query;
  if (metrics.length === 0) return [];
  const rows = await db
    .select({
      ts: schema.telemetryReadings.ts,
      metric: schema.telemetryReadings.metric,
      value: schema.telemetryReadings.value,
    })
    .from(schema.telemetryReadings)
    .where(
      and(
        eq(schema.telemetryReadings.deviceId, deviceId),
        inArray(schema.telemetryReadings.metric, metrics),
        sql`${schema.telemetryReadings.ts} >= ${tsParam(new Date(window.fromMs).toISOString())}`,
        sql`${schema.telemetryReadings.ts} < ${tsParam(new Date(window.toMs).toISOString())}`,
      ),
    )
    .orderBy(asc(schema.telemetryReadings.ts))
    .limit(MAX_TELEMETRY_ROWS);
  if (rows.length === MAX_TELEMETRY_ROWS) {
    console.warn('telemetry-window: window truncated', { deviceId, metrics });
  }
  // Rows are per-metric; group them into one sample per timestamp.
  const byTs = new Map<number, Record<string, number>>();
  for (const row of rows) {
    if (row.value === null) continue;
    const ts = row.ts.getTime();
    (byTs.get(ts) ?? byTs.set(ts, {}).get(ts)!)[row.metric] = row.value;
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, signals]) => ({ ts, signals }));
}

// ---------------------------------------------------------------------------
// Artifact path (S3 segments through the index)
// ---------------------------------------------------------------------------

export interface SegmentRef {
  s3Key: string;
  seq: number;
  startTs: number;
  endTs: number;
}

export interface ArtifactReaderDeps {
  /** Indexed segments of the device overlapping [fromMs, toMs), in (startTs, seq) order. */
  listSegments(deviceId: string, window: Window): Promise<SegmentRef[]>;
  /** The inflated JSONL of one segment, or null when the object is gone. */
  getSegmentText(s3Key: string): Promise<string | null>;
  concurrency?: number;
  maxRows?: number;
}

/**
 * The samples of one inflated segment inside [fromMs, toMs), restricted to
 * `metrics` (a sample with none of them is dropped, as the Postgres grouping
 * drops it). Same line grammar as the ingest path (iterateSegmentLines), so a
 * line the ingester rejected is skipped here too and a line it inserted is
 * yielded here. Pure.
 */
export function samplesFromSegmentText(
  text: string,
  opts: { fromMs: number; toMs: number; metrics: ReadonlySet<string> },
): TelemetrySample[] {
  const out: TelemetrySample[] = [];
  for (const line of iterateSegmentLines(text)) {
    if (line.kind !== 'sample') continue;
    const { ts, metrics } = line.sample;
    if (ts < opts.fromMs || ts >= opts.toMs) continue;
    let signals: Record<string, number> | null = null;
    for (const [group, fields] of Object.entries(metrics)) {
      for (const [field, leaf] of Object.entries(fields)) {
        const key = `${group}.${field}`;
        if (!opts.metrics.has(key)) continue;
        (signals ??= {})[key] = leaf.value;
      }
    }
    if (signals) out.push({ ts, signals });
  }
  return out;
}

/**
 * Merge samples by `ts`: `primary` wins per signal, `secondary` fills what
 * primary lacks (whole samples or individual signals). Ascending output.
 */
export function mergeSamples(primary: TelemetrySample[], secondary: TelemetrySample[]): TelemetrySample[] {
  if (secondary.length === 0) return primary;
  if (primary.length === 0) return secondary;
  const byTs = new Map<number, Record<string, number>>();
  for (const s of secondary) byTs.set(s.ts, { ...s.signals });
  for (const s of primary) {
    const existing = byTs.get(s.ts);
    if (existing) Object.assign(existing, s.signals);
    else byTs.set(s.ts, { ...s.signals });
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, signals]) => ({ ts, signals }));
}

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** The live deps: the index in Postgres, the objects in the core bucket. */
export const artifactReaderDeps: ArtifactReaderDeps = {
  async listSegments(deviceId, window) {
    const t = schema.telemetrySegments;
    const rows = await db
      .select({ s3Key: t.s3Key, seq: t.seq, startTs: t.startTs, endTs: t.endTs })
      .from(t)
      .where(
        and(
          eq(t.deviceId, deviceId),
          // Overlap with [from, to): a file's first sample is before `to` and
          // its last sample is at or after `from`.
          sql`${t.startTs} < ${tsParam(new Date(window.toMs).toISOString())}`,
          sql`${t.endTs} >= ${tsParam(new Date(window.fromMs).toISOString())}`,
        ),
      )
      .orderBy(asc(t.startTs), asc(t.seq));
    return rows.map((r) => ({ s3Key: r.s3Key, seq: r.seq, startTs: r.startTs.getTime(), endTs: r.endTs.getTime() }));
  },
  async getSegmentText(s3Key) {
    if (!BUCKET) throw new Error('BUCKET_NAME is not set');
    let bytes: Buffer;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
      bytes = Buffer.from(await obj.Body!.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    // The SDK hands back the stored bytes whatever the object's Content-Encoding
    // says (README Q14), so inflate by magic, not by metadata.
    if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
      return gunzipSync(bytes).toString('utf8');
    }
    return bytes.toString('utf8');
  },
};

export interface ArtifactReadStats {
  segments: number;
  missingSegments: number;
  samples: number;
  rows: number;
  truncated: boolean;
}

/**
 * Read a window from the artifacts alone. Segments come from the index in
 * (startTs, seq) order and are fetched `concurrency` at a time; samples are
 * appended in that order and re-sorted only if a file overlapped its
 * neighbour (a re-opened session can restart `seq`). Stops listing new
 * fetches once `maxRows` rows (samples x signals) are in hand and says so.
 */
export async function readTelemetryWindowFromArtifacts(
  query: TelemetryWindowQuery,
  deps: ArtifactReaderDeps = artifactReaderDeps,
  stats?: ArtifactReadStats,
): Promise<TelemetrySample[]> {
  const { deviceId, window } = query;
  const metrics = new Set(query.metrics);
  const maxRows = deps.maxRows ?? MAX_TELEMETRY_ROWS;
  const concurrency = Math.max(1, deps.concurrency ?? ARTIFACT_FETCH_CONCURRENCY);
  const out: TelemetrySample[] = [];
  const st: ArtifactReadStats = stats ?? { segments: 0, missingSegments: 0, samples: 0, rows: 0, truncated: false };
  if (metrics.size === 0) return out;

  const segments = await deps.listSegments(deviceId, window);
  st.segments = segments.length;
  let sorted = true;
  let lastTs = -Infinity;
  for (let i = 0; i < segments.length && !st.truncated; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    const texts = await Promise.all(batch.map((seg) => deps.getSegmentText(seg.s3Key)));
    for (const text of texts) {
      if (text === null) {
        st.missingSegments++;
        continue;
      }
      for (const sample of samplesFromSegmentText(text, { fromMs: window.fromMs, toMs: window.toMs, metrics })) {
        const n = Object.keys(sample.signals).length;
        if (st.rows + n > maxRows) {
          st.truncated = true;
          break;
        }
        if (sample.ts <= lastTs) sorted = false;
        lastTs = sample.ts;
        out.push(sample);
        st.rows += n;
      }
      if (st.truncated) break;
    }
  }
  // Dedupe by ts (a straggler re-upload can put the same sample in two files;
  // Postgres would hold one row per metric either way) and restore order.
  const merged = sorted ? out : sortAndDedupe(out);
  st.samples = merged.length;
  if (st.truncated) {
    console.warn('telemetry-window: artifact window truncated', { deviceId, metrics: query.metrics, maxRows });
  }
  return merged;
}

/** Ascending by ts, one sample per ts (later occurrences win per signal). */
function sortAndDedupe(samples: TelemetrySample[]): TelemetrySample[] {
  const byTs = new Map<number, Record<string, number>>();
  for (const s of samples) {
    const existing = byTs.get(s.ts);
    if (existing) Object.assign(existing, s.signals);
    else byTs.set(s.ts, { ...s.signals });
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, signals]) => ({ ts, signals }));
}

// ---------------------------------------------------------------------------
// The sanctioned entry point
// ---------------------------------------------------------------------------

export interface ReadTelemetryWindowOptions {
  /** Test seam: the wall clock the boundary is computed from. */
  nowMs?: number;
  /** Test seam: overrides TELEMETRY_HOT_WINDOW_DAYS. */
  hotWindowDays?: number;
  /** Test seam: the two concrete readers. */
  readers?: {
    postgres?: (query: TelemetryWindowQuery) => Promise<TelemetrySample[]>;
    artifacts?: (query: TelemetryWindowQuery, stats: ArtifactReadStats) => Promise<TelemetrySample[]>;
  };
}

export async function readTelemetryWindow(
  query: TelemetryWindowQuery,
  opts: ReadTelemetryWindowOptions = {},
): Promise<TelemetrySample[]> {
  const postgres = opts.readers?.postgres ?? readTelemetryWindowFromPostgres;
  const artifacts =
    opts.readers?.artifacts ??
    ((q: TelemetryWindowQuery, stats: ArtifactReadStats) => readTelemetryWindowFromArtifacts(q, artifactReaderDeps, stats));
  const days = opts.hotWindowDays ?? hotWindowDays();
  const boundaryMs = hotWindowBoundaryMs(opts.nowMs ?? Date.now(), days);
  const { cold, hot } = splitWindow(query.window, boundaryMs);

  let coldSamples: TelemetrySample[] = [];
  let coldStats: (ArtifactReadStats & { postgresSamples: number; merged: number }) | null = null;
  if (cold) {
    const stats: ArtifactReadStats = { segments: 0, missingSegments: 0, samples: 0, rows: 0, truncated: false };
    const fromArtifacts = await artifacts({ ...query, window: cold }, stats);
    const fromPostgres = await postgres({ ...query, window: cold });
    coldSamples = mergeSamples(fromArtifacts, fromPostgres);
    coldStats = { ...stats, postgresSamples: fromPostgres.length, merged: coldSamples.length };
  }
  const hotSamples = hot ? await postgres({ ...query, window: hot }) : [];

  console.log('telemetry-window: read', {
    deviceId: query.deviceId,
    metrics: query.metrics.length,
    window: { from: new Date(query.window.fromMs).toISOString(), to: new Date(query.window.toMs).toISOString() },
    boundary: new Date(boundaryMs).toISOString(),
    hotWindowDays: days,
    cold: coldStats,
    hot: hot ? { samples: hotSamples.length } : null,
  });

  if (coldSamples.length === 0) return hotSamples;
  if (hotSamples.length === 0) return coldSamples;
  return coldSamples.concat(hotSamples);
}

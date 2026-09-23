import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetrySample } from '@xorgate/workflow-engine';
import { parseSegment } from '../src/services/telemetry-batch';
import {
  hotWindowBoundaryMs,
  hotWindowDays,
  mergeSamples,
  readTelemetryWindow,
  readTelemetryWindowFromArtifacts,
  samplesFromSegmentText,
  splitWindow,
  type ArtifactReaderDeps,
  type SegmentRef,
} from '../src/services/telemetry-window';

/**
 * telemetry-session-artifacts Phase 5 (README D9): the ONE sanctioned reader
 * routes by window age and serves cold windows from the S3 artifacts. These
 * tests pin (a) the pure routing, (b) the segment -> samples grammar against
 * the golden fixture (52 real segments of dev session 019fe89f), and (c) that
 * the artifact path yields EXACTLY what the Postgres path yields for the same
 * files: the Postgres rows are what `parseSegment` (the ingest grammar)
 * produced, so grouping those rows the way the Postgres reader does is the
 * expected output of the artifact reader, sample for sample.
 */

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const FIXTURES = join(__dirname, 'fixtures/telemetry-session');
const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  key: string;
  seq: number;
  text: string;
  firstTs: number;
  lastTs: number;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((n) => n.endsWith('.jsonl.gz'))
    .sort()
    .map((name, i) => {
      const text = gunzipSync(readFileSync(join(FIXTURES, name))).toString('utf8');
      const parsed = parseSegment(text, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15 });
      return { key: `telemetry/v1/${DEVICE}/019fe89f-e9a8-7882-bfb0-aee70ea2b8df/${name}`, seq: i, text, firstTs: parsed.firstTs!, lastTs: parsed.lastTs! };
    });
}

/** What the Postgres path returns for these files: ingest rows, grouped per ts. */
function postgresExpectation(fixtures: Fixture[], metrics: string[], window: { fromMs: number; toMs: number }): TelemetrySample[] {
  const wanted = new Set(metrics);
  const byTs = new Map<number, Record<string, number>>();
  const rows: { ts: number; metric: string; value: number | null }[] = [];
  for (const f of fixtures) {
    const parsed = parseSegment(f.text, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15 });
    for (const r of parsed.rows) rows.push({ ts: r.ts.getTime(), metric: r.metric, value: r.value });
  }
  rows.sort((a, b) => a.ts - b.ts);
  for (const row of rows) {
    if (row.value === null || !wanted.has(row.metric)) continue;
    if (row.ts < window.fromMs || row.ts >= window.toMs) continue;
    (byTs.get(row.ts) ?? byTs.set(row.ts, {}).get(row.ts)!)[row.metric] = row.value;
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, signals]) => ({ ts, signals }));
}

function depsFor(fixtures: Fixture[], over: Partial<ArtifactReaderDeps> = {}): ArtifactReaderDeps & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    async listSegments(deviceId, window) {
      expect(deviceId).toBe(DEVICE);
      return fixtures
        .filter((f) => f.firstTs < window.toMs && f.lastTs >= window.fromMs)
        .map<SegmentRef>((f) => ({ s3Key: f.key, seq: f.seq, startTs: f.firstTs, endTs: f.lastTs }));
    },
    async getSegmentText(key) {
      gets.push(key);
      return fixtures.find((f) => f.key === key)?.text ?? null;
    },
    ...over,
  };
}

const fixtures = loadFixtures();
const SESSION_FROM = fixtures[0].firstTs;
const SESSION_TO = Math.max(...fixtures.map((f) => f.lastTs)) + 1;
const FOUR = ['gps.lat', 'gps.lon', 'gps.speed', 'system.cpu_temp'];

describe('hot window routing (pure)', () => {
  it('reads TELEMETRY_HOT_WINDOW_DAYS, falling back to 90', () => {
    expect(hotWindowDays({})).toBe(90);
    expect(hotWindowDays({ TELEMETRY_HOT_WINDOW_DAYS: '40' })).toBe(40);
    expect(hotWindowDays({ TELEMETRY_HOT_WINDOW_DAYS: 'nope' })).toBe(90);
    expect(hotWindowDays({ TELEMETRY_HOT_WINDOW_DAYS: '0' })).toBe(90);
  });

  it('boundary is now minus the window', () => {
    const now = Date.UTC(2026, 8, 23);
    expect(hotWindowBoundaryMs(now, 90)).toBe(Date.UTC(2026, 5, 25));
  });

  it('splits a window at the boundary into cold and hot halves', () => {
    const b = 1000;
    expect(splitWindow({ fromMs: 1000, toMs: 2000 }, b)).toEqual({ cold: null, hot: { fromMs: 1000, toMs: 2000 } });
    expect(splitWindow({ fromMs: 0, toMs: 1000 }, b)).toEqual({ cold: { fromMs: 0, toMs: 1000 }, hot: null });
    expect(splitWindow({ fromMs: 0, toMs: 500 }, b)).toEqual({ cold: { fromMs: 0, toMs: 500 }, hot: null });
    expect(splitWindow({ fromMs: 500, toMs: 1500 }, b)).toEqual({ cold: { fromMs: 500, toMs: 1000 }, hot: { fromMs: 1000, toMs: 1500 } });
    expect(splitWindow({ fromMs: 5, toMs: 5 }, b)).toEqual({ cold: null, hot: null });
  });
});

describe('samplesFromSegmentText', () => {
  const seq0 = fixtures[0];

  it('yields one sample per line carrying a wanted metric, in file order, header skipped', () => {
    const out = samplesFromSegmentText(seq0.text, { fromMs: 0, toMs: Infinity, metrics: new Set(['system.cpu_temp']) });
    const parsed = parseSegment(seq0.text, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15 });
    // Not every line of seq 0 carries the metric (60 samples, 53 with cpu_temp).
    expect(parsed.sampleLines).toBe(60);
    expect(out.length).toBe(parsed.rows.filter((r) => r.metric === 'system.cpu_temp').length);
    expect(out.length).toBe(53);
    expect(out[0]).toEqual({ ts: 1786314223040, signals: { 'system.cpu_temp': 28.7 } });
    for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThan(out[i - 1].ts);
  });

  it('drops samples that carry none of the wanted metrics', () => {
    // The first fixes of the session have no gps.lat yet.
    const out = samplesFromSegmentText(seq0.text, { fromMs: 0, toMs: Infinity, metrics: new Set(['gps.lat']) });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(60);
    expect(out.every((s) => typeof s.signals['gps.lat'] === 'number')).toBe(true);
  });

  it('clips to the half-open window', () => {
    const all = samplesFromSegmentText(seq0.text, { fromMs: 0, toMs: Infinity, metrics: new Set(['system.cpu_temp']) });
    const second = all[1].ts;
    const clipped = samplesFromSegmentText(seq0.text, { fromMs: second, toMs: all[3].ts, metrics: new Set(['system.cpu_temp']) });
    expect(clipped.map((s) => s.ts)).toEqual([all[1].ts, all[2].ts]);
  });

  it('skips malformed lines like the ingester does', () => {
    const text = '{"type":"header","deviceId":"' + DEVICE + '","sessionId":"019fe89f-e9a8-7882-bfb0-aee70ea2b8df"}\n' +
      'not json\n' +
      '{"ts":1,"metrics":{"gps":{"lat":{"value":1}}}}\n' +
      '{"ts":"2","metrics":{}}\n';
    expect(samplesFromSegmentText(text, { fromMs: 0, toMs: 10, metrics: new Set(['gps.lat']) })).toEqual([
      { ts: 1, signals: { 'gps.lat': 1 } },
    ]);
  });
});

describe('mergeSamples', () => {
  it('primary wins per signal, secondary fills gaps and missing samples, output ascending', () => {
    const primary = [{ ts: 2, signals: { a: 1 } }, { ts: 3, signals: { a: 1, b: 1 } }];
    const secondary = [{ ts: 1, signals: { a: 9 } }, { ts: 2, signals: { a: 9, b: 9 } }, { ts: 3, signals: { a: 9 } }];
    expect(mergeSamples(primary, secondary)).toEqual([
      { ts: 1, signals: { a: 9 } },
      { ts: 2, signals: { a: 1, b: 9 } },
      { ts: 3, signals: { a: 1, b: 1 } },
    ]);
  });

  it('returns the other side untouched when one is empty', () => {
    const only = [{ ts: 1, signals: { a: 1 } }];
    expect(mergeSamples(only, [])).toBe(only);
    expect(mergeSamples([], only)).toBe(only);
  });
});

describe('readTelemetryWindowFromArtifacts against the golden session', () => {
  it('equals the Postgres grouping of the same files, four metrics, whole session', async () => {
    const deps = depsFor(fixtures);
    const got = await readTelemetryWindowFromArtifacts({ deviceId: DEVICE, metrics: FOUR, window: { fromMs: SESSION_FROM, toMs: SESSION_TO } }, deps);
    const want = postgresExpectation(fixtures, FOUR, { fromMs: SESSION_FROM, toMs: SESSION_TO });
    expect(got.length).toBe(want.length);
    expect(got).toEqual(want);
    expect(deps.gets.length).toBe(fixtures.length);
  });

  it('equals the Postgres grouping for every metric the session carries', async () => {
    const all = new Set<string>();
    for (const f of fixtures) for (const r of parseSegment(f.text, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15 }).rows) all.add(r.metric);
    const metrics = [...all].sort();
    expect(metrics.length).toBe(35);
    const got = await readTelemetryWindowFromArtifacts({ deviceId: DEVICE, metrics, window: { fromMs: SESSION_FROM, toMs: SESSION_TO } }, depsFor(fixtures));
    expect(got).toEqual(postgresExpectation(fixtures, metrics, { fromMs: SESSION_FROM, toMs: SESSION_TO }));
    expect(got.length).toBe(3153);
  });

  it('only fetches the segments overlapping a narrow window and clips inside them', async () => {
    const deps = depsFor(fixtures);
    const window = { fromMs: fixtures[3].firstTs + 5_000, toMs: fixtures[4].lastTs - 5_000 };
    const got = await readTelemetryWindowFromArtifacts({ deviceId: DEVICE, metrics: FOUR, window }, deps);
    expect(deps.gets).toEqual([fixtures[3].key, fixtures[4].key]);
    expect(got).toEqual(postgresExpectation(fixtures, FOUR, window));
    expect(got[0].ts).toBeGreaterThanOrEqual(window.fromMs);
    expect(got.at(-1)!.ts).toBeLessThan(window.toMs);
  });

  it('skips an object the lifecycle already deleted and reports it', async () => {
    const deps = depsFor(fixtures, { getSegmentText: async (key) => (key === fixtures[1].key ? null : fixtures.find((f) => f.key === key)!.text) });
    const stats = { segments: 0, missingSegments: 0, samples: 0, rows: 0, truncated: false };
    const got = await readTelemetryWindowFromArtifacts({ deviceId: DEVICE, metrics: FOUR, window: { fromMs: SESSION_FROM, toMs: SESSION_TO } }, deps, stats);
    expect(stats.missingSegments).toBe(1);
    expect(stats.segments).toBe(fixtures.length);
    expect(got).toEqual(postgresExpectation(fixtures.filter((f) => f !== fixtures[1]), FOUR, { fromMs: SESSION_FROM, toMs: SESSION_TO }));
  });

  it('dedupes a sample present in two files (straggler re-upload) and keeps order', async () => {
    const dup = { ...fixtures[2], key: fixtures[2].key + '.dup', seq: 99 };
    const withDup = [...fixtures.slice(0, 3), dup, ...fixtures.slice(3)];
    const got = await readTelemetryWindowFromArtifacts({ deviceId: DEVICE, metrics: FOUR, window: { fromMs: SESSION_FROM, toMs: SESSION_TO } }, depsFor(withDup));
    expect(got).toEqual(postgresExpectation(fixtures, FOUR, { fromMs: SESSION_FROM, toMs: SESSION_TO }));
  });

  it('honours the row ceiling (samples x signals) and flags truncation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stats = { segments: 0, missingSegments: 0, samples: 0, rows: 0, truncated: false };
    const got = await readTelemetryWindowFromArtifacts(
      { deviceId: DEVICE, metrics: FOUR, window: { fromMs: SESSION_FROM, toMs: SESSION_TO } },
      depsFor(fixtures, { maxRows: 100, concurrency: 2 }),
      stats,
    );
    expect(stats.truncated).toBe(true);
    expect(stats.rows).toBeLessThanOrEqual(100);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(100);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns nothing for an empty metric list without touching S3', async () => {
    const deps = depsFor(fixtures);
    expect(await readTelemetryWindowFromArtifacts({ deviceId: DEVICE, metrics: [], window: { fromMs: 0, toMs: Infinity } }, deps)).toEqual([]);
    expect(deps.gets).toEqual([]);
  });
});

describe('readTelemetryWindow routing', () => {
  const NOW = Date.UTC(2026, 8, 23, 12);
  const boundary = hotWindowBoundaryMs(NOW, 90);
  const query = (window: { fromMs: number; toMs: number }) => ({ deviceId: DEVICE, metrics: FOUR, window });
  const s = (ts: number, v: number): TelemetrySample => ({ ts, signals: { 'gps.lat': v } });

  it('a window inside the hot window reads Postgres only', async () => {
    const postgres = vi.fn(async () => [s(boundary + 10, 1)]);
    const artifacts = vi.fn(async () => []);
    const got = await readTelemetryWindow(query({ fromMs: boundary + 1, toMs: boundary + DAY }), { nowMs: NOW, hotWindowDays: 90, readers: { postgres, artifacts } });
    expect(got).toEqual([s(boundary + 10, 1)]);
    expect(artifacts).not.toHaveBeenCalled();
    expect(postgres).toHaveBeenCalledTimes(1);
  });

  it('a window older than the hot window reads the artifacts and merges what Postgres still has', async () => {
    const window = { fromMs: boundary - 2 * DAY, toMs: boundary - DAY };
    const artifacts = vi.fn(async () => [s(window.fromMs + 1, 1), s(window.fromMs + 2, 1)]);
    const postgres = vi.fn(async () => [s(window.fromMs + 2, 9), s(window.fromMs + 3, 9)]);
    const got = await readTelemetryWindow(query(window), { nowMs: NOW, hotWindowDays: 90, readers: { postgres, artifacts } });
    expect(got).toEqual([s(window.fromMs + 1, 1), s(window.fromMs + 2, 1), s(window.fromMs + 3, 9)]);
    expect(artifacts).toHaveBeenCalledWith(expect.objectContaining({ window }), expect.anything());
    expect(postgres).toHaveBeenCalledWith(expect.objectContaining({ window }));
  });

  it('is the same answer whether or not Postgres still holds the rows (the drop invariant)', async () => {
    const window = { fromMs: boundary - 2 * DAY, toMs: boundary - DAY };
    const fromS3 = [s(window.fromMs + 1, 1), s(window.fromMs + 2, 2)];
    const artifacts = vi.fn(async () => fromS3);
    const before = await readTelemetryWindow(query(window), { nowMs: NOW, hotWindowDays: 90, readers: { artifacts, postgres: async () => fromS3 } });
    const after = await readTelemetryWindow(query(window), { nowMs: NOW, hotWindowDays: 90, readers: { artifacts, postgres: async () => [] } });
    expect(after).toEqual(before);
  });

  it('a window straddling the boundary reads both halves and concatenates them in order', async () => {
    const window = { fromMs: boundary - DAY, toMs: boundary + DAY };
    const calls: { who: string; window: { fromMs: number; toMs: number } }[] = [];
    const artifacts = vi.fn(async (q: { window: { fromMs: number; toMs: number } }) => {
      calls.push({ who: 'artifacts', window: q.window });
      return [s(boundary - 10, 1)];
    });
    const postgres = vi.fn(async (q: { window: { fromMs: number; toMs: number } }) => {
      calls.push({ who: 'postgres', window: q.window });
      return q.window.fromMs === boundary ? [s(boundary + 10, 2)] : [];
    });
    const got = await readTelemetryWindow(query(window), { nowMs: NOW, hotWindowDays: 90, readers: { postgres, artifacts } });
    expect(got).toEqual([s(boundary - 10, 1), s(boundary + 10, 2)]);
    expect(calls).toEqual([
      { who: 'artifacts', window: { fromMs: window.fromMs, toMs: boundary } },
      { who: 'postgres', window: { fromMs: window.fromMs, toMs: boundary } },
      { who: 'postgres', window: { fromMs: boundary, toMs: window.toMs } },
    ]);
  });

  it('a narrower TELEMETRY_HOT_WINDOW_DAYS moves recent windows to the artifacts', async () => {
    const window = { fromMs: NOW - 50 * DAY, toMs: NOW - 49 * DAY };
    const artifacts = vi.fn(async () => []);
    const postgres = vi.fn(async () => []);
    await readTelemetryWindow(query(window), { nowMs: NOW, hotWindowDays: 40, readers: { postgres, artifacts } });
    expect(artifacts).toHaveBeenCalledTimes(1);
    await readTelemetryWindow(query(window), { nowMs: NOW, hotWindowDays: 90, readers: { postgres, artifacts } });
    expect(artifacts).toHaveBeenCalledTimes(1);
  });
});

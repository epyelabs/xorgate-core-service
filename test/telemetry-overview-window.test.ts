import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildOverview, type OverviewSegmentInput, type OverviewV1 } from '../src/services/telemetry-overview';
import {
  readWindowInsights,
  readWindowInsightsBatch,
  summarizeOverviewWindow,
  type WindowInsightsDeps,
} from '../src/services/telemetry-overview-window';

/**
 * Windowed insights over the overview grid (the fix for the doubled run
 * distance: a session that overlaps a run by a parked half minute must not
 * contribute its whole drive). The golden dev session (52 real segments,
 * 25 181.6 m by the raw-sample computer) is the reference: the bucketed
 * integral over its whole span lands within a percent or two of it, a
 * sub-window is smaller, and a window over its parked tail is about zero.
 */
const FIXTURE_DIR = join(__dirname, 'fixtures', 'telemetry-session');
const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf8'));
const segments: OverviewSegmentInput[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.jsonl.gz'))
  .map((f) => {
    const gz = readFileSync(join(FIXTURE_DIR, f));
    return { key: f, seq: Number(f.replace(/\.jsonl\.gz$/, '').split('-').pop()), bytes: gz.length, text: gunzipSync(gz).toString('utf8') };
  });
const golden: OverviewV1 = buildOverview({ deviceId: expected.deviceId, sessionId: expected.sessionId, rateHz: expected.rateHz }, segments, expected.builtAt);
const rawMeters: number = expected.insights.distance.meters;

describe('summarizeOverviewWindow', () => {
  it('over the whole session agrees with the raw-sample distance within 2 %', () => {
    const s = summarizeOverviewWindow(golden, golden.from, golden.to + 1)!;
    expect(s).not.toBeNull();
    expect(Math.abs(s.distanceM - rawMeters) / rawMeters).toBeLessThan(0.02);
    expect(s.method).toBe('overview-haversine');
    expect(s.fixes).toBeGreaterThan(1000);
    expect(s.movingMs).toBeGreaterThan(0);
    expect(s.movingMs).toBeLessThanOrEqual(expected.insights.duration.recordedMs);
  });

  it('a sub-window counts only what lies inside it, and the halves add up', () => {
    // Split at the median GPS bucket, not the wall midpoint: the golden
    // session's first file spans a 57-minute recording hole.
    const gpsTs = golden.groups.gps.ts;
    const mid = gpsTs[Math.floor(gpsTs.length / 2)];
    const a = summarizeOverviewWindow(golden, golden.from, mid)!;
    const b = summarizeOverviewWindow(golden, mid, golden.to + 1)!;
    const all = summarizeOverviewWindow(golden, golden.from, golden.to + 1)!;
    expect(a.distanceM).toBeGreaterThan(0);
    expect(b.distanceM).toBeGreaterThan(0);
    expect(a.distanceM).toBeLessThan(all.distanceM);
    // The split loses at most the one leg that straddles `mid`.
    expect(Math.abs(a.distanceM + b.distanceM - all.distanceM)).toBeLessThan(150);
    expect(a.to).toBeLessThan(mid);
    expect(b.from).toBeGreaterThanOrEqual(mid);
  });

  it('a window with no bucket inside it is null, a window outside the session is null', () => {
    expect(summarizeOverviewWindow(golden, golden.to + 10_000, golden.to + 20_000)).toBeNull();
    expect(summarizeOverviewWindow(golden, 0, golden.from)).toBeNull();
  });

  it('a 36 s parked overlap at the start of a drive is metres, not kilometres', () => {
    // The golden drive starts parked (position.startAt is 19 s after `from`).
    const s = summarizeOverviewWindow(golden, golden.from, golden.from + 36_000)!;
    expect(s).not.toBeNull();
    expect(s.distanceM).toBeLessThan(100);
  });

  it('ignores an overview without a GPS grid', () => {
    const noGps = { ...golden, groups: { system: golden.groups.system } } as unknown as OverviewV1;
    expect(summarizeOverviewWindow(noGps, golden.from, golden.to)).toBeNull();
  });
});

describe('readWindowInsights', () => {
  const row = (id: string, from: number, to: number, built: boolean, status = 'closed') => ({
    id,
    status,
    startedAt: new Date(from),
    endedAt: new Date(to),
    overviewKey: built ? `k/${id}` : null,
    overviewBuiltAt: built ? new Date(to) : null,
    overviewStale: false,
  });
  const deps = (rows: ReturnType<typeof row>[], overviews: Record<string, OverviewV1 | null>): WindowInsightsDeps => ({
    listSessions: async () => rows,
    getOverview: async (key) => overviews[key] ?? null,
  });

  it('sums the windowed numbers of built sessions, reports unbuilt ones as partial, clips the coverage', async () => {
    const drive = golden; // 019fe89f: from..to
    // The last ten minutes of the drive (its first hour is a recording hole).
    const window = { fromMs: drive.to - 10 * 60_000, toMs: drive.to - 60_000 };
    const out = await readWindowInsights('dev', window, deps(
      [row('a', drive.from, drive.to, true), row('b', drive.to - 2 * 60_000, drive.to + 3600_000, false, 'open')],
      { 'k/a': drive },
    ));
    expect(out.sessions.map((s) => [s.id, s.source])).toEqual([['a', 'overview'], ['b', 'unbuilt']]);
    expect(out.partial).toBe(true);
    const direct = summarizeOverviewWindow(drive, window.fromMs, window.toMs)!;
    expect(out.distanceM).toBe(direct.distanceM);
    expect(out.movingMs).toBe(direct.movingMs);
    expect(out.sessions[0].overlapMs).toBe(9 * 60_000);
    expect(out.sessions[1].overlapMs).toBe(60_000);
    expect(out.sessions[1].distanceM).toBeNull();
    expect(out.telemetryMs).toBe(9 * 60_000); // the union, not 9 + 1 minutes
    expect(out.distanceM).toBeGreaterThan(1000);
  });

  it('a built session with nothing inside the window is a real zero, not null', async () => {
    const window = { fromMs: golden.to + 1000, toMs: golden.to + 60_000 };
    const out = await readWindowInsights('dev', window, deps([row('a', golden.from, golden.to + 30_000, true)], { 'k/a': golden }));
    expect(out.distanceM).toBe(0);
    expect(out.partial).toBe(false);
  });

  it('an overview object that is gone counts as unbuilt', async () => {
    const out = await readWindowInsights('dev', { fromMs: golden.from, toMs: golden.to }, deps([row('a', golden.from, golden.to, true)], {}));
    expect(out.sessions[0].source).toBe('unbuilt');
    expect(out.distanceM).toBeNull();
    expect(out.partial).toBe(true);
  });

  it('no sessions: empty, zero coverage, not partial', async () => {
    const out = await readWindowInsights('dev', { fromMs: 0, toMs: 1000 }, deps([], {}));
    expect(out).toMatchObject({ sessions: [], distanceM: null, movingMs: null, telemetryMs: 0, partial: false });
  });
});

describe('readWindowInsightsBatch', () => {
  const row = (id: string, from: number, to: number, built: boolean, status = 'closed') => ({
    id,
    status,
    startedAt: new Date(from),
    endedAt: new Date(to),
    overviewKey: built ? `k/${id}` : null,
    overviewBuiltAt: built ? new Date(to) : null,
    overviewStale: false,
  });
  // A fake that honours the overlap predicate and counts its calls, so the
  // batch can be held to the single read's answers AND to its call budget.
  const counting = (rows: ReturnType<typeof row>[], overviews: Record<string, OverviewV1 | null>) => {
    const calls = { list: 0, get: [] as string[] };
    const deps: WindowInsightsDeps = {
      listSessions: async (_d, fromMs, toMs) => {
        calls.list++;
        return rows.filter((r) => (r.endedAt ?? r.startedAt).getTime() >= fromMs && r.startedAt.getTime() < toMs);
      },
      getOverview: async (key) => {
        calls.get.push(key);
        return overviews[key] ?? null;
      },
    };
    return { deps, calls };
  };

  const d = golden;
  const rows = [
    row('a', d.from, d.to, true),
    row('b', d.to + 120_000, d.to + 600_000, false, 'open'),
    row('gone', d.to + 700_000, d.to + 800_000, true),
  ];
  const overviews = { 'k/a': d };
  const windows = [
    { fromMs: d.to - 10 * 60_000, toMs: d.to - 60_000 }, // inside a
    { fromMs: d.to - 5 * 60_000, toMs: d.to + 200_000 }, // a's tail + b
    { fromMs: d.to + 650_000, toMs: d.to + 900_000 }, // only the gone overview
    { fromMs: d.to + 10_000_000, toMs: d.to + 10_060_000 }, // nothing
  ];

  it('answers each window exactly as the single read does, in order', async () => {
    const batch = await readWindowInsightsBatch('dev', windows, counting(rows, overviews).deps);
    const single = await Promise.all(windows.map((w) => readWindowInsights('dev', w, counting(rows, overviews).deps)));
    expect(batch).toEqual(single);
    expect(batch.map((b) => b.sessions.map((s) => s.id))).toEqual([['a'], ['a', 'b'], ['gone'], []]);
  });

  it('lists sessions once and reads each overview once, however many windows share it', async () => {
    const { deps, calls } = counting(rows, overviews);
    await readWindowInsightsBatch('dev', windows, deps);
    expect(calls.list).toBe(1);
    expect(calls.get.sort()).toEqual(['k/a', 'k/gone']);
  });

  it('an empty batch reads nothing', async () => {
    const { deps, calls } = counting(rows, overviews);
    expect(await readWindowInsightsBatch('dev', [], deps)).toEqual([]);
    expect(calls).toEqual({ list: 0, get: [] });
  });
});

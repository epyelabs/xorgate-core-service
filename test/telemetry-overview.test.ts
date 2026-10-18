import { gunzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOverview,
  chooseBucketMs,
  gzipOverview,
  nativePeriodMs,
  OverviewBuilder,
  overviewKeyFor,
  OVERVIEW_METRIC_AGG,
  type OverviewSegmentInput,
} from '../src/services/telemetry-overview';

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const SESSION = '019f857a-1111-7222-8333-444455556666';
const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);
const META = { deviceId: DEVICE, sessionId: SESSION, rateHz: 1, timeSource: 'ntp' };

type Leaf = { value: number; unit?: string };
type Metrics = Record<string, Record<string, Leaf>>;

function header(over: Record<string, unknown> = {}) {
  return {
    type: 'header',
    v: 1,
    deviceId: DEVICE,
    sessionId: SESSION,
    bootId: 'b',
    timeSource: 'ntp',
    rateHz: 1,
    startedAt: T0,
    ...over,
  };
}

function segment(
  seq: number,
  samples: Array<{ ts: number; metrics: Metrics }>,
  headerOver: Record<string, unknown> = {},
): OverviewSegmentInput {
  const lines = [header(headerOver), ...samples.map((s, i) => ({ ts: s.ts, mono: i, seq: i, metrics: s.metrics }))];
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return { key: `telemetry/v1/${DEVICE}/${SESSION}/${samples[0]?.ts ?? T0}-${String(seq).padStart(5, '0')}.jsonl.gz`, seq, bytes: text.length, text };
}

/** n samples at `periodMs`, gps.lat = i, system.cpu_temp = 50 + i % 3. */
function synthetic(n: number, periodMs: number, start = T0, extra?: (i: number) => Metrics): Array<{ ts: number; metrics: Metrics }> {
  return Array.from({ length: n }, (_, i) => ({
    ts: start + i * periodMs,
    metrics: {
      gps: { lat: { value: i, unit: 'deg' }, lon: { value: 1, unit: 'deg' } },
      system: { cpu_temp: { value: 50 + (i % 3), unit: '°C' } },
      ...(extra ? extra(i) : {}),
    },
  }));
}

describe('bucket selection', () => {
  it('walks the client ladder: smallest step whose bucket count fits the target', () => {
    expect(chooseBucketMs(3_481_000, 2000)).toBe(2000); // README §4.1 example
    expect(chooseBucketMs(3_600_000, 500)).toBe(10_000);
    expect(chooseBucketMs(600_000, 500)).toBe(2000);
    expect(chooseBucketMs(86_400_000 * 40, 500)).toBe(7_200_000);
    expect(chooseBucketMs(86_400_000 * 1000, 500)).toBe(86_400_000); // clamps at the top rung
  });

  it('native period follows rateHz, 1 s when unknown', () => {
    expect(nativePeriodMs(1)).toBe(1000);
    expect(nativePeriodMs(10)).toBe(100);
    expect(nativePeriodMs(null)).toBe(1000);
  });
});

describe('buildOverview', () => {
  it('ships a small 1 Hz session at its native period with no averaging', () => {
    const o = buildOverview(META, [segment(0, synthetic(120, 1000))], T0 + 1);
    expect(o.v).toBe(1);
    expect(o.kind).toBe('telemetry-overview');
    expect(o.groups.gps.bucketMs).toBe(1000);
    expect(o.groups.system.bucketMs).toBe(1000);
    expect(o.groups.gps.ts).toHaveLength(120);
    expect(o.groups.gps.ts[0]).toBe(T0);
    expect(o.groups.gps.values['gps.lat'][119]).toBe(119);
    expect(o.groups.gps.units).toEqual({ 'gps.lat': 'deg', 'gps.lon': 'deg' });
    expect(o.from).toBe(T0);
    expect(o.to).toBe(T0 + 119_000);
    expect(o.source).toEqual({
      droppedSamples: 0,
      segments: 1,
      seqFrom: 0,
      seqTo: 0,
      samples: 120,
      bytes: expect.any(Number),
      missingSegments: 0,
      invalidLines: 0,
    });
  });

  it('averages into ladder buckets above the target, per group (gps 2000, others 500)', () => {
    const samples = synthetic(3600, 1000);
    const o = buildOverview(META, [segment(0, samples.slice(0, 1800)), segment(1, samples.slice(1800))]);
    // 3 600 s span, 3 600 gps samples > 2 000 -> 2 s buckets, 1 800 of them.
    expect(o.groups.gps.bucketMs).toBe(2000);
    expect(o.groups.gps.ts).toHaveLength(1800);
    expect(o.groups.gps.values['gps.lat'][0]).toBe(0.5); // avg(0, 1)
    expect(o.groups.gps.values['gps.lat'][1799]).toBe(3598.5);
    // system: 3 600 > 500 -> 10 s buckets (5 s would give 720).
    expect(o.groups.system.bucketMs).toBe(10_000);
    expect(o.groups.system.ts).toHaveLength(360);
    expect(o.groups.system.values['system.cpu_temp'][0]).toBe(50.9); // avg of 50,51,52,50,51,52,50,51,52,50
    expect(o.source.segments).toBe(2);
    expect(o.source.seqTo).toBe(1);
  });

  it('handles 10 Hz: native 100 ms buckets under the target, coarsening above it', () => {
    const small = buildOverview({ ...META, rateHz: 10 }, [segment(0, synthetic(100, 100), { rateHz: 10 })]);
    expect(small.groups.gps.bucketMs).toBe(100);
    expect(small.groups.gps.ts).toHaveLength(100);
    expect(small.groups.gps.ts[1] - small.groups.gps.ts[0]).toBe(100);

    // 6 000 samples over 600 s: system passes 500 mid-stream (folds to 1 s),
    // then finishes at 2 s (1 s would be 600 buckets). gps stays under 2 000
    // only if the count is, and 6 000 is not: 600 s / 1 s = 600 <= 2 000 -> 1 s.
    const big = buildOverview({ ...META, rateHz: 10 }, [segment(0, synthetic(6000, 100), { rateHz: 10 })]);
    expect(big.groups.system.bucketMs).toBe(2000);
    expect(big.groups.system.ts).toHaveLength(300);
    expect(big.groups.gps.bucketMs).toBe(1000);
    expect(big.groups.gps.ts).toHaveLength(600);
    // 10 samples per 1 s gps bucket: lat = i -> avg of 0..9 = 4.5
    expect(big.groups.gps.values['gps.lat'][0]).toBe(4.5);
    // 20 samples per 2 s system bucket, values cycle 50,51,52 -> mean over 20
    const expected = Array.from({ length: 20 }, (_, i) => 50 + (i % 3)).reduce((a, b) => a + b, 0) / 20;
    expect(big.groups.system.values['system.cpu_temp'][0]).toBeCloseTo(expected, 6);
  });

  it('keeps ts sparse across a mid-session hole and nulls a metric absent in a bucket', () => {
    const first = synthetic(60, 1000, T0);
    const second = synthetic(60, 1000, T0 + 300_000, (i) => (i % 2 === 0 ? { lte: { rssi: { value: -80, unit: 'dBm' } } } : {}));
    const o = buildOverview(META, [segment(0, first), segment(1, second)]);
    expect(o.groups.gps.ts).toHaveLength(120);
    expect(o.groups.gps.ts[59]).toBe(T0 + 59_000);
    expect(o.groups.gps.ts[60]).toBe(T0 + 300_000);
    // lte only exists in the second segment, every other second.
    expect(o.groups.lte.ts).toHaveLength(30);
    expect(o.groups.lte.values['lte.rssi'].every((v) => v === -80)).toBe(true);
    // A metric missing from some samples inside its group is null there.
    const mixed = buildOverview(META, [
      segment(0, [
        { ts: T0, metrics: { gps: { lat: { value: 1 }, lon: { value: 2 }, speed: { value: 3, unit: 'km/h' } } } },
        { ts: T0 + 1000, metrics: { gps: { lat: { value: 1 }, lon: { value: 2 } } } },
      ]),
    ]);
    expect(mixed.groups.gps.values['gps.speed']).toEqual([3, null]);
    expect(mixed.groups.gps.units['gps.speed']).toBe('km/h');
  });

  it('frames bbox over accepted fixes only and takes the first non-null unit', () => {
    const o = buildOverview(META, [
      segment(0, [
        { ts: T0, metrics: { gps: { lat: { value: 43.65 }, lon: { value: -79.38 }, hdop: { value: 1.2 }, fix_quality: { value: 1 } } } },
        { ts: T0 + 1000, metrics: { gps: { lat: { value: 43.66, unit: 'deg' }, lon: { value: -79.37 }, hdop: { value: 1.0 }, fix_quality: { value: 1 } } } },
        // Rejected: HDOP 9 and a wild position. Must not stretch the bbox.
        { ts: T0 + 2000, metrics: { gps: { lat: { value: 10 }, lon: { value: 10 }, hdop: { value: 9 }, fix_quality: { value: 1 } } } },
        // Rejected: no fix.
        { ts: T0 + 3000, metrics: { gps: { lat: { value: 0 }, lon: { value: 0 }, fix_quality: { value: 0 } } } },
      ]),
    ]);
    expect(o.groups.gps.bbox).toEqual([-79.38, 43.65, -79.37, 43.66]);
    expect(o.groups.gps.units['gps.lat']).toBe('deg');
    expect(o.groups.gps.values['gps.lat']).toEqual([43.65, 43.66, 10, 0]); // the grid keeps every value; bbox is the filtered one
  });

  it('takes the worst time source across headers and rateHz from a header when the row has none', () => {
    const builder = new OverviewBuilder({ deviceId: DEVICE, sessionId: SESSION });
    builder.feedSegment(segment(0, synthetic(5, 1000), { timeSource: 'ntp', rateHz: 5 }));
    builder.feedSegment(segment(1, synthetic(5, 1000, T0 + 5000), { timeSource: 'unsynced', rateHz: 5 }));
    builder.feedSegment(segment(2, synthetic(5, 1000, T0 + 10_000), { timeSource: 'ntp', rateHz: 5 }));
    builder.noteMissingSegment();
    const o = builder.finish(T0 + 20_000);
    expect(o.timeSource).toBe('unsynced');
    expect(o.rateHz).toBe(5);
    expect(o.source.segments).toBe(3);
    expect(o.source.missingSegments).toBe(1);
    expect(o.builtAt).toBe(T0 + 20_000);
  });

  it('counts invalid lines and falls back to the row window when nothing is valid', () => {
    const seg: OverviewSegmentInput = { key: 'k', seq: 0, bytes: 3, text: 'garbage\n{"ts":"x"}\n' };
    const o = buildOverview({ ...META, startedAt: T0, endedAt: T0 + 5 }, [seg], T0 + 100);
    expect(o.source.invalidLines).toBe(2);
    expect(o.source.samples).toBe(0);
    expect(o.groups).toEqual({});
    expect(o.from).toBe(T0);
    expect(o.to).toBe(T0 + 5);
    expect(o.insights.computed).toEqual({});
  });

  it('carries the insights block, gzips at level 9, and round-trips', () => {
    const o = buildOverview(META, [segment(0, synthetic(120, 1000, T0, (i) => ({ gps: { lat: { value: 43.65 + i * 0.0001 }, lon: { value: -79.38 }, speed: { value: 20, unit: 'km/h' }, fix_quality: { value: 1 } } })))]);
    expect(o.insights.computed).toMatchObject({ duration: 1, distance: 1, speed: 1, position: 1, gpsQuality: 1, system: 1, stops: 1 });
    const gz = gzipOverview(o);
    expect(gz.length).toBeLessThan(JSON.stringify(o).length);
    expect(JSON.parse(gunzipSync(gz).toString('utf8'))).toEqual(o);
    expect(overviewKeyFor(DEVICE, SESSION)).toBe(`telemetry/v1/${DEVICE}/${SESSION}/overview.v1.json.gz`);
  });
});

// Golden assertion on one real dev session (phase file 1.7). The fixture is the
// session's raw .jsonl.gz segments as uploaded by the device, plus
// expected.json with the numbers reviewed when the fixture was made.
const FIXTURE_DIR = join(__dirname, 'fixtures', 'telemetry-session');
describe.skipIf(!existsSync(join(FIXTURE_DIR, 'expected.json')))('real dev session (golden)', () => {
  it('reproduces the reviewed numbers', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, 'expected.json'), 'utf8'));
    const segments: OverviewSegmentInput[] = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.jsonl.gz'))
      .map((f) => {
        const gz = readFileSync(join(FIXTURE_DIR, f));
        const seq = Number(f.replace(/\.jsonl\.gz$/, '').split('-').pop());
        return { key: f, seq, bytes: gz.length, text: gunzipSync(gz).toString('utf8') };
      });
    const o = buildOverview({ deviceId: expected.deviceId, sessionId: expected.sessionId, rateHz: expected.rateHz }, segments, expected.builtAt);
    expect(o.source).toEqual(expected.source);
    expect(o.from).toBe(expected.from);
    expect(o.to).toBe(expected.to);
    expect(o.timeSource).toBe(expected.timeSource);
    expect(Object.fromEntries(Object.entries(o.groups).map(([g, v]) => [g, { bucketMs: v.bucketMs, buckets: v.ts.length, metrics: Object.keys(v.values).length }]))).toEqual(expected.groups);
    expect(o.groups.gps?.bbox).toEqual(expected.bbox);
    expect(o.insights.computed).toEqual(expected.insights.computed);
    expect(o.insights.distance).toEqual(expected.insights.distance);
    expect(o.insights.duration).toEqual(expected.insights.duration);
    expect(o.insights.speed).toEqual(expected.insights.speed);
    expect(o.insights.events).toHaveLength(expected.insights.eventCount);
    expect(o.builder).toBe(2);
    // The default (mean) path is byte-identical to the reviewed build: with an
    // empty registry and the builder-2 stamp set aside, the object is the
    // same bytes as before the aggregation registry existed.
    const allMean = buildOverview({ deviceId: expected.deviceId, sessionId: expected.sessionId, rateHz: expected.rateHz }, segments, expected.builtAt, {});
    expect(gzipOverview({ ...allMean, builder: undefined }).length).toBe(expected.gzipBytes);
    // And with the real registry, only the four listed metrics may differ.
    const changed: string[] = [];
    for (const [g, grid] of Object.entries(o.groups)) {
      expect(grid.ts).toEqual(allMean.groups[g].ts);
      for (const [m, vals] of Object.entries(grid.values)) {
        if (JSON.stringify(vals) !== JSON.stringify(allMean.groups[g].values[m])) changed.push(m);
      }
    }
    for (const m of changed) expect(Object.keys(OVERVIEW_METRIC_AGG)).toContain(m);
    expect({ ...o.insights, computedAt: 0 }).toEqual({ ...allMean.insights, computedAt: 0 });
  });
});

describe('per-metric bucket aggregation (include-led-status-in-telemetry D5)', () => {
  it('buckets led_state with max and health_flags with OR, never the mean; everything else stays a mean', async () => {
    const { OVERVIEW_METRIC_AGG, OVERVIEW_BUILDER_V } = await import('../src/services/telemetry-overview');
    expect(OVERVIEW_METRIC_AGG).toEqual({
      'system.led_state': 'max',
      'system.health_flags': 'or',
      'lte.gnss_health': 'max',
      'system.throttled': 'or',
    });
    // 3600 samples at 1 Hz -> 10 s buckets (target 500). Each 10 s bucket mixes
    // codes 1 and 5 and flags 4 and 1, so a mean would read 3 and 2.5.
    const samples = synthetic(3600, 1000, T0, (i) => ({
      system: {
        cpu_temp: { value: 50 + (i % 3), unit: '°C' },
        led_state: { value: i % 2 === 0 ? 1 : 5 },
        health_flags: { value: i % 2 === 0 ? 4 : 1 },
        throttled: { value: i % 2 === 0 ? 0x4 : 0x10000 },
      },
      lte: { gnss_health: { value: i % 2 === 0 ? 0 : 2 }, rssi: { value: i % 2 === 0 ? -80 : -90, unit: 'dBm' } },
    }));
    const o = buildOverview(META, [segment(0, samples)], T0 + 1);
    expect(o.builder).toBe(OVERVIEW_BUILDER_V);
    const sys = o.groups.system;
    expect(sys.bucketMs).toBe(10_000);
    expect(sys.agg).toEqual({ 'system.health_flags': 'or', 'system.led_state': 'max', 'system.throttled': 'or' });
    expect(new Set(sys.values['system.led_state'])).toEqual(new Set([5]));
    expect(new Set(sys.values['system.health_flags'])).toEqual(new Set([5]));
    expect(new Set(sys.values['system.throttled'])).toEqual(new Set([0x10004]));
    expect(o.groups.lte.agg).toEqual({ 'lte.gnss_health': 'max' });
    expect(new Set(o.groups.lte.values['lte.gnss_health'])).toEqual(new Set([2]));
    // Unlisted metrics in the SAME buckets keep the mean (owner constraint):
    // cpu_temp 50,51,52 repeating -> first 10 s bucket = 509/10; rssi -80/-90 -> -85;
    // gps.lat = i in 2 s gps buckets -> mean of 0,1 = 0.5.
    expect(sys.values['system.cpu_temp'][0]).toBe(50.9);
    expect(new Set(o.groups.lte.values['lte.rssi'])).toEqual(new Set([-85]));
    expect(o.groups.gps.bucketMs).toBe(2_000);
    expect(o.groups.gps.values['gps.lat'][0]).toBe(0.5);
    expect(o.groups.gps.agg).toBeUndefined();
    // The insight sees the raw samples.
    const ds = o.insights.deviceStatus as { worstCode: number; byCodeMs: Record<string, number> };
    expect(ds.worstCode).toBe(5);
    expect(ds.byCodeMs['1'] + ds.byCodeMs['5']).toBe(3_599_000);
  });

  it('keeps max/or exact across the sub-second coarsening fold', () => {
    // 10 Hz: the grid folds to 1 s once past the target, then to the final rung.
    const samples = Array.from({ length: 6000 }, (_, i) => ({
      ts: T0 + i * 100,
      metrics: { system: { led_state: { value: i % 20 === 7 ? 4 : 0 }, health_flags: { value: i % 20 === 7 ? 2 : i % 20 === 9 ? 64 : 0 } } },
    }));
    const o = buildOverview({ ...META, rateHz: 10 }, [segment(0, samples, { rateHz: 10 })], T0 + 1);
    const sys = o.groups.system;
    // 600 s over a 500 target -> 2 s buckets of 20 samples, one code-4 sample each.
    expect(sys.bucketMs).toBe(2_000);
    expect(sys.ts).toHaveLength(300);
    expect(new Set(sys.values['system.led_state'])).toEqual(new Set([4]));
    expect(new Set(sys.values['system.health_flags'])).toEqual(new Set([66]));
  });
});

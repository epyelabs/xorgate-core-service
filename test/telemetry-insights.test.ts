import { describe, expect, it } from 'vitest';
import {
  createInsightRun,
  INSIGHT_COMPUTERS,
  INSIGHT_VERSIONS,
  promotedInsightColumns,
  type InsightSample,
} from '../src/services/telemetry-insights/index';
import { acceptedFix, haversineM } from '../src/services/telemetry-insights/gps-accept';
import { distanceInsight, MIN_STEP_M } from '../src/services/telemetry-insights/distance';
import { durationInsight } from '../src/services/telemetry-insights/duration';
import { speedInsight } from '../src/services/telemetry-insights/speed';
import { positionInsight } from '../src/services/telemetry-insights/position';
import { altitudeInsight } from '../src/services/telemetry-insights/altitude';
import { gpsQualityInsight } from '../src/services/telemetry-insights/gps-quality';
import { systemInsight } from '../src/services/telemetry-insights/system';
import { lteInsight } from '../src/services/telemetry-insights/lte';
import { stopsInsight } from '../src/services/telemetry-insights/stops';

const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);
const LAT0 = 43.65;
const LON0 = -79.38;
// 2*pi*R/360 for the builder's R = 6 371 008.8 m, so the synthetic drive and haversine agree.
const M_PER_DEG_LAT = 111_195.08;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** Deterministic noise in [-1, 1). */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

interface DriveOpts {
  n: number;
  speedKph: number;
  start?: number;
  startLon?: number;
  jitterM?: number;
  withSpeed?: boolean;
  extra?: (i: number) => Record<string, number>;
}

/** A 1 Hz drive due east at constant speed, optional metre-scale jitter. */
function drive({ n, speedKph, start = T0, startLon = LON0, jitterM = 0, withSpeed = true, extra }: DriveOpts): InsightSample[] {
  const mps = speedKph / 3.6;
  return Array.from({ length: n }, (_, i) => {
    const eastM = mps * i;
    const jLat = jitterM ? (noise(i * 2 + 1) * jitterM) / M_PER_DEG_LAT : 0;
    const jLon = jitterM ? (noise(i * 2 + 2) * jitterM) / mPerDegLon : 0;
    const values: Record<string, number> = {
      'gps.lat': LAT0 + jLat,
      'gps.lon': startLon + eastM / mPerDegLon + jLon,
      'gps.fix_quality': 1,
      'gps.hdop': 1.1,
      ...(withSpeed ? { 'gps.speed': speedKph } : {}),
      ...(extra ? extra(i) : {}),
    };
    return { ts: start + i * 1000, values };
  });
}

function run(samples: InsightSample[], computers = INSIGHT_COMPUTERS) {
  const r = createInsightRun(computers);
  const metrics = new Set<string>();
  for (const s of samples) {
    r.feed(s);
    for (const k of Object.keys(s.values)) metrics.add(k);
  }
  return r.finish(
    { metrics, units: {}, rateHz: 1, from: samples[0]?.ts ?? null, to: samples.at(-1)?.ts ?? null },
    T0 + 10_000_000,
  );
}

describe('gps acceptance', () => {
  it('accepts a real fix and rejects no-fix, bad HDOP, out-of-range and (0,0)', () => {
    const ok = { ts: T0, values: { 'gps.lat': LAT0, 'gps.lon': LON0, 'gps.fix_quality': 1, 'gps.hdop': 2 } };
    expect(acceptedFix(ok)).toEqual({ ts: T0, lat: LAT0, lon: LON0 });
    expect(acceptedFix({ ts: T0, values: { 'gps.lat': LAT0, 'gps.lon': LON0, 'gps.fix_quality': 0 } })).toBeNull();
    expect(acceptedFix({ ts: T0, values: { 'gps.lat': LAT0, 'gps.lon': LON0, 'gps.hdop': 5.1 } })).toBeNull();
    expect(acceptedFix({ ts: T0, values: { 'gps.lat': 91, 'gps.lon': LON0 } })).toBeNull();
    expect(acceptedFix({ ts: T0, values: { 'gps.lat': 0, 'gps.lon': 0 } })).toBeNull();
    // No quality metrics at all: still a receiver.
    expect(acceptedFix({ ts: T0, values: { 'gps.lat': LAT0, 'gps.lon': LON0 } })).not.toBeNull();
  });

  it('haversine: one degree of latitude is ~111.2 km', () => {
    expect(haversineM({ ts: 0, lat: 0, lon: 0 }, { ts: 0, lat: 1, lon: 0 })).toBeCloseTo(111_195, -2);
  });
});

describe('distance', () => {
  it('measures a clean drive and the speed integral agrees within 5 %', () => {
    const out = run(drive({ n: 601, speedKph: 36 }), [distanceInsight]);
    const d = out.distance as any;
    expect(d.meters).toBeCloseTo(6000, -1); // 10 m/s for 600 s
    expect(d.crossCheckMeters).toBeCloseTo(6000, -1);
    expect(Math.abs(d.crossCheckMeters - d.meters) / d.meters).toBeLessThan(0.05);
    expect(d.fixesUsed).toBe(601);
    expect(d.fixesRejected).toBe(0);
    expect(d.method).toBe('haversine-2d');
    expect(d.accept).toMatchObject({ minFixQuality: 1, maxHdop: 5, maxJumpMps: 60, breakGapMs: 30_000, stationaryRule: 'speed' });
    expect(out.computed.distance).toBe(1);
  });

  it('does not accumulate parked GPS drift (speed rule)', () => {
    const parked = drive({ n: 1800, speedKph: 0, jitterM: 4 });
    const d = run(parked, [distanceInsight]).distance as any;
    expect(d.meters).toBe(0);
    expect(d.fixesUsed).toBe(1800);
  });

  it('does not accumulate parked drift without a speed metric (dead-band rule)', () => {
    const parked = drive({ n: 1800, speedKph: 0, jitterM: 3, withSpeed: false });
    const d = run(parked, [distanceInsight]).distance as any;
    expect(d.accept.stationaryRule).toBe('dead-band');
    expect(d.accept.minStepM).toBe(MIN_STEP_M);
    expect(d.meters).toBe(0);
    expect(d.crossCheckMeters).toEqual({ value: null, reason: 'no-speed' });
    // ...but a real walk still accumulates through the dead-band.
    const walk = run(drive({ n: 601, speedKph: 5, withSpeed: false }), [distanceInsight]).distance as any;
    expect(walk.meters).toBeGreaterThan(800);
    expect(walk.meters).toBeLessThanOrEqual(834);
  });

  it('rejects a 60 m/s jump and keeps the chain on the previous good fix', () => {
    const samples = drive({ n: 601, speedKph: 36 });
    samples[300] = { ...samples[300], values: { ...samples[300].values, 'gps.lat': LAT0 + 0.1 } }; // ~11 km away for 1 s
    const d = run(samples, [distanceInsight]).distance as any;
    expect(d.fixesRejected).toBe(1);
    expect(d.meters).toBeCloseTo(6000, -1);
  });

  it('does not accumulate across a 3-minute hole', () => {
    const first = drive({ n: 301, speedKph: 36 });
    // Second leg starts 5 km further east, 180 s later: the hole leg must not count.
    const second = drive({ n: 301, speedKph: 36, start: T0 + 300_000 + 180_000, startLon: LON0 + 5000 / mPerDegLon });
    const d = run([...first, ...second], [distanceInsight]).distance as any;
    expect(d.meters).toBeCloseTo(6000, -1);
  });

  it('rejects fixes failing quality or HDOP and counts them', () => {
    const samples = drive({ n: 11, speedKph: 36 });
    samples[5].values['gps.hdop'] = 9;
    samples[6].values['gps.fix_quality'] = 0;
    const d = run(samples, [distanceInsight]).distance as any;
    expect(d.fixesRejected).toBe(2);
    expect(d.fixesUsed).toBe(9);
  });
});

describe('duration', () => {
  it('splits moving and idle time by speed and excludes holes from recordedMs', () => {
    const moving = drive({ n: 300, speedKph: 30 });
    const idle = drive({ n: 100, speedKph: 0, start: T0 + 300_000 });
    const after = drive({ n: 10, speedKph: 30, start: T0 + 400_000 + 120_000 });
    const s = run([...moving, ...idle, ...after], [durationInsight]).duration as any;
    expect(s.totalMs).toBe(409_000 + 120_000);
    expect(s.recordedMs).toBe(409_000 - 1000); // 409 legs of 1 s minus the hole leg
    expect(s.movingMs).toBe(300_000 + 9_000);
    expect(s.idleMs).toBe(99_000);
    expect(s.movingThresholdKph).toBe(2);
  });

  it('is not computable without speed but still reports total', () => {
    const s = run(drive({ n: 10, speedKph: 0, withSpeed: false }), [durationInsight]).duration as any;
    expect(s.totalMs).toBe(9000);
    expect(s.movingMs).toEqual({ value: null, reason: 'no-speed' });
  });
});

describe('speed / position / altitude / gpsQuality', () => {
  it('speed: max with timestamp and average while moving', () => {
    const samples = drive({ n: 10, speedKph: 0, extra: (i) => ({ 'gps.speed': i < 5 ? 0 : 40 + i }) });
    const s = run(samples, [speedInsight]).speed as any;
    expect(s.maxKph).toBe(49);
    expect(s.maxAt).toBe(T0 + 9000);
    expect(s.avgMoving_kph ?? s.avgMovingKph).toBe(47);
    expect(s.source).toBe('gps.speed');
  });

  it('speed: a session that never moves still reports a zero max (10 Hz bench session, dev 2026-09-22)', () => {
    const s = run(drive({ n: 30, speedKph: 0 }), [speedInsight]).speed as any;
    expect(s.maxKph).toBe(0);
    expect(s.maxAt).toBe(T0);
    expect(s.avgMovingKph).toBe(0);
  });

  it('position: first and last accepted fix as [lon, lat]', () => {
    const samples = drive({ n: 5, speedKph: 36 });
    samples[4].values['gps.fix_quality'] = 0; // last fix rejected -> end is sample 3
    const p = run(samples, [positionInsight]).position as any;
    expect(p.start).toEqual([LON0, LAT0]);
    expect(p.startAt).toBe(T0);
    expect(p.end[0]).toBeCloseTo(samples[3].values['gps.lon'], 9);
    expect(p.endAt).toBe(T0 + 3000);
  });

  it('altitude: 3 m hysteresis ignores noise and keeps real climbs', () => {
    // A 50 m climb in 5 m steps every 10 s, with +-1 m noise on top.
    const samples = drive({ n: 100, speedKph: 10, extra: (i) => ({ 'gps.alt': 100 + Math.floor(i / 10) * 5 + noise(i) }) });
    const a = run(samples, [altitudeInsight]).altitude as any;
    expect(a.gainM).toBeGreaterThanOrEqual(40);
    expect(a.gainM).toBeLessThanOrEqual(50);
    expect(a.lossM).toBe(0);
    expect(a.minM).toBeGreaterThanOrEqual(99);
    expect(a.maxM).toBeLessThanOrEqual(146.1);
    const flat = run(drive({ n: 600, speedKph: 10, extra: (i) => ({ 'gps.alt': 100 + noise(i) * 1.4 }) }), [altitudeInsight]).altitude as any;
    expect(flat.gainM).toBe(0);
    expect(flat.lossM).toBe(0);
  });

  it('gpsQuality: fix ratio, averages, and not-computable markers', () => {
    const samples = drive({ n: 10, speedKph: 10, extra: (i) => ({ 'gps.fix_quality': i < 8 ? 1 : 0, 'gps.satellites': 8 }) });
    const q = run(samples, [gpsQualityInsight]).gpsQuality as any;
    expect(q.fixRatio).toBe(0.8);
    expect(q.avgSatellites).toBe(8);
    expect(q.avgHdop).toBe(1.1);
    const bare = run(drive({ n: 3, speedKph: 0 }).map((s) => ({ ts: s.ts, values: { 'gps.lat': LAT0, 'gps.lon': LON0 } })), [gpsQualityInsight]).gpsQuality as any;
    expect(bare.fixRatio).toEqual({ value: null, reason: 'no-fix-quality' });
    expect(bare.avgSatellites).toEqual({ value: null, reason: 'no-metric' });
  });
});

describe('system / lte', () => {
  it('system: max temp and time-weighted throttle bits', () => {
    const samples = Array.from({ length: 61 }, (_, i) => ({
      ts: T0 + i * 1000,
      values: { 'system.cpu_temp': 60 + (i === 30 ? 15 : 0), 'system.throttled': i >= 10 && i < 20 ? 0x4 : i >= 40 && i < 45 ? 0x1 : 0 },
    }));
    const s = run(samples, [systemInsight]).system as any;
    expect(s.maxCpuTempC).toBe(75);
    expect(s.maxCpuTempAt).toBe(T0 + 30_000);
    expect(s.throttledMs).toBe(10_000);
    expect(s.undervoltageMs).toBe(5_000);
    const noBits = run(samples.map((x) => ({ ts: x.ts, values: { 'system.cpu_temp': 50 } })), [systemInsight]).system as any;
    expect(noBits.throttledMs).toEqual({ value: null, reason: 'no-metric' });
  });

  it('lte: rssi extremes and resets from counter increments', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      ts: T0 + i * 1000,
      values: { 'lte.rssi': -70 - i, 'lte.resets_24h': i < 3 ? 2 : i < 7 ? 3 : 5 },
    }));
    const l = run(samples, [lteInsight]).lte as any;
    expect(l.minRssi).toBe(-79);
    expect(l.minRssiAt).toBe(T0 + 9000);
    expect(l.maxRssi).toBe(-70);
    expect(l.avgRssi).toBe(-74.5);
    expect(l.resets).toBe(3);
    expect(l.unit).toBe('dBm');
  });
});

describe('stops', () => {
  it('emits a stop event for >= 60 s at rest with its position, ignores shorter ones', () => {
    const a = drive({ n: 30, speedKph: 30 });
    const shortStop = drive({ n: 30, speedKph: 0, start: T0 + 30_000, startLon: LON0 + 0.01 });
    const b = drive({ n: 30, speedKph: 30, start: T0 + 60_000, startLon: LON0 + 0.01 });
    const longStop = drive({ n: 90, speedKph: 0, start: T0 + 90_000, startLon: LON0 + 0.02 });
    const c = drive({ n: 10, speedKph: 30, start: T0 + 180_000, startLon: LON0 + 0.02 });
    const out = run([...a, ...shortStop, ...b, ...longStop, ...c], [stopsInsight]);
    expect(out.events).toEqual([{ kind: 'stop', ts: T0 + 90_000, endTs: T0 + 180_000, position: [expect.closeTo(LON0 + 0.02, 6), LAT0] }]);
    expect(out.stops).toMatchObject({ count: 1, totalMs: 90_000, minStopMs: 60_000, truncated: false });
  });

  it('closes an open stop at the end of the session and caps the event list', () => {
    const tail = run(drive({ n: 120, speedKph: 0 }), [stopsInsight]);
    expect(tail.events).toHaveLength(1);
    expect((tail.events[0] as any).endTs).toBe(T0 + 119_000);
    // 250 stops of 61 s separated by a second of motion -> capped at 200, truncated flagged.
    const samples: InsightSample[] = [];
    let ts = T0;
    for (let k = 0; k < 250; k++) {
      for (let i = 0; i < 61; i++, ts += 1000) samples.push({ ts, values: { 'gps.speed': 0 } });
      samples.push({ ts, values: { 'gps.speed': 30 } });
      ts += 1000;
    }
    const many = run(samples, [stopsInsight]);
    expect(many.events).toHaveLength(200);
    expect(many.stops).toMatchObject({ count: 250, truncated: true });
  });
});

describe('registry', () => {
  it('omits computers whose needs are absent, writes versions, sorts events', () => {
    const out = run([{ ts: T0, values: { 'system.cpu_temp': 40 } }, { ts: T0 + 1000, values: { 'system.cpu_temp': 41 } }]);
    expect(out.computed).toEqual({ duration: 1, system: 1 });
    expect(out.distance).toBeUndefined();
    expect(out.events).toEqual([]);
    expect(out.computedAt).toBe(T0 + 10_000_000);
    expect(INSIGHT_VERSIONS).toEqual({ duration: 1, distance: 1, speed: 1, position: 1, altitude: 1, gpsQuality: 1, system: 1, lte: 1, stops: 1 });
  });

  it('promotes distance, duration and max speed for the index row', () => {
    const out = run(drive({ n: 61, speedKph: 36 }));
    expect(promotedInsightColumns(out)).toEqual({ distanceM: expect.closeTo(600, -1), durationMs: 60_000, maxSpeedKph: 36 });
    expect(promotedInsightColumns({ computed: {}, computedAt: 0, events: [] })).toEqual({ distanceM: null, durationMs: null, maxSpeedKph: null });
  });
});

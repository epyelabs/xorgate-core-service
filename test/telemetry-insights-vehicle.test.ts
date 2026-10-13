import { describe, expect, it } from 'vitest';
import { createInsightRun, INSIGHT_COMPUTERS, type InsightSample } from '../src/services/telemetry-insights/index';
import { MAX_VEHICLE_EVENTS, REFUEL_MIN_PCT, vehicleInsight } from '../src/services/telemetry-insights/vehicle';
import { buildOverview, type OverviewSegmentInput } from '../src/services/telemetry-overview';
import {
  readWindowInsights,
  rollUpVehicle,
  summarizeOverviewVehicleWindow,
  type WindowInsightsDeps,
} from '../src/services/telemetry-overview-window';

/**
 * The `vehicle` insight (obd2-bluetooth-integration plan, P4) over a
 * synthetic session shaped like the bench emulator run of 2026-10-13: the
 * real idle values (rpm ~926, fuel 76.86 %, odometer 47 318.8 km, coolant
 * 97..100 C, link 2), then a drive, a link drop (adapter gone: `obd.link 0`
 * with no other fields, then `1` while the adapter answers alone), a DTC
 * rise with the MIL, a refuel, a 100 s recording hole and a final idle.
 */
const T0 = Date.UTC(2026, 9, 13, 18, 0, 0);
const DEVICE = '58b51737-196e-4c29-a6f6-36f6793a5126';
const SESSION = '019f9c2e-0000-7000-8000-00000000c0bd';
const LAT0 = 43.65;
const LON0 = -79.38;
const M_PER_DEG_LON = 111_195.08 * Math.cos((LAT0 * Math.PI) / 180);

type Leaf = { value: number; unit?: string };
type Metrics = Record<string, Record<string, Leaf>>;
interface Line {
  ts: number;
  metrics: Metrics;
}

const u = (value: number, unit?: string): Leaf => (unit === undefined ? { value } : { value, unit });

function obd(fields: Record<string, number>): Record<string, Leaf> {
  const units: Record<string, string> = { rpm: 'rpm', speed: 'km/h', coolant_temp: 'C', fuel_level: '%', odometer: 'km' };
  const out: Record<string, Leaf> = {};
  for (const k in fields) out[k] = u(fields[k], units[k]);
  return out;
}

/** Idle at the kerb: engine running, not moving, coolant warming to 100. */
function idle(ts: number, i: number, over: Record<string, number> = {}, eastM = 0): Line {
  return {
    ts,
    metrics: {
      gps: { lat: u(LAT0, 'deg'), lon: u(LON0 + eastM / M_PER_DEG_LON, 'deg'), speed: u(0, 'km/h'), fix_quality: u(1), hdop: u(1.1) },
      obd: obd({
        link: 2,
        rpm: 926 + (i % 3),
        speed: 0,
        coolant_temp: Math.min(100, 97 + i / 40),
        fuel_level: 76.86,
        odometer: 47318.8,
        mil: 0,
        dtc_count: 0,
        ...over,
      }),
    },
  };
}

/** A 1 Hz drive due east at 50 km/h, fuel sipping, odometer climbing in 0.1 km steps. */
function drive(ts: number, i: number, eastM: number): Line {
  const km = eastM / 1000;
  return {
    ts,
    metrics: {
      gps: { lat: u(LAT0, 'deg'), lon: u(LON0 + eastM / M_PER_DEG_LON, 'deg'), speed: u(50, 'km/h'), fix_quality: u(1), hdop: u(1.1) },
      obd: obd({
        link: 2,
        rpm: 2000 + (i % 9) * 100, // peaks at 2800
        speed: 50,
        coolant_temp: 100,
        fuel_level: 76.86 - km * 0.4,
        odometer: Math.floor((47318.8 + km) * 10) / 10,
        mil: 0,
        dtc_count: 0,
      }),
    },
  };
}

/** Adapter gone (`link 0`) or answering alone (`link 1`): the helper emits only the health code. */
function dark(ts: number, link: 0 | 1, eastM: number): Line {
  return {
    ts,
    metrics: {
      gps: { lat: u(LAT0, 'deg'), lon: u(LON0 + eastM / M_PER_DEG_LON, 'deg'), speed: u(0, 'km/h'), fix_quality: u(1), hdop: u(1.1) },
      obd: { link: u(link) },
    },
  };
}

const DRIVE_MPS = 50 / 3.6;
const DRIVE_S = 300;
const DRIVE_END_M = DRIVE_MPS * DRIVE_S;

/** The synthetic session, one line per second. */
function session(): Line[] {
  const lines: Line[] = [];
  let s = 0;
  // A: 120 s idle.
  for (let i = 0; i < 120; i++, s++) lines.push(idle(T0 + s * 1000, i));
  // B: 300 s drive.
  for (let i = 0; i < DRIVE_S; i++, s++) lines.push(drive(T0 + s * 1000, i, DRIVE_MPS * i));
  // C: 50 s adapter gone, 10 s adapter only.
  for (let i = 0; i < 50; i++, s++) lines.push(dark(T0 + s * 1000, 0, DRIVE_END_M));
  for (let i = 0; i < 10; i++, s++) lines.push(dark(T0 + s * 1000, 1, DRIVE_END_M));
  // D: 120 s idle again; DTC + MIL at +20 s, refuel at +60 s (fuel 75.2 -> 95).
  for (let i = 0; i < 120; i++, s++) {
    const fuel = i < 60 ? 75.2 : 95.0;
    const over = i >= 20 ? { mil: 1, dtc_count: 1, fuel_level: fuel, odometer: 47322.9 } : { fuel_level: fuel, odometer: 47322.9 };
    lines.push(idle(T0 + s * 1000, i, over, DRIVE_END_M));
  }
  // Hole: 100 s with nothing recorded.
  s += 100;
  // E: 60 s idle.
  for (let i = 0; i < 60; i++, s++) {
    lines.push(idle(T0 + s * 1000, i, { mil: 1, dtc_count: 1, fuel_level: 95.0, odometer: 47322.9 }, DRIVE_END_M));
  }
  return lines;
}

function flatten(lines: Line[]): InsightSample[] {
  return lines.map((l) => {
    const values: Record<string, number> = {};
    for (const g in l.metrics) for (const f in l.metrics[g]) values[`${g}.${f}`] = l.metrics[g][f].value;
    return { ts: l.ts, values };
  });
}

function run(samples: InsightSample[], computers = INSIGHT_COMPUTERS) {
  const r = createInsightRun(computers);
  const metrics = new Set<string>();
  for (const s of samples) {
    r.feed(s);
    for (const k of Object.keys(s.values)) metrics.add(k);
  }
  return r.finish({ metrics, units: {}, rateHz: 1, from: samples[0]?.ts ?? null, to: samples.at(-1)?.ts ?? null }, T0 + 10_000_000);
}

function segment(seq: number, lines: Line[]): OverviewSegmentInput {
  const header = { type: 'header', v: 1, deviceId: DEVICE, sessionId: SESSION, bootId: 'b', timeSource: 'gps', rateHz: 1, startedAt: lines[0].ts };
  const text = [header, ...lines.map((l, i) => ({ ts: l.ts, mono: i, seq: i, metrics: l.metrics }))].map((l) => JSON.stringify(l)).join('\n') + '\n';
  return { key: `telemetry/v1/${DEVICE}/${SESSION}/${lines[0].ts}-${String(seq).padStart(5, '0')}.jsonl.gz`, seq, bytes: text.length, text };
}

const LINES = session();
const SAMPLES = flatten(LINES);

describe('vehicle insight', () => {
  it('computes the synthetic bench session (snapshot)', () => {
    const out = run(SAMPLES);
    const v = out.vehicle as Record<string, any>;
    expect(out.computed.vehicle).toBe(1);
    // Live LEGS (fence posts): A+B 420 (0->1 .. 419->420, the last starts live) + D 119 + E 59; the hole is not time.
    expect(v.link.liveMs).toBe(598_000);
    expect(v.link.samples).toBe(660);
    expect(v.link.liveSamples).toBe(600);
    expect(v.engineOn.ms).toBe(598_000);
    expect(v.idle).toEqual({ ms: 298_000, speedSource: 'obd.speed', movingThresholdKph: 2 });
    expect(v.rpm).toEqual({ max: 2800, maxAt: T0 + 128_000, unit: 'rpm' });
    expect(v.coolant).toEqual({ max: 100, unit: 'C' });
    expect(v.fuel).toEqual({ startPct: 76.86, endPct: 95, usedPct: 0, refuels: 1, refuelMinPct: REFUEL_MIN_PCT, unit: '%' });
    expect(v.odometer).toEqual({ startKm: 47318.8, endKm: 47322.9, deltaKm: 4.1, unit: 'km', role: 'cross-check' });
    expect(v.dtc).toEqual({ maxCount: 1, endCount: 1, milEnd: 1, events: 1 });
    expect(v.truncated).toBe(false);
    const events = out.events.filter((e) => e.kind === 'refuel' || e.kind === 'dtc');
    expect(events).toEqual([
      { kind: 'dtc', ts: T0 + 500_000, count: 1, value: 1 },
      { kind: 'refuel', ts: T0 + 540_000, fromPct: 75.2, toPct: 95, value: 19.8, unit: '%' },
    ]);
    // The GPS insights are untouched by the obd group: distance stays GPS.
    expect((out.distance as any).meters).toBeCloseTo(DRIVE_END_M, -2);
    expect((out.speed as any).source).toBe('gps.speed');
    expect({ vehicle: out.vehicle, events }).toMatchSnapshot();
  });

  it('is skipped when the session has no obd group, and the other insights are unaffected', () => {
    const noObd = SAMPLES.map((s) => {
      const values: Record<string, number> = {};
      for (const k in s.values) if (!k.startsWith('obd.')) values[k] = s.values[k];
      return { ts: s.ts, values };
    });
    const out = run(noObd);
    expect(out.computed.vehicle).toBeUndefined();
    expect(out.vehicle).toBeUndefined();
    expect(out.computed.distance).toBe(1);
    expect(out.events.every((e) => e.kind === 'stop')).toBe(true);
  });

  it('is skipped when the link never reaches 2 (adapter absent all session)', () => {
    const dark = SAMPLES.map((s) => ({ ts: s.ts, values: { 'gps.speed': 0, 'obd.link': s.ts % 2000 === 0 ? 0 : 1 } }));
    const out = run(dark);
    expect(out.computed.vehicle).toBeUndefined();
    expect(out.vehicle).toBeUndefined();
  });

  it('falls back to gps.speed for idle when the vehicle reports no obd.speed, and marks missing fields not computable', () => {
    const samples: InsightSample[] = Array.from({ length: 61 }, (_, i) => ({
      ts: T0 + i * 1000,
      values: { 'gps.speed': i < 30 ? 0 : 40, 'obd.link': 2, 'obd.rpm': i < 30 ? 900 : 2200 },
    }));
    const out = run(samples, [vehicleInsight]);
    const v = out.vehicle as Record<string, any>;
    expect(v.idle).toEqual({ ms: 30_000, speedSource: 'gps.speed', movingThresholdKph: 2 });
    expect(v.engineOn.ms).toBe(60_000);
    expect(v.fuel).toEqual({ value: null, reason: 'no-metric' });
    expect(v.odometer).toEqual({ value: null, reason: 'no-metric' });
    expect(v.coolant).toEqual({ value: null, reason: 'no-metric' });
    expect(v.dtc).toEqual({ value: null, reason: 'no-metric' });
  });

  it('without any speed, idle is not computable; without rpm, engineOn and idle are not computable', () => {
    const noSpeed = run(
      Array.from({ length: 11 }, (_, i) => ({ ts: T0 + i * 1000, values: { 'obd.link': 2, 'obd.rpm': 900 } })),
      [vehicleInsight],
    );
    expect((noSpeed.vehicle as any).idle).toEqual({ value: null, reason: 'no-speed' });
    expect((noSpeed.vehicle as any).engineOn.ms).toBe(10_000);
    const noRpm = run(
      Array.from({ length: 11 }, (_, i) => ({ ts: T0 + i * 1000, values: { 'obd.link': 2, 'obd.speed': 0 } })),
      [vehicleInsight],
    );
    expect((noRpm.vehicle as any).engineOn).toEqual({ value: null, reason: 'no-metric' });
    expect((noRpm.vehicle as any).idle).toEqual({ value: null, reason: 'no-metric' });
    expect((noRpm.vehicle as any).link.liveMs).toBe(10_000);
  });

  it('ignores obd fields while the link is below 2 (stale values after a drop count for nothing)', () => {
    const samples: InsightSample[] = [
      { ts: T0, values: { 'obd.link': 2, 'obd.rpm': 900, 'obd.fuel_level': 50, 'obd.odometer': 100 } },
      { ts: T0 + 1000, values: { 'obd.link': 2, 'obd.rpm': 900, 'obd.fuel_level': 50, 'obd.odometer': 100 } },
      // Adapter dropped but a stale frame still carries old fields.
      { ts: T0 + 2000, values: { 'obd.link': 0, 'obd.rpm': 900, 'obd.fuel_level': 90, 'obd.odometer': 999 } },
      { ts: T0 + 3000, values: { 'obd.link': 0, 'obd.rpm': 900, 'obd.fuel_level': 90, 'obd.odometer': 999 } },
    ];
    const v = run(samples, [vehicleInsight]).vehicle as any;
    expect(v.link.liveMs).toBe(2000);
    expect(v.engineOn.ms).toBe(2000);
    expect(v.fuel.endPct).toBe(50);
    expect(v.fuel.refuels).toBe(0);
    expect(v.odometer.endKm).toBe(100);
  });

  it('caps each event kind at MAX_VEHICLE_EVENTS and flags truncation', () => {
    const samples: InsightSample[] = Array.from({ length: 2 * (MAX_VEHICLE_EVENTS + 5) }, (_, i) => ({
      ts: T0 + i * 1000,
      // Fuel saw-tooth: 10 -> 20 (+10, a refuel) -> 10 -> 20 ... every other sample; dtc rises every other sample too.
      values: { 'obd.link': 2, 'obd.rpm': 900, 'obd.fuel_level': i % 2 === 0 ? 10 : 20, 'obd.dtc_count': Math.floor(i / 2) * 2 + (i % 2) },
    }));
    const out = run(samples, [vehicleInsight]);
    const v = out.vehicle as any;
    expect(out.events.filter((e) => e.kind === 'refuel')).toHaveLength(MAX_VEHICLE_EVENTS);
    expect(out.events.filter((e) => e.kind === 'dtc')).toHaveLength(MAX_VEHICLE_EVENTS);
    expect(v.fuel.refuels).toBe(MAX_VEHICLE_EVENTS + 5);
    expect(v.dtc.events).toBeGreaterThan(MAX_VEHICLE_EVENTS);
    expect(v.truncated).toBe(true);
  });
});

describe('vehicle in the overview and the windowed insights', () => {
  const overview = buildOverview(
    { deviceId: DEVICE, sessionId: SESSION, rateHz: 1, timeSource: 'gps' },
    [segment(0, LINES.slice(0, 300)), segment(1, LINES.slice(300))],
    T0 + 10_000_000,
  );

  it('the generic grid carries an obd group with its units, and the insight block carries vehicle', () => {
    expect(overview.groups.obd).toBeDefined();
    expect(overview.groups.obd.units['obd.rpm']).toBe('rpm');
    expect(overview.groups.obd.values['obd.link']).toHaveLength(overview.groups.obd.ts.length);
    expect(overview.insights.computed.vehicle).toBe(1);
    expect(overview.insights.vehicle).toEqual(run(SAMPLES).vehicle);
  });

  it('the window summary over the whole session agrees with the raw insight within the bucket width', () => {
    const w = summarizeOverviewVehicleWindow(overview, overview.from, overview.to + 1)!;
    expect(w).not.toBeNull();
    const bucket = overview.groups.obd.bucketMs;
    // Each of the three live/dark edges can cost one bucket.
    expect(Math.abs(w.liveMs - 598_000)).toBeLessThanOrEqual(3 * bucket);
    expect(Math.abs(w.engineOnMs! - 598_000)).toBeLessThanOrEqual(3 * bucket);
    expect(Math.abs(w.idleMs! - 298_000)).toBeLessThanOrEqual(3 * bucket);
    expect(w.fuelUsedPct).toBe(0);
    expect(w.odometerDeltaKm).toBe(4.1);
    expect(w.rpmMax).toBeGreaterThan(2500);
    expect(w.coolantMax).toBe(100);
    expect(w.refuels).toBe(1);
    expect(w.dtcEvents).toBe(1);
    expect(w.method).toBe('overview-obd');
  });

  it('a sub-window counts only what lies inside it; halves add up; outside is null', () => {
    const mid = T0 + 420_000; // the link drop
    const a = summarizeOverviewVehicleWindow(overview, overview.from, mid)!;
    const b = summarizeOverviewVehicleWindow(overview, mid, overview.to + 1)!;
    const bucket = overview.groups.obd.bucketMs;
    expect(Math.abs(a.liveMs - 419_000)).toBeLessThanOrEqual(2 * bucket);
    expect(Math.abs(b.liveMs - 178_000)).toBeLessThanOrEqual(2 * bucket);
    expect(a.refuels).toBe(0);
    expect(b.refuels).toBe(1);
    expect(a.odometerDeltaKm).toBeCloseTo(4.1, 0);
    expect(b.odometerDeltaKm).toBe(0);
    expect(summarizeOverviewVehicleWindow(overview, T0 + 425_000, T0 + 470_000)).toBeNull(); // adapter gone
    expect(summarizeOverviewVehicleWindow(overview, T0 - 100_000, T0 - 1000)).toBeNull();
    const noObd = { ...overview, groups: { gps: overview.groups.gps } };
    expect(summarizeOverviewVehicleWindow(noObd, overview.from, overview.to + 1)).toBeNull();
  });

  it('rollUpVehicle sums the durations and deltas and takes the max of the extremes', () => {
    const a = summarizeOverviewVehicleWindow(overview, overview.from, T0 + 420_000)!;
    const b = summarizeOverviewVehicleWindow(overview, T0 + 420_000, overview.to + 1)!;
    const all = rollUpVehicle([a, b])!;
    expect(all.liveMs).toBe(a.liveMs + b.liveMs);
    expect(all.engineOnMs).toBe(a.engineOnMs! + b.engineOnMs!);
    expect(all.idleMs).toBe(a.idleMs! + b.idleMs!);
    expect(all.odometerDeltaKm).toBe(Math.round((a.odometerDeltaKm! + b.odometerDeltaKm!) * 10) / 10);
    expect(all.rpmMax).toBe(Math.max(a.rpmMax!, b.rpmMax!));
    expect(all.coolantMax).toBe(100);
    expect(all.refuels).toBe(1);
    expect(all.dtcEvents).toBe(1);
    expect(rollUpVehicle([])).toBeNull();
    expect(rollUpVehicle([{ ...a, engineOnMs: null, rpmMax: null }, b]).engineOnMs).toBe(b.engineOnMs);
  });

  it('readWindowInsights carries vehicle per session and in the totals, null for a session without obd', async () => {
    const gpsOnly = { ...overview, groups: { gps: overview.groups.gps } };
    const deps: WindowInsightsDeps = {
      async listSessions() {
        return [
          { id: 'a', status: 'closed', startedAt: new Date(T0), endedAt: new Date(T0 + 760_000), overviewKey: 'k/a', overviewBuiltAt: new Date(), overviewStale: false },
          { id: 'b', status: 'closed', startedAt: new Date(T0 + 800_000), endedAt: new Date(T0 + 900_000), overviewKey: 'k/b', overviewBuiltAt: new Date(), overviewStale: false },
          { id: 'c', status: 'open', startedAt: new Date(T0 + 900_000), endedAt: null, overviewKey: null, overviewBuiltAt: null, overviewStale: false },
        ];
      },
      async getOverview(key) {
        return key === 'k/a' ? overview : gpsOnly;
      },
    };
    const out = await readWindowInsights(DEVICE, { fromMs: T0, toMs: T0 + 1_000_000 }, deps);
    expect(out.sessions.map((s) => s.vehicle?.method ?? null)).toEqual(['overview-obd', null, null]);
    expect(out.vehicle).toEqual(out.sessions[0].vehicle);
    expect(out.partial).toBe(true);
    expect(out.distanceM).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { createInsightRun, type InsightSample } from '../src/services/telemetry-insights/index';
import {
  deviceStatusInsight,
  MAX_DEVICE_STATUS_EVENTS,
  mergeStatusRuns,
  type DeviceStatusSummaryV1,
} from '../src/services/telemetry-insights/device-status';

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

function run(samples: InsightSample[]) {
  const r = createInsightRun([deviceStatusInsight]);
  const metrics = new Set<string>();
  for (const s of samples) {
    r.feed(s);
    for (const k of Object.keys(s.values)) metrics.add(k);
  }
  return r.finish({ metrics, units: {}, rateHz: 1, from: samples[0]?.ts ?? null, to: samples.at(-1)?.ts ?? null }, T0);
}

/** 1 Hz samples from a list of [code, flags, seconds] stretches, starting at `start`. */
function session(stretches: Array<[number, number, number]>, start = T0): InsightSample[] {
  const out: InsightSample[] = [];
  let ts = start;
  for (const [code, flags, secs] of stretches) {
    for (let i = 0; i < secs; i++, ts += 1000) {
      out.push({ ts, values: { 'system.led_state': code, 'system.health_flags': flags, 'system.cpu_temp': 50 } });
    }
  }
  return out;
}

const summaryOf = (samples: InsightSample[]) => run(samples).deviceStatus as DeviceStatusSummaryV1;

describe('deviceStatus insight', () => {
  it('is omitted on a session without system.led_state', () => {
    const out = run([{ ts: T0, values: { 'system.cpu_temp': 40 } }, { ts: T0 + 1000, values: { 'system.cpu_temp': 41 } }]);
    expect(out.deviceStatus).toBeUndefined();
    expect(out.computed.deviceStatus).toBeUndefined();
  });

  it('times each code and flag from raw samples and lists contiguous runs', () => {
    // 1 starting (5 s) -> 0 healthy (60 s) -> 3 network, lte_down|mqtt_down (30 s) -> 2 gps_wait, gps_no_fix (20 s) -> 0 (10 s)
    const s = summaryOf(session([[1, 0, 5], [0, 0, 60], [3, 4 | 8, 30], [2, 16, 20], [0, 0, 10]]));
    expect(s.version).toBe(1);
    expect(s.worstCode).toBe(3);
    // The last sample holds for 0, so the final healthy stretch is 9 s.
    expect(s.byCodeMs).toEqual({ '0': 69_000, '1': 5_000, '2': 20_000, '3': 30_000, '4': 0, '5': 0, '6': 0 });
    expect(s.byFlagMs).toEqual({ '1': 0, '2': 0, '4': 30_000, '8': 30_000, '16': 20_000, '32': 0, '64': 0, '128': 0, '256': 0 });
    expect(s.events).toEqual([
      { kind: 'led_state', ts: T0, endTs: T0 + 5_000, value: 1 },
      { kind: 'led_state', ts: T0 + 5_000, endTs: T0 + 65_000, value: 0 },
      { kind: 'led_state', ts: T0 + 65_000, endTs: T0 + 95_000, value: 3 },
      { kind: 'led_state', ts: T0 + 95_000, endTs: T0 + 115_000, value: 2 },
      { kind: 'led_state', ts: T0 + 115_000, endTs: T0 + 124_000, value: 0 },
    ]);
    expect(s.truncated).toBeUndefined();
  });

  it('folds sub-2 s blips into the neighbour but still counts them', () => {
    const s = summaryOf(session([[0, 0, 30], [5, 1, 1], [0, 0, 30]]));
    expect(s.worstCode).toBe(5);
    expect(s.byCodeMs['5']).toBe(1_000);
    expect(s.byFlagMs['1']).toBe(1_000);
    expect(s.events).toEqual([{ kind: 'led_state', ts: T0, endTs: T0 + 60_000, value: 0 }]);
  });

  it('folds a leading blip into the run after it', () => {
    expect(
      mergeStatusRuns([
        { value: 1, ts: 0, endTs: 1000 },
        { value: 0, ts: 1000, endTs: 10_000 },
      ]),
    ).toEqual([{ value: 0, ts: 0, endTs: 10_000 }]);
  });

  it('caps a hold at 10 s and breaks the run at a recording hole', () => {
    const samples = [
      ...session([[3, 4, 10]]),
      // 5 minute hole, then the same code again.
      ...session([[3, 4, 10]], T0 + 10_000 + 300_000),
    ];
    const s = summaryOf(samples);
    // 9 s + capped 10 s across the hole + 9 s.
    expect(s.byCodeMs['3']).toBe(28_000);
    expect(s.byFlagMs['4']).toBe(28_000);
    expect(s.events).toEqual([
      { kind: 'led_state', ts: T0, endTs: T0 + 19_000, value: 3 },
      { kind: 'led_state', ts: T0 + 310_000, endTs: T0 + 319_000, value: 3 },
    ]);
  });

  it('ignores samples without led_state (other groups at other cadences)', () => {
    const samples: InsightSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({ ts: T0 + i * 1000, values: { 'system.led_state': i < 10 ? 2 : 0, 'system.health_flags': i < 10 ? 16 : 0 } });
      samples.push({ ts: T0 + i * 1000 + 500, values: { 'imu.accel_x': 0.1 } });
    }
    const s = summaryOf(samples);
    expect(s.byCodeMs['2']).toBe(10_000);
    expect(s.byCodeMs['0']).toBe(9_000);
    expect(s.byFlagMs['16']).toBe(10_000);
    expect(s.events.map((e) => e.value)).toEqual([2, 0]);
  });

  it('caps events at 500, keeping the longest, in time order, and flags truncated', () => {
    // 600 alternating runs; every 3rd one is longer (5 s) than the others (3 s).
    const stretches: Array<[number, number, number]> = [];
    for (let i = 0; i < 600; i++) stretches.push([i % 2 === 0 ? 0 : 3, 0, i % 3 === 0 ? 5 : 3]);
    const s = summaryOf(session(stretches));
    expect(s.truncated).toBe(true);
    expect(s.events).toHaveLength(MAX_DEVICE_STATUS_EVENTS);
    const sorted = [...s.events].sort((a, b) => a.ts - b.ts);
    expect(s.events).toEqual(sorted);
    // All 200 long runs survived.
    expect(s.events.filter((e) => e.endTs - e.ts === 5_000)).toHaveLength(200);
  });
});

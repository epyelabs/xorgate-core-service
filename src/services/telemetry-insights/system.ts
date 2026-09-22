import type { InsightComputer } from './types';
import { notComputable } from './types';
import { GPS_ACCEPT, round } from './gps-accept';

/** `system.throttled` bit flags (device agent/telemetry.ts): CURRENT state. */
const THROTTLED_UNDERVOLTAGE = 0x1;
const THROTTLED_ACTIVE = 0x4;

interface State {
  maxTempC: number | null;
  maxTempAt: number | null;
  tempSum: number;
  tempCount: number;
  prevTs: number | null;
  prevThrottled: number | null;
  throttledMs: number;
  undervoltageMs: number;
  sawThrottled: boolean;
}

/**
 * Thermal and power extremes: max / average CPU temperature, and how long the
 * SoC reported active throttling or under-voltage (time-weighted from the
 * current-state bitmask, legs longer than the gap break excluded).
 */
export const systemInsight: InsightComputer<State> = {
  id: 'system',
  v: 1,
  needs: ['system.cpu_temp'],
  init: () => ({
    maxTempC: null,
    maxTempAt: null,
    tempSum: 0,
    tempCount: 0,
    prevTs: null,
    prevThrottled: null,
    throttledMs: 0,
    undervoltageMs: 0,
    sawThrottled: false,
  }),
  feed(s, sample) {
    const temp = sample.values['system.cpu_temp'];
    if (temp !== undefined && Number.isFinite(temp)) {
      if (s.maxTempC === null || temp > s.maxTempC) {
        s.maxTempC = temp;
        s.maxTempAt = sample.ts;
      }
      s.tempSum += temp;
      s.tempCount++;
    }
    const throttled = sample.values['system.throttled'];
    if (throttled !== undefined) s.sawThrottled = true;
    if (s.prevTs !== null && s.prevThrottled !== null) {
      const dt = sample.ts - s.prevTs;
      if (dt > 0 && dt <= GPS_ACCEPT.breakGapMs) {
        if (s.prevThrottled & THROTTLED_ACTIVE) s.throttledMs += dt;
        if (s.prevThrottled & THROTTLED_UNDERVOLTAGE) s.undervoltageMs += dt;
      }
    }
    s.prevTs = sample.ts;
    s.prevThrottled = throttled ?? null;
  },
  finish(s) {
    if (s.tempCount === 0) return null;
    return {
      summary: {
        maxCpuTempC: round(s.maxTempC as number, 1),
        maxCpuTempAt: s.maxTempAt,
        avgCpuTempC: round(s.tempSum / s.tempCount, 1),
        throttledMs: s.sawThrottled ? s.throttledMs : notComputable('no-metric'),
        undervoltageMs: s.sawThrottled ? s.undervoltageMs : notComputable('no-metric'),
      },
    };
  },
};

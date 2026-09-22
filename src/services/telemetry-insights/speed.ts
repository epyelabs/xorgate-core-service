import type { InsightComputer } from './types';
import { MOVING_THRESHOLD_KPH, round } from './gps-accept';

interface State {
  seen: number;
  maxKph: number;
  maxTs: number | null;
  movingSum: number;
  movingCount: number;
}

/** Max and average-while-moving speed from the receiver's own `gps.speed` (km/h). */
export const speedInsight: InsightComputer<State> = {
  id: 'speed',
  v: 1,
  needs: ['gps.speed'],
  init: () => ({ seen: 0, maxKph: 0, maxTs: null, movingSum: 0, movingCount: 0 }),
  feed(s, sample) {
    const v = sample.values['gps.speed'];
    if (v === undefined || !Number.isFinite(v) || v < 0) return;
    s.seen++;
    // >= so a session that never moves still records WHEN its (zero) max was.
    if (s.maxTs === null || v > s.maxKph) {
      s.maxKph = v;
      s.maxTs = sample.ts;
    }
    if (v > MOVING_THRESHOLD_KPH) {
      s.movingSum += v;
      s.movingCount++;
    }
  },
  finish(s) {
    if (s.seen === 0) return null;
    return {
      summary: {
        maxKph: round(s.maxKph, 1),
        maxAt: s.maxTs,
        avgMovingKph: s.movingCount > 0 ? round(s.movingSum / s.movingCount, 1) : 0,
        movingThresholdKph: MOVING_THRESHOLD_KPH,
        unit: 'km/h',
        source: 'gps.speed',
      },
    };
  },
};

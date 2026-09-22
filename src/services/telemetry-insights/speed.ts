import type { InsightComputer } from './types';
import { MOVING_THRESHOLD_KPH, round } from './gps-accept';

interface State {
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
  init: () => ({ maxKph: 0, maxTs: null, movingSum: 0, movingCount: 0 }),
  feed(s, sample) {
    const v = sample.values['gps.speed'];
    if (v === undefined || !Number.isFinite(v) || v < 0) return;
    if (v > s.maxKph) {
      s.maxKph = v;
      s.maxTs = sample.ts;
    }
    if (v > MOVING_THRESHOLD_KPH) {
      s.movingSum += v;
      s.movingCount++;
    }
  },
  finish(s) {
    if (s.maxTs === null) return null;
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

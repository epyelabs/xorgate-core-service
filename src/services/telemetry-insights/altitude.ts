import type { InsightComputer } from './types';
import { acceptedFix, round } from './gps-accept';

/** Altitude has to move this far from the last turning point to count as climbing or descending. */
export const ALTITUDE_HYSTERESIS_M = 3;

interface State {
  minM: number | null;
  maxM: number | null;
  ref: number | null;
  gainM: number;
  lossM: number;
}

/**
 * Min / max / cumulative gain and loss of `gps.alt` over accepted fixes, with a
 * 3 m hysteresis so GPS altitude noise (a few metres at rest) does not read as
 * a mountain over an hour.
 */
export const altitudeInsight: InsightComputer<State> = {
  id: 'altitude',
  v: 1,
  needs: ['gps.alt'],
  init: () => ({ minM: null, maxM: null, ref: null, gainM: 0, lossM: 0 }),
  feed(s, sample) {
    const alt = sample.values['gps.alt'];
    if (alt === undefined || !Number.isFinite(alt)) return;
    if (!acceptedFix(sample)) return;
    if (s.minM === null || alt < s.minM) s.minM = alt;
    if (s.maxM === null || alt > s.maxM) s.maxM = alt;
    if (s.ref === null) {
      s.ref = alt;
      return;
    }
    const delta = alt - s.ref;
    if (delta >= ALTITUDE_HYSTERESIS_M) {
      s.gainM += delta;
      s.ref = alt;
    } else if (-delta >= ALTITUDE_HYSTERESIS_M) {
      s.lossM += -delta;
      s.ref = alt;
    }
  },
  finish(s) {
    if (s.minM === null || s.maxM === null) return null;
    return {
      summary: {
        minM: round(s.minM, 1),
        maxM: round(s.maxM, 1),
        gainM: round(s.gainM, 1),
        lossM: round(s.lossM, 1),
        hysteresisM: ALTITUDE_HYSTERESIS_M,
        unit: 'm',
      },
    };
  },
};

import type { InsightComputer } from './types';
import { notComputable } from './types';
import { acceptedFix, GPS_ACCEPT, haversineM, MOVING_THRESHOLD_KPH, round, type Fix } from './gps-accept';

/**
 * Dead-band for a receiver that reports no `gps.speed`: a leg shorter than
 * this from the last anchored fix is jitter, not travel. Two parked fixes
 * scattered +-3 m per axis can sit 8.5 m apart, so 5 m leaks (measured: ~60 m
 * per half hour in the unit test); 10 m does not, and is still under one
 * second of driving, so a moving trace loses nothing. Walking pace (1.4 m/s)
 * accumulates in 10 m steps, a slight undercount on tight curves only.
 */
export const MIN_STEP_M = 10;

interface State {
  prev: (Fix & { speedKph: number | null }) | null;
  /** Dead-band anchor (no-speed rule only). */
  anchor: Fix | null;
  meters: number;
  crossCheckMeters: number;
  crossCheckLegs: number;
  fixesUsed: number;
  fixesRejected: number;
  sawSpeed: boolean;
}

/**
 * Total distance travelled: haversine over consecutive ACCEPTED fixes, with
 * the acceptance rule and a speed-integral cross-check recorded next to the
 * number (README §4.1). Three things stop GPS drift while parked from
 * inflating it:
 *  - the shared acceptance rule (fix quality, HDOP);
 *  - a jump rule: a leg implying > 60 m/s is a glitch and is rejected;
 *  - a stationary rule: with `gps.speed` present, a leg counts only when the
 *    receiver says it was moving at either end (Doppler speed is reliable at
 *    rest); without it, a 5 m dead-band anchor.
 * No accumulation across a gap longer than the break window; the chain
 * restarts at the next fix.
 */
export const distanceInsight: InsightComputer<State> = {
  id: 'distance',
  v: 1,
  needs: ['gps.lat', 'gps.lon'],
  init: () => ({
    prev: null,
    anchor: null,
    meters: 0,
    crossCheckMeters: 0,
    crossCheckLegs: 0,
    fixesUsed: 0,
    fixesRejected: 0,
    sawSpeed: false,
  }),
  feed(s, sample) {
    if (sample.values['gps.lat'] === undefined && sample.values['gps.lon'] === undefined) return;
    const fix = acceptedFix(sample);
    if (!fix) {
      s.fixesRejected++;
      return;
    }
    const speedRaw = sample.values['gps.speed'];
    const speedKph = speedRaw !== undefined && Number.isFinite(speedRaw) ? speedRaw : null;
    if (speedKph !== null) s.sawSpeed = true;

    const prev = s.prev;
    if (prev && fix.ts > prev.ts && fix.ts - prev.ts <= GPS_ACCEPT.breakGapMs) {
      const dtS = (fix.ts - prev.ts) / 1000;
      const legM = haversineM(prev, fix);
      if (legM / dtS > GPS_ACCEPT.maxJumpMps) {
        // A glitch fix. Reject it and keep the chain anchored on the previous
        // good fix, so one bad sample costs nothing.
        s.fixesRejected++;
        return;
      }
      s.fixesUsed++;
      if (speedKph !== null || prev.speedKph !== null) {
        const moving =
          (speedKph ?? 0) > MOVING_THRESHOLD_KPH || (prev.speedKph ?? 0) > MOVING_THRESHOLD_KPH;
        if (moving) {
          s.meters += legM;
          const vPrev = ((prev.speedKph ?? speedKph) as number) / 3.6;
          const vCur = ((speedKph ?? prev.speedKph) as number) / 3.6;
          s.crossCheckMeters += ((vPrev + vCur) / 2) * dtS;
          s.crossCheckLegs++;
        }
        s.anchor = fix;
      } else {
        // No speed anywhere on this leg: dead-band against the anchor.
        const anchor = s.anchor ?? prev;
        const fromAnchorM = haversineM(anchor, fix);
        if (fromAnchorM >= MIN_STEP_M) {
          s.meters += fromAnchorM;
          s.anchor = fix;
        }
      }
    } else {
      // First fix, or the chain broke on a gap: restart here.
      s.fixesUsed++;
      s.anchor = fix;
    }
    s.prev = { ...fix, speedKph };
  },
  finish(s) {
    if (s.fixesUsed === 0 && s.fixesRejected === 0) return null;
    return {
      summary: {
        meters: round(s.meters, 1),
        unit: 'm',
        method: 'haversine-2d',
        accept: {
          ...GPS_ACCEPT,
          stationaryRule: s.sawSpeed ? 'speed' : 'dead-band',
          movingThresholdKph: MOVING_THRESHOLD_KPH,
          minStepM: MIN_STEP_M,
        },
        fixesUsed: s.fixesUsed,
        fixesRejected: s.fixesRejected,
        crossCheckMeters: s.sawSpeed ? round(s.crossCheckMeters, 1) : notComputable('no-speed'),
      },
    };
  },
};

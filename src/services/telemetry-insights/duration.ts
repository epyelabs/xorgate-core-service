import type { InsightComputer } from './types';
import { GPS_ACCEPT, MOVING_THRESHOLD_KPH } from './gps-accept';
import { notComputable } from './types';

interface State {
  first: number | null;
  last: number | null;
  prevTs: number | null;
  prevSpeed: number | null;
  /** Time covered by consecutive samples closer than the gap break. */
  recordedMs: number;
  movingMs: number;
  idleMs: number;
  sawSpeed: boolean;
}

/**
 * Total / moving / idle time. `totalMs` is wall time first sample to last;
 * `recordedMs` excludes holes longer than the gap break (a device that was off
 * for an hour mid-session is not "idle" for that hour, it is absent). Moving vs
 * idle is decided per leg by `gps.speed` at its start, against the shared
 * moving threshold; without `gps.speed` both are not computable.
 */
export const durationInsight: InsightComputer<State> = {
  id: 'duration',
  v: 1,
  needs: [],
  init: () => ({
    first: null,
    last: null,
    prevTs: null,
    prevSpeed: null,
    recordedMs: 0,
    movingMs: 0,
    idleMs: 0,
    sawSpeed: false,
  }),
  feed(s, sample) {
    const { ts } = sample;
    if (s.first === null || ts < s.first) s.first = ts;
    if (s.last === null || ts > s.last) s.last = ts;
    const speed = sample.values['gps.speed'];
    if (speed !== undefined) s.sawSpeed = true;
    if (s.prevTs !== null) {
      const dt = ts - s.prevTs;
      if (dt > 0 && dt <= GPS_ACCEPT.breakGapMs) {
        s.recordedMs += dt;
        if (s.prevSpeed !== null) {
          if (s.prevSpeed > MOVING_THRESHOLD_KPH) s.movingMs += dt;
          else s.idleMs += dt;
        }
      }
    }
    s.prevTs = ts;
    s.prevSpeed = speed ?? null;
  },
  finish(s) {
    if (s.first === null || s.last === null) return null;
    return {
      summary: {
        totalMs: s.last - s.first,
        recordedMs: s.recordedMs,
        movingMs: s.sawSpeed ? s.movingMs : notComputable('no-speed'),
        idleMs: s.sawSpeed ? s.idleMs : notComputable('no-speed'),
        movingThresholdKph: MOVING_THRESHOLD_KPH,
        breakGapMs: GPS_ACCEPT.breakGapMs,
      },
    };
  },
};

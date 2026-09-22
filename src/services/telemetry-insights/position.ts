import type { InsightComputer } from './types';
import { acceptedFix, type Fix } from './gps-accept';

interface State {
  start: Fix | null;
  end: Fix | null;
}

/** First and last accepted fix, as [lon, lat] (GeoJSON order, like bbox). */
export const positionInsight: InsightComputer<State> = {
  id: 'position',
  v: 1,
  needs: ['gps.lat', 'gps.lon'],
  init: () => ({ start: null, end: null }),
  feed(s, sample) {
    const fix = acceptedFix(sample);
    if (!fix) return;
    if (s.start === null || fix.ts < s.start.ts) s.start = fix;
    if (s.end === null || fix.ts >= s.end.ts) s.end = fix;
  },
  finish(s) {
    if (!s.start || !s.end) return null;
    return {
      summary: {
        start: [s.start.lon, s.start.lat],
        startAt: s.start.ts,
        end: [s.end.lon, s.end.lat],
        endAt: s.end.ts,
      },
    };
  },
};

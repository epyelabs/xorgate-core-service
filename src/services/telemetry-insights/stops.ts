import type { InsightComputer, InsightEvent } from './types';
import { acceptedFix, GPS_ACCEPT, MOVING_THRESHOLD_KPH } from './gps-accept';

/** A stop has to last this long to be an event (shorter is a traffic light). */
export const MIN_STOP_MS = 60_000;
/** Events per session, hard cap (README D12: bounded lists). */
export const MAX_STOP_EVENTS = 200;

interface Open {
  ts: number;
  lastTs: number;
  position?: [number, number];
}

interface State {
  open: Open | null;
  prevTs: number | null;
  events: InsightEvent[];
  dropped: number;
  totalMs: number;
}

function close(s: State, endTs: number): void {
  const open = s.open;
  s.open = null;
  if (!open || endTs - open.ts < MIN_STOP_MS) return;
  s.totalMs += endTs - open.ts;
  if (s.events.length >= MAX_STOP_EVENTS) {
    s.dropped++;
    return;
  }
  const event: InsightEvent = { kind: 'stop', ts: open.ts, endTs };
  if (open.position) event.position = open.position;
  s.events.push(event);
}

/**
 * Stops: `gps.speed` at or below the moving threshold for at least a minute.
 * Each event carries the position where the stop began (first accepted fix
 * inside it). A recording hole longer than the gap break ends a stop at the
 * last sample before the hole rather than spanning it.
 */
export const stopsInsight: InsightComputer<State> = {
  id: 'stops',
  v: 1,
  needs: ['gps.speed'],
  init: () => ({ open: null, prevTs: null, events: [], dropped: 0, totalMs: 0 }),
  feed(s, sample) {
    const speed = sample.values['gps.speed'];
    if (speed === undefined || !Number.isFinite(speed)) return;
    const { ts } = sample;
    if (s.open && s.prevTs !== null && ts - s.prevTs > GPS_ACCEPT.breakGapMs) close(s, s.prevTs);
    if (speed <= MOVING_THRESHOLD_KPH) {
      if (!s.open) s.open = { ts, lastTs: ts };
      else s.open.lastTs = ts;
      if (!s.open.position) {
        const fix = acceptedFix(sample);
        if (fix) s.open.position = [fix.lon, fix.lat];
      }
    } else if (s.open) {
      close(s, ts);
    }
    s.prevTs = ts;
  },
  finish(s) {
    if (s.open) close(s, s.open.lastTs);
    return {
      summary: {
        count: s.events.length + s.dropped,
        totalMs: s.totalMs,
        minStopMs: MIN_STOP_MS,
        speedThresholdKph: MOVING_THRESHOLD_KPH,
        truncated: s.dropped > 0,
      },
      events: s.events,
    };
  },
};

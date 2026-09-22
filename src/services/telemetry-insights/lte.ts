import type { InsightComputer } from './types';
import { notComputable } from './types';
import { round } from './gps-accept';

interface State {
  minRssi: number | null;
  minRssiAt: number | null;
  maxRssi: number | null;
  rssiSum: number;
  rssiCount: number;
  prevResets: number | null;
  resets: number;
  sawResets: boolean;
}

/**
 * Cellular link extremes: min / avg / max `lte.rssi` (dBm), and the number of
 * modem resets during the session, read as the positive increments of the
 * daemon's rolling `lte.resets_24h` counter.
 */
export const lteInsight: InsightComputer<State> = {
  id: 'lte',
  v: 1,
  needs: ['lte.rssi'],
  init: () => ({
    minRssi: null,
    minRssiAt: null,
    maxRssi: null,
    rssiSum: 0,
    rssiCount: 0,
    prevResets: null,
    resets: 0,
    sawResets: false,
  }),
  feed(s, sample) {
    const rssi = sample.values['lte.rssi'];
    if (rssi !== undefined && Number.isFinite(rssi)) {
      if (s.minRssi === null || rssi < s.minRssi) {
        s.minRssi = rssi;
        s.minRssiAt = sample.ts;
      }
      if (s.maxRssi === null || rssi > s.maxRssi) s.maxRssi = rssi;
      s.rssiSum += rssi;
      s.rssiCount++;
    }
    const resets = sample.values['lte.resets_24h'];
    if (resets !== undefined && Number.isFinite(resets)) {
      s.sawResets = true;
      if (s.prevResets !== null && resets > s.prevResets) s.resets += resets - s.prevResets;
      s.prevResets = resets;
    }
  },
  finish(s) {
    if (s.rssiCount === 0) return null;
    return {
      summary: {
        minRssi: s.minRssi,
        minRssiAt: s.minRssiAt,
        avgRssi: round(s.rssiSum / s.rssiCount, 1),
        maxRssi: s.maxRssi,
        unit: 'dBm',
        resets: s.sawResets ? s.resets : notComputable('no-metric'),
      },
    };
  },
};

import type { InsightComputer } from './types';
import { notComputable } from './types';
import { GPS_ACCEPT, round } from './gps-accept';

interface State {
  samples: number;
  fixes: number;
  qualitySeen: boolean;
  satSum: number;
  satCount: number;
  hdopSum: number;
  hdopCount: number;
}

/**
 * How trustworthy the trace is: the share of GPS samples with a real fix, and
 * the average satellite count and HDOP. `fixRatio` needs `gps.fix_quality`;
 * without it every sample with a position is assumed a fix.
 */
export const gpsQualityInsight: InsightComputer<State> = {
  id: 'gpsQuality',
  v: 1,
  needs: ['gps.lat'],
  init: () => ({
    samples: 0,
    fixes: 0,
    qualitySeen: false,
    satSum: 0,
    satCount: 0,
    hdopSum: 0,
    hdopCount: 0,
  }),
  feed(s, sample) {
    const { values } = sample;
    if (values['gps.lat'] === undefined && values['gps.fix_quality'] === undefined) return;
    s.samples++;
    const q = values['gps.fix_quality'];
    if (q !== undefined) {
      s.qualitySeen = true;
      if (q >= GPS_ACCEPT.minFixQuality) s.fixes++;
    }
    const sats = values['gps.satellites'];
    if (sats !== undefined && Number.isFinite(sats)) {
      s.satSum += sats;
      s.satCount++;
    }
    const hdop = values['gps.hdop'];
    if (hdop !== undefined && Number.isFinite(hdop)) {
      s.hdopSum += hdop;
      s.hdopCount++;
    }
  },
  finish(s) {
    if (s.samples === 0) return null;
    return {
      summary: {
        samples: s.samples,
        fixRatio: s.qualitySeen ? round(s.fixes / s.samples, 3) : notComputable('no-fix-quality'),
        avgSatellites: s.satCount > 0 ? round(s.satSum / s.satCount, 1) : notComputable('no-metric'),
        avgHdop: s.hdopCount > 0 ? round(s.hdopSum / s.hdopCount, 2) : notComputable('no-metric'),
      },
    };
  },
};

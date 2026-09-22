import type { InsightSample } from './types';

/**
 * The GPS fix acceptance rule every position-derived insight shares (README
 * Q11, accepted): a fix counts when it has a real solution and a sane
 * dilution. Legs between accepted fixes are additionally gated by the jump
 * and gap rules in the distance computer. Written down once, and recorded
 * inside the distance summary (`accept`), so the number carries its own
 * methodology.
 */
export const GPS_ACCEPT = {
  minFixQuality: 1,
  maxHdop: 5,
  maxJumpMps: 60,
  breakGapMs: 30_000,
} as const;

/** `gps.speed` (km/h) at or below this is "not moving" (README D12, Q11). */
export const MOVING_THRESHOLD_KPH = 2;

export interface Fix {
  ts: number;
  lat: number;
  lon: number;
}

/**
 * The accepted fix in a sample, or null. `fix_quality` / `hdop` gate only when
 * the device reports them (a receiver that emits neither is still a receiver);
 * lat/lon must be finite, in range, and not the (0, 0) "no fix" placeholder.
 */
export function acceptedFix(sample: InsightSample): Fix | null {
  const { values } = sample;
  const lat = values['gps.lat'];
  const lon = values['gps.lon'];
  if (lat === undefined || lon === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const quality = values['gps.fix_quality'];
  if (quality !== undefined && quality < GPS_ACCEPT.minFixQuality) return null;
  const hdop = values['gps.hdop'];
  if (hdop !== undefined && hdop > GPS_ACCEPT.maxHdop) return null;
  return { ts: sample.ts, lat, lon };
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres (2-D, ignores altitude). */
export function haversineM(a: Fix, b: Fix): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Round to a fixed number of decimals for a stable, compact artifact. */
export const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

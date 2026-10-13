import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import { GPS_ACCEPT, haversineM, MOVING_THRESHOLD_KPH, round, type Fix } from './telemetry-insights/gps-accept';
import { MIN_STEP_M } from './telemetry-insights/distance';
import { feedVehicle, finishVehicle, initVehicleState } from './telemetry-insights/vehicle';
import type { OverviewV1 } from './telemetry-overview';

/**
 * Windowed telemetry insights (`GET /devices/{id}/telemetry/insights?from&to`).
 *
 * A telemetry session and a media run are different id spaces joined by
 * time, and the two do not line up at their edges: the recorder starts at
 * boot, the camera after its boot defer and GPS gate, and a reboot mid-drive
 * splits the telemetry into sessions the video never sees. Summing whole
 * sessions that merely overlap a run (the first Q12 reading) therefore
 * counts a parked 36-second overlap as a whole drive. This reads the WINDOW:
 * for every session overlapping [from, to) with a built overview, the GPS
 * grid of the overview clipped to the window, integrated with the same
 * rules the session's own `insights.distance` uses (accepted fixes, the
 * 60 m/s jump reject, the 30 s gap break, the `gps.speed` stationary rule
 * or the 10 m dead-band without speed). The grid is bucketed (2 s for a
 * drive), so the answer is within about a percent of the raw-sample number,
 * and the summary says so (`method: "overview-haversine"`).
 *
 * One S3 GET per overlapping built session; an open or unbuilt session is
 * reported with `source: "unbuilt"` and no numbers rather than guessed.
 *
 * `vehicle` (obd2-bluetooth-integration P4) runs the session `vehicle`
 * insight's accumulator over the overview's `obd` grid clipped to the window,
 * so a run's engine-on, idle, fuel-used and odometer-delta numbers follow the
 * same rules as the whole-session insight (gated on `obd.link === 2`, legs
 * broken at 30 s). Totals SUM `liveMs`, `engineOnMs`, `idleMs`,
 * `fuelUsedPct`, `odometerDeltaKm`, `refuels` and `dtcEvents` and take the
 * MAX of `rpmMax` and `coolantMax`; fuel start/end, odometer start/end and
 * the event lists are per session and are not rolled up (read the session's
 * own insight for those). `null` when no overlapping built session carries
 * an `obd` grid with a live bucket inside the window.
 */

export interface WindowGpsSummary {
  /** Metres over accepted legs inside the window. */
  distanceM: number;
  /** Milliseconds of legs the receiver called moving (or that advanced the dead-band anchor). */
  movingMs: number;
  /** Bucket points inside the window that carried an accepted fix. */
  fixes: number;
  /** First and last accepted fix inside the window, epoch ms; null when none. */
  from: number | null;
  to: number | null;
  method: 'overview-haversine';
}

/** The vehicle (OBD-II) numbers of one session inside the window; see the module note for what rolls up. */
export interface WindowVehicleSummary {
  /** Milliseconds with `obd.link === 2` inside the window. */
  liveMs: number;
  /** Milliseconds with the engine running (`obd.rpm > 0`); null when the vehicle reports no rpm. */
  engineOnMs: number | null;
  /** Engine running and not moving (`obd.speed`, else `gps.speed`, at or under the moving threshold); null without a speed. */
  idleMs: number | null;
  /** `max(0, first - last)` of `obd.fuel_level` inside the window; null without the metric. */
  fuelUsedPct: number | null;
  /** `last - first` of `obd.odometer` inside the window (a GPS cross-check, never the distance); null without the metric. */
  odometerDeltaKm: number | null;
  rpmMax: number | null;
  coolantMax: number | null;
  refuels: number;
  dtcEvents: number;
  method: 'overview-obd';
}

export interface WindowInsightsSession {
  id: string;
  status: string;
  /** The session's own bounds (ISO). */
  from: string;
  to: string;
  /** Milliseconds of [from, to) this session's bounds cover. */
  overlapMs: number;
  /** `overview` when the numbers come from the built artifact, `unbuilt` when there is none yet. */
  source: 'overview' | 'unbuilt';
  distanceM: number | null;
  movingMs: number | null;
  fixes: number | null;
  /** Null when unbuilt, or built without a live OBD bucket inside the window. */
  vehicle: WindowVehicleSummary | null;
}

export interface WindowInsights {
  from: string;
  to: string;
  sessions: WindowInsightsSession[];
  /** Sum over the sessions with numbers; null when none has any. */
  distanceM: number | null;
  movingMs: number | null;
  /** Milliseconds of the window covered by any session's bounds (clipped, not double counted). */
  telemetryMs: number;
  /** True when at least one overlapping session has no built overview yet. */
  partial: boolean;
  /** Roll-up over the sessions with a `vehicle` summary (sums, and max for rpm/coolant); null when none has one. */
  vehicle: WindowVehicleSummary | null;
}

interface Pt extends Fix {
  speedKph: number | null;
}

/**
 * The window summary of one overview object (pure). `null` when the overview
 * carries no GPS grid or no accepted fix inside the window.
 */
export function summarizeOverviewWindow(overview: OverviewV1, fromMs: number, toMs: number): WindowGpsSummary | null {
  const gps = overview.groups?.gps;
  if (!gps) return null;
  const lat = gps.values['gps.lat'];
  const lon = gps.values['gps.lon'];
  if (!lat || !lon) return null;
  const speed = gps.values['gps.speed'];
  const quality = gps.values['gps.fix_quality'];
  const hdop = gps.values['gps.hdop'];

  let meters = 0;
  let movingMs = 0;
  let fixes = 0;
  let first: number | null = null;
  let last: number | null = null;
  let prev: Pt | null = null;
  let anchor: Fix | null = null;

  for (let i = 0; i < gps.ts.length; i++) {
    const ts = gps.ts[i];
    if (ts < fromMs) continue;
    if (ts >= toMs) break;
    const la = lat[i];
    const lo = lon[i];
    if (la === null || lo === null || la === undefined || lo === undefined) continue;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (la === 0 && lo === 0) continue;
    const q = quality?.[i];
    if (q !== null && q !== undefined && q < GPS_ACCEPT.minFixQuality) continue;
    const h = hdop?.[i];
    if (h !== null && h !== undefined && h > GPS_ACCEPT.maxHdop) continue;
    const sp = speed?.[i];
    const speedKph = sp !== null && sp !== undefined && Number.isFinite(sp) ? sp : null;
    const fix: Fix = { ts, lat: la, lon: lo };
    fixes++;
    if (first === null) first = ts;
    last = ts;

    if (prev && ts > prev.ts && ts - prev.ts <= GPS_ACCEPT.breakGapMs) {
      const dtMs = ts - prev.ts;
      const legM = haversineM(prev, fix);
      if (legM / (dtMs / 1000) > GPS_ACCEPT.maxJumpMps) {
        // A glitch bucket: keep the chain on the previous good point.
        continue;
      }
      if (speedKph !== null || prev.speedKph !== null) {
        const moving = (speedKph ?? 0) > MOVING_THRESHOLD_KPH || (prev.speedKph ?? 0) > MOVING_THRESHOLD_KPH;
        if (moving) {
          meters += legM;
          movingMs += dtMs;
        }
        anchor = fix;
      } else {
        const base = anchor ?? prev;
        const fromAnchorM = haversineM(base, fix);
        if (fromAnchorM >= MIN_STEP_M) {
          meters += fromAnchorM;
          movingMs += dtMs;
          anchor = fix;
        }
      }
    } else {
      anchor = fix;
    }
    prev = { ...fix, speedKph };
  }
  if (fixes === 0) return null;
  return { distanceM: round(meters, 1), movingMs, fixes, from: first, to: last, method: 'overview-haversine' };
}

/**
 * The vehicle summary of one overview object inside the window (pure): the
 * session `vehicle` insight's accumulator fed the `obd` grid's buckets in
 * order, with the `gps` grid's speed replayed ahead of each one for the
 * no-`obd.speed` fallback. `null` without an `obd` grid or without a live
 * bucket inside the window.
 */
export function summarizeOverviewVehicleWindow(overview: OverviewV1, fromMs: number, toMs: number): WindowVehicleSummary | null {
  const obd = overview.groups?.obd;
  if (!obd || !obd.values['obd.link']) return null;
  const gps = overview.groups?.gps;
  const gpsTs = gps?.ts ?? [];
  const gpsSpeed = gps?.values['gps.speed'];
  const metrics = Object.keys(obd.values);
  const state = initVehicleState();
  let g = 0;
  for (let i = 0; i < obd.ts.length; i++) {
    const ts = obd.ts[i];
    if (ts < fromMs) continue;
    if (ts >= toMs) break;
    if (gpsSpeed) {
      while (g < gpsTs.length && gpsTs[g] <= ts) {
        const v = gpsSpeed[g];
        if (v !== null && v !== undefined) feedVehicle(state, gpsTs[g], { 'gps.speed': v });
        g++;
      }
    }
    const values: Record<string, number | null> = {};
    for (const m of metrics) values[m] = obd.values[m][i];
    feedVehicle(state, ts, values);
  }
  const out = finishVehicle(state);
  if (!out) return null;
  const v = out.summary;
  const n = <T extends { value: null }>(x: T | Record<string, unknown>, key: string): number | null =>
    'value' in x && x.value === null ? null : ((x as Record<string, number>)[key] ?? null);
  return {
    liveMs: v.link.liveMs,
    engineOnMs: n(v.engineOn, 'ms'),
    idleMs: n(v.idle, 'ms'),
    fuelUsedPct: n(v.fuel, 'usedPct'),
    odometerDeltaKm: n(v.odometer, 'deltaKm'),
    rpmMax: n(v.rpm, 'max'),
    coolantMax: n(v.coolant, 'max'),
    refuels: n(v.fuel, 'refuels') ?? 0,
    dtcEvents: n(v.dtc, 'events') ?? 0,
    method: 'overview-obd',
  };
}

/** Fold per-session vehicle summaries: sums, and max for the two extremes. */
export function rollUpVehicle(parts: WindowVehicleSummary[]): WindowVehicleSummary | null {
  if (parts.length === 0) return null;
  const sum = (pick: (p: WindowVehicleSummary) => number | null, decimals: number): number | null => {
    let acc: number | null = null;
    for (const p of parts) {
      const x = pick(p);
      if (x !== null) acc = (acc ?? 0) + x;
    }
    return acc === null ? null : round(acc, decimals);
  };
  const max = (pick: (p: WindowVehicleSummary) => number | null): number | null => {
    let acc: number | null = null;
    for (const p of parts) {
      const x = pick(p);
      if (x !== null && (acc === null || x > acc)) acc = x;
    }
    return acc;
  };
  return {
    liveMs: sum((p) => p.liveMs, 0) ?? 0,
    engineOnMs: sum((p) => p.engineOnMs, 0),
    idleMs: sum((p) => p.idleMs, 0),
    fuelUsedPct: sum((p) => p.fuelUsedPct, 2),
    odometerDeltaKm: sum((p) => p.odometerDeltaKm, 1),
    rpmMax: max((p) => p.rpmMax),
    coolantMax: max((p) => p.coolantMax),
    refuels: sum((p) => p.refuels, 0) ?? 0,
    dtcEvents: sum((p) => p.dtcEvents, 0) ?? 0,
    method: 'overview-obd',
  };
}

export interface WindowSessionRow {
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  overviewKey: string | null;
  overviewBuiltAt: Date | null;
  overviewStale: boolean;
}

export interface WindowInsightsDeps {
  /** Sessions of the device whose bounds overlap [fromMs, toMs), oldest first. */
  listSessions(deviceId: string, fromMs: number, toMs: number): Promise<WindowSessionRow[]>;
  /** The parsed overview object, or null when the object is gone. */
  getOverview(key: string): Promise<OverviewV1 | null>;
}

const BUCKET = process.env.BUCKET_NAME;
const s3 = new S3Client({});

export const windowInsightsDeps: WindowInsightsDeps = {
  async listSessions(deviceId, fromMs, toMs) {
    const t = schema.telemetrySessions;
    return db
      .select({
        id: t.id,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        overviewKey: t.overviewKey,
        overviewBuiltAt: t.overviewBuiltAt,
        overviewStale: t.overviewStale,
      })
      .from(t)
      .where(
        and(
          eq(t.deviceId, deviceId),
          sql`coalesce(${t.endedAt}, ${t.startedAt}) >= ${tsParam(new Date(fromMs).toISOString())}`,
          sql`${t.startedAt} < ${tsParam(new Date(toMs).toISOString())}`,
        ),
      )
      .orderBy(asc(t.startedAt));
  },
  async getOverview(key) {
    if (!BUCKET) throw new Error('BUCKET_NAME is not set');
    let bytes: Buffer;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      bytes = Buffer.from(await obj.Body!.transformToByteArray());
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
    const text = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    return JSON.parse(text) as OverviewV1;
  },
};

/** Milliseconds of [fromMs, toMs) covered by the union of the given spans. */
function coveredMs(spans: Array<[number, number]>, fromMs: number, toMs: number): number {
  const clipped = spans
    .map(([a, b]): [number, number] => [Math.max(a, fromMs), Math.min(b, toMs)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curFrom = -Infinity;
  let curTo = -Infinity;
  for (const [a, b] of clipped) {
    if (a > curTo) {
      if (curTo > curFrom) total += curTo - curFrom;
      curFrom = a;
      curTo = b;
    } else if (b > curTo) {
      curTo = b;
    }
  }
  if (curTo > curFrom) total += curTo - curFrom;
  return total;
}

export async function readWindowInsights(
  deviceId: string,
  window: { fromMs: number; toMs: number },
  deps: WindowInsightsDeps = windowInsightsDeps,
): Promise<WindowInsights> {
  const rows = await deps.listSessions(deviceId, window.fromMs, window.toMs);
  return insightsFromRows(rows, window, (key) => deps.getOverview(key));
}

/** Most windows one batch read accepts (a page of media runs is 25 by default). */
export const WINDOW_INSIGHTS_BATCH_MAX = 100;

/** Overview objects read at once by a batch. */
const OVERVIEW_FETCH_CONCURRENCY = 8;

/**
 * The batch form of `readWindowInsights`: one result per window, in order.
 * What a page of media runs needs, and why it exists: the per-window read
 * repeats auth, the ownership check, close-on-read and the session query
 * for every run on the page, about seven sequential Data API round trips
 * each. Here the device's sessions are listed ONCE over the windows' span,
 * and each overview object is read ONCE however many windows it overlaps
 * (adjacent runs usually share a telemetry session). The per-window numbers
 * are exactly the single read's: the same rows, filtered by the same overlap
 * rule, folded by the same function.
 */
export async function readWindowInsightsBatch(
  deviceId: string,
  windows: Array<{ fromMs: number; toMs: number }>,
  deps: WindowInsightsDeps = windowInsightsDeps,
): Promise<WindowInsights[]> {
  if (windows.length === 0) return [];
  const spanFrom = Math.min(...windows.map((w) => w.fromMs));
  const spanTo = Math.max(...windows.map((w) => w.toMs));
  const all = await deps.listSessions(deviceId, spanFrom, spanTo);
  // The SQL predicate of `listSessions`, per window.
  const rowsFor = (w: { fromMs: number; toMs: number }) =>
    all.filter((r) => (r.endedAt ?? r.startedAt).getTime() >= w.fromMs && r.startedAt.getTime() < w.toMs);
  const perWindow = windows.map(rowsFor);

  // Only the overviews some window will read, each once.
  const keys = [
    ...new Set(
      perWindow.flat().filter((r) => r.status === 'closed' && r.overviewKey && r.overviewBuiltAt).map((r) => r.overviewKey!),
    ),
  ];
  const overviews = new Map<string, OverviewV1 | null>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length) {
      const key = keys[next++];
      overviews.set(key, await deps.getOverview(key));
    }
  };
  await Promise.all(Array.from({ length: Math.min(OVERVIEW_FETCH_CONCURRENCY, keys.length) }, worker));

  return Promise.all(
    windows.map((w, i) => insightsFromRows(perWindow[i], w, async (key) => overviews.get(key) ?? null)),
  );
}

async function insightsFromRows(
  rows: WindowSessionRow[],
  window: { fromMs: number; toMs: number },
  getOverview: (key: string) => Promise<OverviewV1 | null>,
): Promise<WindowInsights> {
  const sessions: WindowInsightsSession[] = [];
  const spans: Array<[number, number]> = [];
  const vehicles: WindowVehicleSummary[] = [];
  let distance: number | null = null;
  let moving: number | null = null;
  let partial = false;
  for (const row of rows) {
    const sFrom = row.startedAt.getTime();
    const sTo = (row.endedAt ?? row.startedAt).getTime();
    const overlapMs = Math.max(0, Math.min(sTo, window.toMs) - Math.max(sFrom, window.fromMs));
    spans.push([sFrom, sTo]);
    const built = row.status === 'closed' && row.overviewKey && row.overviewBuiltAt;
    let summary: WindowGpsSummary | null = null;
    let vehicle: WindowVehicleSummary | null = null;
    let source: 'overview' | 'unbuilt' = 'unbuilt';
    if (built) {
      const overview = await getOverview(row.overviewKey!);
      if (overview) {
        source = 'overview';
        summary = summarizeOverviewWindow(overview, window.fromMs, window.toMs);
        vehicle = summarizeOverviewVehicleWindow(overview, window.fromMs, window.toMs);
        if (vehicle) vehicles.push(vehicle);
      }
    }
    if (source === 'unbuilt') partial = true;
    if (summary) {
      distance = (distance ?? 0) + summary.distanceM;
      moving = (moving ?? 0) + summary.movingMs;
    } else if (source === 'overview') {
      // Built, but no accepted fix inside the window: that is a real zero.
      distance = distance ?? 0;
      moving = moving ?? 0;
    }
    sessions.push({
      id: row.id,
      status: row.status,
      from: row.startedAt.toISOString(),
      to: (row.endedAt ?? row.startedAt).toISOString(),
      overlapMs,
      source,
      distanceM: source === 'overview' ? (summary?.distanceM ?? 0) : null,
      movingMs: source === 'overview' ? (summary?.movingMs ?? 0) : null,
      fixes: source === 'overview' ? (summary?.fixes ?? 0) : null,
      vehicle,
    });
  }
  return {
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    sessions,
    distanceM: distance === null ? null : round(distance, 1),
    movingMs: moving,
    telemetryMs: coveredMs(spans, window.fromMs, window.toMs),
    partial,
    vehicle: rollUpVehicle(vehicles),
  };
}

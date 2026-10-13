import type { InsightComputer, InsightEvent } from './types';
import { notComputable } from './types';
import { GPS_ACCEPT, MOVING_THRESHOLD_KPH, round } from './gps-accept';

/**
 * Vehicle insight (obd2-bluetooth-integration plan, D8): what the OBD-II
 * adapter saw while it was talking to the ECU. Everything here is gated on
 * `obd.link === 2` ("ECU answering", D4): with the adapter absent (0) or
 * answering alone (1) the other `obd.*` fields are either not emitted or
 * stale, so they count for nothing.
 *
 * GPS and OBD stay separate sensors (plan §5 decision 4): `distance` keeps
 * its GPS method, `speed` stays `gps.speed`; the odometer delta here is a
 * CROSS-CHECK for GPS dropouts, never a replacement. Idle time is the one
 * place OBD speed is preferred (the consumer rule), falling back to the last
 * `gps.speed` seen within the gap break when the vehicle does not report
 * PID 0D.
 *
 * Time is accumulated per leg between consecutive `obd.link` samples (the OBD
 * stream is its own 1 Hz time base, C10), attributed to the state at the leg
 * start, and a leg longer than the shared gap break is a hole, not time.
 *
 * The accumulator is exported on its own so the windowed insights endpoint
 * can run the same rules over an overview's `obd` grid (bucket averages) and
 * report per-run numbers that match the per-session ones in method.
 */

/** `obd.link` value meaning "ECU answering" (plan D4). */
export const OBD_LINK_LIVE = 2;
/** A rise in `obd.fuel_level` between consecutive readings larger than this is a refuel, not sensor slosh. */
export const REFUEL_MIN_PCT = 5;
/** Events per kind, hard cap (README D12: bounded lists). */
export const MAX_VEHICLE_EVENTS = 50;

export interface RefuelEvent extends InsightEvent {
  kind: 'refuel';
  fromPct: number;
  toPct: number;
}

export interface DtcEvent extends InsightEvent {
  kind: 'dtc';
  /** `obd.dtc_count` at the event (0 when only `obd.mil` flipped and no count is reported). */
  count: number;
}

export interface VehicleState {
  everLive: boolean;
  obdSamples: number;
  liveSamples: number;
  prevTs: number | null;
  prevLive: boolean;
  prevEngineOn: boolean;
  /** Speed at the previous live, engine-on sample; null = unknown. */
  prevSpeed: number | null;
  liveMs: number;
  engineOnMs: number;
  idleMs: number;
  sawRpm: boolean;
  sawSpeedObd: boolean;
  sawSpeedGps: boolean;
  lastGpsSpeed: number | null;
  lastGpsSpeedTs: number | null;
  rpmMax: number;
  rpmMaxAt: number | null;
  coolantMax: number | null;
  fuelStart: number | null;
  fuelEnd: number | null;
  prevFuel: number | null;
  refuels: RefuelEvent[];
  refuelsDropped: number;
  odoStart: number | null;
  odoEnd: number | null;
  sawDtc: boolean;
  prevDtc: number | null;
  prevMil: number | null;
  dtcMax: number | null;
  dtcEnd: number | null;
  milEnd: number | null;
  dtcEvents: DtcEvent[];
  dtcDropped: number;
}

export function initVehicleState(): VehicleState {
  return {
    everLive: false,
    obdSamples: 0,
    liveSamples: 0,
    prevTs: null,
    prevLive: false,
    prevEngineOn: false,
    prevSpeed: null,
    liveMs: 0,
    engineOnMs: 0,
    idleMs: 0,
    sawRpm: false,
    sawSpeedObd: false,
    sawSpeedGps: false,
    lastGpsSpeed: null,
    lastGpsSpeedTs: null,
    rpmMax: 0,
    rpmMaxAt: null,
    coolantMax: null,
    fuelStart: null,
    fuelEnd: null,
    prevFuel: null,
    refuels: [],
    refuelsDropped: 0,
    odoStart: null,
    odoEnd: null,
    sawDtc: false,
    prevDtc: null,
    prevMil: null,
    dtcMax: null,
    dtcEnd: null,
    milEnd: null,
    dtcEvents: [],
    dtcDropped: 0,
  };
}

const num = (v: number | null | undefined): number | null =>
  v !== null && v !== undefined && Number.isFinite(v) ? v : null;

/** Coded fields (`link`, `mil`, `dtc_count`) arrive averaged from an overview bucket; snap them back to the code. */
const code = (v: number | null | undefined): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/**
 * Feed one sample (raw line or overview bucket). `values` is the flattened
 * `<group>.<field>` record; a sample without `obd.link` only refreshes the
 * GPS speed fallback.
 */
export function feedVehicle(s: VehicleState, ts: number, values: Record<string, number | null | undefined>): void {
  const gpsSpeed = num(values['gps.speed']);
  if (gpsSpeed !== null && gpsSpeed >= 0) {
    s.lastGpsSpeed = gpsSpeed;
    s.lastGpsSpeedTs = ts;
  }
  const link = code(values['obd.link']);
  if (link === null) return;

  s.obdSamples++;
  // Close the leg from the previous OBD sample with the state it started in.
  if (s.prevTs !== null) {
    const dt = ts - s.prevTs;
    if (dt > 0 && dt <= GPS_ACCEPT.breakGapMs) {
      if (s.prevLive) s.liveMs += dt;
      if (s.prevEngineOn) {
        s.engineOnMs += dt;
        if (s.prevSpeed !== null && s.prevSpeed <= MOVING_THRESHOLD_KPH) s.idleMs += dt;
      }
    }
  }

  const live = link === OBD_LINK_LIVE;
  let engineOn = false;
  let speed: number | null = null;
  if (live) {
    s.everLive = true;
    s.liveSamples++;

    const rpm = num(values['obd.rpm']);
    if (rpm !== null && rpm >= 0) {
      s.sawRpm = true;
      engineOn = rpm > 0;
      if (s.rpmMaxAt === null || rpm > s.rpmMax) {
        s.rpmMax = rpm;
        s.rpmMaxAt = ts;
      }
    }

    const obdSpeed = num(values['obd.speed']);
    if (obdSpeed !== null && obdSpeed >= 0) {
      speed = obdSpeed;
      s.sawSpeedObd = true;
    } else if (s.lastGpsSpeed !== null && s.lastGpsSpeedTs !== null && ts - s.lastGpsSpeedTs <= GPS_ACCEPT.breakGapMs) {
      speed = s.lastGpsSpeed;
      s.sawSpeedGps = true;
    }

    const coolant = num(values['obd.coolant_temp']);
    if (coolant !== null && (s.coolantMax === null || coolant > s.coolantMax)) s.coolantMax = coolant;

    const fuel = num(values['obd.fuel_level']);
    if (fuel !== null && fuel >= 0 && fuel <= 100) {
      if (s.fuelStart === null) s.fuelStart = fuel;
      s.fuelEnd = fuel;
      if (s.prevFuel !== null && fuel - s.prevFuel > REFUEL_MIN_PCT) {
        if (s.refuels.length < MAX_VEHICLE_EVENTS) {
          s.refuels.push({
            kind: 'refuel',
            ts,
            fromPct: round(s.prevFuel, 2),
            toPct: round(fuel, 2),
            value: round(fuel - s.prevFuel, 2),
            unit: '%',
          });
        } else s.refuelsDropped++;
      }
      s.prevFuel = fuel;
    }

    const odo = num(values['obd.odometer']);
    if (odo !== null && odo >= 0) {
      if (s.odoStart === null) s.odoStart = odo;
      s.odoEnd = odo;
    }

    const dtc = code(values['obd.dtc_count']);
    const mil = code(values['obd.mil']);
    if (dtc !== null || mil !== null) {
      s.sawDtc = true;
      let fire = false;
      if (dtc !== null) {
        if (s.dtcMax === null || dtc > s.dtcMax) s.dtcMax = dtc;
        s.dtcEnd = dtc;
        if (s.prevDtc !== null && dtc > s.prevDtc) fire = true;
        s.prevDtc = dtc;
      }
      if (mil !== null) {
        s.milEnd = mil;
        if (s.prevMil === 0 && mil === 1) fire = true;
        s.prevMil = mil;
      }
      if (fire) {
        const count = dtc ?? s.dtcEnd ?? 0;
        if (s.dtcEvents.length < MAX_VEHICLE_EVENTS) s.dtcEvents.push({ kind: 'dtc', ts, count, value: count });
        else s.dtcDropped++;
      }
    }
  }

  s.prevTs = ts;
  s.prevLive = live;
  s.prevEngineOn = engineOn;
  s.prevSpeed = engineOn ? speed : null;
}

export interface VehicleSummary {
  link: { liveMs: number; samples: number; liveSamples: number; liveValue: number };
  engineOn: { ms: number; source: 'obd.rpm' } | ReturnType<typeof notComputable>;
  idle:
    | { ms: number; speedSource: 'obd.speed' | 'gps.speed' | 'mixed'; movingThresholdKph: number }
    | ReturnType<typeof notComputable>;
  rpm: { max: number; maxAt: number | null; unit: 'rpm' } | ReturnType<typeof notComputable>;
  coolant: { max: number; unit: 'C' } | ReturnType<typeof notComputable>;
  fuel:
    | { startPct: number; endPct: number; usedPct: number; refuels: number; refuelMinPct: number; unit: '%' }
    | ReturnType<typeof notComputable>;
  odometer:
    | { startKm: number; endKm: number; deltaKm: number; unit: 'km'; role: 'cross-check' }
    | ReturnType<typeof notComputable>;
  dtc:
    | { maxCount: number | null; endCount: number | null; milEnd: number | null; events: number }
    | ReturnType<typeof notComputable>;
  breakGapMs: number;
  truncated: boolean;
}

/** The summary of an accumulator, or null when the ECU never answered. */
export function finishVehicle(s: VehicleState): { summary: VehicleSummary; events: InsightEvent[] } | null {
  if (!s.everLive) return null;
  const speedSource = s.sawSpeedObd && s.sawSpeedGps ? 'mixed' : s.sawSpeedObd ? 'obd.speed' : s.sawSpeedGps ? 'gps.speed' : null;
  const summary: VehicleSummary = {
    link: { liveMs: s.liveMs, samples: s.obdSamples, liveSamples: s.liveSamples, liveValue: OBD_LINK_LIVE },
    engineOn: s.sawRpm ? { ms: s.engineOnMs, source: 'obd.rpm' } : notComputable('no-metric'),
    idle: !s.sawRpm
      ? notComputable('no-metric')
      : speedSource === null
        ? notComputable('no-speed')
        : { ms: s.idleMs, speedSource, movingThresholdKph: MOVING_THRESHOLD_KPH },
    rpm: s.sawRpm ? { max: round(s.rpmMax, 1), maxAt: s.rpmMaxAt, unit: 'rpm' } : notComputable('no-metric'),
    coolant: s.coolantMax !== null ? { max: round(s.coolantMax, 1), unit: 'C' } : notComputable('no-metric'),
    fuel:
      s.fuelStart !== null && s.fuelEnd !== null
        ? {
            startPct: round(s.fuelStart, 2),
            endPct: round(s.fuelEnd, 2),
            usedPct: round(Math.max(0, s.fuelStart - s.fuelEnd), 2),
            refuels: s.refuels.length + s.refuelsDropped,
            refuelMinPct: REFUEL_MIN_PCT,
            unit: '%',
          }
        : notComputable('no-metric'),
    odometer:
      s.odoStart !== null && s.odoEnd !== null
        ? {
            startKm: round(s.odoStart, 1),
            endKm: round(s.odoEnd, 1),
            deltaKm: round(s.odoEnd - s.odoStart, 1),
            unit: 'km',
            role: 'cross-check',
          }
        : notComputable('no-metric'),
    dtc: s.sawDtc
      ? { maxCount: s.dtcMax, endCount: s.dtcEnd, milEnd: s.milEnd, events: s.dtcEvents.length + s.dtcDropped }
      : notComputable('no-metric'),
    breakGapMs: GPS_ACCEPT.breakGapMs,
    truncated: s.refuelsDropped > 0 || s.dtcDropped > 0,
  };
  return { summary, events: [...s.refuels, ...s.dtcEvents] };
}

export const vehicleInsight: InsightComputer<VehicleState> = {
  id: 'vehicle',
  v: 1,
  needs: ['obd.link'],
  init: initVehicleState,
  feed(s, sample) {
    feedVehicle(s, sample.ts, sample.values);
  },
  finish: finishVehicle,
};

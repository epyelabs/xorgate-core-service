import type { InsightComputer } from './types';

/**
 * `deviceStatus`: what the kit's status LED showed over the session, and why
 * (include-led-status-in-telemetry D6). Built from the device's 1 Hz
 * `system.led_state` code and `system.health_flags` bitmask, raw per sample,
 * so time-in-state is exact (the overview's buckets are `max` / `or`, which is
 * right for a band but not for durations).
 *
 * Codes are severity-ascending (D2): 0 healthy, 1 starting, 2 gps_wait,
 * 3 network, 4 thermal, 5 undervoltage, 6 agent_down (reserved, never emitted
 * by the agent). Flag bits (D3): 1 undervoltage, 2 thermal, 4 lte_down,
 * 8 mqtt_down, 16 gps_no_fix, 32 gps_gate_hold, 64 dead_zone, 128 power_shed,
 * 256 live_block.
 *
 * Durations: a sample's value holds until the next sample of the same metric,
 * capped at {@link DEVICE_STATUS_HOLD_CAP_MS} so a recording hole does not
 * inflate a state; the last sample holds for 0.
 *
 * `events` (inside the summary, NOT the block-level `insights.events`, which
 * would carry the same up-to-500 intervals twice) are the contiguous runs of
 * `led_state`: a run ends at a code change or at a hole longer than the cap.
 * Runs shorter than {@link DEVICE_STATUS_MIN_RUN_MS} are folded into the
 * previous contiguous run (else the next one) so a one-sample blip does not
 * paint a sliver; `byCodeMs` / `worstCode` still count it. Over
 * {@link MAX_DEVICE_STATUS_EVENTS}, the longest runs are kept (in time order)
 * and `truncated: true` is set.
 *
 * Omitted (needs) on sessions recorded before the agent emitted `led_state`.
 */

export const DEVICE_STATUS_HOLD_CAP_MS = 10_000;
export const DEVICE_STATUS_MIN_RUN_MS = 2_000;
export const MAX_DEVICE_STATUS_EVENTS = 500;

/** Codes the agent can emit, plus the reserved one: always present in `byCodeMs`. */
export const DEVICE_STATUS_CODE_KEYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** Known flag bits: always present in `byFlagMs`. */
export const HEALTH_FLAG_BIT_KEYS = [1, 2, 4, 8, 16, 32, 64, 128, 256] as const;

export interface DeviceStatusEvent {
  kind: 'led_state';
  ts: number;
  endTs: number;
  value: number;
}

export interface DeviceStatusSummaryV1 {
  version: 1;
  /** Highest `led_state` seen on any sample. */
  worstCode: number;
  /** Code ("0".."6") -> ms the device was in it. */
  byCodeMs: Record<string, number>;
  /** Bit value ("1", "2", "4", ...) -> ms the bit was set. */
  byFlagMs: Record<string, number>;
  events: DeviceStatusEvent[];
  truncated?: boolean;
}

interface Run {
  value: number;
  ts: number;
  endTs: number;
}

interface State {
  worstCode: number | null;
  byCodeMs: Record<string, number>;
  byFlagMs: Record<string, number>;
  prevCodeTs: number | null;
  prevCode: number | null;
  prevFlagsTs: number | null;
  prevFlags: number | null;
  runs: Run[];
  open: Run | null;
}

const asCode = (v: number | undefined): number | null =>
  v === undefined || !Number.isFinite(v) || v < 0 ? null : Math.round(v);

function addFlagMs(s: State, flags: number, dt: number): void {
  let mask = flags >>> 0;
  for (let bit = 1; mask !== 0 && bit <= 0x80000000; bit = bit * 2) {
    if (mask & bit) {
      const k = String(bit);
      s.byFlagMs[k] = (s.byFlagMs[k] ?? 0) + dt;
      mask = (mask & ~bit) >>> 0;
    }
  }
}

/** Fold sub-minimum runs into a contiguous neighbour and coalesce equal neighbours. */
export function mergeStatusRuns(runs: readonly Run[], minRunMs = DEVICE_STATUS_MIN_RUN_MS): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const r = { ...run };
    const prev = out.at(-1);
    const contiguous = prev !== undefined && prev.endTs >= r.ts;
    if (contiguous && (r.endTs - r.ts < minRunMs || prev.value === r.value)) {
      prev.endTs = Math.max(prev.endTs, r.endTs);
      continue;
    }
    out.push(r);
  }
  // Leading short runs (no contiguous run before them) fold into the next contiguous one.
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i];
    const b = out[i + 1];
    const leftContiguous = i > 0 && out[i - 1].endTs >= a.ts;
    if (!leftContiguous && a.endTs - a.ts < minRunMs && a.endTs >= b.ts) {
      b.ts = a.ts;
      out.splice(i, 1);
    }
  }
  return out;
}

function closeRun(s: State): void {
  if (s.open) s.runs.push(s.open);
  s.open = null;
}

export const deviceStatusInsight: InsightComputer<State> = {
  id: 'deviceStatus',
  v: 1,
  needs: ['system.led_state'],
  init: () => ({
    worstCode: null,
    byCodeMs: Object.fromEntries(DEVICE_STATUS_CODE_KEYS.map((c) => [String(c), 0])),
    byFlagMs: Object.fromEntries(HEALTH_FLAG_BIT_KEYS.map((b) => [String(b), 0])),
    prevCodeTs: null,
    prevCode: null,
    prevFlagsTs: null,
    prevFlags: null,
    runs: [],
    open: null,
  }),
  feed(s, sample) {
    const { ts } = sample;
    const code = asCode(sample.values['system.led_state']);
    if (code !== null) {
      if (s.prevCodeTs !== null && s.prevCode !== null && ts > s.prevCodeTs) {
        const gap = ts - s.prevCodeTs;
        const hold = Math.min(gap, DEVICE_STATUS_HOLD_CAP_MS);
        const k = String(s.prevCode);
        s.byCodeMs[k] = (s.byCodeMs[k] ?? 0) + hold;
        if (s.open) s.open.endTs = s.prevCodeTs + hold;
        if (gap > DEVICE_STATUS_HOLD_CAP_MS) closeRun(s);
      }
      if (s.worstCode === null || code > s.worstCode) s.worstCode = code;
      if (s.open && s.open.value !== code) closeRun(s);
      if (!s.open) s.open = { value: code, ts, endTs: ts };
      s.prevCodeTs = ts;
      s.prevCode = code;
    }
    const flags = asCode(sample.values['system.health_flags']);
    if (flags !== null) {
      if (s.prevFlagsTs !== null && s.prevFlags !== null && ts > s.prevFlagsTs) {
        addFlagMs(s, s.prevFlags, Math.min(ts - s.prevFlagsTs, DEVICE_STATUS_HOLD_CAP_MS));
      }
      s.prevFlagsTs = ts;
      s.prevFlags = flags;
    }
  },
  finish(s) {
    if (s.worstCode === null) return null;
    closeRun(s);
    let events: DeviceStatusEvent[] = mergeStatusRuns(s.runs).map((r) => ({
      kind: 'led_state' as const,
      ts: r.ts,
      endTs: r.endTs,
      value: r.value,
    }));
    let truncated = false;
    if (events.length > MAX_DEVICE_STATUS_EVENTS) {
      truncated = true;
      events = [...events]
        .sort((a, b) => b.endTs - b.ts - (a.endTs - a.ts) || a.ts - b.ts)
        .slice(0, MAX_DEVICE_STATUS_EVENTS)
        .sort((a, b) => a.ts - b.ts);
    }
    const summary: DeviceStatusSummaryV1 = {
      version: 1,
      worstCode: s.worstCode,
      byCodeMs: { ...s.byCodeMs },
      byFlagMs: { ...s.byFlagMs },
      events,
    };
    if (truncated) summary.truncated = true;
    return { summary };
  },
};

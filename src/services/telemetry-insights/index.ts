import type { InsightComputer, InsightContext, InsightEvent, InsightSample, InsightsV1 } from './types';
import { durationInsight } from './duration';
import { distanceInsight } from './distance';
import { speedInsight } from './speed';
import { positionInsight } from './position';
import { altitudeInsight } from './altitude';
import { gpsQualityInsight } from './gps-quality';
import { systemInsight } from './system';
import { lteInsight } from './lte';
import { stopsInsight } from './stops';
import { vehicleInsight } from './vehicle';
import { deviceStatusInsight } from './device-status';

export type { InsightComputer, InsightContext, InsightEvent, InsightSample, InsightsV1 } from './types';

/**
 * The v1 registry (README Q11). Order is the order the summaries appear in the
 * block. Adding an insight is one file and one entry here; bumping one is
 * that file's `v`.
 */
export const INSIGHT_COMPUTERS: readonly InsightComputer<any>[] = [
  durationInsight,
  distanceInsight,
  speedInsight,
  positionInsight,
  altitudeInsight,
  gpsQualityInsight,
  systemInsight,
  lteInsight,
  stopsInsight,
  vehicleInsight,
  deviceStatusInsight,
];

/** Per-insight versions the registry currently produces: `{ distance: 1, ... }`. */
export const INSIGHT_VERSIONS: Readonly<Record<string, number>> = Object.fromEntries(
  INSIGHT_COMPUTERS.map((c) => [c.id, c.v]),
);

/** Field names on the block that are not insight ids. */
const RESERVED = new Set(['computed', 'computedAt', 'events']);

export interface InsightRun {
  feed(sample: InsightSample): void;
  finish(ctx: InsightContext, computedAt: number): InsightsV1;
}

/**
 * One streaming pass over a session for every registered computer. Feed each
 * sample once; finish once. A computer whose `needs` are missing from the
 * session, or that returns null, is omitted from `computed` and the block.
 */
export function createInsightRun(
  computers: readonly InsightComputer<any>[] = INSIGHT_COMPUTERS,
): InsightRun {
  const states = computers.map((c) => c.init());
  return {
    feed(sample) {
      for (let i = 0; i < computers.length; i++) computers[i].feed(states[i], sample);
    },
    finish(ctx, computedAt) {
      const computed: Record<string, number> = {};
      const events: InsightEvent[] = [];
      const block: InsightsV1 = { computed, computedAt, events };
      for (let i = 0; i < computers.length; i++) {
        const c = computers[i];
        if (RESERVED.has(c.id)) throw new Error(`insight id "${c.id}" is reserved`);
        if (!c.needs.every((m) => ctx.metrics.has(m))) continue;
        const result = c.finish(states[i], ctx);
        if (result === null) continue;
        computed[c.id] = c.v;
        block[c.id] = result.summary;
        if (result.events) events.push(...result.events);
      }
      events.sort((a, b) => a.ts - b.ts);
      return block;
    },
  };
}

/**
 * The three promoted columns of `telemetry_sessions` (README D7): what a list
 * sorts, filters or sums on. Everything else stays in the jsonb mirror.
 */
export function promotedInsightColumns(insights: InsightsV1): {
  distanceM: number | null;
  durationMs: number | null;
  maxSpeedKph: number | null;
} {
  const distance = insights.distance as { meters?: number } | undefined;
  const duration = insights.duration as { totalMs?: number } | undefined;
  const speed = insights.speed as { maxKph?: number } | undefined;
  return {
    distanceM: typeof distance?.meters === 'number' ? distance.meters : null,
    durationMs: typeof duration?.totalMs === 'number' ? duration.totalMs : null,
    maxSpeedKph: typeof speed?.maxKph === 'number' ? speed.maxKph : null,
  };
}

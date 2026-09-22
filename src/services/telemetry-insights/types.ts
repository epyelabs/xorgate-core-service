/**
 * Session insight registry (telemetry-session-artifacts plan, README D12).
 *
 * An insight is a pure, streaming function of the session's segments: one
 * accumulator per computer, fed every sample once, finished once. The
 * registry (index.ts) runs every computer in the same pass the overview
 * builder makes over the segments, so adding an insight costs one file and
 * one registry entry: no migration (the jsonb mirror absorbs new keys), no
 * artifact format bump (additive), no device change.
 *
 * Rules, from D12:
 *  - additive only within a version; a changed meaning bumps that computer's
 *    `v`, never the block's;
 *  - units explicit; `{ value: null, reason }` when something is not computable;
 *  - scalars and BOUNDED event lists only, never per-sample series (those are
 *    metrics and belong in `groups`);
 *  - segment-derived only: nothing that needs a geofence, an org setting or a
 *    model, so a rebuild is a pure function of (segments, computer version).
 */

/** One sample line, flattened: `<group>.<field>` -> value. */
export interface InsightSample {
  ts: number;
  values: Record<string, number>;
}

/** What every computer sees at finish time. */
export interface InsightContext {
  /** Every metric name seen anywhere in the session. */
  metrics: ReadonlySet<string>;
  /** First non-null unit seen per metric. */
  units: Readonly<Record<string, string>>;
  rateHz: number | null;
  from: number | null;
  to: number | null;
}

/** A timestamped finding the timeline can pin and a click can seek to. */
export interface InsightEvent {
  kind: string;
  ts: number;
  endTs?: number;
  /** [lon, lat], GeoJSON order, same as the overview's bbox. */
  position?: [number, number];
  value?: number;
  unit?: string;
}

/** `{ value: null, reason }` for a scalar that could not be computed. */
export interface NotComputable {
  value: null;
  reason: string;
}

export interface InsightResult {
  summary: unknown;
  events?: InsightEvent[];
}

export interface InsightComputer<S = unknown> {
  id: string;
  v: number;
  /** Metric names that MUST be present in the session for the computer to run. */
  needs: readonly string[];
  init(): S;
  feed(state: S, sample: InsightSample): void;
  /** `null` = nothing to say (omitted from `computed`). */
  finish(state: S, ctx: InsightContext): InsightResult | null;
}

/** The `insights` block of an overview.v1 object (and the `telemetry_sessions.insights` mirror). */
export interface InsightsV1 {
  computed: Record<string, number>;
  computedAt: number;
  events: InsightEvent[];
  [insightId: string]: unknown;
}

export const notComputable = (reason: string): NotComputable => ({ value: null, reason });

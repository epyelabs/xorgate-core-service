/**
 * Pure logic behind `handlers/partition-maintenance.ts`: month arithmetic for
 * pre-creating `telemetry_readings` partitions, and the retention planner that
 * decides which old partitions may be dropped.
 *
 * Kept free of DB/AWS imports so it unit-tests directly — the handler does the
 * I/O. `telemetry_readings` is monthly RANGE(ts)-partitioned
 * (drizzle/manual/001_telemetry_partition.sql for a fresh cluster,
 * drizzle/manual/008_telemetry_partition_migrate.sql for one with rows already
 * in it), so both halves are month-boundary arithmetic and nothing else.
 *
 * ============================================================================
 * RETENTION: THE 90-DAY HOT WINDOW (telemetry-session-artifacts plan, Phase 5)
 * ============================================================================
 * This shipped DORMANT in the improve-recording-history-fetching plan (phase
 * 4): the product was prototyping, nobody had a retention constraint, and an
 * enabled deletion job in a prototype is a way to lose data you wanted. That
 * reasoning ended on 2026-09-22 when the owner approved the telemetry-session-
 * artifacts plan (README D1, D8, Q1): recorded telemetry's SYSTEM OF RECORD is
 * now the device's own gzipped segment objects plus one overview object per
 * session under `telemetry/v1/` in S3 (kept 365 days, storage-stack), indexed
 * by `telemetry_sessions` / `telemetry_segments`, and `telemetry_readings` is
 * a derived HOT WINDOW: 90 days, served from Postgres for the paginated table,
 * `recent`, `lastNWindow` and the live-plane triggers (README D9). Workflow
 * runs over older windows read the artifacts through the one sanctioned
 * reader (services/telemetry-window.ts).
 *
 * So since Phase 5 (2026-09-23) retention is ENABLED on dev by default
 * (bin/app.ts TELEMETRY_RETENTION_DEFAULT) and prod flips when the owner sets
 * `prod: true` there. The gate itself is unchanged: `TELEMETRY_RETENTION_ENABLED`
 * must be the literal string `true` before a single partition is dropped.
 * Absent, empty, `false`, `1`, `yes` — all off. Enabling the maintenance
 * SCHEDULE (`--context scheduledJobs=on`) still never starts deleting history
 * as a side effect, which is exactly why the gate is a separate env var and
 * not the schedule itself.
 *
 * The 90-day window is no longer a placeholder: it is the approved hot window
 * (Q1). It still comfortably covers the `TELEMETRY_BATCH_MAX_AGE_DAYS = 90`
 * window the batch ingester accepts (so retention can never delete a month
 * that a late segment upload could still legitimately write into: a sample
 * the ingester accepts is younger than 90 days, and a partition is only
 * dropped once its EXCLUSIVE UPPER BOUND is older than that), and the readers'
 * boundary (TELEMETRY_HOT_WINDOW_DAYS) defaults to the same number so a window
 * the readers treat as hot is always still in Postgres.
 *
 * One rule the phase added on top of the planner (handlers/partition-
 * maintenance.ts): a month is held back, with a warning, while any telemetry
 * session overlapping it has no overview artifact yet, because the artifact
 * must exist before its rows may expire. Partitions older than the index
 * (rows with no session at all) are dropped as approved: their objects left
 * S3 under the old 90-day lifecycle long ago and nothing can rebuild them.
 */

/** UTC month start `offset` months from `now`'s month. */
export const monthStartUtc = (now: Date, offset: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));

/** `telemetry_readings_2026_07` — matches manual/001's bootstrap naming. */
export const partitionName = (monthStart: Date): string =>
  `telemetry_readings_${monthStart.getUTCFullYear()}_${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

/** The literal form a partition bound is written in. */
export const boundary = (monthStart: Date): string =>
  `${monthStart.toISOString().slice(0, 10)} 00:00:00+00`;

/** Month offsets the maintainer pre-creates on every run. */
export const MAINTAINED_MONTH_OFFSETS = [0, 1, 2] as const;

/**
 * Autovacuum storage parameters applied to every month partition as it is
 * created. `telemetry_readings` is append-only, so `n_dead_tup` stays ~0 and
 * the dead-tuple autovacuum trigger effectively never fires; the INSERT
 * trigger (PG13+) is what keeps the VISIBILITY MAP warm, and a stale
 * visibility map turns every index-only scan into a full heap fetch — measured
 * at `Heap Fetches: 170001` on a 170 K-row scan before this was tuned, and 0
 * after.
 *
 * The cluster default is `insert_scale_factor = 0.2`, i.e. a refresh only
 * every 20 % of the table's size — which on a multi-million-row partition
 * means well over a million inserts of drift. Turning the scale factor off and
 * using a flat threshold makes the refresh interval independent of partition
 * size, which is the property that was missing.
 *
 * These are set per-partition because storage parameters on a partitioned
 * PARENT are not inherited by its partitions.
 */
export const PARTITION_AUTOVACUUM_OPTS = {
  autovacuum_vacuum_insert_threshold: 100_000,
  autovacuum_vacuum_insert_scale_factor: 0,
} as const;

export const partitionAutovacuumClause = (): string =>
  Object.entries(PARTITION_AUTOVACUUM_OPTS)
    .map(([k, v]) => `${k} = ${v}`)
    .join(', ');

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionConfig {
  /** Nothing is dropped unless this is true. Default OFF. See the header. */
  enabled: boolean;
  /** Keep partitions whose newest possible row is within this many days. */
  days: number;
  /** Hard ceiling on drops per run — the clock-skew backstop. */
  maxDropsPerRun: number;
}

/** The approved hot window (README Q1). One quarter, ≥ the batch-ingest age window. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * A run that wanted to drop more than this is refusing to, and says so. One
 * month per monthly run is the steady state; 3 leaves room to catch up after a
 * couple of missed runs without a bad `now()` being able to delete a year.
 */
export const DEFAULT_MAX_DROPS_PER_RUN = 3;

/**
 * Below this the window is treated as a typo and retention refuses to run.
 * `TELEMETRY_RETENTION_DAYS=3` should not silently become "delete everything";
 * monthly partitions mean anything under a month can only ever mean confusion.
 */
export const MIN_RETENTION_DAYS = 31;

export function retentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  // Deliberately strict: only the exact string `true` arms this. A typo like
  // `TELEMETRY_RETENTION_ENABLED=1` leaves it dormant, which is the safe way
  // for that mistake to fail.
  const enabled = env.TELEMETRY_RETENTION_ENABLED === 'true';
  const rawDays = Number(env.TELEMETRY_RETENTION_DAYS);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : DEFAULT_RETENTION_DAYS;
  const rawMax = Number(env.TELEMETRY_RETENTION_MAX_DROPS);
  const maxDropsPerRun =
    Number.isInteger(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_DROPS_PER_RUN;
  return { enabled, days, maxDropsPerRun };
}

/** A partition as `pg_inherits` describes it. `upperBound` is null for DEFAULT. */
export interface PartitionInfo {
  name: string;
  /** Exclusive upper bound of the range, or null when it has none (DEFAULT). */
  upperBound: Date | null;
  /** Inclusive lower bound, when the catalog text carries one (the artifact guard needs it). */
  lowerBound?: Date | null;
}

/**
 * Pull the exclusive upper bound out of what `pg_get_expr(relpartbound, oid)`
 * returns, e.g.
 *   FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')
 *
 * Returns null — meaning "never droppable" — for anything this does not
 * confidently understand: the DEFAULT partition, an unbounded `MAXVALUE` edge,
 * a LIST/HASH bound, or an unparseable date. Retention keys off this, so
 * "I don't understand this partition" must fail towards keeping the data.
 */
export function parseUpperBound(boundExpr: string | null | undefined): Date | null {
  if (!boundExpr) return null;
  const m = /\bTO \('([^']+)'\)/.exec(boundExpr);
  if (!m) return null;
  const d = new Date(m[1].replace(' ', 'T').replace('+00', 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The INCLUSIVE lower bound of a RANGE partition, from the same catalog text,
 * e.g. FROM ('2026-07-01 00:00:00+00'). Null for DEFAULT / MINVALUE / anything
 * not understood, exactly like parseUpperBound. Used by the artifact guard in
 * the handler to ask "which telemetry sessions overlap this month".
 */
export function parseLowerBound(boundExpr: string | null | undefined): Date | null {
  if (!boundExpr) return null;
  const m = /\bFROM \('([^']+)'\)/.exec(boundExpr);
  if (!m) return null;
  const d = new Date(m[1].replace(' ', 'T').replace('+00', 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface RetentionPlan {
  /** Partitions to detach + drop, oldest first. */
  drop: PartitionInfo[];
  /** Eligible but held back by `maxDropsPerRun` — logged, never silent. */
  deferred: PartitionInfo[];
  /** Cutoff used, for the log line. Rows older than this are droppable. */
  cutoff: Date;
  /** Set when the plan is empty for a reason worth logging. */
  refusal?: string;
}

/**
 * Which partitions may be dropped, given the whole partition list and `now`.
 *
 * A partition is eligible only when its EXCLUSIVE UPPER BOUND is at or before
 * the cutoff — i.e. every row it can possibly hold is already older than the
 * window. Using the lower bound instead would drop the current month's
 * partition the moment the window's edge crossed into it.
 *
 * Never eligible, regardless of configuration:
 *   - the DEFAULT partition (no upper bound; it is the safety net that keeps a
 *     skewed-clock insert from hard-failing, and its contents are by
 *     definition rows whose date nobody trusts)
 *   - any partition with an unbounded upper edge (`MAXVALUE`)
 */
export function planRetention(
  partitions: PartitionInfo[],
  now: Date,
  cfg: RetentionConfig,
): RetentionPlan {
  const cutoff = new Date(now.getTime() - cfg.days * 24 * 60 * 60 * 1000);

  if (!cfg.enabled) {
    return { drop: [], deferred: [], cutoff, refusal: 'retention disabled' };
  }
  if (cfg.days < MIN_RETENTION_DAYS) {
    return {
      drop: [],
      deferred: [],
      cutoff,
      refusal: `retention window ${cfg.days}d is below the ${MIN_RETENTION_DAYS}d minimum — refusing`,
    };
  }

  const eligible = partitions
    .filter((p) => p.upperBound !== null && p.upperBound.getTime() <= cutoff.getTime())
    .sort((a, b) => a.upperBound!.getTime() - b.upperBound!.getTime());

  return {
    drop: eligible.slice(0, cfg.maxDropsPerRun),
    deferred: eligible.slice(cfg.maxDropsPerRun),
    cutoff,
  };
}

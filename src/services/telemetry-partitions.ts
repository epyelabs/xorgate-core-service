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
 * RETENTION SHIPS DORMANT — THAT IS THE DESIGN, NOT AN OVERSIGHT
 * ============================================================================
 * Plan question Q4 ("how long do we keep telemetry?") is only half-answered:
 * the product is at prototyping stage, so there is no retention pressure and
 * nobody has a real constraint to satisfy yet. The mechanism is cheap to write
 * now and expensive to retrofit under pressure later, but an ENABLED retention
 * job in a prototype environment is just a way to lose data you wanted.
 *
 * So: `TELEMETRY_RETENTION_ENABLED` must be the literal string `true` before a
 * single partition is dropped. Absent, empty, `false`, `1`, `yes` — all off.
 * Enabling the maintenance SCHEDULE (`--context scheduledJobs=on`, which the
 * dev cluster needs anyway so future months get created) must not start
 * deleting history as a side effect, which is exactly why the gate is a
 * separate env var and not the schedule itself.
 *
 * The 90-day default window is a placeholder chosen to be defensible, not
 * researched: it is one full quarter, it comfortably covers the
 * `TELEMETRY_BATCH_MAX_AGE_DAYS = 90` window the batch ingester will accept
 * (so retention can never delete a month that a late segment upload could
 * still legitimately write into), and it is long enough that no realistic
 * field investigation loses its evidence. Set the real number when production
 * data exists.
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

/** Placeholder window (see header). One quarter, ≥ the batch-ingest age window. */
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

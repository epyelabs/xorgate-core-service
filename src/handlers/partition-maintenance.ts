import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import {
  MAINTAINED_MONTH_OFFSETS,
  boundary,
  monthStartUtc,
  parseUpperBound,
  partitionAutovacuumClause,
  partitionName,
  planRetention,
  retentionConfig,
  type PartitionInfo,
} from '../services/telemetry-partitions';

/**
 * Partition maintenance (P4). Invoked by a monthly EventBridge schedule (15th,
 * 02:00 UTC). telemetry_readings is RANGE(ts)-partitioned by month; a missing
 * partition makes ingestion fail, so this pre-creates upcoming months.
 *
 * Idempotent (`IF NOT EXISTS`) over month offsets 0/+1/+2: offset 0 self-heals
 * the current month, +2 keeps ingestion alive even if one monthly run fails.
 * Naming and boundary literals match the P0 bootstrap
 * (drizzle/manual/001_telemetry_partition.sql).
 *
 * Runs as DDL through the Lambda role's rds-data grant — deliberately runtime,
 * not a migration (future months are open-ended).
 *
 * Two things were added in the improve-recording-history-fetching plan, phase 4:
 *
 *  1. Every partition it creates gets the append-only autovacuum settings, so
 *     future months keep a warm visibility map without another migration. See
 *     PARTITION_AUTOVACUUM_OPTS.
 *  2. RETENTION — detach + drop partitions older than the configured window.
 *     ⚠ It SHIPS DORMANT: `TELEMETRY_RETENTION_ENABLED` must be exactly
 *     `'true'`. Turning the schedule on (`--context scheduledJobs=on`) must not
 *     start deleting history as a side effect. The reasoning, the 90-day
 *     placeholder and the guardrails all live in services/telemetry-partitions.ts.
 *
 * The month arithmetic and the retention planner are pure and live in
 * services/telemetry-partitions.ts with unit tests; this file is the I/O.
 */

/** Pre-create months 0/+1/+2 with the append-only autovacuum settings. */
async function ensureMonths(now: Date): Promise<void> {
  for (const offset of MAINTAINED_MONTH_OFFSETS) {
    const from = monthStartUtc(now, offset);
    const to = monthStartUtc(now, offset + 1);
    const name = partitionName(from);
    // sql.raw is safe here: every fragment derives from Date arithmetic above.
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "telemetry_readings" ` +
          `FOR VALUES FROM ('${boundary(from)}') TO ('${boundary(to)}')`,
      ),
    );
    // Separate statement so it also heals a partition created before this
    // setting existed (e.g. the ones manual/001 bootstrapped).
    await db.execute(sql.raw(`ALTER TABLE "${name}" SET (${partitionAutovacuumClause()})`));
    console.log(`partition-maintenance: ensured ${name}`);
  }
}

/**
 * Read the parent's partitions with their exclusive upper bounds. DEFAULT has
 * no bound and comes back as `upperBound: null`, which makes it permanently
 * ineligible for retention by construction rather than by a name check.
 */
async function listPartitions(): Promise<PartitionInfo[]> {
  // The bound comes back as its catalog TEXT and is parsed in TypeScript, not
  // in SQL: it keeps the "which partitions may be dropped" decision entirely in
  // pure, unit-tested code (parseUpperBound + planRetention), and it sidesteps
  // raw db.execute() returning the Data API's own timestamp strings rather than
  // drizzle-mapped Dates.
  const res = await db.execute<{ name: string; bound: string | null }>(sql`
    select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'telemetry_readings'::regclass
    order by 1
  `);
  return res.rows.map((r) => ({ name: r.name, upperBound: parseUpperBound(r.bound) }));
}

/** Retention. Dormant unless explicitly armed — see the header. */
async function applyRetention(now: Date): Promise<void> {
  const cfg = retentionConfig();
  const partitions = await listPartitions();
  const plan = planRetention(partitions, now, cfg);

  if (plan.refusal) {
    console.log(`partition-maintenance: retention not applied (${plan.refusal})`);
    return;
  }
  if (plan.drop.length === 0) {
    console.log(
      `partition-maintenance: retention armed (${cfg.days}d, cutoff ${plan.cutoff.toISOString()}) — nothing older`,
    );
    return;
  }
  if (plan.deferred.length > 0) {
    // Never truncate coverage silently: the run says what it left behind.
    console.warn(
      `partition-maintenance: ${plan.deferred.length} further partition(s) are past the retention ` +
        `window but held back by maxDropsPerRun=${cfg.maxDropsPerRun}: ` +
        `${plan.deferred.map((p) => p.name).join(', ')}. They will drop on subsequent runs.`,
    );
  }

  for (const p of plan.drop) {
    // Count BEFORE dropping — this log line is the only record that the rows
    // ever existed, so it has to be written while they still do.
    const countRes = await db.execute(sql.raw(`select count(*)::bigint as n from "${p.name}"`));
    const rows = (countRes as unknown as { rows?: { n?: unknown }[] }).rows?.[0]?.n ?? 'unknown';
    console.warn(
      `partition-maintenance: RETENTION dropping ${p.name} ` +
        `(upper bound ${p.upperBound?.toISOString()}, cutoff ${plan.cutoff.toISOString()}, rows ${String(rows)})`,
    );

    // Detach first, then drop. If the DROP fails, the data survives as a
    // standalone table under the SAME NAME, which the line above has already
    // recorded — recoverable by re-attaching. A bare DROP has no such step.
    await db.execute(sql.raw(`ALTER TABLE "telemetry_readings" DETACH PARTITION "${p.name}"`));
    await db.execute(sql.raw(`DROP TABLE "${p.name}"`));
    console.warn(`partition-maintenance: RETENTION dropped ${p.name}`);
  }
}

export const handler = async (): Promise<void> => {
  const now = new Date();
  await ensureMonths(now);
  await applyRetention(now);
};

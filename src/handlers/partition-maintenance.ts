import { sql } from 'drizzle-orm';
import { db } from '../db/index';

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
 */

const monthStartUtc = (now: Date, offset: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));

const partitionName = (monthStart: Date): string =>
  `telemetry_readings_${monthStart.getUTCFullYear()}_${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

const boundary = (monthStart: Date): string =>
  `${monthStart.toISOString().slice(0, 10)} 00:00:00+00`;

export const handler = async (): Promise<void> => {
  const now = new Date();
  for (const offset of [0, 1, 2]) {
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
    console.log(`partition-maintenance: ensured ${name}`);
  }
};

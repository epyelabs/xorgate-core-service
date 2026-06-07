import { sql, type SQL } from 'drizzle-orm';
import type { NewTelemetryReading } from '../db/schema';
import { tsParam } from './sql';

/**
 * Build a multi-row, last-writer-wins upsert into `device_latest` from a set of
 * flattened telemetry rows (one telemetry payload carries a single `ts`, so we
 * keep the latest row per metric — guards against a metric appearing twice).
 *
 * The `drizzle-orm/aws-data-api/pg` driver has no column-type context inside a
 * raw `sql` template, so every value that maps to a non-text column must carry
 * an explicit cast: `ts` via `tsParam` (→ `::timestamptz`) and `device_id` via
 * `::uuid`. `value ?? null` (not `||`) preserves a legitimate `0`.
 *
 * Returns `null` when there is nothing to upsert.
 */
export function buildDeviceLatestUpsert(
  deviceId: string,
  tsIso: string,
  rows: NewTelemetryReading[],
): SQL | null {
  const latestByMetric = new Map(rows.map((r) => [r.metric, r]));
  const tuples = [...latestByMetric.values()].map(
    (r) =>
      sql`(${deviceId}::uuid, ${r.metric}, ${r.value ?? null}, ${r.unit ?? null}, ${tsParam(tsIso)})`,
  );
  if (tuples.length === 0) return null;

  return sql`
    INSERT INTO device_latest (device_id, metric, value, unit, ts)
    VALUES ${sql.join(tuples, sql`, `)}
    ON CONFLICT (device_id, metric) DO UPDATE SET
      value = EXCLUDED.value,
      unit = EXCLUDED.unit,
      ts = EXCLUDED.ts
    WHERE EXCLUDED.ts > device_latest.ts
  `;
}

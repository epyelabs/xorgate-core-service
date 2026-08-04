import { sql, type SQL } from 'drizzle-orm';
import { telemetryReadings } from '../db/schema';

/**
 * Bounded distinct-timestamp count for `GET /devices/{id}/telemetry/readings`.
 *
 * The pager needs a `total`, but the exact one is unaffordable: `count(distinct
 * ts)` over an unfiltered device history sorts millions of timestamps against
 * `work_mem = 4 MB` and spills to disk (measured > 45 s on the dev cluster,
 * where the RDS Data API cancels — the Lambda's own timeout fires first and the
 * caller sees a 500). Instead we count only up to a cap, which lets the
 * `Unique` node stop early on the already-ordered index.
 *
 * The cap is 10 000 and was measured, not chosen. The cost curve is sharply
 * non-linear because heap fetches dominate, and the planner abandons the index
 * entirely past ~30 000:
 *
 *   5 000 → 69 ms · 10 000 → 133 ms · 20 000 → 643 ms · 30 000 → 5 906 ms ·
 *   50 000 → seq scan + sort
 *
 * 10 000 is the last comfortable value and leaves headroom for the MergeAppend
 * overhead partitioning will add. Re-measure before touching it.
 *
 * Considered and rejected (do not re-derive these):
 *
 * - **Exact total via `count(*) from (select ts … group by ts)`** — 1.1 s over
 *   all history, and exact. Rejected because the planner chose a *parallel seq
 *   scan of the whole 2.3 GB table* rather than one device's index, so it
 *   degrades with total rows across every device instead of with the queried
 *   device's. Fast today only because dev has one busy device.
 * - **Raising the Lambda timeout alone** — the query needs > 45 s. No timeout
 *   under the Data API's own ceiling can save it.
 * - **Raising `work_mem`** — helps the spill, does not stop the query being
 *   O(all rows for the device), and it is cluster-wide on a shared sandbox.
 * - **Dropping `total` entirely** — that is keyset pagination, a contract
 *   change, and belongs to its own phase.
 *
 * ⚠ Semantics this chooses, deliberately:
 *
 * - **The cap applies to the ordered slice.** With `order=desc` the addressable
 *   window is the newest 10 000 samples; with `order=asc` it is the oldest
 *   10 000. Flipping the sort therefore changes *which* samples are reachable.
 * - **`total` stops meaning "all matching samples"** once `totalIsCapped` is
 *   true. It means "addressable samples under this filter". The escape hatch
 *   for seeing everything is narrowing the time range.
 */

/** Distinct timestamps addressable per filter. Measured — see above. */
export const READINGS_TOTAL_CAP = 10_000;

/** `to_char` mask producing the same ISO-8601 shape as `Date#toISOString()`. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * One row, keyed by the emitted column names. Raw `db.execute` returns the Data
 * API's own scalars with no Drizzle column mapping, which is why the span is
 * `to_char`'d to ISO in SQL rather than left as a timestamp — hence also the
 * snake_case keys and the `Record` constraint `db.execute<T>` requires.
 */
export interface BoundedTotalRow extends Record<string, unknown> {
  total: number;
  covered_from: string | null;
  covered_to: string | null;
}

/**
 * Build the bounded-count statement.
 *
 * `where` and `order` MUST be the same values the page query uses — pass them
 * by reference. If the count's filter ever drifts from the page's filter,
 * `total` silently lies.
 *
 * Two nested limits, on purpose:
 *
 * - `capped` takes `cap + 1` rows. The `+ 1` is the only thing distinguishing
 *   "exactly cap" from "more than cap" — do not drop it.
 * - `addressable` takes the first `cap` of those, and the covered span is
 *   computed over *that* set. Taking `min`/`max` over `capped` directly would
 *   report a span one sample wider than the pager can actually reach, so the
 *   UI's "most recent N samples, X to Y" claim would be false at the far edge.
 *
 * `capped` is referenced twice, so Postgres materialises it and the index is
 * scanned once. Measured 136 ms over all history for the 8.3 M-row dev device
 * (`Unique` over `Index Only Scan Backward using telemetry_device_ts_metric_idx`,
 * 167 097 index rows read, early stop at 10 001).
 *
 * The validated integer cap is inlined with `sql.raw` and the ISO mask is a
 * literal: the Data API binds params as `stringValue`, which breaks both a
 * `limit $n` and a `to_char(…, $n)`. Same reason `tsParam()` exists.
 */
export function boundedTotalQuery(
  where: SQL | undefined,
  order: 'asc' | 'desc',
  cap: number = READINGS_TOTAL_CAP,
): SQL {
  const t = telemetryReadings;
  const dir = sql.raw(order === 'asc' ? 'asc' : 'desc');
  const capRaw = sql.raw(String(cap));
  const capPlusOne = sql.raw(String(cap + 1));

  return sql`with capped as (
  select distinct ${t.ts} as ts
  from ${t}
  where ${where ?? sql`true`}
  order by ${t.ts} ${dir}
  limit ${capPlusOne}
), addressable as (
  select ts from capped order by ts ${dir} limit ${capRaw}
)
select c.total, a.covered_from, a.covered_to
from (select count(*)::int as total from capped) c
cross join (
  select
    to_char(min(ts) at time zone 'utc', ${sql.raw(ISO_UTC)}) as covered_from,
    to_char(max(ts) at time zone 'utc', ${sql.raw(ISO_UTC)}) as covered_to
  from addressable
) a`;
}

/**
 * Fold the `cap + 1` probe into the reported total.
 *
 * `rawTotal > cap` means the filter matches more than the pager can address, so
 * we report the cap and flag it. Anything at or below the cap is exact.
 */
export function capTotal(
  rawTotal: number,
  cap: number = READINGS_TOTAL_CAP,
): { total: number; totalIsCapped: boolean } {
  const totalIsCapped = rawTotal > cap;
  return { total: totalIsCapped ? cap : rawTotal, totalIsCapped };
}

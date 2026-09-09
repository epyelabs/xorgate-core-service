import { sql, type SQL } from 'drizzle-orm';

/**
 * Cast helpers for the `drizzle-orm/aws-data-api/pg` driver.
 *
 * The RDS Data API binds most JS values as `stringValue`, which makes Postgres
 * reject (or mis-plan) filters like `WHERE ts >= $from` on a `timestamptz`
 * column and jsonb comparisons. Wrap such values with an explicit `::type` cast
 * and compose them through Drizzle's `sql` template instead of bare
 * `eq()`/`gte()` on the raw value.
 *
 * Inserts are unaffected: pass a JS `Date` and Drizzle attaches the right
 * typeHint. This caveat is a *filter* problem, not an *insert* problem.
 *
 *   import { telemetryReadings } from '../db/schema';
 *   db.select().from(telemetryReadings).where(
 *     sql`${telemetryReadings.ts} >= ${tsParam(from)} and ${telemetryReadings.ts} < ${tsParam(to)}`,
 *   );
 */

/** Force a `timestamptz` cast on an ISO-8601 string param. */
export const tsParam = (iso: string): SQL => sql`${iso}::timestamptz`;

/** Force a `jsonb` cast on an arbitrary value (serialized to JSON text first). */
export const jsonbParam = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

/**
 * Force a `uuid` cast on an id param.
 *
 * Only needed in RAW `sql` where there is no column to take a typeHint from.
 * `eq(table.organizationId, id)` is fine: drizzle reads the hint off the column.
 * The same comparison written out by hand in a `sql` template is
 * `operator does not exist: uuid = text`.
 */
export const uuidParam = (id: string): SQL => sql`${id}::uuid`;

/**
 * A `text[]` literal built from bound params: `ARRAY[$1, $2]::text[]`.
 *
 * The driver has no array binding, so handing drizzle's `arrayOverlaps` a JS
 * array binds one `stringValue` and Postgres answers
 * `operator does not exist: text[] && text`. Each element is still a bound
 * parameter here, so nothing is interpolated into SQL text. Callers must not
 * pass an empty list: `ARRAY[]::text[]` needs the cast inside the brackets and
 * an empty filter has nothing to ask anyway.
 */
export const textArrayParam = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;

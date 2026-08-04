#!/usr/bin/env node
/**
 * Driver for drizzle/manual/008_telemetry_partition_migrate.sql — converts an
 * already-populated `telemetry_readings` into a monthly RANGE-partitioned table
 * without losing rows.
 *
 * READ 008_telemetry_partition_migrate.sql FIRST. It is the specification; this
 * file only sequences it through the RDS Data API, whose ~45 s per-statement
 * ceiling is the reason the copy is chunked at all. The SQL file's own DO-block
 * loops are the psql equivalent of what this script issues one day per call.
 *
 * Why a script rather than pasting the file:
 *   - the copy is ~59 day chunks; each needs its own Data API call
 *   - every chunk is verified by row count as it lands, so a partial run is
 *     RESUMABLE and a missed chunk is DETECTABLE rather than silently absent
 *   - the month list is derived from the data, not hard-coded
 *
 * Idempotent and resumable at step granularity: step 1 no-ops once the table is
 * partitioned, staging tables are `IF NOT EXISTS`, and each day chunk is
 * skipped when the destination already holds exactly the legacy count for that
 * day. Re-run after a failure; it picks up where it stopped.
 *
 * ⚠ STOP THE DEVICE AGENT FIRST (`ssh pi@10.0.0.111` — safe to interrupt).
 * With no live writer the current-month copy is a straight copy instead of a
 * moving target, and the row-count check becomes an exact match.
 *
 * Usage:
 *   node scripts/migrate-telemetry-partitions.mjs --plan     # print, change nothing
 *   node scripts/migrate-telemetry-partitions.mjs --apply
 *   node scripts/migrate-telemetry-partitions.mjs --apply --drop-legacy
 *
 * Environment (defaults are the dev sandbox cluster):
 *   XORGATE_DB_CLUSTER_ARN, XORGATE_DB_SECRET_ARN, XORGATE_DB_NAME
 *
 * Requires the `aws` CLI on PATH with rds-data:ExecuteStatement.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLUSTER_ARN =
  process.env.XORGATE_DB_CLUSTER_ARN ??
  'arn:aws:rds:us-east-1:111910761410:cluster:epye-sandbox-db';
const SECRET_ARN =
  process.env.XORGATE_DB_SECRET_ARN ??
  'arn:aws:secretsmanager:us-east-1:111910761410:secret:epye-sandbox/xorgate-db-credentials-PxoDqV';
const DATABASE = process.env.XORGATE_DB_NAME ?? 'xorgatedb_dev';

const APPLY = process.argv.includes('--apply');
const DROP_LEGACY = process.argv.includes('--drop-legacy');

const LEGACY = 'telemetry_readings_legacy';
const PARENT = 'telemetry_readings';

// Chunk ceilings, derived from the dev measurements in the SQL file: ~175 K
// rows/s into an unindexed heap, so 1.5 M rows ≈ 9 s against a 45 s limit.
// The current month's destination is the live, INDEXED partition, where index
// maintenance costs several times as much per row — hence the smaller ceiling.
const STAGING_CHUNK_ROWS = 1_500_000;
const CURRENT_MONTH_CHUNK_ROWS = 500_000;

/** One statement per call — the Data API does not accept multi-statement SQL. */
async function sql(statement) {
  const { stdout } = await execFileAsync(
    'aws',
    [
      'rds-data',
      'execute-statement',
      '--resource-arn',
      CLUSTER_ARN,
      '--secret-arn',
      SECRET_ARN,
      '--database',
      DATABASE,
      '--output',
      'json',
      '--sql',
      statement,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** First column of the first row, unwrapped from the Data API's typed record. */
function scalar(res) {
  const cell = res.records?.[0]?.[0];
  if (!cell || cell.isNull) return null;
  return cell.longValue ?? cell.stringValue ?? cell.doubleValue ?? cell.booleanValue ?? null;
}

const rows = (res) => (res.records ?? []).map((r) => r.map((c) => (c.isNull ? null : Object.values(c)[0])));

const log = (...a) => console.log(...a);

/** UTC month key ('2026_07') and inclusive/exclusive bounds for a month start. */
const monthKey = (d) => `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const iso = (d) => d.toISOString().slice(0, 10);
/** Full UTC timestamp literal — sub-day chunks need more than a date. */
const stamp = (d) => `${d.toISOString().slice(0, 19).replace('T', ' ')}+00`;
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);

async function main() {
  log(`# telemetry_readings partition migration -> ${DATABASE}`);
  log(`# mode: ${APPLY ? 'APPLY' : 'PLAN (nothing will change)'}\n`);

  const relkind = scalar(
    await sql(`select relkind::text from pg_class where relname = '${PARENT}'`),
  );
  const legacyExists =
    scalar(await sql(`select count(*)::int from pg_class where relname = '${LEGACY}'`)) > 0;

  // ---- Step 0: where the rows are, and therefore which months we need -------
  const source = relkind === 'p' && legacyExists ? LEGACY : relkind === 'p' ? null : PARENT;
  if (!source) {
    log('Already partitioned and no legacy table left — nothing to migrate.');
    await report();
    return;
  }

  const breakdown = rows(
    await sql(
      `select to_char(date_trunc('month', ts), 'YYYY-MM-DD') as m, count(*)::bigint
       from "${source}" group by 1 order by 1`,
    ),
  );
  const totalBefore = breakdown.reduce((n, [, c]) => n + Number(c), 0);
  log('Legacy data by month:');
  for (const [m, c] of breakdown) log(`  ${m}  ${String(c).padStart(10)}`);
  log(`  TOTAL     ${String(totalBefore).padStart(10)}\n`);

  const currentMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const months = breakdown.map(([m]) => new Date(`${m}T00:00:00Z`));

  // After step 1 the source table has been RENAMED, so every subsequent read of
  // the original rows goes through the legacy name. On a plan run nothing was
  // renamed, so it is still whatever `source` resolved to.
  const srcTable = APPLY ? LEGACY : source;

  // ---- Step 1: the swap, one atomic statement ------------------------------
  if (relkind === 'p') {
    log('Step 1: already partitioned — skipped.\n');
  } else {
    log('Step 1: rename legacy + stand up partitioned parent + DEFAULT + months 0/+1/+2');
    if (APPLY) {
      await sql(step1Sql());
      log('  done\n');
    } else {
      log('  (plan) would run the step-1 DO block\n');
    }
  }

  // ---- Step 2/3: per month ------------------------------------------------
  for (const month of months) {
    const key = monthKey(month);
    const table = `${PARENT}_${key}`;
    const from = iso(month);
    const to = iso(addMonths(month, 1));
    const isCurrent = month.getTime() >= currentMonth.getTime();

    log(`Month ${key}  [${from} .. ${to})  ${isCurrent ? '(current — live partition)' : '(past — build & attach)'}`);

    if (!isCurrent && APPLY) {
      await sql(`create table if not exists "${table}" (like "${PARENT}")`);
    }

    // Day chunks, sub-split when a day is fat enough to risk the 45 s ceiling.
    // A past month copies into an UNINDEXED staging heap (~175 K rows/s
    // measured); the current month copies into the live, INDEXED partition,
    // which is materially slower per row — hence the lower ceiling for it.
    const chunkLimit = isCurrent ? CURRENT_MONTH_CHUNK_ROWS : STAGING_CHUNK_ROWS;
    let copied = 0;
    for (let d = new Date(month); d < addMonths(month, 1); d = addDays(d, 1)) {
      copied += await copyRange(table, srcTable, d, addDays(d, 1), chunkLimit);
    }
    log(`  month total: ${copied}`);

    if (!isCurrent && APPLY) {
      const attached =
        scalar(
          await sql(
            `select count(*)::int from pg_inherits i join pg_class c on c.oid = i.inhrelid
             where i.inhparent = '${PARENT}'::regclass and c.relname = '${table}'`,
          ),
        ) > 0;
      if (attached) {
        log('  already attached\n');
        continue;
      }
      log('  building indexes…');
      await sql(
        `create index if not exists "${table}_device_metric_ts_idx" on "${table}" using btree ("device_id","metric","ts")`,
      );
      await sql(
        `create index if not exists "${table}_device_ts_metric_idx" on "${table}" using btree ("device_id","ts","metric")`,
      );
      // Validated CHECK first: ATTACH then skips its own verification scan, so
      // the parent's ACCESS EXCLUSIVE lock is held for a moment, not a minute.
      await sql(
        `alter table "${table}" add constraint "${table}_ts_check"
         check (ts >= '${from} 00:00:00+00' and ts < '${to} 00:00:00+00')`,
      );
      // Any stray row DEFAULT caught for this month would make ATTACH fail.
      await sql(
        `with moved as (
           delete from "${PARENT}_default"
           where ts >= '${from} 00:00:00+00' and ts < '${to} 00:00:00+00' returning *
         ) insert into "${table}" select * from moved`,
      );
      log('  attaching…');
      await sql(
        `alter table "${PARENT}" attach partition "${table}"
         for values from ('${from} 00:00:00+00') to ('${to} 00:00:00+00')`,
      );
      await sql(`alter table "${table}" drop constraint "${table}_ts_check"`);
      log('  attached\n');
    } else {
      log('');
    }
  }

  // ---- Step 4: verify ------------------------------------------------------
  if (APPLY) {
    log('Verification:');
    const after = rows(
      await sql(
        `select to_char(date_trunc('month', ts), 'YYYY-MM') as m, count(*)::bigint
         from "${PARENT}" group by 1 order by 1`,
      ),
    );
    const before = new Map(breakdown.map(([m, c]) => [m.slice(0, 7), Number(c)]));
    let ok = true;
    for (const [m, c] of after) {
      const b = before.get(m) ?? 0;
      const delta = Number(c) - b;
      if (delta !== 0) ok = false;
      log(`  ${m}  legacy ${String(b).padStart(9)}  partitioned ${String(c).padStart(9)}  delta ${delta}`);
    }
    const dflt = Number(scalar(await sql(`select count(*)::bigint from "${PARENT}_default"`)));
    log(`  DEFAULT partition rows: ${dflt}${dflt === 0 ? ' ✓' : '  ⚠ NON-EMPTY'}`);
    if (dflt !== 0) ok = false;

    if (ok && DROP_LEGACY) {
      log('\nDropping legacy table…');
      await sql(`drop table "${LEGACY}"`);
      log('  dropped');
    } else if (!DROP_LEGACY) {
      log(`\nLegacy table retained. Re-run with --drop-legacy once you are satisfied.`);
    } else {
      log('\n⚠ Counts do not reconcile — legacy table RETAINED. Investigate before dropping.');
    }
    await report();
  }
}

/**
 * Copy `[from, to)` from `src` into `dest`, splitting the range in half until
 * each statement is small enough to finish well inside the Data API's ~45 s
 * ceiling. Verifies as it goes:
 *   - destination already holds exactly the source count -> skip (resumable)
 *   - destination holds SOME of them -> refuse, rather than double-insert
 * Returns the number of rows accounted for.
 */
async function copyRange(dest, src, from, to, limit, depth = 0) {
  const f = stamp(from);
  const t = stamp(to);
  const pad = '  '.repeat(depth + 1);
  const label = depth === 0 ? iso(from) : `${f} .. ${t}`;

  const want = Number(
    scalar(await sql(`select count(*)::bigint from "${src}" where ts >= '${f}' and ts < '${t}'`)),
  );
  if (want === 0) return 0;

  if (!APPLY) {
    log(`${pad}${label}  ${String(want).padStart(9)}  (plan)${want > limit ? ' — would sub-split' : ''}`);
    return want;
  }

  const have = Number(
    scalar(await sql(`select count(*)::bigint from "${dest}" where ts >= '${f}' and ts < '${t}'`)),
  );
  if (have === want) {
    log(`${pad}${label}  ${String(want).padStart(9)}  already present, skipped`);
    return have;
  }
  if (have > 0 && want <= limit) {
    throw new Error(
      `${dest} already holds ${have} of ${want} rows for ${f}..${t} — a partial chunk. ` +
        `Delete that range from ${dest} and re-run rather than double-inserting.`,
    );
  }

  if (want > limit) {
    const mid = new Date(from.getTime() + Math.floor((to.getTime() - from.getTime()) / 2));
    if (mid.getTime() === from.getTime()) {
      throw new Error(`cannot split ${f}..${t} any further; ${want} rows share one instant`);
    }
    log(`${pad}${label}  ${String(want).padStart(9)}  > ${limit} — splitting`);
    return (
      (await copyRange(dest, src, from, mid, limit, depth + 1)) +
      (await copyRange(dest, src, mid, to, limit, depth + 1))
    );
  }

  const t0 = Date.now();
  await sql(`insert into "${dest}" select * from "${src}" where ts >= '${f}' and ts < '${t}'`);
  log(`${pad}${label}  ${String(want).padStart(9)}  copied in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return want;
}

function step1Sql() {
  // Kept byte-identical to step 1 of drizzle/manual/008_telemetry_partition_migrate.sql.
  return `
DO $$
DECLARE
  month_start date := date_trunc('month', now() at time zone 'utc')::date;
  m_from      date;
  m_to        date;
  offset_i    int;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE relname = 'telemetry_readings') = 'p' THEN
    RAISE NOTICE 'telemetry_readings is already partitioned - step 1 skipped';
    RETURN;
  END IF;

  ALTER TABLE "telemetry_readings" RENAME TO "telemetry_readings_legacy";
  ALTER INDEX "telemetry_device_metric_ts_idx" RENAME TO "telemetry_legacy_device_metric_ts_idx";
  ALTER INDEX "telemetry_device_ts_metric_idx" RENAME TO "telemetry_legacy_device_ts_metric_idx";

  CREATE TABLE "telemetry_readings" (
    "device_id" uuid NOT NULL,
    "ts" timestamp with time zone NOT NULL,
    "metric" text NOT NULL,
    "value" double precision,
    "unit" text,
    "meta" jsonb
  ) PARTITION BY RANGE ("ts");

  CREATE INDEX "telemetry_device_metric_ts_idx" ON "telemetry_readings" USING btree ("device_id","metric","ts");
  CREATE INDEX "telemetry_device_ts_metric_idx" ON "telemetry_readings" USING btree ("device_id","ts","metric");

  CREATE TABLE "telemetry_readings_default" PARTITION OF "telemetry_readings" DEFAULT;

  FOR offset_i IN 0..2 LOOP
    m_from := (month_start + (offset_i     || ' month')::interval)::date;
    m_to   := (month_start + (offset_i + 1 || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "telemetry_readings" FOR VALUES FROM (%L) TO (%L)',
      'telemetry_readings_' || to_char(m_from, 'YYYY_MM'),
      to_char(m_from, 'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(m_to,   'YYYY-MM-DD') || ' 00:00:00+00'
    );
  END LOOP;
END $$;`;
}

async function report() {
  const parts = rows(
    await sql(
      `select c.relname, pg_get_expr(c.relpartbound, c.oid), coalesce(c.reltuples::bigint, 0)
       from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = '${PARENT}'::regclass order by 1`,
    ),
  );
  console.log('\nPartitions:');
  for (const [name, bound, est] of parts) console.log(`  ${name.padEnd(32)} ${bound}  (~${est} rows)`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  console.error(
    'Every step is idempotent — fix the cause and re-run. If a day chunk timed out, ' +
      'the chunk is re-runnable; if it timed out mid-insert, delete that day from the ' +
      'destination partition first (the script refuses to double-insert a partial chunk).',
  );
  process.exit(1);
});

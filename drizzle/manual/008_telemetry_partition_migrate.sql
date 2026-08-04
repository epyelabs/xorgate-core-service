-- Manual migration: convert an ALREADY-POPULATED telemetry_readings into a monthly
-- RANGE-partitioned table WITHOUT losing its rows.
--
-- ============================================================================
-- WHY THIS FILE EXISTS — read before reaching for manual/001
-- ============================================================================
-- manual/001_telemetry_partition.sql does the same conversion but opens with
-- `DROP TABLE IF EXISTS "telemetry_readings" CASCADE`. It was authored as an
-- EMPTY-CLUSTER BOOTSTRAP: run it on a fresh cluster before first ingestion and
-- it is correct and cheap. Run it on a cluster that has accumulated rows and it
-- silently destroys every one of them.
--
-- `xorgatedb_dev` accumulated 8.87 M rows before anyone applied 001, so dev
-- needed a migrating variant. Postgres has no `ALTER TABLE ... PARTITION BY`,
-- so partitioning an existing table ALWAYS means building a new partitioned
-- parent and moving the rows into it. The only real question was copy-or-discard,
-- and the answer (plan Q6, reversed 2026-08-04) is COPY.
--
--   * Fresh cluster, table genuinely empty  -> apply manual/001 + manual/005.
--   * Table already has rows                -> apply THIS file.
--
-- ============================================================================
-- SHAPE OF THE WORK — build-and-attach
-- ============================================================================
-- Each month is built, filled, indexed and CHECK-constrained as a STANDALONE
-- table, and only then attached. The parent therefore never serves a
-- half-copied partition, and the expensive scans happen on a table nobody can
-- see rather than under the ACCESS EXCLUSIVE lock that `ATTACH PARTITION`
-- takes on the parent.
--
--   1. One atomic statement: rename the old table (and its indexes) out of the
--      way, stand up the partitioned parent, its indexes, the DEFAULT
--      partition, and the live month partitions 0/+1/+2. Ingestion downtime is
--      the duration of this single statement — well under a second.
--   2. Per PAST month in the legacy data: unindexed staging table -> copy in
--      day chunks -> two indexes -> validated CHECK -> ATTACH.
--   3. CURRENT month: its partition is already live and attached from step 1,
--      so copy the legacy rows straight into it, in day chunks, last.
--   4. Verify counts per month, then drop the legacy table.
--
-- ============================================================================
-- THE 45-SECOND CEILING, AND WHY THE COPY IS DAY-CHUNKED
-- ============================================================================
-- The RDS Data API cancels any statement at ~45 s. (That ceiling is the API's,
-- not the database's — `statement_timeout` is 0 on this cluster.) Measured on
-- dev 2026-08-04:
--
--   full seq scan of the 704 MB legacy heap, warm ......  330 ms
--   insert into an UNINDEXED heap ...................... ~175 K rows/s
--   worst single day (2026-08-03, 1 408 363 rows) ......  8 s
--
-- So a day chunk costs roughly `scan + rows/175K` seconds and the worst real
-- day has >5x headroom. Day chunks also make a partial run RESUMABLE and a
-- missed chunk DETECTABLE: every chunk is independently verifiable by row
-- count, and a partition short by exactly one day's rows names the chunk that
-- failed.
--
-- If a chunk ever does time out, SPLIT IT IN HALF AND RE-RUN. Never reach for
-- `--continue-after-timeout`: it returns an error to the caller while the
-- statement keeps running server-side, which is precisely the ambiguity you do
-- not want in the middle of a table swap.
--
-- ============================================================================
-- HOW TO RUN IT
-- ============================================================================
-- Two ways, same statements:
--
--   a) `scripts/migrate-telemetry-partitions.mjs` — the driver used for the dev
--      run. It issues every statement below through the Data API ONE DAY PER
--      CALL, verifies each chunk's row count, and is idempotent/resumable.
--      This is the recommended path against Aurora + Data API.
--
--   b) By hand, splitting this file on its `--> statement-breakpoint` markers
--      (the Data API runs one statement per call — see manual/README.md). The
--      copy steps below are written as DO blocks that loop over days
--      internally, so pasting them works under psql, or under the Data API for
--      any month small enough to finish inside 45 s. A month that does not fit
--      needs path (a).
--
-- BEFORE YOU START: stop the device agent (`ssh pi@10.0.0.111`; the plan's
-- working agreements say it is safe to interrupt). With no live writer the
-- current-month reconciliation is a straight copy rather than a moving target,
-- and the row-count DoD becomes an exact match instead of an allowance.
--
-- ============================================================================
-- ADAPTING IT TO ANOTHER CLUSTER
-- ============================================================================
-- The month literals below (2026_06 / 2026_07 / 2026_08) are dev's data span,
-- taken from `select date_trunc('month', ts), count(*) from telemetry_readings
-- group by 1`. On another cluster, re-derive that breakdown and repeat the
-- step-2 block once per PAST month; step 1 and step 3 are month-agnostic (they
-- compute months 0/+1/+2 from `now()`, the same arithmetic as
-- src/handlers/partition-maintenance.ts). The driver script does this
-- derivation automatically.

-- ============================================================================
-- STEP 1 — the swap. ONE statement, so it is atomic and the ingestion gap is
-- a single sub-second transaction.
--
-- The index renames are load-bearing: the legacy table keeps its two indexes,
-- and the parent's indexes must reuse the ORIGINAL names (src/db/schema.ts
-- declares them, and drizzle snapshots compare on name). Without the rename
-- the CREATE INDEX below fails on a duplicate relation name.
--
-- The DEFAULT partition (manual/005) is created HERE, not at the end: it is
-- what catches rows for a month nobody created, and the window where it does
-- not exist is a window where an insert HARD-FAILS.
--
-- Idempotent: re-running after a successful step 1 is a no-op notice.
-- ============================================================================
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

  -- Column DDL copied verbatim from manual/001. Deliberately NO PRIMARY KEY:
  -- batched inserts stay cheap and ingestion is last-writer-wins (see
  -- src/db/schema.ts). Do not "improve" this; it is the hot write path.
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

  -- manual/005, inlined so the safety net exists before anything can insert.
  CREATE TABLE "telemetry_readings_default" PARTITION OF "telemetry_readings" DEFAULT;

  -- Months 0/+1/+2, matching partition-maintenance.ts's naming and boundaries
  -- exactly (that Lambda's CREATE ... IF NOT EXISTS must be a no-op over these).
  FOR offset_i IN 0..2 LOOP
    m_from := (month_start + (offset_i    || ' month')::interval)::date;
    m_to   := (month_start + (offset_i + 1 || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "telemetry_readings" FOR VALUES FROM (%L) TO (%L)',
      'telemetry_readings_' || to_char(m_from, 'YYYY_MM'),
      to_char(m_from, 'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(m_to,   'YYYY-MM-DD') || ' 00:00:00+00'
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ============================================================================
-- STEP 2 — PAST months: build unindexed, fill, index, constrain, attach.
-- Repeat this block once per past month present in the legacy data.
-- ============================================================================

-- ---- 2026-06 (37 940 rows on dev) -----------------------------------------
CREATE TABLE IF NOT EXISTS "telemetry_readings_2026_06" (LIKE "telemetry_readings");
--> statement-breakpoint

-- Day-chunked copy. Under the Data API the driver issues one INSERT per day;
-- this loop is the psql-equivalent and the specification of what it does.
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series('2026-06-01'::date, '2026-06-30'::date, '1 day')::date LOOP
    EXECUTE format(
      'INSERT INTO "telemetry_readings_2026_06" SELECT * FROM "telemetry_readings_legacy" WHERE ts >= %L AND ts < %L',
      d::text, (d + 1)::text
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "telemetry_readings_2026_06_device_metric_ts_idx" ON "telemetry_readings_2026_06" USING btree ("device_id","metric","ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_readings_2026_06_device_ts_metric_idx" ON "telemetry_readings_2026_06" USING btree ("device_id","ts","metric");
--> statement-breakpoint

-- A VALIDATED CHECK matching the partition bound lets ATTACH PARTITION skip its
-- own verification scan. The scan still happens — but here, on a table nobody
-- can see, instead of under the ACCESS EXCLUSIVE lock ATTACH takes on the
-- PARENT. That is the whole point of adding it.
ALTER TABLE "telemetry_readings_2026_06"
  ADD CONSTRAINT "telemetry_readings_2026_06_ts_check"
  CHECK (ts >= '2026-06-01 00:00:00+00' AND ts < '2026-07-01 00:00:00+00');
--> statement-breakpoint

-- Moves any stray row the DEFAULT partition caught for this month into the
-- staging table. Cheap when DEFAULT is empty (the steady state), and the
-- difference between a clean attach and `ERROR: updated partition constraint
-- for default partition would be violated by some row` if one did land.
WITH moved AS (
  DELETE FROM "telemetry_readings_default"
  WHERE ts >= '2026-06-01 00:00:00+00' AND ts < '2026-07-01 00:00:00+00'
  RETURNING *
)
INSERT INTO "telemetry_readings_2026_06" SELECT * FROM moved;
--> statement-breakpoint

ALTER TABLE "telemetry_readings" ATTACH PARTITION "telemetry_readings_2026_06"
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint

-- Redundant once attached (the partition bound implies it) and it would cost a
-- little on every insert.
ALTER TABLE "telemetry_readings_2026_06" DROP CONSTRAINT "telemetry_readings_2026_06_ts_check";
--> statement-breakpoint

-- ---- 2026-07 (6 279 816 rows on dev — the big one) -------------------------
CREATE TABLE IF NOT EXISTS "telemetry_readings_2026_07" (LIKE "telemetry_readings");
--> statement-breakpoint

DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series('2026-07-01'::date, '2026-07-31'::date, '1 day')::date LOOP
    EXECUTE format(
      'INSERT INTO "telemetry_readings_2026_07" SELECT * FROM "telemetry_readings_legacy" WHERE ts >= %L AND ts < %L',
      d::text, (d + 1)::text
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "telemetry_readings_2026_07_device_metric_ts_idx" ON "telemetry_readings_2026_07" USING btree ("device_id","metric","ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_readings_2026_07_device_ts_metric_idx" ON "telemetry_readings_2026_07" USING btree ("device_id","ts","metric");
--> statement-breakpoint
ALTER TABLE "telemetry_readings_2026_07"
  ADD CONSTRAINT "telemetry_readings_2026_07_ts_check"
  CHECK (ts >= '2026-07-01 00:00:00+00' AND ts < '2026-08-01 00:00:00+00');
--> statement-breakpoint
WITH moved AS (
  DELETE FROM "telemetry_readings_default"
  WHERE ts >= '2026-07-01 00:00:00+00' AND ts < '2026-08-01 00:00:00+00'
  RETURNING *
)
INSERT INTO "telemetry_readings_2026_07" SELECT * FROM moved;
--> statement-breakpoint
ALTER TABLE "telemetry_readings" ATTACH PARTITION "telemetry_readings_2026_07"
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
--> statement-breakpoint
ALTER TABLE "telemetry_readings_2026_07" DROP CONSTRAINT "telemetry_readings_2026_07_ts_check";
--> statement-breakpoint

-- ============================================================================
-- STEP 3 — CURRENT month. Its partition was created live and attached in step
-- 1, so anything the device wrote during the migration is ALREADY in it. Copy
-- the legacy rows into that same partition, day by day, and do it LAST: with
-- the agent stopped August has stopped moving, but if you chose to leave the
-- agent running this is the chunk you re-run to catch stragglers.
--
-- Note this copy goes into an INDEXED, ATTACHED partition, so it is slower per
-- row than step 2's unindexed staging. Day chunks keep it inside the ceiling.
-- ============================================================================
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series('2026-08-01'::date, '2026-08-31'::date, '1 day')::date LOOP
    EXECUTE format(
      'INSERT INTO "telemetry_readings_2026_08" SELECT * FROM "telemetry_readings_legacy" WHERE ts >= %L AND ts < %L',
      d::text, (d + 1)::text
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ============================================================================
-- STEP 4 — verify, then drop the legacy table.
--
-- DO NOT SKIP THE VERIFY. The whole reason Q6 was reversed to "migrate" is that
-- the rows matter; a chunk lost in the middle of a 59-chunk copy is invisible
-- unless someone counts. Expect one row per month, `legacy` = `partitioned`,
-- and `default_rows` = 0.
-- ============================================================================
SELECT
  m,
  legacy_rows,
  partitioned_rows,
  partitioned_rows - legacy_rows AS delta
FROM (
  SELECT to_char(date_trunc('month', ts), 'YYYY-MM') AS m, count(*) AS legacy_rows
  FROM "telemetry_readings_legacy" GROUP BY 1
) l
FULL JOIN (
  SELECT to_char(date_trunc('month', ts), 'YYYY-MM') AS m2, count(*) AS partitioned_rows
  FROM "telemetry_readings" GROUP BY 1
) p ON p.m2 = l.m
ORDER BY 1;
--> statement-breakpoint

SELECT count(*) AS default_rows FROM "telemetry_readings_default";
--> statement-breakpoint

DROP TABLE "telemetry_readings_legacy";
--> statement-breakpoint

-- ============================================================================
-- STEP 5 — visibility-map hygiene (plan phase 4 section C).
--
-- telemetry_readings is append-only, so `n_dead_tup` stays ~0 and the
-- dead-tuple autovacuum trigger never fires. Postgres 13+ has an INSERT
-- trigger for exactly this case, but the cluster default
-- `autovacuum_vacuum_insert_scale_factor = 0.2` means a table this size waits
-- ~1.8 M inserts between visibility-map refreshes — and a stale VM turns every
-- index-only scan into a full heap fetch, roughly doubling I/O on every
-- history query (measured: `Heap Fetches: 170001` on a 170 K-row index-only
-- scan).
--
-- Per-partition settings, because storage parameters on a partitioned PARENT
-- are not inherited by its partitions. A flat 100 K threshold with the scale
-- factor OFF makes the refresh interval independent of table size — which is
-- the property that was missing.
--
-- partition-maintenance.ts applies the same two settings to every month
-- partition it creates, so future months inherit this without a migration.
-- ============================================================================
ALTER TABLE "telemetry_readings_2026_06" SET (autovacuum_vacuum_insert_threshold = 100000, autovacuum_vacuum_insert_scale_factor = 0.0);
--> statement-breakpoint
ALTER TABLE "telemetry_readings_2026_07" SET (autovacuum_vacuum_insert_threshold = 100000, autovacuum_vacuum_insert_scale_factor = 0.0);
--> statement-breakpoint
ALTER TABLE "telemetry_readings_2026_08" SET (autovacuum_vacuum_insert_threshold = 100000, autovacuum_vacuum_insert_scale_factor = 0.0);
--> statement-breakpoint
ALTER TABLE "telemetry_readings_default" SET (autovacuum_vacuum_insert_threshold = 100000, autovacuum_vacuum_insert_scale_factor = 0.0);
--> statement-breakpoint

-- Seed the visibility map and the planner's stats immediately rather than
-- waiting for the first autovacuum. VACUUM cannot run inside a transaction
-- block, so this is one call per partition (the Data API autocommits each).
VACUUM (ANALYZE) "telemetry_readings_2026_06";
--> statement-breakpoint
VACUUM (ANALYZE) "telemetry_readings_2026_07";
--> statement-breakpoint
VACUUM (ANALYZE) "telemetry_readings_2026_08";
--> statement-breakpoint
ANALYZE "telemetry_readings";

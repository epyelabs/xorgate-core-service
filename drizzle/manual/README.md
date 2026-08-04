# Manual migrations

Hand-written SQL that drizzle-kit cannot generate (partitioning) or shouldn't own
(seed data). These live outside the tracked `drizzle/NNNN_*.sql` set because
drizzle-kit owns the `NNNN_` numbering via `meta/_journal.json` — a hand-named
`0004_*.sql` would collide with the next `npm run db:generate`.

## How they are applied

Like the generated migrations, these are applied **out-of-band against the target
Aurora cluster via the RDS Data API** (AWS console Query Editor, or
`aws rds-data execute-statement`). There is no migration runner and no CDK custom
resource (see `initiate_backend.md`). The Data API runs **one statement per call**,
so split each file on its `--> statement-breakpoint` markers.

## Order

Apply after the latest generated migration, in filename order:

1. `drizzle/0003_minor_puff_adder.sql` (generated) — creates the new tables, incl. a
   **plain** `telemetry_readings`.
2. `manual/001_telemetry_partition.sql` — drops & recreates `telemetry_readings` as a
   monthly RANGE-partitioned table + bootstrap partitions (`2026_06`, `2026_07`).
3. `manual/002_seed_rpi_device_model.sql` — upserts the full-capability reference
   device model (idempotent).
4. `manual/003_imu_bno085_capabilities.sql` — re-upserts the same model with the
   richer BNO085 `sensors.imu` block (idempotent).
5. `manual/004_gps_extended_fields.sql` — re-upserts the same model with
   `satellites` + `fix_quality` added to `comm.gps.fields` (idempotent).
6. `manual/005_telemetry_default_partition.sql` — adds a catch-all `DEFAULT`
   partition to `telemetry_readings` so a `ts` outside every monthly partition still
   lands rather than hard-failing the insert (kvs-webrtc-lts §13 T2). Idempotent
   (guarded). Apply after the generated `0010_*` migration.
7. `manual/006_gps_quality_fields.sql` — in-place `jsonb_set` adding
   `satellites_in_view` + `hdop` to the model's `comm.gps.fields` (idempotent).
   Deliberately not a re-upsert: the live row has drifted from the seed (model
   renamed, camera labels changed), so it only touches the gps fields list.

8. `manual/008_telemetry_partition_migrate.sql` — **NOT part of the fresh-cluster
   sequence.** It converts an ALREADY-POPULATED `telemetry_readings` into the same
   monthly-partitioned shape as `001`, without losing its rows. Read the choice
   this way:

   - **Fresh cluster, `telemetry_readings` genuinely empty** → apply `001` + `005`
     as above, **before first ingestion**. Cheap, and no migration is needed.
   - **Table already has rows** → apply `008` instead. `001` opens with
     `DROP TABLE IF EXISTS "telemetry_readings" CASCADE` and would destroy every
     one of them.

   `008` is build-and-attach (per-month tables filled, indexed and CHECK-constrained
   before they are attached, so the parent never serves a half-copied partition)
   and is driven by `scripts/migrate-telemetry-partitions.mjs`, which issues the
   copy one chunk per Data API call and verifies each chunk by row count.
   Applied to `xorgatedb_dev` on 2026-08-04: 8 900 602 rows, zero lost. Full
   rationale is in the file header; the `improve-recording-history-fetching`
   plan's PROGRESS.md (phase 4 notes) has the measurements.

The capability re-upserts (002 → 003 → 004) each carry the full `io_capabilities`
forward, so applying only the latest is enough on a fresh cluster (then 006 on
top); re-running all in order is safe — but note 004 re-seeds the original
name/labels, so on the live cluster prefer 006 alone.

Going forward, future monthly partitions are created by the P4
`partition-maintenance` Lambda; these bootstrap files only cover the first two months.

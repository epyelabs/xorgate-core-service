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

The capability re-upserts (002 → 003 → 004) each carry the full `io_capabilities`
forward, so applying only the latest is enough on a fresh cluster; re-running all
in order is safe.

Going forward, future monthly partitions are created by the P4
`partition-maintenance` Lambda; these bootstrap files only cover the first two months.

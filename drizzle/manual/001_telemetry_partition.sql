-- Manual migration: convert telemetry_readings into a monthly RANGE-partitioned table.
-- drizzle-kit cannot emit `PARTITION BY`, so 0003 creates a PLAIN telemetry_readings;
-- this migration drops it and recreates it as a partitioned parent, then bootstraps
-- the current + next month. Apply AFTER 0003. Partition maintenance (future months)
-- is handled by the P4 partition-maintenance Lambda.
--
-- Partitioning is invisible to drizzle snapshots, so this drop+recreate causes no
-- future `db:generate` drift (columns/indexes still match src/db/schema.ts).

DROP TABLE IF EXISTS "telemetry_readings" CASCADE;
--> statement-breakpoint
CREATE TABLE "telemetry_readings" (
	"device_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"value" double precision,
	"unit" text,
	"meta" jsonb
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE INDEX "telemetry_device_metric_ts_idx" ON "telemetry_readings" USING btree ("device_id","metric","ts");
--> statement-breakpoint
CREATE INDEX "telemetry_device_ts_metric_idx" ON "telemetry_readings" USING btree ("device_id","ts","metric");
--> statement-breakpoint
CREATE TABLE "telemetry_readings_2026_06" PARTITION OF "telemetry_readings"
	FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "telemetry_readings_2026_07" PARTITION OF "telemetry_readings"
	FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

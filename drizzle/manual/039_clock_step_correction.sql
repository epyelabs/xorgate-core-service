-- clock-step-correction P0 (2026-10-20): audit columns for the cloud-side
-- correction of stale boot clocks (plans/clock-step-correction/PLAN.md, D9).
-- A battery-less CM5 boots on the fake-hwclock restore stamp; ingest detects
-- the NTP/GPS/NITZ step (inflated media durationMs, telemetry ts-vs-mono jump),
-- shifts the stale rows forward and records how much here:
--   clock_correction_ms  cumulative forward shift applied (NULL = never)
--   clock_stale_before   raw wall time below which a late segment is still
--                        stale and gets the same shift (D10)
--   clock_corrected_at   server time of the last correction
-- Idempotent (IF NOT EXISTS). Apply on dev and prod BEFORE deploying the code
-- that selects these columns (drizzle names every column in its reads).

ALTER TABLE "media_sessions"
	ADD COLUMN IF NOT EXISTS "clock_correction_ms" bigint,
	ADD COLUMN IF NOT EXISTS "clock_stale_before" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "clock_corrected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "telemetry_sessions"
	ADD COLUMN IF NOT EXISTS "clock_correction_ms" bigint,
	ADD COLUMN IF NOT EXISTS "clock_stale_before" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "clock_corrected_at" timestamp with time zone;

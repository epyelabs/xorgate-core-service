-- Telemetry session artifacts, Phase 6 (plans/telemetry-session-artifacts,
-- phase file item 9, README Q15): the `telemetry_session_completed` workflow
-- trigger. It fires from the sweeper's housekeeping tick once a telemetry
-- session is closed AND its overview (and so its insights) is built. This
-- column records the last fire so the tick can find what still owes one:
--
--   status = 'closed' AND overview_key IS NOT NULL AND overview_stale = false
--   AND (completed_fired_at IS NULL OR completed_fired_at < last_segment_at)
--
-- A straggler segment (last_segment_at moves) re-arms the session, so a
-- reopened-and-reclosed session fires again with its rebuilt insights
-- (at-least-once, like the media twin); a manual rebuild does not.
--
-- Backfill: every session closed and built before this migration is marked
-- as already fired, so enabling the trigger does not replay history.
--
-- Idempotent. Apply through the RDS Data API BEFORE deploying the Phase 6
-- code (drizzle names every column it selects). Two statements.

ALTER TABLE "telemetry_sessions" ADD COLUMN IF NOT EXISTS "completed_fired_at" timestamptz;
--> statement-breakpoint
UPDATE "telemetry_sessions" SET "completed_fired_at" = coalesce("overview_built_at", now())
WHERE "completed_fired_at" IS NULL AND "status" = 'closed' AND "overview_key" IS NOT NULL;

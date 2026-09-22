-- Telemetry session artifacts, Phase 2 (plans/telemetry-session-artifacts,
-- phase file step 2.1): the replay manifest reports each overview's gzipped
-- size so a client can budget the fetch, and a HEAD per manifest request is a
-- round trip we do not want. The builder knows the size at PUT time and
-- records it here; rows built before this column existed are filled by the
-- housekeeping tick (one HEAD per session, bounded per pass) and read as
-- `bytes: null` in the manifest until then.
--
-- Also repairs index rows whose device clock was garbage: two dev sessions
-- have a second segment stamped in the year 2080 by an RTC that jumped, and
-- because the manifest joins telemetry sessions to the replay by OVERLAP,
-- they matched every window for decades. `indexSegment` now clamps a sample
-- ts more than a day after the object's arrival to the arrival time; these
-- two statements apply the same rule to rows indexed before that and re-derive
-- the session bounds from the repaired segments (a no-op on consistent rows).
--
-- Idempotent. Apply through the RDS Data API BEFORE deploying the Phase 2
-- code: drizzle names every column it selects, so code that knows this column
-- 500s against a cluster that does not have it. Three statements.

ALTER TABLE "telemetry_sessions" ADD COLUMN IF NOT EXISTS "overview_bytes" integer;
--> statement-breakpoint
UPDATE "telemetry_segments" SET
	"start_ts" = CASE WHEN "start_ts" > "uploaded_at" + interval '1 day' THEN "uploaded_at" ELSE "start_ts" END,
	"end_ts" = greatest(
		CASE WHEN "end_ts" > "uploaded_at" + interval '1 day' THEN "uploaded_at" ELSE "end_ts" END,
		CASE WHEN "start_ts" > "uploaded_at" + interval '1 day' THEN "uploaded_at" ELSE "start_ts" END)
WHERE "start_ts" > "uploaded_at" + interval '1 day' OR "end_ts" > "uploaded_at" + interval '1 day';
--> statement-breakpoint
UPDATE "telemetry_sessions" s SET "started_at" = b.min_start, "ended_at" = b.max_end, "updated_at" = now()
FROM (SELECT "session_id", min("start_ts") AS min_start, max("end_ts") AS max_end FROM "telemetry_segments" GROUP BY "session_id") b
WHERE b."session_id" = s."id" AND (s."started_at" <> b.min_start OR s."ended_at" IS DISTINCT FROM b.max_end);

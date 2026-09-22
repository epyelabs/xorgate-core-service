-- Telemetry session index (plans/telemetry-session-artifacts, Phase 1, README D7).
--
-- Two tables:
--   `telemetry_sessions` - one row per device-minted telemetry session (the
--                          uuidv7 in the segment key and header). Lifecycle,
--                          counters, the overview artifact pointer and the
--                          D12 insights mirror with its three promoted columns.
--   `telemetry_segments` - one row per uploaded segment object, keyed by its
--                          S3 key. The replay manifest (Phase 2) reads these
--                          instead of listing S3.
--
-- Hand-written for the reason this folder exists: `drizzle/meta` is several
-- manual migrations behind the live schema, so `drizzle-kit generate` would
-- emit CREATEs for tables the cluster already has.
--
-- Idempotent: every statement is `IF NOT EXISTS`. Apply through the RDS Data
-- API, one call per breakpoint marker below.
--
-- Foreign keys: `telemetry_sessions.device_id` cascades from `devices` (unlike
-- `telemetry_readings`, which is partitioned and is deleted by hand in
-- services/device-teardown.ts; nothing is added there, the FK does it).
-- `telemetry_segments.session_id` cascades from its session. A device transfer
-- moves `workspace_id` only; these rows key on `device_id` and are unaffected.

CREATE TABLE IF NOT EXISTS "telemetry_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"last_segment_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"rate_hz" integer,
	"time_source" text,
	"segment_count" integer DEFAULT 0 NOT NULL,
	"sample_count" bigint DEFAULT 0 NOT NULL,
	"byte_count" bigint DEFAULT 0 NOT NULL,
	"overview_key" text,
	"overview_built_at" timestamp with time zone,
	"overview_stale" boolean DEFAULT false NOT NULL,
	"insights" jsonb,
	"insights_computed" jsonb,
	"distance_m" double precision,
	"duration_ms" bigint,
	"max_speed_kph" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_sessions_device_id_devices_id_fk"
		FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade
);
--> statement-breakpoint
-- The manifest's range scan: telemetry sessions overlapping [from, to] for a device.
CREATE INDEX IF NOT EXISTS "telemetry_sessions_device_started_idx"
	ON "telemetry_sessions" USING btree ("device_id","started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_sessions_device_ended_idx"
	ON "telemetry_sessions" USING btree ("device_id","ended_at");
--> statement-breakpoint
-- The sweeper's close pass. Partial: only open sessions are ever candidates.
CREATE INDEX IF NOT EXISTS "telemetry_sessions_open_idx"
	ON "telemetry_sessions" USING btree ("status","last_segment_at") WHERE "status" = 'open';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telemetry_segments" (
	"s3_key" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"start_ts" timestamp with time zone NOT NULL,
	"end_ts" timestamp with time zone NOT NULL,
	"samples" integer NOT NULL,
	"bytes" integer NOT NULL,
	"normalized" boolean DEFAULT false NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_segments_session_id_telemetry_sessions_id_fk"
		FOREIGN KEY ("session_id") REFERENCES "public"."telemetry_sessions"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telemetry_segments_session_seq_idx"
	ON "telemetry_segments" USING btree ("session_id","seq");
--> statement-breakpoint
-- The manifest's per-session segment filter to [from, to], and the builder's
-- seq-ordered walk.
CREATE INDEX IF NOT EXISTS "telemetry_segments_session_start_idx"
	ON "telemetry_segments" USING btree ("session_id","start_ts");

CREATE TABLE "telemetry_ingest_log" (
	"s3_key" text PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" uuid,
	"rows_inserted" integer NOT NULL,
	"lines_skipped" integer DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);

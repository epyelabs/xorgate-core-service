ALTER TABLE "recordings" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "duration_ms" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "max_recording_ms" integer;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "capture_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "reconnect_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "media_segments" ADD COLUMN "finalized" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "media_segments" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "media_sessions" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "media_sessions" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_sessions" ADD COLUMN "time_source" text;--> statement-breakpoint
ALTER TABLE "media_sessions" ADD COLUMN "bitrate_kbps" integer;--> statement-breakpoint
ALTER TABLE "media_sessions" ADD COLUMN "last_segment_at" timestamp with time zone;
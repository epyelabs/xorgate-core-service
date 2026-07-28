DROP TABLE "recordings" CASCADE;--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "persist_telemetry";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "auto_record";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "max_recording_ms";
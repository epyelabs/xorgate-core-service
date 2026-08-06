ALTER TABLE "devices" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "config_rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "config_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "reported_config" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "ui_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;
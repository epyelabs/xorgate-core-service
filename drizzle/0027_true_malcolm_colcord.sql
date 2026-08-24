ALTER TABLE "device_registrations" ADD COLUMN "model_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "needs_model" boolean DEFAULT false NOT NULL;
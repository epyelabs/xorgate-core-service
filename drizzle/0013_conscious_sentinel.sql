ALTER TABLE "workflow_runs" ADD COLUMN "mode" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "engine_version" integer;
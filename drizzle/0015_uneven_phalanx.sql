ALTER TABLE "workflow_events" ALTER COLUMN "device_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "device_id" DROP NOT NULL;
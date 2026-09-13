-- xorgate Models, M3 (plans/xorgate-models, design §4b, §4d): the training and
-- assist job row. Hand-written because `db:generate` is blocked on its rename
-- prompt (drizzle/manual/README.md); mirrors src/db/schema.ts column for
-- column. Status and task columns are text, not enums (the aws-data-api
-- driver's enum cast). Idempotent; safe to re-run.
--
-- Apply BEFORE the deploy that ships the training-jobs handler and the
-- finalizer: drizzle names every column, so a deploy ahead of this file is a
-- 500 on every touched route.

CREATE TABLE IF NOT EXISTS "model_training_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "dataset_id" uuid REFERENCES "datasets"("id") ON DELETE set null,
  "dataset_version_id" uuid REFERENCES "dataset_versions"("id") ON DELETE set null,
  "task" text DEFAULT 'train' NOT NULL,
  "recipe" text DEFAULT 'yolov8' NOT NULL,
  "base" jsonb,
  "spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "mode" text,
  "target" text DEFAULT 'cpu' NOT NULL,
  "compute" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "dispatched_at" timestamp with time zone,
  "external_ref" text,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "billable_seconds" integer,
  "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metrics" jsonb,
  "artifacts" jsonb,
  "error" text,
  "output_model_id" uuid,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_training_jobs_org_status_idx" ON "model_training_jobs" ("organization_id", "status");
--> statement-breakpoint
-- The SageMaker job name is the external identity the EventBridge finalizer
-- looks a row up by; unique so a redelivered state change can never match two.
CREATE UNIQUE INDEX IF NOT EXISTS "model_training_jobs_external_ref_idx" ON "model_training_jobs" ("external_ref");

-- xorgate Models, M2 (plans/xorgate-models, design §4b): datasets, dataset
-- items, annotations, recording imports, dataset versions, and the
-- organization model registry rows. Hand-written because `db:generate` is
-- blocked on its rename prompt (drizzle/manual/README.md); mirrors
-- src/db/schema.ts column for column. Every status column is text, not an
-- enum (the aws-data-api driver's enum cast). Idempotent; safe to re-run.
--
-- Apply BEFORE the deploy that ships the datasets/models handlers: drizzle
-- names every column, so a deploy ahead of this file is a 500 on every route.

CREATE TABLE IF NOT EXISTS "datasets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "task" text DEFAULT 'object_detection' NOT NULL,
  "classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "item_count" integer DEFAULT 0 NOT NULL,
  "labeled_count" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "datasets_org_slug_idx" ON "datasets" ("organization_id", "slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "datasets"("id") ON DELETE cascade,
  "s3_key" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "source" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "group_key" text,
  "status" text DEFAULT 'unlabeled' NOT NULL,
  "labeled_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "labeled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_items_dataset_sha256_idx" ON "dataset_items" ("dataset_id", "sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_items_dataset_status_idx" ON "dataset_items" ("dataset_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_annotations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL REFERENCES "dataset_items"("id") ON DELETE cascade,
  "class_id" text NOT NULL,
  "x1" double precision NOT NULL,
  "y1" double precision NOT NULL,
  "x2" double precision NOT NULL,
  "y2" double precision NOT NULL,
  "source" text DEFAULT 'human' NOT NULL,
  "source_ref" text,
  "confidence" double precision,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_annotations_item_idx" ON "dataset_annotations" ("item_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "datasets"("id") ON DELETE cascade,
  "kind" text DEFAULT 'recording' NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "items_added" integer DEFAULT 0 NOT NULL,
  "error" text,
  "dispatched_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_imports_dataset_idx" ON "dataset_imports" ("dataset_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "datasets"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "message" text,
  "split_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "class_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "stats" jsonb,
  "health" jsonb,
  "s3_prefix" text NOT NULL,
  "status" text DEFAULT 'building' NOT NULL,
  "error" text,
  "dispatched_at" timestamp with time zone,
  "ready_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_versions_dataset_version_idx" ON "dataset_versions" ("dataset_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "family" text NOT NULL,
  "name" text NOT NULL,
  "version" integer NOT NULL,
  "label" text,
  "manifest" jsonb NOT NULL,
  "s3_prefix" text NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "provenance" jsonb,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_models_org_family_name_version_idx" ON "org_models" ("organization_id", "family", "name", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_models_org_family_idx" ON "org_models" ("organization_id", "family");

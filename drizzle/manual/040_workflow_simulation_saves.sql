-- Workflow simulator "Saved runs" (sim-cancel-save, 2026-11-05).
--
-- A user's bookmark of a simulation run on a template, so the simulator can
-- reopen it later. Lookups are keyed by (template_id, user_id); a user may save
-- several runs per template but never the same run twice (a re-save renames the
-- existing row, ON CONFLICT on the unique index). `user_id` is TEXT because
-- users.id is the Cognito sub. `bindings` is a display-only snapshot of the
-- run's trigger_context.bindings at save time. Every FK cascades, so deleting
-- the template, run, user or org removes the bookmark.
--
-- A hand-written manual migration rather than `npm run db:generate` output: the
-- drizzle snapshot lags the schema (every table since manual/020 was added here
-- by hand), so a generated 0028 would re-CREATE ~20 existing tables.
--
-- Additive and idempotent (IF NOT EXISTS). Apply through the RDS Data API
-- BEFORE deploying the code (the saved-simulation routes 500 without the
-- table; nothing else reads it). Three statements.
CREATE TABLE IF NOT EXISTS "workflow_simulation_saves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"bindings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_simulation_saves_template_user_run_idx"
	ON "workflow_simulation_saves" ("template_id", "user_id", "run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_simulation_saves_template_user_idx"
	ON "workflow_simulation_saves" ("template_id", "user_id");

CREATE TABLE "workflow_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"pinned_version" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"triggers" jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"confidence" double precision,
	"clip" boolean DEFAULT false NOT NULL,
	"clip_s3_key" text,
	"payload_summary" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"node_id" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"attachment_id" uuid,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"trigger" text NOT NULL,
	"trigger_context" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"execution_mode" text NOT NULL,
	"task_arn" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"failed_node_id" text,
	"event_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"definition" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_trigger_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"trigger_index" integer NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_condition_met" boolean,
	"last_window_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_attachments" ADD CONSTRAINT "workflow_attachments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_attachments" ADD CONSTRAINT "workflow_attachments_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_attachments" ADD CONSTRAINT "workflow_attachments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_attachment_id_workflow_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."workflow_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_trigger_state" ADD CONSTRAINT "workflow_trigger_state_attachment_id_workflow_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."workflow_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_attachments_device_template_idx" ON "workflow_attachments" USING btree ("device_id","template_id");--> statement-breakpoint
CREATE INDEX "workflow_events_run_idx" ON "workflow_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_events_device_occurred_idx" ON "workflow_events" USING btree ("device_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_steps_run_node_idx" ON "workflow_run_steps" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_workspace_started_idx" ON "workflow_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_device_started_idx" ON "workflow_runs" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_runs_attachment_idx" ON "workflow_runs" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_template_versions_template_version_idx" ON "workflow_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_templates_org_slug_idx" ON "workflow_templates" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_trigger_state_attachment_trigger_idx" ON "workflow_trigger_state" USING btree ("attachment_id","trigger_index");
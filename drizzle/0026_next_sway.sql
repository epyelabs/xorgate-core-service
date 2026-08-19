-- ALREADY APPLIED. DO NOT RUN THIS AGAINST dev.
--
-- This file is a RE-BASELINE, not a migration. `drizzle/meta` had drifted five
-- items behind the real schema because Phases 1 to 4 of
-- plans/platform-auth-and-live-plane applied their SQL by hand under
-- `drizzle/manual/` (out-of-band via the RDS Data API), which is the project's
-- normal route and leaves drizzle's snapshot untouched. `npm run db:generate`
-- was consequently blocked for six phases on an interactive prompt about the
-- unapplied firmware_version -> agent_version rename.
--
-- Phase 6 answered that prompt (RENAME, never create -- creating would have
-- dropped the column and its data) and regenerated. The value of this commit is
-- `drizzle/meta/0026_snapshot.json`: the next `db:generate` now produces a real
-- diff instead of re-emitting these eight statements forever.
--
-- Every statement below was VERIFIED present on dev before this was committed
-- (2026-08-19, information_schema over the RDS Data API): both tables exist,
-- all six columns exist, devices.firmware_version is gone, and
-- device_registrations.created_by_user_id is already nullable. Running it would
-- fail on the first CREATE TABLE.
--
-- It is kept rather than emptied because the snapshot beside it is derived from
-- it, and because a future environment built from zero does need these
-- statements. If one is ever created, run the whole `drizzle/` chain plus
-- `drizzle/manual/` on it; do not run this file alone.

CREATE TABLE "iot_policy_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"policy_name" text NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hashed_token" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"role" text NOT NULL,
	"created_by_key_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" RENAME COLUMN "firmware_version" TO "agent_version";--> statement-breakpoint
ALTER TABLE "device_registrations" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "key_prefix" text;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "kvs_channels" ADD COLUMN "tagged_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "iot_policy_attachments" ADD CONSTRAINT "iot_policy_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_created_by_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "iot_policy_attachments_identity_policy_idx" ON "iot_policy_attachments" USING btree ("identity_id","policy_name");--> statement-breakpoint
CREATE INDEX "iot_policy_attachments_user_idx" ON "iot_policy_attachments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_tokens_hashed_token_idx" ON "session_tokens" USING btree ("hashed_token");--> statement-breakpoint
CREATE INDEX "session_tokens_expires_at_idx" ON "session_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_tokens_created_by_key_idx" ON "session_tokens" USING btree ("created_by_key_id");--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_created_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_org_active_idx" ON "api_keys" USING btree ("organization_id") WHERE "api_keys"."revoked_at" is null;
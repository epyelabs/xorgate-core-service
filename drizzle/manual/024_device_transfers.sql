-- Device transfer ownership (plans/transfer-device-ownership, Phase 2 + Phase 4).
--
-- Two tables:
--   `device_transfers`       — the audit trail for a tenancy change and the state
--                              machine that makes an interrupted one recoverable.
--   `device_transfer_offers` — the cross-organization handshake (README §2.4/Q1),
--                              modelled on `device_registrations`.
--
-- Hand-written rather than drizzle-generated for the reason this whole folder
-- exists: `drizzle/meta` is several manual migrations behind the live schema
-- (datasets, org_models, model_training_jobs, workflow_templates.tags,
-- organizations.logo_key, users.avatar_key …), so `drizzle-kit generate` emits a
-- migration that would try to CREATE tables the cluster already has. Reconciling
-- the snapshot is its own piece of work and is the owner's.
--
-- Idempotent: every statement is `IF NOT EXISTS`, so re-running it is a no-op.
-- Apply through the RDS Data API, one call per breakpoint marker below. (The
-- marker is deliberately not spelled out in this header: a splitter that scans
-- the file for it would otherwise cut the header in half.)
--
-- Note on foreign keys, because the asymmetry is deliberate:
--   `device_transfers.device_id`       -> ON DELETE SET NULL. The record of where
--        a device has been outlives the device, exactly as `device_registrations`
--        outlives it.
--   `device_transfers.*_workspace_id` / `*_organization_id` -> NO foreign key at
--        all, like `deleted_devices`. A transfer record has to survive the
--        deletion of either tenancy, or the history disappears the first time
--        someone tidies up a workspace.
--   `device_transfer_offers.device_id` -> ON DELETE CASCADE. An offer is a LIVE
--        claim on a device; a deleted device must not leave a claimable code.

CREATE TABLE IF NOT EXISTS "device_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid,
	"from_workspace_id" uuid NOT NULL,
	"to_workspace_id" uuid NOT NULL,
	"from_organization_id" uuid NOT NULL,
	"to_organization_id" uuid NOT NULL,
	"actor_user_id" text,
	"actor_api_key_id" uuid,
	"offer_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"stage" text DEFAULT 'db' NOT NULL,
	"scope_attributes" text,
	"detached_workflow_attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "device_transfers_device_id_devices_id_fk"
		FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null,
	CONSTRAINT "device_transfers_actor_user_id_users_id_fk"
		FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null,
	CONSTRAINT "device_transfers_actor_api_key_id_api_keys_id_fk"
		FOREIGN KEY ("actor_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_transfers_device_idx"
	ON "device_transfers" USING btree ("device_id","created_at");
--> statement-breakpoint
-- The mid-transfer guard scans this. Partial, because `pending` is a state a row
-- occupies for a couple of seconds and the index only ever has to answer
-- "is one in flight for this device right now".
CREATE INDEX IF NOT EXISTS "device_transfers_pending_idx"
	ON "device_transfers" USING btree ("device_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_transfer_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"device_id" uuid NOT NULL,
	"from_organization_id" uuid NOT NULL,
	"from_workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_user_id" text,
	"created_by_api_key_id" uuid,
	"accepted_by_organization_id" uuid,
	"accepted_workspace_id" uuid,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"transfer_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_transfer_offers_device_id_devices_id_fk"
		FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade,
	CONSTRAINT "device_transfer_offers_from_organization_id_organizations_id_fk"
		FOREIGN KEY ("from_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade,
	CONSTRAINT "device_transfer_offers_from_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("from_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
	CONSTRAINT "device_transfer_offers_created_by_user_id_users_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null,
	CONSTRAINT "device_transfer_offers_created_by_api_key_id_api_keys_id_fk"
		FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null,
	CONSTRAINT "device_transfer_offers_resolved_by_user_id_users_id_fk"
		FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_transfer_offers_code_idx"
	ON "device_transfer_offers" USING btree ("code");
--> statement-breakpoint
-- One live offer per device. This is the DB half of the idempotency
-- `device_registrations` already uses: a second create returns the existing
-- pending offer rather than minting a second claimable code for the same device.
CREATE UNIQUE INDEX IF NOT EXISTS "device_transfer_offers_pending_device_idx"
	ON "device_transfer_offers" USING btree ("device_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_transfer_offers_from_org_status_idx"
	ON "device_transfer_offers" USING btree ("from_organization_id","status");

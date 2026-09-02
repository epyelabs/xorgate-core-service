-- Destroy mechanism (delete device / workspace / organization / own account).
--
-- Rows are deleted for real and the FK graph cascades; these tables hold the
-- facts that must outlive them. See the block comment above `deletedUsers` in
-- src/db/schema.ts for what each is for. In short:
--
--   deleted_users          a closed account's Cognito ID token verifies until it
--                          expires, and the API creates a `users` row on first
--                          sight of an unknown sub; this stops the re-creation.
--   deleted_organizations  audit trail for consumers reconciling their records.
--   deleted_devices        marks devices whose S3 prefixes were not fully drained
--                          in-request (the bucket lifecycle finishes the job).
--
-- Also flips device_registrations.created_by_user_id from ON DELETE CASCADE to
-- SET NULL: a registration is the record of how a device came to exist and
-- should outlive the account that minted it (the API-key creator column
-- already behaved this way).

CREATE TABLE IF NOT EXISTS deleted_users (
  id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS deleted_organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL,
  workspace_count integer NOT NULL DEFAULT 0,
  device_count integer NOT NULL DEFAULT 0,
  deleted_by text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS deleted_devices (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  serial text,
  s3_drained boolean NOT NULL DEFAULT true,
  deleted_by text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE device_registrations
  DROP CONSTRAINT IF EXISTS device_registrations_created_by_user_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE device_registrations
  ADD CONSTRAINT device_registrations_created_by_user_id_users_id_fk
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE NO ACTION;

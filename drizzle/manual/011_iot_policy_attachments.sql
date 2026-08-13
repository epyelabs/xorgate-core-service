-- Create `iot_policy_attachments` (platform-auth-and-live-plane plan, Phase 1).
--
-- Records which AWS IoT policy is attached to which Cognito identity, and for
-- which user. AWS remains the source of truth for the attachment itself; this
-- table exists solely because AWS cannot answer "which Cognito identity belongs
-- to user X". `GetId` needs the user's own id token, and the membership-removal
-- path holds a user id and no token, so without a recorded identity id there is
-- no way to detach a removed member's live-plane access.
--
-- Cardinality is one row per user in practice today: GetId is stable for a given
-- identity pool + provider + sub (verified on the dev pool, 2026-08-13, two
-- independent sign-ins of the same user resolving to the same identity id). The
-- policy_name dimension is the one expected to grow: Phase 4 evaluates
-- per-workspace policy variants, and a detach must then know which named
-- policies to remove.
--
-- ⚠️ Hand-written rather than `npm run db:generate`, for the same reason as
-- `010_rename_agent_version.sql`: generate stops on the still-unanswered
-- firmware_version -> agent_version rename prompt, which needs a TTY, and
-- answering it would fold that unrelated pending change into this migration.
-- The snapshot under drizzle/meta therefore does not know this table exists;
-- the next `npm run db:generate` will offer to CREATE it. That is correct and
-- harmless on a database where this file has already run (the generated SQL is
-- a plain CREATE TABLE which will then fail), but the honest fix is to answer
-- the rename prompt first and let generate re-baseline both at once.
--
-- Idempotent (IF NOT EXISTS throughout). No table rewrite, no data to migrate.
--
-- Apply on dev with the Data API (one statement per call, split on the
-- statement-breakpoint markers):
--   aws rds-data execute-statement --resource-arn <cluster> --secret-arn <secret> \
--     --database xorgatedb_dev --sql '<statement>'
-- Prod is user-only.

CREATE TABLE IF NOT EXISTS "iot_policy_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "identity_id" text NOT NULL,
  "policy_name" text NOT NULL,
  "attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One attachment row per (identity, policy). Keyed on the identity rather than
-- the user because the identity is what AWS actually holds the attachment
-- against, and it makes the attach path a clean ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS "iot_policy_attachments_identity_policy_idx"
  ON "iot_policy_attachments" ("identity_id", "policy_name");
--> statement-breakpoint
-- The membership-removal lookup: user -> every identity to detach.
CREATE INDEX IF NOT EXISTS "iot_policy_attachments_user_idx"
  ON "iot_policy_attachments" ("user_id");

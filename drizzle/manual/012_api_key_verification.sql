-- API-key verification (platform-auth-and-live-plane plan, Phase 2).
--
-- Makes a minted `xg_` key a usable credential. Two tables move.
--
-- `api_keys` gains three columns:
--
--   role       - the membership role the key acts with. Default 'member',
--                which can write devices, workspaces and device registrations
--                but cannot touch memberships, API keys or organization
--                settings. Same vocabulary as `memberships.role`
--                (owner|admin|member|viewer); deliberately NOT a FK or an enum,
--                matching how `memberships.role` is already stored (plain text,
--                validated in the handler).
--   expires_at - opt-in expiry. NULL means "never expires", which is what every
--                existing key is.
--   key_prefix - the first 8 characters of the plaintext (`xg_` + 5), stored so
--                a list response can identify a key a human is holding.
--                **Cannot be backfilled**: only the SHA-256 was ever stored, so
--                every key minted before this migration keeps NULL forever and
--                the API documents that as "unknown".
--
-- `device_registrations` loses a NOT NULL and gains a column. `created_by_user_id`
-- was `NOT NULL REFERENCES users(id)`, which an API-key caller cannot satisfy:
-- a key has no Cognito identity and therefore no `users` row. `POST
-- /device-registrations` is gated to owner|admin|member, so a default-role key
-- reaches it, and without this change it would fail on the foreign key.
-- Attribution is preserved rather than dropped: exactly one of the two creator
-- columns is set. Existing rows are untouched and keep their user id.
--
-- ⚠️ Hand-written rather than `npm run db:generate`, for the same reason as
-- `010_rename_agent_version.sql` and `011_iot_policy_attachments.sql`: generate
-- stops on the still-unanswered firmware_version -> agent_version rename prompt,
-- which needs a TTY, and answering it would fold that unrelated pending change
-- into this migration. The snapshot under drizzle/meta therefore does not know
-- about these columns either; it is now behind the real schema in three places
-- (010's rename, 011's table, this file's columns). The honest fix is still to
-- answer the rename prompt first and let generate re-baseline all of it at once.
--
-- Idempotent (IF NOT EXISTS / conditional DROP NOT NULL). No table rewrite:
-- every ADD COLUMN is nullable or has a constant default, which Postgres 11+
-- applies without touching existing rows.
--
-- Apply on dev with the Data API (one statement per call, split on the
-- statement-breakpoint markers):
--   aws rds-data execute-statement --resource-arn <cluster> --secret-arn <secret> \
--     --database xorgatedb_dev --sql '<statement>'
-- Prod is user-only.
--
-- WHAT IS INERT WITHOUT IT: everything this phase ships. Unlike Phase 1's
-- migration, the code does NOT degrade gracefully here — `requireOrgContext`
-- selects `role`, `expires_at` and `key_prefix` on every key-authenticated
-- request, so on a database without these columns EVERY `Bearer xg_` request is
-- a 500 rather than a 401. The Cognito path is unaffected either way (it never
-- reads `api_keys`), so an unmigrated deployment keeps working exactly as it
-- does today for xorgate-web and every existing caller. Apply this before
-- telling anyone their key works.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "key_prefix" text;
--> statement-breakpoint
-- Key lookup on the verification path filters `revoked_at IS NULL`. The unique
-- index on hashed_key already makes the lookup a single-row fetch, so this is
-- about the OTHER direction: listing an organization's live keys, which the
-- api-keys handler does on every GET.
CREATE INDEX IF NOT EXISTS "api_keys_org_active_idx"
  ON "api_keys" ("organization_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "device_registrations"
  ALTER COLUMN "created_by_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "device_registrations"
  ADD COLUMN IF NOT EXISTS "created_by_api_key_id" uuid
  REFERENCES "api_keys"("id") ON DELETE SET NULL;

-- Session tokens (platform-auth-and-live-plane plan, Phase 3).
--
-- The public-client credential. A consumer's BACKEND presents its `xg_` key to
-- `POST /auth/session-tokens` and gets back a short-lived `xgs_` token that its
-- browser or mobile app may hold. One new table, nothing else moves.
--
-- Columns worth explaining:
--
--   hashed_token     - SHA-256 hex of the plaintext, same construction as
--                      `api_keys.hashed_key`. The plaintext is returned once
--                      and never stored.
--   workspace_id     - NULL means org-scoped, and such a token behaves exactly
--                      like the key that minted it. When set it is an ENFORCED
--                      boundary: the token sees that workspace's devices and
--                      nothing else, and organization-wide resources answer
--                      `403 WORKSPACE_SCOPED`. This is the column that turns
--                      the workspace-as-consumer-tenant decision from a filter
--                      into a boundary. ON DELETE CASCADE so a deleted
--                      workspace cannot leave tokens naming it.
--   role             - inherited from the minting key, never elevated. The
--                      EFFECTIVE role is the lower of this and the key's
--                      CURRENT role, computed at verify time, so downgrading a
--                      key downgrades its live tokens rather than leaving them
--                      privileged until TTL.
--   created_by_key_id- the minting key, ON DELETE CASCADE. This is the
--                      revocation story: `DELETE /api-keys/{id}` is a hard
--                      delete (Phase 2 decision), so deleting a key destroys
--                      every token it minted, in the same statement, with no
--                      extra lookup. Revoking or expiring the key without
--                      deleting it is caught by the verify path, which INNER
--                      JOINs the key row and re-applies its reject rules — one
--                      statement, so cascade costs no extra round trip.
--   revoked_at       - honoured by the verify path. No endpoint sets it, and
--                      that is deliberate: max TTL is 3600s and deleting the
--                      minting key is the emergency stop. See the Phase 3
--                      handoff.
--
-- ⚠️ Hand-written rather than `npm run db:generate`, for the same reason as
-- `010`, `011` and `012`: generate stops on the still-unanswered
-- firmware_version -> agent_version rename prompt, which needs a TTY, and
-- answering it would fold that unrelated pending change into this migration.
-- The snapshot under drizzle/meta is therefore now behind the real schema in
-- FOUR places (010's rename, 011's table, 012's columns, this file's table).
-- The honest fix is still to answer the rename prompt first and let generate
-- re-baseline all of it at once, as its own revertible commit.
--
-- Idempotent (IF NOT EXISTS throughout). Creating a table touches no existing
-- row, so there is no rewrite and no lock of consequence.
--
-- Apply on dev with the Data API (one statement per call, split on the
-- statement-breakpoint markers):
--   aws rds-data execute-statement --resource-arn <cluster> --secret-arn <secret> \
--     --database xorgatedb_dev --sql '<statement>'
-- Prod is out of scope for this whole plan (user, 2026-08-13).
--
-- WHAT IS INERT WITHOUT IT: everything this phase ships. Like `012` and unlike
-- `011`, the code does NOT degrade gracefully: the verify path selects from
-- `session_tokens` on every `Bearer xgs_` request, so on a database without the
-- table every session-token request is a 500 rather than a 401, and
-- `POST /auth/session-tokens` 500s on the insert. The Cognito and API-key paths
-- never touch this table and are unaffected either way. Apply this before
-- deploying the code.

CREATE TABLE IF NOT EXISTS "session_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hashed_token" text NOT NULL,
  "organization_id" uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  "workspace_id" uuid
    REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_by_key_id" uuid NOT NULL
    REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The verification lookup. Unique so a hash collision is a constraint error
-- rather than an ambiguous row, and so the lookup is a single-row fetch.
CREATE UNIQUE INDEX IF NOT EXISTS "session_tokens_hashed_token_idx"
  ON "session_tokens" ("hashed_token");
--> statement-breakpoint
-- The expiry sweep (job 4 in handlers/offline-sweeper.ts) scans on this.
CREATE INDEX IF NOT EXISTS "session_tokens_expires_at_idx"
  ON "session_tokens" ("expires_at");
--> statement-breakpoint
-- Not for the verify path (which joins by primary key) but for the cascade
-- delete: without it, deleting an API key sequentially scans session_tokens.
CREATE INDEX IF NOT EXISTS "session_tokens_created_by_key_idx"
  ON "session_tokens" ("created_by_key_id");

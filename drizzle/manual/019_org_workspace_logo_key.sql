-- Organization and workspace logos (settings page).
--
-- One nullable column on each table: the S3 key of the picture, written by
-- `PUT /organizations/{id}/logo` and `PUT /workspaces/{id}/logo` into the core
-- bucket under `logos/organizations/<orgId>/<uuid>.<ext>` and
-- `logos/workspaces/<workspaceId>/<uuid>.<ext>`. As with `users.avatar_key`
-- (manual/018) the key carries a fresh uuid per upload rather than overwriting
-- a stable one, so a replaced logo cannot be served stale from a cache still
-- holding the previous presigned URL.
--
-- NULL means "no logo": every row before this feature, and anyone who removed
-- theirs. Clients fall back to initials, so there is nothing to backfill and
-- the field is optional forever.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_key text;
--> statement-breakpoint
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS logo_key text;

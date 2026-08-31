-- Profile pictures (account page).
--
-- One nullable column: the S3 key of the user's profile picture, written by
-- `PUT /me/avatar` into the core bucket under `avatars/<userId>/<uuid>.<ext>`.
-- The key carries a fresh uuid per upload rather than overwriting a stable
-- one, so a replaced picture cannot be served stale from a cache still holding
-- the previous presigned URL.
--
-- NULL means "no picture": every user before this feature, and anyone who
-- removed theirs. Clients fall back to initials, so there is nothing to
-- backfill and the field is optional forever.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_key text;

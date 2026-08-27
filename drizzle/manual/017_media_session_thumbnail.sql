-- Media session thumbnails (session-thumbnails feature).
--
-- One nullable column: the S3 key of the session's poster frame, extracted by
-- MediaThumbnailFn from the session's first segment (seq 0, keyframe-aligned by
-- construction) and stored inside the session's own prefix
-- (media-sessions/v1/<deviceId>/<streamKey>/<sessionId>/thumb.jpg) so the
-- existing lifecycle expiry covers it.
--
-- NULL means "no thumbnail (yet)": sessions ingested before this feature, or a
-- session whose seq-0 extraction failed past retries. Consumers must treat the
-- field as optional forever - there is no backfill.

ALTER TABLE media_sessions
  ADD COLUMN IF NOT EXISTS thumbnail_key text;

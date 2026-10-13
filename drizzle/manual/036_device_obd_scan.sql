-- obd2-bluetooth-integration plan, P3 backend: server-side rate limit for the
-- `obd_scan` device command (POST /devices/{id}/commands/obd-scan). The
-- handler accepts a scan only when this is NULL or older than 60 s, with one
-- conditional UPDATE ... RETURNING, so concurrent requests cannot both pass.
-- NULL = never scanned. Idempotent.

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "obd_scan_requested_at" timestamp with time zone;

-- Device SMS inbox (plans/device-sms-inbox, Phase 2, README §3.1 + contract.md §4-5).
--
-- One row per "read the SIM's messages" request. `id` doubles as the command
-- `requestId` the device echoes on `xorgate/devices/{id}/sms`; the ingest
-- Lambda (handlers/device-sms-result.ts) writes the outcome onto the row.
--
-- Retention is NOT a schedule. The ingest Lambda, after storing an `ok`
-- result, deletes every OLDER row of that device, so each device keeps one
-- `ok` row (the copy an offline device's sheet shows) plus whatever failed or
-- pending requests came after it. `device_id` CASCADES, which covers device
-- deletion and teardown. `workspace_id` / `organization_id` carry no FK, like
-- `device_purges`.
--
-- `result` holds message text and sender numbers (PII): it is only ever set on
-- `ok` rows and goes with the next `ok` read.
--
-- `"limit"` is a reserved word in Postgres; it stays quoted everywhere (drizzle
-- quotes every identifier, so the app code needs nothing special).
--
-- Additive and idempotent. Apply through the RDS Data API BEFORE deploying the
-- Phase 2 code (the SMS routes and the ingest Lambda 500 without the table;
-- nothing else reads it). Three statements.
CREATE TABLE IF NOT EXISTS device_sms_reads (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  requested_by text NOT NULL,
  "limit" integer NOT NULL DEFAULT 10,
  status text NOT NULL DEFAULT 'pending',
  error_code text,
  error_message text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_sms_reads_device_created_idx
  ON device_sms_reads (device_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_sms_reads_device_latest_ok_idx
  ON device_sms_reads (device_id, completed_at DESC)
  WHERE status = 'ok';

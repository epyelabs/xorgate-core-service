-- Device data purge (plans/device-wf-data-delete, Phase 1 §1.1).
--
-- One row per purge request: the audit record ("who wiped what, when, with
-- what outcome") and the job state the queue worker resumes from. The worker
-- (services/device-purge.ts) claims the row through `lease_until`, persists
-- `cursor` and `counts` after every chunk, and re-enqueues itself when the
-- Lambda budget runs low, so a duplicate SQS delivery resumes rather than
-- repeats.
--
-- `device_id` CASCADES on purpose: once the device is gone its own tombstone
-- (`deleted_devices`) is the record, and a worker that finds no row acks.
-- `workspace_id` / `organization_id` carry no FK, like `deleted_devices`.
--
-- Additive and idempotent. Apply through the RDS Data API BEFORE deploying
-- the Phase 1 code (drizzle selects every column, so an unmigrated database
-- 500s on the purge routes). Two statements.
CREATE TABLE IF NOT EXISTS device_purges (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  cutoff timestamptz NOT NULL,
  cursor jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_purges_device_requested_idx
  ON device_purges (device_id, requested_at DESC);

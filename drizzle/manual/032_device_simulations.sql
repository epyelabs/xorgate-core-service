-- Device simulator (plans/xorgate-device-simulator, Phase 3, README §3.1).
--
-- `devices.simulated` marks a device created by `POST /device-simulations`: the
-- real agent in `--mode replay` in a container on a sim host. Fixed at creation,
-- never patchable; it is what lets the `simulation` config namespace be refused
-- for every real device.
--
-- `device_simulations` is 1:1 with a simulated device: what the sim host should
-- do with it (`desired_state`, plus the `start_requested_at` power-on edge,
-- README Q8) and what the host last reported (`host_*`). `device_id` CASCADES:
-- the device's teardown deletes the provision-bundle secret first
-- (services/device-teardown.ts) and the row goes with the device.
--
-- Additive and idempotent. Apply through the RDS Data API BEFORE deploying the
-- Phase 3 code: drizzle selects every column of `devices`, so an unmigrated
-- database 500s on EVERY device route, not just the new ones. Three statements.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS device_simulations (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  desired_state text NOT NULL DEFAULT 'running',
  start_requested_at timestamptz,
  host_id text,
  host_state text NOT NULL DEFAULT 'pending',
  host_message text,
  host_reported_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- `GET /devices?simulated=true` and the quota count; a partial index stays tiny
-- because almost every device is real.
CREATE INDEX IF NOT EXISTS devices_simulated_idx ON devices (workspace_id) WHERE simulated;

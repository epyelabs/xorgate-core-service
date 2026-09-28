-- Xorgate webhooks, Phase 1 (plans/xorgate-webhooks, README §6): the endpoint
-- registry, device-side routing, the outbox and the delivery log, plus the
-- `devices.status_changed_at` edge column the Phase 2 presence emitters claim on.
--
--   webhook_endpoints   org registry: name (the handle templates reference),
--                       URL, Secrets Manager pointer (secret_version), health.
--                       No event list and no routing of its own (README D1).
--   webhook_routes      device -> endpoint + event types (presence, sessions).
--                       Workflow events are routed by the output.event node's
--                       `webhook` field instead, so they never appear here.
--   webhook_events      the OUTBOX: one row per thing that happened, written in
--                       the same statement sequence as the state change.
--                       `dedupe_key` makes emitters idempotent; `dispatched_at`
--                       NULL means the minute tick must re-enqueue it.
--                       `endpoint_id` is set for node-routed events and `ping`.
--   webhook_deliveries  one row per (event, endpoint) attempt chain; a
--                       redelivery is a new row pointing at the original
--                       (`redelivery_of`), so the fan-out uniqueness is partial.
--
-- Deviations from the README sketch, all deliberate:
--   * created_by is text: users.id is the Cognito sub (text), not a uuid.
--   * webhook_events.endpoint_id is ON DELETE SET NULL, so deleting an endpoint
--     keeps its event history (and deletes its deliveries by cascade).
--   * webhook_deliveries gains redelivery_of + the partial unique index
--     (event_id, endpoint_id) WHERE redelivery_of IS NULL (fan-out idempotency).
--
-- Text status columns, never pgEnum (Data API binds enums as text). Idempotent:
-- every statement is IF NOT EXISTS. Apply through the RDS Data API, one
-- statement per call, split on the breakpoints, BEFORE deploying the Phase 1
-- code. Thirteen statements.

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "description" text,
  "secret_version" integer DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "disabled_at" timestamptz,
  "disabled_reason" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_delivery_at" timestamptz,
  "last_success_at" timestamptz,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_endpoints_org_name_idx" ON "webhook_endpoints" ("organization_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_endpoints_org_enabled_idx" ON "webhook_endpoints" ("organization_id") WHERE "enabled";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "device_id" uuid REFERENCES "devices"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "event_types" text[] NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_routes_device_endpoint_idx" ON "webhook_routes" ("device_id", "endpoint_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "workspace_id" uuid,
  "type" text NOT NULL,
  "endpoint_id" uuid REFERENCES "webhook_endpoints"("id") ON DELETE SET NULL,
  "dedupe_key" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "dispatched_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_dedupe_key_idx" ON "webhook_events" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_undispatched_idx" ON "webhook_events" ("created_at") WHERE "dispatched_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "webhook_events"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "redelivery_of" uuid REFERENCES "webhook_deliveries"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz,
  "response_status" integer,
  "response_ms" integer,
  "response_excerpt" text,
  "error" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_event_endpoint_idx" ON "webhook_deliveries" ("event_id", "endpoint_id") WHERE "redelivery_of" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx" ON "webhook_deliveries" ("next_attempt_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" ("endpoint_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamptz;

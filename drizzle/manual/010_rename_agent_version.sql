-- Rename devices.firmware_version -> devices.agent_version
-- (device_update_management plan, Phase 2 / README §2.3).
--
-- The column never held firmware. It was operator-written, never populated by
-- the claim path, and so has been NULL fleet-wide since it was added; from this
-- phase on it is MIRRORED from the device's own config report
-- (`effective.agent.build.version`) and operator writes are dropped. The agent
-- is not firmware, hence the name.
--
-- Metadata-only ALTER: instant, no table rewrite, data preserved (there is none
-- to preserve, but the rename is data-safe regardless). Not idempotent on its
-- own — Postgres has no `RENAME COLUMN IF EXISTS` — hence the DO block, which
-- makes re-running a no-op rather than an error.
--
-- ⚠️ drizzle-kit cannot author this: it emits a destructive drop+create for a
-- column rename unless a human answers its interactive rename prompt, and the
-- prompt needs a TTY. Same reason `0006_rename_project_to_workspace.sql` was
-- hand-written. The generated snapshot under drizzle/meta therefore still
-- carries `firmware_version`; the next `npm run db:generate` will offer
-- "renamed from firmware_version" — answer RENAME, never create/drop.
--
-- Apply on dev with the Data API (one statement per call):
--   aws rds-data execute-statement --resource-arn <cluster> --secret-arn <secret> \
--     --database xorgatedb_dev --sql "$(cat 010_rename_agent_version.sql)"
-- Prod is user-only.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'devices' AND column_name = 'firmware_version'
  ) THEN
    ALTER TABLE "devices" RENAME COLUMN "firmware_version" TO "agent_version";
  END IF;
END $$;

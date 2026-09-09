-- Free-form tags on a workflow template.
--
-- One `text[]` column plus a GIN index. The column is what a consumer holding an
-- organization API key filters on: `GET /workflow-templates?tag=geofence` becomes
-- `tags && ARRAY['geofence']`, which is exactly what a GIN index over an array
-- answers. A join table would buy referential tidiness that free-form labels have
-- no use for, at the cost of a join on every list row.
--
-- Values are normalized app-side before they land here (src/utils/tags.ts):
-- trimmed, lowercased, deduplicated, 1 to 32 characters matching
-- `^[a-z0-9][a-z0-9._-]*$`, at most 20 per template. Those rules are NOT enforced
-- by a CHECK constraint on purpose: the same module normalizes the query filter,
-- so a rule that lived in the database as well would be a second copy that can
-- disagree with the one the filter uses.
--
-- NOT NULL DEFAULT '{}' rather than a nullable column, so every read path can
-- treat the value as an array without a null branch. Postgres 11+ applies the
-- default to existing rows without rewriting the table, so there is nothing to
-- backfill: every template that existed before this is untagged.
--
-- Idempotent; safe to re-run.

ALTER TABLE workflow_templates
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflow_templates_tags_idx
  ON workflow_templates USING gin (tags);

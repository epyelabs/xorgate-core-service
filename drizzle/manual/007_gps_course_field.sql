-- Manual migration: extend the RPi reference model's GPS capability with
-- `course` (RMC track angle / course over ground, degrees true 0-360), which
-- the device agent's GPS collector now emits alongside the existing fields.
-- The telemetry ingest path is generic (flattens <group>.<field>), so no table
-- change is needed; this only tells the frontend/consumers the metric exists.
--
-- Like 006 this is an in-place jsonb_set, NOT a full re-upsert: the live row has
-- drifted from the seed (name "Argus CM5 Rev1", camera labels "Left"/"Right"),
-- so a re-upsert would clobber it. Idempotent — safe to re-run. On a fresh
-- cluster apply 002-006 first (this UPDATE is a no-op if the row doesn't exist).

UPDATE "device_models"
SET
	"io_capabilities" = jsonb_set(
		"io_capabilities",
		'{comm,gps,fields}',
		'["lat","lon","alt","speed","course","satellites","fix_quality","satellites_in_view","hdop"]'::jsonb
	),
	"updated_at" = now()
WHERE "sku" = 'XG-RPI-REF-1';

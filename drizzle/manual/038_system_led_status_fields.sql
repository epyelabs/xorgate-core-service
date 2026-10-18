-- include-led-status-in-telemetry P2 (2026-10-18): status-LED state in telemetry.
-- Appends two fields to the open `system.fields` list of the reference models,
-- in this order, each ONLY IF ABSENT:
--   led_state     severity-ascending status-LED code: 0 healthy, 1 starting,
--                 2 gps_wait, 3 network, 4 thermal, 5 undervoltage,
--                 6 agent_down (reserved, never emitted by the agent)
--   health_flags  bitmask: 1 undervoltage, 2 thermal, 4 lte_down, 8 mqtt_down,
--                 16 gps_no_fix, 32 gps_gate_hold, 64 dead_zone, 128 power_shed,
--                 256 live_block
-- Both numeric, no unit, emitted on every 1 Hz sample (live and recorded),
-- also on kits without an LED (owner decision: XG-CM4-REF-1 included).
--
-- Models: XG-RPI-REF-1 (Argus CM5 Rev1), XG-RPI-REF-1-OBD (its OBD clone) and
-- XG-CM4-REF-1 (Argus CM4 Rev1, statusLed null). Nothing else in a row moves.
-- Idempotent: a second run matches no row (the ?& guard) and changes nothing.
-- `system.fields` is an open string list (src/schemas/capabilities.ts), so the
-- order against a deploy does not matter.
--
-- If 035_obd_model.sql is ever re-run (it re-derives the OBD clone from the
-- base model), run this file again after it (and 037).

UPDATE "device_models"
SET
	"io_capabilities" = jsonb_set(
		"io_capabilities",
		'{system,fields}',
		("io_capabilities" #> '{system,fields}') || COALESCE((
			SELECT jsonb_agg(t.f ORDER BY t.ord)
			FROM jsonb_array_elements_text('["led_state", "health_flags"]'::jsonb)
				WITH ORDINALITY AS t(f, ord)
			WHERE NOT (("io_capabilities" #> '{system,fields}') ? t.f)
		), '[]'::jsonb)
	),
	"updated_at" = now()
WHERE "sku" IN ('XG-RPI-REF-1', 'XG-RPI-REF-1-OBD', 'XG-CM4-REF-1')
	AND jsonb_typeof("io_capabilities" #> '{system,fields}') = 'array'
	AND NOT (("io_capabilities" #> '{system,fields}') ?& ARRAY['led_state', 'health_flags']);

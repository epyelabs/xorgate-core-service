-- POST_INTEGRATION (obd2-bluetooth-integration, 2026-10-16): engine torque.
-- Appends the three torque fields to the pilot OBD model's declared field list
-- (`peripherals.obd.fields` of SKU XG-RPI-REF-1-OBD), after `link`, in this
-- order, each ONLY IF ABSENT:
--   engine_torque_pct  PID 62, actual engine torque, % of reference (A - 125)
--   reference_torque   PID 63, engine reference torque, Nm (A*256 + B)
--   engine_torque      derived on the device, Nm = pct / 100 * reference
-- Nothing else in the row moves; the base model XG-RPI-REF-1 is not touched.
-- Idempotent: a second run matches no row (the ?& guard) and changes nothing.
--
-- No device republish is needed: the device-facing hardware block carries
-- only {adapter, transport} (deriveHardwareBlock), so this edit does not
-- change what any device receives. The device polls every field its helper
-- knows when the `obd.fields` setting is empty (the default); the torque
-- fields reach a car through the agent release that ships the new decoders.
--
-- If 035_obd_model.sql is ever re-run (ON CONFLICT re-derives the clone with
-- the original 21 fields), run this file again after it.

UPDATE "device_models"
SET
	"io_capabilities" = jsonb_set(
		"io_capabilities",
		'{peripherals,obd,fields}',
		("io_capabilities" #> '{peripherals,obd,fields}') || COALESCE((
			SELECT jsonb_agg(t.f ORDER BY t.ord)
			FROM jsonb_array_elements_text('["engine_torque_pct", "reference_torque", "engine_torque"]'::jsonb)
				WITH ORDINALITY AS t(f, ord)
			WHERE NOT (("io_capabilities" #> '{peripherals,obd,fields}') ? t.f)
		), '[]'::jsonb)
	),
	"updated_at" = now()
WHERE "sku" = 'XG-RPI-REF-1-OBD'
	AND jsonb_typeof("io_capabilities" #> '{peripherals,obd,fields}') = 'array'
	AND NOT (("io_capabilities" #> '{peripherals,obd,fields}') ?& ARRAY['engine_torque_pct', 'reference_torque', 'engine_torque']);

-- Manual seed (obd2-bluetooth-integration plan, P2 backend, D2): the pilot
-- model "Argus CM5 Rev1 + OBD2", sku XG-RPI-REF-1-OBD. It is a CLONE of the
-- live "Argus CM5 Rev1" row (XG-RPI-REF-1) plus a v2 `peripherals.obd`
-- section, so every device on it keeps the exact CM5 hardware block and only
-- gains the OBD collector (hardware.peripherals.obd) once its agent knows the
-- key. Capabilities are per model (C2) and the base model's devices must not
-- light up a vehicle card, hence a new SKU rather than mutating XG-RPI-REF-1.
--
-- The base JSON is READ FROM THE BASE ROW AT APPLY TIME (jsonb || concat), not
-- copied here, so the clone never ships a stale snapshot of a row that has
-- drifted from its seed (015 upgraded it in place, 006/007 before that).
-- Idempotent: ON CONFLICT (sku) re-derives io_capabilities from the current
-- base row + the same peripherals section. No device is reassigned here; the
-- orchestrator moves the bench device after the agent that reads the key ships.
--
-- Claim ambiguity (C12): this row has the same platform (rpi-cm5) and camera
-- count (2) as XG-RPI-REF-1, so probe-at-claim now sees TWO cm5 candidates and
-- flags a fresh CM5 claim `needs_model` unless the registration pins a model.
-- Deliberate for the pilot (registrations pin `XG-RPI-REF-1-OBD`); resolved in
-- the console otherwise.

INSERT INTO "device_models" ("name", "sku", "io_capabilities", "firmware_channel")
SELECT
	'Argus CM5 Rev1 + OBD2',
	'XG-RPI-REF-1-OBD',
	base."io_capabilities" || '{
		"peripherals": {
			"obd": {
				"adapter": "elm327",
				"transport": "bt-spp",
				"rateHz": 1,
				"fields": [
					"rpm", "speed", "coolant_temp", "engine_load", "throttle", "pedal",
					"intake_temp", "ambient_temp", "intake_map", "baro", "fuel_level",
					"fuel_rate", "module_voltage", "adapter_voltage", "run_time",
					"odometer", "gear", "distance_since_clear", "mil", "dtc_count", "link"
				],
				"info": ["vin", "cal_ids", "ecu_names", "dtcs"]
			}
		}
	}'::jsonb,
	'stable'
FROM "device_models" AS base
WHERE base."sku" = 'XG-RPI-REF-1'
	AND (base."io_capabilities"->>'schemaVersion')::int = 2
ON CONFLICT ("sku") DO UPDATE SET
	"io_capabilities" = EXCLUDED."io_capabilities",
	"name" = EXCLUDED."name",
	"firmware_channel" = EXCLUDED."firmware_channel",
	"updated_at" = now();

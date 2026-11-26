-- Manual seed (daedalus-board plan): the model "Daedalus CM5 Rev1", sku
-- XG-RPI-DAE-1. The Daedalus carrier board is the Argus CM5 board with one
-- hardware difference that matters to the platform: its IMU is a BNO086 where
-- Argus has a BNO085. (It also exposes the 40-pin GPIO header as a port, which
-- no model section describes yet.) So the row is a CLONE of the live
-- "Argus CM5 Rev1" row (XG-RPI-REF-1) with:
--   - sensors.imu.model = "bno086"  (a free string end to end: the backend,
--     the SDK and both agents only test "an IMU is declared", so every agent
--     in the field reads this row exactly as it reads Argus);
--   - media.video[0|1].sensor = "imx219"  (the default camera sensor of both
--     ports, the owner's choice; Argus says imx290. It only seeds new
--     registrations and is the fallback label when a device has no
--     cameraSensors setting of its own).
-- Stream keys, connectors (cam0@csi0, cam1@csi1), platform, encoder, rails,
-- status LED, comm and telemetry fields are those of the base row, so moving a
-- device from Argus CM5 Rev1 to this row changes nothing but those two values.
--
-- The base JSON is READ FROM THE BASE ROW AT APPLY TIME, as 035 does, so the
-- clone never ships a stale snapshot. The guards below make the statement a
-- no-op if the base row is not the v2 two-camera document this seed was
-- written against (cam0 and cam1 at array positions 0 and 1).
-- Idempotent: ON CONFLICT (sku) re-derives the document from the current base
-- row. No device is reassigned here.
--
-- Claim ambiguity / fallback: this is a third rpi-cm5 two-camera row, so a
-- fresh CM5 claim stays `needs_model` unless the registration pins a model (it
-- already was, since 035). As the newest row it also becomes the fallback of
-- an UNPINNED registration, in place of XG-RPI-REF-1-OBD. Pin the model in the
-- Register dialog.

INSERT INTO "device_models" ("name", "sku", "io_capabilities", "firmware_channel")
SELECT
	'Daedalus CM5 Rev1',
	'XG-RPI-DAE-1',
	jsonb_set(
		jsonb_set(
			jsonb_set(
				base."io_capabilities",
				'{sensors,imu,model}', '"bno086"'::jsonb, true
			),
			'{media,video,0,sensor}', '"imx219"'::jsonb, false
		),
		'{media,video,1,sensor}', '"imx219"'::jsonb, false
	),
	'stable'
FROM "device_models" AS base
WHERE base."sku" = 'XG-RPI-REF-1'
	AND (base."io_capabilities"->>'schemaVersion')::int = 2
	AND base."io_capabilities"->'sensors'->'imu' IS NOT NULL
	AND jsonb_array_length(base."io_capabilities"->'media'->'video') = 2
	AND base."io_capabilities"->'media'->'video'->0->>'key' = 'cam0'
	AND base."io_capabilities"->'media'->'video'->1->>'key' = 'cam1'
ON CONFLICT ("sku") DO UPDATE SET
	"io_capabilities" = EXCLUDED."io_capabilities",
	"name" = EXCLUDED."name",
	"firmware_channel" = EXCLUDED."firmware_channel",
	"updated_at" = now();

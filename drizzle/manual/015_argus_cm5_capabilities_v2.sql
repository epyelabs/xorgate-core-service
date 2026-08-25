-- Manual migration (cm4-support plan, Phase 1): upgrade the live CM5 model row
-- ("Argus CM5 Rev1", sku XG-RPI-REF-1) from io_capabilities schemaVersion 1 to
-- 2 IN PLACE. Like 006/007 this is NOT a re-upsert — the row has drifted from
-- the 002 seed (name, labels, extended gps/signal/system fields) and must keep
-- that drift. Adds only the v2 platform facts:
--   system.platform  = rpi-cm5    (camera enumeration strategy / encoder default)
--   system.encoder   = sw-h264    (D4: the CM5 has NO hardware H.264 encoder)
--   system.rails     = true       (PMIC 5V-rail/PSU telemetry exists)
--   system.statusLed = {12,21,16} (the previously hardcoded STATUS_LED_MAP pins)
--   sensors.imu.model = bno085
--   media.video[0/1] += {connector: csi0/csi1, sensor: imx290}
-- Existing devices see NO behavior change: the derived hardware block tells a
-- CM5 agent to do exactly what its hardcoded legacy path already does.
-- Idempotent (|| overwrites with identical values; schemaVersion set to 2 is
-- stable). The video-count guard makes it a no-op on a row whose media shape
-- ever diverges from the expected two cameras.

UPDATE "device_models"
SET
	"io_capabilities" =
		jsonb_set(
		jsonb_set(
		jsonb_set(
		jsonb_set(
		jsonb_set("io_capabilities", '{schemaVersion}', '2'::jsonb),
			'{system}',
			("io_capabilities"->'system')
				|| '{"platform":"rpi-cm5","encoder":"sw-h264","rails":true,"statusLed":{"r":12,"g":21,"b":16}}'::jsonb),
			'{sensors,imu,model}', '"bno085"'::jsonb),
			'{media,video,0}',
			("io_capabilities"->'media'->'video'->0) || '{"connector":"csi0","sensor":"imx290"}'::jsonb),
			'{media,video,1}',
			("io_capabilities"->'media'->'video'->1) || '{"connector":"csi1","sensor":"imx290"}'::jsonb),
	"updated_at" = now()
WHERE "sku" = 'XG-RPI-REF-1'
	AND jsonb_array_length(COALESCE("io_capabilities"->'media'->'video', '[]'::jsonb)) = 2;

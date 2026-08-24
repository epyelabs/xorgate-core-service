-- Manual seed (cm4-support plan, Phase 1): the CM4 reference model — the first
-- schemaVersion-2-native row. One IMX290 on CSI0, hardware H.264 encode
-- (v4l2h264enc — the headline CM4 win: 53%/core -> 3%), no PMIC rail telemetry
-- (bare CM4 carrier), no status LED wired, IMU expected-if-present (the
-- collector self-gates on absence). comm/gps/signal identical to the CM5 row —
-- the SIM7600 stack is platform-independent. system.fields deliberately omits
-- rail_5v/psu_max_current (no PMIC ADC on CM4 -> would render permanent "—").
-- Idempotent upsert keyed on device_models_sku_idx, same pattern as 002.
--
-- NOTE: this row becomes the newest model, i.e. the registration auto-pick
-- fallback. That is safe because probe-at-claim (same plan phase) maps real
-- hardware to its platform's row; only an unrecognizable host keeps the
-- fallback, flagged needs_model for one-click correction in the console.

INSERT INTO "device_models" ("name", "sku", "io_capabilities", "firmware_channel")
VALUES (
	'Argus CM4 Rev1',
	'XG-CM4-REF-1',
	'{
		"schemaVersion": 2,
		"system": {
			"platform": "rpi-cm4",
			"encoder": "hw-h264",
			"rails": false,
			"statusLed": null,
			"fields": ["cpu_usage", "cpu_temp", "ram_usage", "disk_usage", "throttled"]
		},
		"sensors": {"imu": {
			"model": "bno085",
			"accel": ["x", "y", "z"],
			"quaternion": ["r", "i", "j", "k"],
			"euler": ["roll", "pitch", "yaw"],
			"unit": "m/s^2",
			"rateHz": 10
		}},
		"comm": {
			"module": "4g-lte",
			"gps": {"fields": ["lat", "lon", "alt", "speed", "course", "satellites", "fix_quality", "satellites_in_view", "hdop", "ttff_s"]},
			"signal": {"fields": ["rssi", "quality", "modem_temp", "gnss_health", "resets_24h"]}
		},
		"media": {
			"audio": [],
			"video": [
				{"key": "cam0", "codec": "h264", "label": "Front", "connector": "csi0", "sensor": "imx290", "maxWidth": 1280, "maxHeight": 720, "maxFps": 25}
			]
		}
	}'::jsonb,
	'stable'
)
ON CONFLICT ("sku") DO UPDATE SET
	"io_capabilities" = EXCLUDED."io_capabilities",
	"name" = EXCLUDED."name",
	"firmware_channel" = EXCLUDED."firmware_channel",
	"updated_at" = now();

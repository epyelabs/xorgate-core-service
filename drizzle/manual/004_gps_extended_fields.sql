-- Manual migration: extend the RPi reference model's GPS capability with
-- `satellites` and `fix_quality`, so the frontend renders the new gps.satellites
-- and gps.fix_quality metrics the device agent's real GPS collector now emits.
-- Re-upserts the same XG-RPI-REF-1 row as 003 (carrying its richer sensors.imu
-- block forward) with the wider gps.fields list. The telemetry ingest path is
-- generic (flattens <group>.<field>), so no table change is needed. Idempotent
-- upsert keyed on device_models_sku_idx — safe to re-run.

INSERT INTO "device_models" ("name", "sku", "io_capabilities", "firmware_channel")
VALUES (
	'Xorgate RPi Reference Kit',
	'XG-RPI-REF-1',
	'{
		"schemaVersion": 1,
		"media": {
			"video": [
				{"key":"cam0","codec":"h264","maxWidth":1280,"maxHeight":720,"maxFps":25,"label":"Front"},
				{"key":"cam1","codec":"h264","maxWidth":1280,"maxHeight":720,"maxFps":25,"label":"Rear"}
			],
			"audio": [{"key":"audio0","codec":"opus","sampleRate":48000,"channels":2}]
		},
		"sensors": {"imu": {
			"accel":["x","y","z"],
			"quaternion":["r","i","j","k"],
			"euler":["roll","pitch","yaw"],
			"unit":"m/s^2",
			"rateHz":10
		}},
		"comm": {"module":"4g-lte","gps":{"fields":["lat","lon","alt","speed","satellites","fix_quality"]},"signal":{"fields":["rssi","quality"]}},
		"system": {"fields":["cpu_usage","cpu_temp","ram_usage","disk_usage"]}
	}'::jsonb,
	'stable'
)
ON CONFLICT ("sku") DO UPDATE SET
	"io_capabilities" = EXCLUDED."io_capabilities",
	"name" = EXCLUDED."name",
	"firmware_channel" = EXCLUDED."firmware_channel",
	"updated_at" = now();

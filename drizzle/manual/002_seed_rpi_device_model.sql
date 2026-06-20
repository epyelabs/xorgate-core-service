-- Manual seed: full-capability Raspberry Pi reference device model.
-- Idempotent upsert keyed on the unique device_models_sku_idx. Safe to re-run.

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
		"sensors": {"imu": {"axes":["x","y","z"],"unit":"m/s^2","rateHz":10}},
		"comm": {"module":"4g-lte","gps":{"fields":["lat","lon","alt","speed"]},"signal":{"fields":["rssi","quality"]}},
		"system": {"fields":["cpu_usage","cpu_temp","ram_usage","disk_usage"]}
	}'::jsonb,
	'stable'
)
ON CONFLICT ("sku") DO UPDATE SET
	"io_capabilities" = EXCLUDED."io_capabilities",
	"name" = EXCLUDED."name",
	"firmware_channel" = EXCLUDED."firmware_channel",
	"updated_at" = now();

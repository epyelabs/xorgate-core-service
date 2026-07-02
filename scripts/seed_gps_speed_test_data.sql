-- Seed synthetic gps.speed telemetry for the overspeed inline-path test.
-- Device: a73f7a36-2a9c-45c4-a66c-54d3b018a7f7
--
-- 90 readings at 1 Hz over the last 90 seconds (ts up to ~now), in km/h. The
-- profile has TWO Gaussian humps (peaks ~18 and ~22 km/h at ~65s and ~25s ago),
-- separated by ~27s under 10 km/h — so against limitKph=10 it yields TWO distinct
-- overspeed episodes => two events (also verifies episode collapsing).
--
-- unit = 'km/h' so speed_from_gps treats the value as-is (it only converts when
-- unit = 'm/s'). Rows are tagged meta.seed='overspeed-test' for easy cleanup.
--
-- Run it, then within a few minutes do "Run now" on the Overspeed Detect
-- attachment with a lastN window (N >= 500 if the device also streams other live
-- telemetry; N=100 is plenty if it doesn't).

INSERT INTO telemetry_readings (device_id, ts, metric, value, unit, meta)
SELECT
  'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7'::uuid,
  now() - make_interval(secs => (90 - g)),
  'gps.speed',
  round((18 * exp(-power(g - 25, 2) / 50.0) + 22 * exp(-power(g - 65, 2) / 60.0))::numeric, 1),
  'km/h',
  '{"seed":"overspeed-test"}'::jsonb
FROM generate_series(0, 90) AS g;

-- Verify what you just inserted (should show ~91 rows, max ~22, unit km/h):
-- SELECT count(*), min(value), max(value), max(unit) AS unit,
--        min(ts) AS oldest, max(ts) AS newest
-- FROM telemetry_readings
-- WHERE device_id = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7'
--   AND meta->>'seed' = 'overspeed-test';

-- Cleanup when done:
-- DELETE FROM telemetry_readings
-- WHERE device_id = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7'
--   AND meta->>'seed' = 'overspeed-test';

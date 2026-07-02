-- Seed a published "Overspeed Detect" workflow template for E2E testing of the
-- INLINE (telemetry) execution path: source.gps -> speed_from_gps ->
-- speed_limit_check -> output.event. Runs in-process in the dispatcher Lambda (no
-- Fargate). Resolves your org + user id from the "Person Detect" template you
-- already created, so there are no ids to fill in.
--
-- limitKph is intentionally LOW (10) so a moving simulator reliably crosses it.
-- speed_from_gps converts gps.speed from m/s -> km/h ONLY if the reading's unit is
-- literally "m/s"; otherwise the raw value is treated as km/h. Run the diagnostic
-- query at the bottom to see your device's actual gps.speed range + unit, then
-- either edit the "Speed Limit Check" node in the UI (now in the catalog) or re-run
-- this with a different limitKph.

WITH src AS (
  SELECT organization_id, created_by_user_id
  FROM workflow_templates
  WHERE name = 'Person Detect'
  ORDER BY created_at DESC
  LIMIT 1
),
t AS (
  INSERT INTO workflow_templates
    (organization_id, name, slug, description, status,
     current_version, published_version, created_by_user_id, updated_by_user_id)
  SELECT
    organization_id,
    'Overspeed Detect',
    'overspeed-detect',
    'Flag GPS speed over a limit from persisted telemetry; emit one overspeed event per episode.',
    'published', 1, 1, created_by_user_id, created_by_user_id
  FROM src
  RETURNING id, created_by_user_id
)
INSERT INTO workflow_template_versions
  (template_id, version, status, message, definition, created_by_user_id)
SELECT
  t.id, 1, 'published', 'Initial published version',
  $def$
  {
    "nodes": [
      { "id": "n1", "type": "source.gps",
        "position": { "x": 40, "y": 200 },
        "data": { "label": "GPS", "config": {} } },
      { "id": "n2", "type": "processor.speed_from_gps",
        "position": { "x": 300, "y": 200 },
        "data": { "label": "Speed from GPS", "config": { "smoothing": "ema", "window": 2 } } },
      { "id": "n3", "type": "processor.speed_limit_check",
        "position": { "x": 580, "y": 200 },
        "data": { "label": "Speed Limit Check", "config": { "limitKph": 10 } } },
      { "id": "n4", "type": "output.event",
        "position": { "x": 860, "y": 200 },
        "data": { "label": "Overspeed", "config": { "kind": "overspeed" } } }
    ],
    "edges": [
      { "id": "e1", "source": "n1", "target": "n2" },
      { "id": "e2", "source": "n2", "target": "n3" },
      { "id": "e3", "source": "n3", "target": "n4" }
    ]
  }
  $def$::jsonb,
  t.created_by_user_id
FROM t;

-- Diagnostic: what gps.speed is actually persisted for your device (last hour)?
-- Replace <DEVICE_ID>. If count = 0, telemetry isn't being persisted
-- (persistTelemetry must be true) or the device isn't publishing gps.speed.
-- Use max(value)/unit to pick a limitKph the runs will actually cross.
--
-- SELECT count(*), min(value), max(value), avg(value)::numeric(10,2), max(unit) AS unit
-- FROM telemetry_readings
-- WHERE device_id = '<DEVICE_ID>' AND metric = 'gps.speed'
--   AND ts > now() - interval '1 hour';

-- Seed a published "Perimeter Person Detect" workflow template for E2E testing of
-- the video path (recording_saved -> Fargate CV runner -> events).
--
-- Single statement (data-modifying CTEs), safe for the RDS Data API. It resolves
-- your organization + user id from the "Person Detect" template you already
-- created in the UI, so there are no ids to fill in. If you renamed/deleted that
-- template, change the WHERE clause in `src` (or hardcode organization_id +
-- created_by_user_id).
--
-- Graph: source.video -> decode_sample(2fps) -> object_detection(person/vehicle,
-- minConfidence 0.4) -> output.event(person_at_perimeter, clip on). minDwellSeconds
-- is intentionally low (1s = 2 frames @ 2fps) so a short test clip reliably fires.

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
    'Perimeter Person Detect',
    'perimeter-person-detect',
    'Detect people in recorded video (YOLOv8 + IoU tracking); emit one event per dwelling track.',
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
      { "id": "n1", "type": "source.video",
        "position": { "x": 40, "y": 200 },
        "data": { "label": "Video Stream", "config": {} } },
      { "id": "n2", "type": "processor.decode_sample",
        "position": { "x": 320, "y": 200 },
        "data": { "label": "Decode & Sample", "config": { "fps": 2 } } },
      { "id": "n3", "type": "processor.object_detection",
        "position": { "x": 600, "y": 200 },
        "data": { "label": "Object Detection", "config": { "model": "yolo-n", "minConfidence": 0.4 } } },
      { "id": "n4", "type": "output.event",
        "position": { "x": 880, "y": 200 },
        "data": { "label": "Person at Perimeter",
                  "config": { "kind": "person_at_perimeter", "clip": "yes",
                              "minDwellSeconds": 1, "cooldownSeconds": 60 } } }
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

-- Verify (optional): should return one published template + its version.
-- SELECT t.id, t.name, t.slug, t.status, t.published_version, v.version, v.status
-- FROM workflow_templates t
-- JOIN workflow_template_versions v ON v.template_id = t.id
-- WHERE t.slug = 'perimeter-person-detect';

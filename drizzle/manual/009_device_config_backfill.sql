-- Backfill devices.config / devices.ui_prefs from the pre-consolidation columns
-- (improve_device_settings_management plan, Phase 2). Apply AFTER the generated
-- drizzle/0025_slim_iron_lad.sql, which adds the six new columns.
--
-- Fold the five device-delivered columns into ONE namespaced document, using
-- exactly the wire/settings.json keys (never renamed — the modem daemon greps
-- those paths), and the two cloud-only columns into ui_prefs:
--
--   gnss_ant_bias        -> config.gnssAntBias   (NOT NULL column, always set)
--   imu_mount            -> config.imuMount      (NULL -> key omitted)
--   recording_config     -> config.recording     (NULL -> key omitted)
--   lte_recovery_config  -> config.lteRecovery   (NULL -> key omitted)
--   time_sync_config     -> config.timeSync      (NULL -> key omitted)
--   active_streams_view_type -> ui_prefs.activeStreamsViewType (NOT NULL)
--   imu_view                 -> ui_prefs.imuView (NULL -> key omitted)
--
-- An ABSENT namespace means "device defaults", which is why NULL columns are
-- omitted rather than materialized — same semantics the publisher already had
-- (a NULL column was simply left out of the retained message).
--
-- jsonb_build_object is used per-namespace inside a CASE rather than
-- jsonb_strip_nulls over the whole document: strip_nulls is RECURSIVE and would
-- also delete any legitimately-null leaf inside a stored namespace.
--
-- config_rev starts at 1 for every existing device: rev 0 means "never
-- written", and the fleet's retained messages predate `rev` entirely (devices
-- ignore the field until the Phase 4 agent ships). The next PATCH bumps to 2.
--
-- Idempotent: the WHERE clause only touches rows still holding the '{}' default.

UPDATE devices SET
  config =
      jsonb_build_object('gnssAntBias', gnss_ant_bias)
   || CASE WHEN imu_mount IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('imuMount', imu_mount) END
   || CASE WHEN recording_config IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('recording', recording_config) END
   || CASE WHEN lte_recovery_config IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('lteRecovery', lte_recovery_config) END
   || CASE WHEN time_sync_config IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('timeSync', time_sync_config) END,
  ui_prefs =
      jsonb_build_object('activeStreamsViewType', active_streams_view_type)
   || CASE WHEN imu_view IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('imuView', imu_view) END,
  config_rev = 1,
  config_updated_at = updated_at
WHERE config = '{}'::jsonb;

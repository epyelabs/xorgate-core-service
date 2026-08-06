import type { DeviceConfigDocument } from './index';

/**
 * The pre-consolidation `devices` columns are DUAL-WRITTEN alongside `config` /
 * `ui_prefs` for the whole transition window: the deployed frontend and any
 * out-of-band script still read them off `GET /devices/{id}`. A follow-up
 * migration drops both the columns and this module (cf. drizzle/0022, which
 * dropped the pre-recording columns the same way).
 *
 * Each function mirrors ONLY its own half, and is called only when that half is
 * actually being written — mirroring ui_prefs on a config-only write would
 * reset `active_streams_view_type` to its default for any row whose ui_prefs
 * had not been backfilled.
 *
 * Lives here rather than in `handlers/devices.ts` because `devices.config` now
 * has a second writer: the device-config-report mirror folds `origin: local`
 * edits back into the document (settings-management plan, Phase 4), and a
 * writer that skipped these columns would leave the settings UI showing the
 * pre-edit value.
 */
export function legacyConfigColumns(config: DeviceConfigDocument): Record<string, unknown> {
  return {
    gnssAntBias: config.gnssAntBias ?? false,
    imuMount: config.imuMount ?? null,
    recordingConfig: config.recording ?? null,
    lteRecoveryConfig: config.lteRecovery ?? null,
    timeSyncConfig: config.timeSync ?? null,
  };
}

export function legacyUiPrefColumns(uiPrefs: Record<string, unknown>): Record<string, unknown> {
  return {
    activeStreamsViewType: (uiPrefs.activeStreamsViewType as string | undefined) ?? 'card',
    imuView: (uiPrefs.imuView as Record<string, unknown> | undefined) ?? null,
  };
}

/**
 * Central configuration for the recording-lifecycle thresholds (kvs-webrtc-lts §6).
 *
 * Every value reads an env var (wired via `commonEnv` in `lib/stacks/api-stack.ts`,
 * overridable at deploy time via `--context <key>=<value>`) and falls back to a
 * documented default that preserves today's behavior. Read at module scope by the
 * recording handlers/services so a threshold is never a bare magic number (G5).
 */

function numEnv(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(key: string, def: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const recordingConfig = {
  /** Auto-record: grace after a stream goes absent before its auto row stops. */
  autoRecordStopGraceMs: numEnv('AUTORECORD_STOP_GRACE_MS', 30_000),
  /** Auto-record: per-device reconcile throttle (telemetry-ingest). */
  autoRecordReconcileMs: numEnv('AUTORECORD_RECONCILE_MS', 8_000),
  /** Offline-sweeper: telemetry-staleness threshold that flips the device badge. */
  deviceOfflineStaleMs: numEnv('DEVICE_OFFLINE_STALE_MS', 60_000),
  /** Watchdog: default max recording duration cap; devices.max_recording_ms overrides. */
  maxRecordingMs: numEnv('MAX_RECORDING_MS', 4 * 60 * 60 * 1000),
  /** Watchdog: grace before a stuck recording/stopping row is reconciled terminal. */
  reconcileStuckMs: numEnv('RECONCILE_STUCK_MS', 5 * 60 * 1000),
  /** Device-status: debounce an online:false that follows a recent online:true (R3). */
  statusFlapGuardMs: numEnv('STATUS_FLAP_GUARD_MS', 10_000),
  /** Corroboration (§4.5): a capture heartbeat older than this means the media is gone. */
  captureStaleMs: numEnv('CAPTURE_STALE_MS', 36_000),
  /**
   * Master gate for the corroborated offline-stop (R6). Keep FALSE until the
   * recorder heartbeat (Phase 4) is deployed and writing `capture_heartbeat_at`;
   * until then a device-offline only flips the badge and never stops a recording
   * (the recorder's own media dead-air remains the end). See rollout §9 step 4.
   */
  offlineStopEnabled: boolEnv('OFFLINE_STOP_ENABLED', false),
  /**
   * Values handed to the recorder container as env via the RunTask overrides in
   * `services/recordings.ts`. Baked defaults live in the recorder C; these let the
   * backend override them per launch without a recorder-image rebuild.
   */
  recorder: {
    /** Capture-heartbeat cadence the recorder publishes at (media-plane liveness). */
    heartbeatMs: numEnv('RECORDER_HEARTBEAT_MS', 12_000),
    /** Ride-through budget: how long the recorder re-offers before finalizing. */
    reconnectWindowMs: numEnv('RECORDER_RECONNECT_WINDOW_MS', 90_000),
    /** Gap between re-offer attempts during a ride-through. */
    reofferIntervalMs: numEnv('RECORDER_REOFFER_INTERVAL_MS', 2_000),
  },
} as const;

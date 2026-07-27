/**
 * Central configuration for device-presence and on-device media thresholds.
 *
 * Every value reads an env var (wired via `commonEnv` in `lib/stacks/api-stack.ts`,
 * overridable at deploy time via `--context <key>=<value>`) and falls back to a
 * documented default that preserves today's behavior. Read at module scope so a
 * threshold is never a bare magic number (G5).
 *
 * The cloud viewer-recorder's own thresholds (auto-record, watchdog, capture
 * heartbeat) were removed with it — destroy-kvs-recorder Phase 3. Their env vars
 * are unwired from `commonEnv` in Phase 5.
 */

function numEnv(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export const recordingConfig = {
  /** Offline-sweeper: telemetry-staleness threshold that flips the device badge. */
  deviceOfflineStaleMs: numEnv('DEVICE_OFFLINE_STALE_MS', 60_000),
  /** Device-status: debounce an online:false that follows a recent online:true (R3). */
  statusFlapGuardMs: numEnv('STATUS_FLAP_GUARD_MS', 10_000),
  /**
   * Device-recorded media sessions (offline recording plan, Phase 4): a session
   * with no new segment ARRIVAL for this long is advisorily closed by the
   * sweeper. Generous by design — segments upload on backlog drain, so arrival
   * gaps of a few minutes are normal while a device rides through dead zones.
   */
  mediaSessionCloseAfterMs: numEnv('MEDIA_SESSION_CLOSE_AFTER_MS', 10 * 60 * 1000),
  /**
   * Device-recorded segment retention (offline recording plan, Phase 6.3).
   * S3 lifecycle rules expire `telemetry/v1/*` + `media-sessions/v1/*` objects
   * at this age (storage-stack, same context key); the sweeper expires the
   * matching DB index rows one day LATER, so S3 always deletes first and a
   * row is never removed while its object still needs indexing (see
   * expireSegmentIndexRows).
   */
  segmentRetentionDays: numEnv('SEGMENT_RETENTION_DAYS', 90),
} as const;

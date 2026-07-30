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
  /**
   * Media time-source upgrade experiment (optimize-system-process-cycle
   * Phase 1, Q6): when on, segment ingest monotonically upgrades
   * media_sessions.time_source (unsynced < rtc < ntp, never downgrades) as
   * better-stamped sidecars arrive — so a session whose clock synced
   * mid-session sheds the "clock unsynced" badge. Default off.
   */
  mediaTimeSourceUpgrade: numEnv('MEDIA_TIME_SOURCE_UPGRADE', 0) !== 0,
  /**
   * Far-future guardrail for device media segments (optimize-system-process-
   * cycle Phase 8). A device whose clock is catastrophically wrong — the
   * 2026-07-29 field case stamped segments in the year 2080 after trusting an
   * un-NITZ'd modem clock — used to have those segments absorbed silently:
   * the rows exist, no query with a sane time window ever returns them, and
   * nothing anywhere says so. Segments starting further than this into the
   * future are DROPPED with an error log instead (permanent failure, no
   * retry: the object's own timestamp can't improve). The telemetry batch
   * path has had the equivalent window since its Phase 2 build
   * (DEFAULT_MAX_FUTURE_MS); this closes the media half.
   *
   * Generous on purpose — legitimate skew is seconds, and the point is to
   * catch garbage, not to police clocks. 0 disables the check.
   */
  mediaSegmentMaxFutureMs: numEnv('MEDIA_SEGMENT_MAX_FUTURE_MS', 24 * 60 * 60 * 1000),
} as const;

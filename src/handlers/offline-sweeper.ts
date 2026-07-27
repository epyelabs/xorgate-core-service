import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  closeStaleMediaSessions,
  expireSegmentIndexRows,
} from '../services/media-sessions';
import { recordingConfig } from '../config/recording';

/**
 * Housekeeping tick (kvs-webrtc-lts Phase 2). Invoked by the existing EventBridge
 * schedule (~1 min, gated by disableScheduledJobs so it stays OFF in the shared
 * sandbox). Folds three jobs onto the ONE tick — deliberately no new schedule, so
 * no new Aurora wake source (§7.3):
 *
 *  1. Offline sweep: flip devices that stopped reporting `online` -> `offline`
 *     (badge only, telemetry-staleness based). Only touches `online` rows, so
 *     `provisioned`/`decommissioned` are never affected.
 *  2. Media-session close (offline recording plan, Phase 4): advisorily flip
 *     device-recorded media_sessions to 'closed' once segments stop arriving.
 *     Each open→closed transition also fires `session_completed` workflow
 *     triggers (Phase 6.4, at-least-once — see closeStaleMediaSessions).
 *  3. Segment index-row expiry (Phase 6.3): delete media_segments /
 *     empty media_sessions / telemetry_ingest_log rows one day after the S3
 *     lifecycle expired their objects.
 *
 * Each job is isolated in its own try/catch so one failing job never starves the
 * others. Pure server-side time; idempotent.
 */
export const handler = async (): Promise<void> => {
  // 1: offline sweep.
  try {
    const staleSecs = Math.round(recordingConfig.deviceOfflineStaleMs / 1000);
    await db
      .update(schema.devices)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(
        and(
          eq(schema.devices.status, 'online'),
          sql`(${schema.devices.lastSeenAt} IS NULL OR ${schema.devices.lastSeenAt} < now() - make_interval(secs => ${sql.raw(String(staleSecs))}))`,
        ),
      );
  } catch (err) {
    console.error('offline-sweeper: offline sweep failed', err);
  }

  // 2: advisory close of device-recorded media sessions that stopped receiving
  // segments (offline recording plan, Phase 4 — same "no new schedule" stance).
  try {
    const closed = await closeStaleMediaSessions();
    if (closed > 0) console.log('offline-sweeper: closed stale media sessions', { closed });
  } catch (err) {
    console.error('offline-sweeper: media-session close failed', err);
  }

  // 3: expire segment index rows behind the S3 lifecycle (Phase 6.3).
  try {
    const expired = await expireSegmentIndexRows();
    if (expired.segments > 0 || expired.sessions > 0 || expired.ingestLog > 0) {
      console.log('offline-sweeper: expired segment index rows', expired);
    }
  } catch (err) {
    console.error('offline-sweeper: segment index expiry failed', err);
  }
};

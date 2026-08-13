import { and, eq, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  closeStaleMediaSessions,
  expireSegmentIndexRows,
} from '../services/media-sessions';
import { recordingConfig } from '../config/recording';
import { EXPIRED_TOKEN_GRACE_MS } from '../services/session-token-auth';

/**
 * Housekeeping tick (kvs-webrtc-lts Phase 2). Invoked by the existing EventBridge
 * schedule (~1 min, gated by disableScheduledJobs so it stays OFF in the shared
 * sandbox — which means every job here is INERT on dev). Folds four jobs onto
 * the ONE tick — deliberately no new schedule, so no new Aurora wake source
 * (§7.3):
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
 *  4. Session-token expiry (platform-auth Phase 3): delete `session_tokens`
 *     rows that expired more than a day ago. Hygiene only — the verify path
 *     checks `expires_at` itself and never trusts the table to be clean.
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

  // 4: delete long-expired session tokens (platform-auth Phase 3). Piggybacked
  // on this tick for the same reason as jobs 2 and 3 — no new schedule, so no
  // new Aurora wake source. One indexed DELETE per tick, usually matching
  // nothing.
  //
  // Purely hygienic. An expired row is already dead to the verify path, which
  // checks `expires_at` rather than trusting the table to be clean; this only
  // stops the table growing forever. The 24-hour grace is so a token that just
  // expired is still there to be looked at while someone is debugging why their
  // browser started 401ing.
  try {
    const cutoff = new Date(Date.now() - EXPIRED_TOKEN_GRACE_MS);
    const deleted = await db
      .delete(schema.sessionTokens)
      .where(lt(schema.sessionTokens.expiresAt, cutoff))
      .returning({ id: schema.sessionTokens.id });
    if (deleted.length > 0) {
      console.log('offline-sweeper: deleted expired session tokens', {
        count: deleted.length,
      });
    }
  } catch (err) {
    console.error('offline-sweeper: session-token expiry failed', err);
  }
};

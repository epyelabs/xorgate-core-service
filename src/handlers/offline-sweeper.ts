import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  runRecordingWatchdog,
  stopRecordingsForOfflineDevice,
} from '../services/recordings';
import { closeStaleMediaSessions } from '../services/media-sessions';
import { recordingConfig } from '../config/recording';

/**
 * Housekeeping tick (kvs-webrtc-lts Phase 2). Invoked by the existing EventBridge
 * schedule (~1 min, gated by disableScheduledJobs so it stays OFF in the shared
 * sandbox). Folds four jobs onto the ONE tick — deliberately no new schedule, so
 * no new Aurora wake source (§7.3):
 *
 *  1. Offline sweep: flip devices that stopped reporting `online` -> `offline`
 *     (badge only, telemetry-staleness based). Only touches `online` rows, so
 *     `provisioned`/`decommissioned` are never affected.
 *  2. Corroborated offline-stop (§4.5): for each device this sweep just flipped
 *     offline, stop its active recordings — but only those whose media plane
 *     (capture heartbeat) has also gone quiet. This closes the gap where a lost
 *     QoS-0 LWT means only the sweeper catches the offline. Gated by
 *     offlineStopEnabled (R6); shares one helper with the LWT handler so both paths
 *     behave identically.
 *  3. Recording watchdog: max-duration cap (runaway guard) + orphan/stuck reconcile
 *     so no recording runs forever and no row sticks in recording/stopping.
 *  4. Media-session close (offline recording plan, Phase 4): advisorily flip
 *     device-recorded media_sessions to 'closed' once segments stop arriving.
 *
 * Each job is isolated in its own try/catch so one failing job never starves the
 * others. Pure server-side time; idempotent.
 */
export const handler = async (): Promise<void> => {
  // 1 + 2: offline sweep, then corroborated stop for the devices just flipped.
  try {
    const staleSecs = Math.round(recordingConfig.deviceOfflineStaleMs / 1000);
    const offlined = await db
      .update(schema.devices)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(
        and(
          eq(schema.devices.status, 'online'),
          sql`(${schema.devices.lastSeenAt} IS NULL OR ${schema.devices.lastSeenAt} < now() - make_interval(secs => ${sql.raw(String(staleSecs))}))`,
        ),
      )
      .returning({ id: schema.devices.id });

    for (const d of offlined) {
      try {
        const stopped = await stopRecordingsForOfflineDevice(d.id);
        if (stopped > 0) {
          console.log('offline-sweeper: stopped recordings on offline', {
            deviceId: d.id,
            stopped,
          });
        }
      } catch (err) {
        console.error('offline-sweeper: offline-stop failed', { deviceId: d.id, err });
      }
    }
  } catch (err) {
    console.error('offline-sweeper: offline sweep failed', err);
  }

  // 3: recording watchdog (max-duration + orphan/stuck reconcile).
  try {
    await runRecordingWatchdog();
  } catch (err) {
    console.error('offline-sweeper: recording watchdog failed', err);
  }

  // 4: advisory close of device-recorded media sessions that stopped receiving
  // segments (offline recording plan, Phase 4 — same "no new schedule" stance).
  try {
    const closed = await closeStaleMediaSessions();
    if (closed > 0) console.log('offline-sweeper: closed stale media sessions', { closed });
  } catch (err) {
    console.error('offline-sweeper: media-session close failed', err);
  }
};

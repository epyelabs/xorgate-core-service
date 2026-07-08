import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { stopRecordingsForOfflineDevice } from '../services/recordings';
import { recordingConfig } from '../config/recording';

// The IoT topic rule injects `topicDeviceId` via `topic(3)` and forwards the
// published JSON body: {v, deviceId, ts, online}. We trust the topic segment (the
// device IoT policy scopes publish to its own thing name = deviceId), not the body.
const statusEventSchema = z.object({
  online: z.boolean(),
  ts: z.number().optional(),
  deviceId: z.string().optional(),
  v: z.number().optional(),
});

// Flap guard (R3): remember the last online:true per device in the warm container
// so a stale/late LWT that arrives just after a reconnect doesn't bounce the badge.
const lastOnlineAt = new Map<string, number>();

/**
 * Device status / Last-Will (kvs-webrtc-lts Phase 1 — the keystone). Invoked
 * directly by the IoT Topic Rule
 *
 *   SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/status'
 *
 * The device agent publishes {online:true} on connect, {online:false} on graceful
 * shutdown, and — crucially — the broker fires the same {online:false} as an MQTT
 * Last-Will when the device drops ungracefully (power-off). The broker only fires
 * the LWT after the keepalive lapses (~1.5x), which is what distinguishes a true
 * power-off from a brief tunnel (§4.2).
 *
 * On offline we flip the device badge immediately (safe: self-corrects on
 * reconnect) and then do the §4.5 corroborated stop of active recordings — but only
 * once `offlineStopEnabled` (R6) is on and the media plane confirms the recording is
 * actually dead (stale capture heartbeat). Until then we only flip the badge.
 *
 * Error semantics mirror telemetry-ingest (IoT rule lambda actions are async
 * invokes): unrecoverable/bad payloads log and drop; a transient DB error throws so
 * the async-retry path can recover.
 */
export const handler = async (event: unknown): Promise<void> => {
  const parsed = statusEventSchema.safeParse(event);
  if (!parsed.success) {
    console.error('device-status: invalid payload, dropping', { issues: parsed.error.issues });
    return;
  }

  const topicDeviceId = (event as { topicDeviceId?: unknown }).topicDeviceId;
  if (typeof topicDeviceId !== 'string' || topicDeviceId.length === 0) {
    console.error('device-status: missing topic deviceId, dropping');
    return;
  }
  const deviceId = topicDeviceId;

  // Sanity check the in-body deviceId against the (trusted) topic segment.
  if (parsed.data.deviceId && parsed.data.deviceId !== deviceId) {
    console.warn('device-status: deviceId/topic mismatch (trusting topic)', {
      topicDeviceId: deviceId,
      bodyDeviceId: parsed.data.deviceId,
    });
  }

  const { online } = parsed.data;
  const now = Date.now();

  if (online) {
    lastOnlineAt.set(deviceId, now);
    // Re-assert online + bump last_seen so the sweeper doesn't immediately re-flip
    // it. Never resurrect a decommissioned device. (Do NOT auto-start recordings
    // here; auto-record start stays in reconcileAutoRecord, which picks the stream
    // up once telemetry resumes.)
    await db.execute(sql`
      UPDATE devices
      SET status = CASE WHEN status = 'decommissioned' THEN status ELSE 'online' END,
          last_seen_at = now(),
          updated_at = now()
      WHERE id = ${deviceId}::uuid
    `);
    return;
  }

  // online === false. Debounce a flap: ignore if this device published online:true
  // within the guard window (a late/duplicate LWT racing a fresh reconnect).
  const lastOn = lastOnlineAt.get(deviceId);
  if (lastOn !== undefined && now - lastOn < recordingConfig.statusFlapGuardMs) {
    console.log('device-status: ignoring offline flap', { deviceId });
    return;
  }

  // Flip the badge at once — only an actually-online row, never a decommissioned one.
  await db.execute(sql`
    UPDATE devices
    SET status = 'offline', updated_at = now()
    WHERE id = ${deviceId}::uuid AND status = 'online'
  `);

  // Corroborated stop (§4.5). No-op until offlineStopEnabled (R6) + the media plane
  // (capture heartbeat) confirms the recording is really dead.
  try {
    const stopped = await stopRecordingsForOfflineDevice(deviceId);
    if (stopped > 0) {
      console.log('device-status: stopped recordings on offline', { deviceId, stopped });
    }
  } catch (err) {
    console.error('device-status: offline-stop failed', { deviceId, err });
  }
};

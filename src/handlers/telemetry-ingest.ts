import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { telemetryPayloadSchema, flattenTelemetryToRows } from '../schemas/telemetry';
import { buildDeviceLatestUpsert } from '../utils/upsert';
import { evaluateTelemetryTriggers } from '../services/workflow-triggers';

/**
 * Telemetry ingestion (P2). Invoked directly by the AWS IoT Topic Rule
 *
 *   SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/telemetry'
 *
 * so the `event` IS the telemetry payload JSON (plus `topicDeviceId` injected by
 * the rule), NOT an API Gateway event. There is no HTTP auth context.
 *
 * Pipeline: validate → flatten → last-writer upsert `device_latest` → throttled
 * `devices.last_seen_at`/`status` heartbeat. The live plane is the *realtime*
 * plane only: it writes no telemetry history (disable_telemetry_recording,
 * 2026-08-04). The heartbeat is isolated from the upsert, so status tracking
 * survives a persist failure.
 *
 * Error semantics (IoT rule lambda actions are *async* invokes):
 *  - Bad/unparseable payloads can never succeed on retry → log and return (drop).
 *    The rule's SQS error action captures action-level failures separately.
 *  - Transient infra errors (DB down) → throw, so Lambda async-retry + the DLQ
 *    get a chance to recover the message.
 */
export const handler = async (event: unknown): Promise<void> => {
  const parsed = telemetryPayloadSchema.safeParse(event);
  if (!parsed.success) {
    console.error('telemetry-ingest: invalid payload, dropping', {
      issues: parsed.error.issues,
    });
    return;
  }
  const payload = parsed.data;

  // The device IoT policy scopes publish to its own thing name (= deviceId), so
  // the topic segment is trustworthy; the in-body deviceId is not. Reject a
  // payload that claims a different deviceId than the topic it arrived on.
  const topicDeviceId = (event as { topicDeviceId?: unknown }).topicDeviceId;
  if (typeof topicDeviceId === 'string' && topicDeviceId !== payload.deviceId) {
    console.error('telemetry-ingest: deviceId/topic mismatch, dropping', {
      topicDeviceId,
      payloadDeviceId: payload.deviceId,
    });
    return;
  }

  const rows = flattenTelemetryToRows(payload);

  // The live plane writes NO telemetry history (disable_telemetry_recording,
  // 2026-08-04). `recording.telemetry.enabled` is now the master switch for
  // `telemetry_readings`, and the on-device batch path (S3 segment →
  // telemetry-batch-ingest) is its SOLE writer — so with recording on the batch
  // plane already owns history, and with recording off nothing writes it. The
  // former D4 authority split (live wrote history whenever the device was not
  // recording) is gone with it; there is no branch left to key off
  // `payload.recording`.
  //
  // ⚠ Deliberately still UNCONDITIONAL (destroy-kvs-recorder decision A):
  // `device_latest` below, the heartbeat, and the workflow triggers. The old
  // `devices.persist_telemetry` gate covered `device_latest` too, and its
  // opted-out branch upserted only the `recording.*` / `media.recording` gauges —
  // so `lte.gnss_health` never landed and the GNSS health badge froze. This gate
  // is history-only; every device's live metrics keep reaching `device_latest`
  // every second regardless of any recording setting.
  //
  // Isolated (kvs-webrtc-lts §13 T1): an upsert failure (DB blip, Data API
  // throttle) must NOT cascade into the heartbeat below — otherwise last_seen_at
  // stops bumping and the offline-sweeper wrongly flips an actively publishing
  // device to 'offline'. Same control-plane/critical-path isolation principle as
  // §4.5. Log + continue; the heartbeat and workflow triggers still run. A
  // persistent DB outage still surfaces via the heartbeat UPDATE throwing (which
  // drives the async-retry / DLQ path).
  if (rows.length > 0) {
    try {
      // Last-writer-wins per (device_id, metric).
      const tsIso = new Date(payload.ts).toISOString();
      const upsert = buildDeviceLatestUpsert(payload.deviceId, tsIso, rows);
      if (upsert) await db.execute(upsert);
    } catch (err) {
      console.error('telemetry-ingest: device_latest upsert failed (continuing to heartbeat)', {
        deviceId: payload.deviceId,
        err,
      });
    }
  }

  // Throttled heartbeat: re-assert online + bump last_seen at most every ~15s,
  // server-side `now()` (no timestamptz bind), never resurrect a decommissioned
  // device. The ~15s window keeps writes to ≤1/device/15s while leaving the
  // 60s offline-sweeper room to win when telemetry stops.
  await db.execute(sql`
    UPDATE devices
    SET last_seen_at = now(),
        status = CASE WHEN status = 'decommissioned' THEN status ELSE 'online' END,
        updated_at = now()
    WHERE id = ${payload.deviceId}::uuid
      AND (last_seen_at IS NULL OR last_seen_at < now() - interval '15 seconds')
  `);

  // Workflow telemetry-condition triggers (cached, debounced). Best-effort:
  // steady-state cost is ~zero (devices with no such attachments hit a cached
  // empty array), and a workflow failure must never break ingestion.
  try {
    await evaluateTelemetryTriggers(payload);
  } catch (err) {
    console.error('telemetry-ingest: workflow trigger eval failed', { deviceId: payload.deviceId, err });
  }
};

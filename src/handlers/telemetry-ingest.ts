import { sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
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
 * Pipeline: validate → flatten → batch-insert `telemetry_readings` + last-writer
 * upsert `device_latest` → throttled `devices.last_seen_at`/`status` heartbeat.
 * Persistence is unconditional (destroy-kvs-recorder decision A); the heartbeat is
 * isolated from it, so status tracking survives a persist failure.
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

  // DB persistence is unconditional (destroy-kvs-recorder decision A). The old
  // per-device opt-in column is gone from this path: every device's live telemetry
  // reaches `telemetry_readings` + `device_latest`. This also fixes a latent bug —
  // the removed opted-out branch upserted only the `recording.*` / `media.recording`
  // gauges, so metrics like `lte.gnss_health` never reached `device_latest` for a
  // device that had not opted in.
  //
  // Isolated (kvs-webrtc-lts §13 T1): a persist failure (DB blip, Data API throttle,
  // a partition miss) must NOT cascade into the heartbeat below — otherwise
  // last_seen_at stops bumping and the offline-sweeper wrongly flips an actively
  // publishing device to 'offline'. Same control-plane/critical-path isolation
  // principle as §4.5. Log + continue; the heartbeat and workflow triggers still
  // run. A persistent DB outage still surfaces via the heartbeat UPDATE throwing
  // (which drives the async-retry / DLQ path).
  if (rows.length > 0) {
    try {
      // Authority split (offline recording plan D4): while the device reports
      // on-device telemetry recording active, the batch path (S3 segment →
      // telemetry-batch-ingest) is the sole writer of `telemetry_readings`;
      // persisting the live 1 Hz samples too would duplicate history (the table
      // has no unique key). The signal is the payload's own `recording.enabled`
      // — the device asserting "I am the authoritative recorder" — rather than
      // a config column, so the split stays correct even if cloud config and
      // device reality diverge (Phase 5 adds the config column for the UI).
      // `device_latest`, the heartbeat and workflow triggers below are untouched:
      // live remains the realtime plane either way.
      const recordingActive = payload.recording?.enabled === true;
      if (!recordingActive) {
        // Batched insert. Typed columns give `ts` (a Date) the correct typeHint,
        // and Postgres routes the row to the right monthly partition automatically.
        await db.insert(schema.telemetryReadings).values(rows);
      }

      // Last-writer-wins per (device_id, metric).
      const tsIso = new Date(payload.ts).toISOString();
      const upsert = buildDeviceLatestUpsert(payload.deviceId, tsIso, rows);
      if (upsert) await db.execute(upsert);
    } catch (err) {
      console.error('telemetry-ingest: persist failed (continuing to heartbeat)', {
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

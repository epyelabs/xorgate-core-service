import { sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  telemetryPayloadSchema,
  flattenTelemetryToRows,
} from '../schemas/telemetry';
import { buildDeviceLatestUpsert } from '../utils/upsert';

/**
 * Telemetry ingestion (P2). Invoked directly by the AWS IoT Topic Rule
 *
 *   SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/telemetry'
 *
 * so the `event` IS the telemetry payload JSON (plus `topicDeviceId` injected by
 * the rule), NOT an API Gateway event. There is no HTTP auth context.
 *
 * Pipeline: validate → flatten → batch-insert `telemetry_readings` → last-writer
 * upsert `device_latest` → throttled `devices.last_seen_at`/`status` heartbeat.
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

  if (rows.length > 0) {
    // Batched insert. Typed columns give `ts` (a Date) the correct typeHint, and
    // Postgres routes the row to the right monthly partition automatically.
    await db.insert(schema.telemetryReadings).values(rows);

    // Last-writer-wins per (device_id, metric).
    const tsIso = new Date(payload.ts).toISOString();
    const upsert = buildDeviceLatestUpsert(payload.deviceId, tsIso, rows);
    if (upsert) await db.execute(upsert);
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
};

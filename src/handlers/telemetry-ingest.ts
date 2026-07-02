import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  telemetryPayloadSchema,
  flattenTelemetryToRows,
  activeStreamKeys,
  type TelemetryPayload,
} from '../schemas/telemetry';
import { buildDeviceLatestUpsert } from '../utils/upsert';
import {
  activeRecordings,
  recorderConfigured,
  startRecording,
  stopRecording,
} from '../services/recordings';
import { evaluateTelemetryTriggers } from '../services/workflow-triggers';

// Per-device settings (telemetry persistence + auto-record) are opt-in (default
// off). Cache the flags in the warm Lambda container so the 1 Hz hot path doesn't
// read `devices` every message; the short TTL bounds how long a settings toggle
// takes to take effect (~30s).
interface DeviceFlags {
  persistTelemetry: boolean;
  autoRecord: boolean;
}
const flagsCache = new Map<string, { value: DeviceFlags; expires: number }>();
const FLAGS_TTL_MS = 30_000;

async function deviceFlags(deviceId: string): Promise<DeviceFlags> {
  const now = Date.now();
  const hit = flagsCache.get(deviceId);
  if (hit && hit.expires > now) return hit.value;
  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, deviceId),
    columns: { persistTelemetry: true, autoRecord: true },
  });
  const value: DeviceFlags = {
    persistTelemetry: device?.persistTelemetry ?? false,
    autoRecord: device?.autoRecord ?? false,
  };
  flagsCache.set(deviceId, { value, expires: now + FLAGS_TTL_MS });
  return value;
}

// Auto-record reconcile is throttled per device (the existence checks already make
// it idempotent; this just bounds DB/ECS calls). Stops use a grace window so a
// brief stream restart (cred refresh) doesn't chop the recording into fragments.
const RECONCILE_INTERVAL_MS = 8_000;
const STOP_GRACE_MS = 30_000;
const nextReconcileAt = new Map<string, number>();
const streamMissingSince = new Map<string, number>(); // `${deviceId}:${streamKey}` -> first-missing ts

/**
 * Auto-record: when a device opts in, keep a cloud viewer-recorder running for each
 * live stream. Starts a recorder for any active stream that isn't recording; stops
 * an auto recording once its stream has been gone for STOP_GRACE_MS. No-ops when
 * the recorder isn't configured or the payload carries no media state this tick.
 */
async function reconcileAutoRecord(payload: TelemetryPayload): Promise<void> {
  if (!recorderConfigured()) return;
  const deviceId = payload.deviceId;

  const now = Date.now();
  const due = nextReconcileAt.get(deviceId) ?? 0;
  if (now < due) return;
  nextReconcileAt.set(deviceId, now + RECONCILE_INTERVAL_MS);

  if (!(await deviceFlags(deviceId)).autoRecord) return;

  const active = activeStreamKeys(payload);
  if (active === null) return; // media state unknown this tick — don't touch anything
  const desired = new Set(active);

  const current = await activeRecordings(deviceId);
  const recordingStreams = new Set(current.map((r) => r.streamKey));

  // Start a recorder for each desired stream that isn't already recording.
  for (const streamKey of desired) {
    streamMissingSince.delete(`${deviceId}:${streamKey}`);
    if (!recordingStreams.has(streamKey)) {
      try {
        await startRecording(deviceId, streamKey, 'auto');
      } catch (err) {
        console.error('auto-record: start failed', { deviceId, streamKey, err });
      }
    }
  }

  // Stop auto recordings whose stream has been absent past the grace window.
  for (const r of current) {
    if (r.trigger !== 'auto' || desired.has(r.streamKey)) continue;
    const k = `${deviceId}:${r.streamKey}`;
    const missingSince = streamMissingSince.get(k) ?? now;
    streamMissingSince.set(k, missingSince);
    if (now - missingSince >= STOP_GRACE_MS) {
      streamMissingSince.delete(k);
      try {
        await stopRecording(r.id);
      } catch (err) {
        console.error('auto-record: stop failed', { id: r.id, err });
      }
    }
  }
}

/**
 * Telemetry ingestion (P2). Invoked directly by the AWS IoT Topic Rule
 *
 *   SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/telemetry'
 *
 * so the `event` IS the telemetry payload JSON (plus `topicDeviceId` injected by
 * the rule), NOT an API Gateway event. There is no HTTP auth context.
 *
 * Pipeline: validate → flatten → (if the device opts in via `persist_telemetry`)
 * batch-insert `telemetry_readings` + last-writer upsert `device_latest` → throttled
 * `devices.last_seen_at`/`status` heartbeat. The heartbeat always runs, so status
 * tracking is unaffected when persistence is off.
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

  // DB persistence is opt-in per device. When disabled (default) we still run the
  // heartbeat below so status tracking is unaffected, but write no telemetry.
  if (rows.length > 0 && (await deviceFlags(payload.deviceId)).persistTelemetry) {
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

  // Auto-record (opt-in, throttled). Best-effort: never let a recorder failure
  // break telemetry ingestion / the heartbeat above.
  try {
    await reconcileAutoRecord(payload);
  } catch (err) {
    console.error('telemetry-ingest: auto-record reconcile failed', { deviceId: payload.deviceId, err });
  }

  // Workflow telemetry-condition triggers (cached, debounced). Best-effort:
  // steady-state cost is ~zero (devices with no such attachments hit a cached
  // empty array), and a workflow failure must never break ingestion.
  try {
    await evaluateTelemetryTriggers(payload);
  } catch (err) {
    console.error('telemetry-ingest: workflow trigger eval failed', { deviceId: payload.deviceId, err });
  }
};

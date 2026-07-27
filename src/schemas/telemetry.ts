import { z } from 'zod';
import type { NewTelemetryReading } from '../db/schema';

/**
 * Telemetry payload contract (MQTT topic `xorgate/devices/{deviceId}/telemetry`, ~1 Hz).
 *
 * Leaf shape `{ value, unit? }` is preserved from the device PoC. `metrics` is a
 * generic group -> field -> leaf map so new sensors need no schema change; the
 * flatten step below turns it into `telemetry_readings` rows keyed by the
 * `<group>.<field>` metric-naming contract.
 */

const numericLeaf = z.object({ value: z.number(), unit: z.string().optional() });
const boolLeaf = z.object({ value: z.boolean() });

// The device reports per-stream state as objects ({ streamKey, channelName?, state? });
// older/synthetic builds may send a bare stream-key string. Accept both so a media
// payload never fails validation. Informational only — not stored as readings.
const mediaStreamLeaf = z.union([
  z.string(),
  z.object({
    streamKey: z.string(),
    channelName: z.string().optional(),
    state: z.string().optional(), // starting | running | retrying | failed | stopped
  }),
]);

/**
 * On-device recording status (offline recording plan, Phase 2). Mirrors the
 * agent's `RecordingStatus` (device src/agent/telemetry.ts) and the frontend
 * copy in xorgate-web src/lib/schemas.ts — change all three together.
 * Optional: pre-Phase-2 agents don't send it. Also the D4 authority-split
 * signal: `enabled: true` means the device itself is the authoritative writer
 * of telemetry history (batch path), so live ingest skips `telemetry_readings`.
 */
export const recordingStatusSchema = z.object({
  enabled: z.boolean(),
  sessionId: z.string().nullable(),
  backlogBytes: z.number().nonnegative(),
  backlogSegments: z.number().int().nonnegative(),
  droppedSegments: z.number().int().nonnegative(),
  uploading: z.boolean(),
  lastUploadAt: z.number().nullable(),
});

export const telemetryPayloadSchema = z.object({
  v: z.literal(1),
  deviceId: z.string().uuid(),
  ts: z.number().int().nonnegative(), // epoch ms, UTC
  seq: z.number().int().nonnegative().optional(),
  metrics: z.record(z.record(numericLeaf)).default({}), // group -> field -> { value, unit? }
  media: z
    .object({
      kvs: boolLeaf.optional(),
      recording: boolLeaf.optional(),
      streams: z.array(mediaStreamLeaf).optional(),
    })
    .optional(),
  recording: recordingStatusSchema.optional(),
});

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

/**
 * Encode the metric-naming contract: flatten a payload into rows ready for
 * `db.insert(telemetryReadings)`. `ts` is returned as a `Date` so the Data API
 * driver inserts it with the correct typeHint (the cast caveat is filter-only).
 *
 * - `metrics.<group>.<field>` -> metric `"<group>.<field>"`, with `value`/`unit`.
 * - `media.kvs` / `media.recording` booleans -> metric `media.kvs`/`media.recording`,
 *   value `1|0`, unit `"bool"`. `media.streams` is skipped (informational).
 */
export function flattenTelemetryToRows(payload: TelemetryPayload): NewTelemetryReading[] {
  const ts = new Date(payload.ts);
  const rows: NewTelemetryReading[] = [];

  for (const [group, fields] of Object.entries(payload.metrics)) {
    for (const [field, leaf] of Object.entries(fields)) {
      rows.push({
        deviceId: payload.deviceId,
        ts,
        metric: `${group}.${field}`,
        value: leaf.value,
        unit: leaf.unit ?? null,
      });
    }
  }

  if (payload.media?.kvs) {
    rows.push({
      deviceId: payload.deviceId,
      ts,
      metric: 'media.kvs',
      value: payload.media.kvs.value ? 1 : 0,
      unit: 'bool',
    });
  }
  if (payload.media?.recording) {
    rows.push({
      deviceId: payload.deviceId,
      ts,
      metric: 'media.recording',
      value: payload.media.recording.value ? 1 : 0,
      unit: 'bool',
    });
  }

  // On-device recording gauges (Phase 2): numeric projections of the recording
  // block, so `device_latest` carries live backlog/eviction state for the
  // Phase 5 UI without a new table. sessionId/lastUploadAt are skipped (not
  // meaningfully numeric).
  if (payload.recording) {
    const r = payload.recording;
    const gauges: Array<[string, number, string | undefined]> = [
      ['recording.enabled', r.enabled ? 1 : 0, 'bool'],
      ['recording.uploading', r.uploading ? 1 : 0, 'bool'],
      ['recording.backlog_bytes', r.backlogBytes, 'B'],
      ['recording.backlog_segments', r.backlogSegments, undefined],
      ['recording.dropped_segments', r.droppedSegments, undefined],
    ];
    for (const [metric, value, unit] of gauges) {
      rows.push({ deviceId: payload.deviceId, ts, metric, value, unit: unit ?? null });
    }
  }

  return rows;
}

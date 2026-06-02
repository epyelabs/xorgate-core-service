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
      streams: z.array(z.string()).optional(), // informational; not stored as readings
    })
    .optional(),
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

  return rows;
}

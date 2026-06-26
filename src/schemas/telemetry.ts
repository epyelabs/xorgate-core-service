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
});

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

/**
 * Stream keys that are currently live in a telemetry payload, used by the
 * auto-record path. Object streams count as active when running/starting (or when
 * no state is reported); bare-string streams are assumed active (best effort).
 * Returns null when the payload carries no media block at all, so the caller can
 * distinguish "no streams active" from "media state unknown this tick".
 */
export function activeStreamKeys(payload: TelemetryPayload): string[] | null {
  const streams = payload.media?.streams;
  if (!payload.media || streams === undefined) return null;
  const keys: string[] = [];
  for (const s of streams) {
    if (typeof s === 'string') {
      keys.push(s);
    } else if (!s.state || s.state === 'running' || s.state === 'starting') {
      keys.push(s.streamKey);
    }
  }
  return keys;
}

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

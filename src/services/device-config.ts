import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { iotDataClient } from './iot-data';
import {
  CONFIG_NAMESPACES,
  GNSS_ANT_BIAS_DEFAULT,
  type DeviceConfigDocument,
  type PublishedConfigDocument,
} from '../config-registry/index';

/**
 * Cloud -> device config delivery. Publishes the device's full config document
 * to `xorgate/devices/{deviceId}/config` with the MQTT retain flag, so an
 * offline device receives the latest config on its next connect — no shadow
 * service or reconciliation loop. The payload is the complete document (not a
 * delta) so redelivery is idempotent and self-contained.
 *
 * The device IoT policy already allows subscribe/receive on
 * `xorgate/devices/${thingName}/*` (thingName = deviceId), so no policy change
 * is needed device-side. The Lambda role needs `iot:Publish` AND the separate
 * `iot:RetainPublish` action on the config topic (granted in api-stack.ts).
 *
 * ⚠️ The message is built FROM THE REGISTRY (src/config-registry), not from a
 * hand-maintained interface. The old `DeviceConfigMessage`/`RecordingConfigMessage`
 * types that lived here were a parallel copy of the schema and drifted: the
 * thermal-shed keys were delivered but absent from them for two releases.
 * Namespaces are spread in registry order, so the wire shape is byte-identical
 * to v1 for every existing key — Phase 2 only ADDS `rev`.
 */

/** Envelope fields; the namespaces themselves come from the config document. */
export interface DeviceConfigEnvelope {
  /**
   * Wire version. Stays 1: `rev` is additive, old agents ignore unknown keys
   * and new agents treat a missing `rev` as 0 (always apply) until the fleet is
   * upgraded (design.md §4).
   */
  v: 1;
  /**
   * `devices.config_rev` — monotonic per device. The Phase 4 agent skips a
   * redelivered document whose rev it has already applied, which is what stops
   * reconnect-redelivery from reverting newer local state.
   */
  rev: number;
  /**
   * Segment-upload S3 bucket (offline recording plan, Phase 6.2). The install
   * script writes this into kvs.json for NEW devices; carrying it on the
   * retained config message backfills devices fielded before that. Sourced from
   * the Lambda's BUCKET_NAME env; omitted if unset. Not a config namespace —
   * it is environment-derived and lands in kvs.json, not settings.json.
   */
  uploadBucket?: string;
  ts: number;
}

export type DeviceConfigMessage = DeviceConfigEnvelope & PublishedConfigDocument;

/**
 * Build the retained message for a stored config document.
 *
 * `gnssAntBias` is emitted even when absent from the document (falling back to
 * the registry default) because it has ALWAYS been present on this topic and
 * the modem daemon reads it unconditionally — omitting it would be the one
 * non-additive change in an otherwise byte-compatible v1 message. It is also
 * why nulling `gnssAntBias` has always genuinely reverted the device while the
 * object namespaces silently did not.
 *
 * The three stored states map to three wire states
 * (settings_sync_hardening, finding 2):
 *
 * - **absent** → omitted. The device keeps its local value. Unchanged, and
 *   load-bearing: it is what stops the cloud wiping settings it doesn't manage.
 * - **a value** → emitted as-is. Unchanged.
 * - **`null`** (explicitly cleared) → emitted as `{}`, which the device's
 *   tolerant parser has always read as "drop your local key".
 *
 * ⚠️ The absent → omitted rule is the one thing in this file that can do fleet-
 * wide damage. Emitting `{}` for a namespace nobody configured would tell every
 * device on the next publish to wipe settings the cloud never managed. The
 * `hasOwnProperty` guard below is the only thing standing between those two
 * cases, and `device-config.test.ts` pins it.
 */
export function buildDeviceConfigMessage(
  doc: DeviceConfigDocument | null | undefined,
  rev: number,
  now: number = Date.now(),
): DeviceConfigMessage {
  const source = (doc ?? {}) as Record<string, unknown>;
  // Registry order is the wire order, and gnssAntBias is first in both — keep
  // the emitted key order stable so consecutive entries in the device's
  // "cloud config applied" journal diff cleanly.
  const namespaces: Record<string, unknown> = { gnssAntBias: GNSS_ANT_BIAS_DEFAULT };
  for (const ns of CONFIG_NAMESPACES) {
    if (!Object.prototype.hasOwnProperty.call(source, ns.key)) continue;
    const value = source[ns.key];
    if (value === undefined) continue;
    if (value === null) {
      // Cleared. A scalar namespace reverts by falling back to the registry
      // default, which gnssAntBias is already seeded with above — emitting `{}`
      // for it would just be an invalid boolean the device would drop.
      if (ns.kind === 'object') namespaces[ns.key] = {};
      continue;
    }
    namespaces[ns.key] = value;
  }
  const uploadBucket = process.env.BUCKET_NAME;
  return {
    v: 1,
    rev,
    ...(namespaces as PublishedConfigDocument),
    ...(uploadBucket ? { uploadBucket } : {}),
    ts: now,
  } as DeviceConfigMessage;
}

/**
 * Publish the retained per-device config message. Throws on failure.
 *
 * A failed publish leaves the DB ahead of the device; today the handler turns
 * that into a 502 telling the operator to re-save. Phase 3 removes that crutch:
 * the device's reported `rev` lets the mirror Lambda notice `config_rev >
 * reported.rev` and republish by itself. The rev is logged on failure so that
 * reconciliation has something to match on.
 */
export async function publishDeviceConfig(
  deviceId: string,
  doc: DeviceConfigDocument | null | undefined,
  rev: number,
): Promise<void> {
  const message = buildDeviceConfigMessage(doc, rev);
  const client = await iotDataClient();
  await client.send(
    new PublishCommand({
      topic: `xorgate/devices/${deviceId}/config`,
      qos: 1,
      retain: true,
      payload: Buffer.from(JSON.stringify(message)),
    }),
  );
}

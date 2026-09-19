import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { deriveHardwareBlock, type DeviceHardwareBlock } from '../schemas/capabilities';
import { deviceScope, ensureThingScopeAttributes, type DeviceScope } from './device-scope';
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
  /**
   * The device's tenant (platform-auth Phase 4). Not a config namespace — it is
   * tenancy, not a setting, and there is nothing for an operator to change —
   * so it rides the envelope exactly as `uploadBucket` does, for exactly the
   * same reason: this is the one channel that reaches a device already in the
   * field without re-provisioning it.
   *
   * An agent that has it publishes telemetry to
   * `xorgate/orgs/{organizationId}/ws/{workspaceId}/devices/{deviceId}/telemetry`,
   * which is the only topic shape a per-tenant IAM policy can be written
   * against. An agent that does not (an older build, or a device whose
   * workspace row has gone) keeps using the unscoped topic, which still works
   * and is still ingested. Omitted rather than nulled when unresolvable, so an
   * old agent and a new one see the same absence.
   */
  scope?: DeviceScope;
  /**
   * The device's hardware block (cm4-support plan): the projection of its
   * model's v2 `io_capabilities` the agent turns into mechanism — platform,
   * encoder token, connector/sensor list, LED/rails/IMU. Not a config
   * namespace — it is a fact about the hardware, not a setting, and it rides
   * the envelope for the same reason `scope` does: the retained config topic
   * is the one channel that reaches fielded devices without re-provisioning.
   * A model edit in the console fans out a rev-bumped republish
   * (handlers/device-models.ts), so the agent re-renders pipelines from it.
   * Omitted for v1 models — the agent then keeps its legacy CM5 behavior.
   */
  hardware?: DeviceHardwareBlock;
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
  scope?: DeviceScope | null,
  hardware?: DeviceHardwareBlock | null,
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
    ...(scope ? { scope } : {}),
    ...(hardware ? { hardware } : {}),
    ts: now,
  } as DeviceConfigMessage;
}

/**
 * The device's hardware block, derived from its model row at publish time (so
 * the message always reflects the CURRENT model — including after a model edit
 * or a device-model reassignment). null when the device is gone or its model
 * is v1/unparseable, in which case the block is omitted from the message.
 */
export async function deviceHardwareBlock(
  deviceId: string,
): Promise<DeviceHardwareBlock | null> {
  const rows = await db
    .select({ caps: schema.deviceModels.ioCapabilities })
    .from(schema.devices)
    .innerJoin(
      schema.deviceModels,
      eq(schema.devices.deviceModelId, schema.deviceModels.id),
    )
    .where(eq(schema.devices.id, deviceId))
    .limit(1);
  return deriveHardwareBlock(rows[0]?.caps);
}

/**
 * Publish the retained per-device config message, and nothing else. Throws on
 * failure; returns the scope it published (null when the device or its
 * workspace is gone, in which case the message carries no `scope` at all).
 *
 * This is the INSTRUCTION half of a tenancy change, split out from
 * `publishDeviceConfig` in Phase 1 of transfer-device-ownership so a caller can
 * choose the order. For an ordinary config save the order does not matter and
 * `publishDeviceConfig` is the right call. For a TRANSFER it matters completely:
 * the device has to be told its new topic BEFORE the broker is told to stop
 * accepting the old one, or a running agent is stranded (README §2.2/§2.3, and
 * the ordering note on `ensureThingScopeAttributes`). The transfer path is
 *
 *   update devices.workspace_id
 *   const scope = await publishDeviceConfigOnly(id, doc, rev)   // unchanged rev
 *   await ensureThingScopeAttributes(id, scope)                 // immediately
 *
 * and the returned scope is what the second call should use: it is the exact
 * tenancy the device was just handed, so the two halves cannot disagree even if
 * the row changes under a concurrent write.
 *
 * ⚠️ Publish at the device's CURRENT `config_rev`. Bumping the rev to force a
 * republish is what turned the 2026-09-18 incident into a storm — the reconciler
 * republishes whenever `report.rev < config_rev`, and a device that cannot
 * converge never stops reporting behind. `scope` is applied by the agent
 * OUTSIDE its rev guard, so an unchanged rev takes effect anyway.
 */
export async function publishDeviceConfigOnly(
  deviceId: string,
  doc: DeviceConfigDocument | null | undefined,
  rev: number,
): Promise<DeviceScope | null> {
  const scope = await deviceScope(deviceId);
  await publishRetainedConfig(deviceId, doc, rev, scope);
  return scope;
}

/**
 * Publish the retained per-device config message, asserting the device's
 * tenancy attributes on its IoT thing first. Throws if the publish fails; the
 * attribute write is best-effort (see `ensureThingScopeAttributes`).
 *
 * **The attributes-first order here is deliberate and is NOT the transfer
 * order.** Which direction is safe depends on whether the device already holds
 * a scope, and the two callers are different:
 *
 * - This path (a config save, a model-edit fanout, a claim seeding the topic)
 *   never CHANGES the tenancy; it asserts the one the device already has, or
 *   sets the first one on a device still using the unscoped topic. Writing the
 *   attribute there only ever ADDS a permitted topic — the unscoped topic it is
 *   currently using stays permitted by the policy's `PublishReceive` statement
 *   — so there is no window in which the device is publishing somewhere it is
 *   not allowed.
 * - A TRANSFER moves the tenancy, and the attribute write REVOKES the old
 *   topic. Attributes-first there leaves a running agent publishing into a
 *   topic the broker now refuses, which closes the connection, on every
 *   reconnect, forever (README §2.3). That path must use
 *   `publishDeviceConfigOnly` and then `ensureThingScopeAttributes`.
 *
 * What Phase 1 changed for THIS function is not the order but the cost: the
 * attribute write is now a genuine no-op when the attributes already match,
 * which on this path is every call after the first. That is what stopped the
 * reconciler amplifying a stuck device into an account-wide storm.
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
  const scope = await deviceScope(deviceId);
  if (scope) await ensureThingScopeAttributes(deviceId, scope);
  await publishRetainedConfig(deviceId, doc, rev, scope);
}

/**
 * The publish itself, with the scope already resolved.
 *
 * The scope is resolved by the two exported wrappers rather than passed in by
 * their callers, deliberately. Every caller already has the device row and could
 * supply it, and every future caller would have to remember to — and a caller
 * that forgot would silently publish a message telling the device it has no
 * tenant, which reverts it to the unscoped topic. One indexed read on an
 * operation that happens when someone saves settings is the cheaper side of
 * that trade.
 */
async function publishRetainedConfig(
  deviceId: string,
  doc: DeviceConfigDocument | null | undefined,
  rev: number,
  scope: DeviceScope | null,
): Promise<void> {
  const hardware = await deviceHardwareBlock(deviceId);
  const message = buildDeviceConfigMessage(doc, rev, Date.now(), scope, hardware);
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

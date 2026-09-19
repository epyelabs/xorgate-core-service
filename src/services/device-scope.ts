import { DescribeThingCommand, IoTClient, UpdateThingCommand } from '@aws-sdk/client-iot';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';

/**
 * Telling a device which tenant it belongs to.
 *
 * The live plane is scoped by putting the organization and workspace INTO the
 * telemetry topic (`xorgate/orgs/{orgId}/ws/{workspaceId}/devices/{deviceId}/telemetry`),
 * because IAM authorizes on the topic string and the historical topic carries
 * no tenant at all. Two things have to know the scope for that to work, and
 * they have to agree:
 *
 * - the **device**, so it publishes to the right topic. It learns the scope
 *   from the retained config message, which is the same channel that already
 *   backfills `uploadBucket` onto devices fielded before it existed.
 * - the **broker**, so a device cannot publish into somebody else's topic. The
 *   device IoT policy names the scope through THING ATTRIBUTES
 *   (`${iot:Connection.Thing.Attributes[xgOrgId]}`), which this file writes.
 *
 * The attributes are the enforcement half and the config message is the
 * instruction half, so they are written together and from one place.
 *
 * They are NOT symmetric, which cost ~50 minutes of production to learn
 * (2026-09-18; transfer-device-ownership README §2.3). Getting only the config
 * message out is benign: the device tries a topic the broker refuses, and on an
 * agent from Phase 1 of that plan onwards it drops back to the unscoped topic,
 * which is still ingested. Getting only the ATTRIBUTES out is not benign when
 * the device is online, because the attribute does not ADD a topic — it MOVES
 * the one topic this thing may publish on. A running agent pinned to the old
 * topic is then refused on every publish, and IoT Core closes the connection on
 * an unauthorized publish, so it reconnects into the same state forever. Publish
 * first, write the attributes immediately after, and never straddle a slow call
 * between them.
 */

const iot = new IoTClient({});

export const ORG_ATTRIBUTE = 'xgOrgId';
export const WORKSPACE_ATTRIBUTE = 'xgWorkspaceId';

export interface DeviceScope {
  organizationId: string;
  workspaceId: string;
}

/** The device's tenant, or null if the device (or its workspace) is gone. */
export async function deviceScope(deviceId: string): Promise<DeviceScope | null> {
  const rows = await db
    .select({
      workspaceId: schema.devices.workspaceId,
      organizationId: schema.workspaces.organizationId,
    })
    .from(schema.devices)
    .innerJoin(schema.workspaces, eq(schema.devices.workspaceId, schema.workspaces.id))
    .where(eq(schema.devices.id, deviceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The scoped telemetry topic. One definition, imported by everything that
 * publishes it, authorizes it or subscribes to it, so a change to the shape
 * cannot leave one of the three behind.
 */
export function scopedTelemetryTopic(scope: DeviceScope, deviceId: string): string {
  return `xorgate/orgs/${scope.organizationId}/ws/${scope.workspaceId}/devices/${deviceId}/telemetry`;
}

/** What `ensureThingScopeAttributes` actually did. */
export type ScopeAttributeResult = 'unchanged' | 'written' | 'failed';

/**
 * Write the tenancy attributes onto the IoT thing, so the device policy's
 * topic variables resolve.
 *
 * **Reads before it writes, and skips the write when the attributes already
 * match.** `UpdateThing` is not a no-op: an identical payload still bumps the
 * thing's `version` and re-evaluates policy for connected sessions. That is not
 * theoretical — on 2026-09-18 a device that could not converge had its boot
 * report re-trigger this on every reconnect and the version went 118 -> 255 in
 * minutes, turning one bad state into a storm
 * (transfer-device-ownership README §2.2). The `DescribeThing` costs one call on
 * a path that runs when someone saves settings, and it is the cheaper side of
 * that trade by a wide margin.
 *
 * `precheck: false` skips the read. It is for the one caller that already knows
 * the answer — a TRANSFER, where the attributes are being moved on purpose — and
 * it exists so the read does not sit inside the window between the config
 * publish and this write, which README §2.2 says must not straddle a slow call.
 * The read is ~40 ms against a window measured in seconds, so this is tidiness
 * rather than a fix; every other caller should leave the precheck on, because for
 * them skipping it is exactly the unconditional `UpdateThing` this replaced.
 *
 * Best-effort by design — a failure here means the device is refused when it
 * tries the scoped topic and keeps using the legacy one, which is exactly the
 * state it was already in, so turning it into a 5xx on a config save would be
 * trading a working device for an error message. A failed DESCRIBE falls through
 * to the write rather than skipping it: not knowing the current attributes is a
 * reason to write, not a reason to assume they are right.
 *
 * ⚠️ **Ordering.** For a device that is ONLINE this write is what authorizes a
 * topic; the retained config message is what instructs it. Landing this FIRST
 * strands a running agent on a topic the broker now refuses — publish, refused,
 * connection closed, reconnect, repeat, with no remote exit. Anything moving a
 * device's tenancy must publish the config first and call this immediately
 * after (README §2.2/§2.3); `publishDeviceConfigOnly` in `device-config.ts` is
 * the publish half. Phase 1 of that plan gave the agent an unscoped-topic
 * fallback so a mistake here costs a demotion to the legacy plane rather than an
 * outage — but the fleet is only as protected as its oldest installed agent.
 */
export async function ensureThingScopeAttributes(
  deviceId: string,
  scope: DeviceScope,
  opts: { precheck?: boolean } = {},
): Promise<ScopeAttributeResult> {
  try {
    if (opts.precheck !== false && (await thingScopeMatches(deviceId, scope))) {
      return 'unchanged';
    }
    await iot.send(
      new UpdateThingCommand({
        thingName: deviceId,
        attributePayload: {
          attributes: {
            [ORG_ATTRIBUTE]: scope.organizationId,
            [WORKSPACE_ATTRIBUTE]: scope.workspaceId,
          },
          merge: true,
        },
      }),
    );
    return 'written';
  } catch (err) {
    console.warn(
      `[device-scope] could not write scope attributes for ${deviceId}; ` +
        'it stays on the unscoped telemetry topic',
      err,
    );
    return 'failed';
  }
}

/**
 * Does the thing already carry exactly this tenancy?
 *
 * False on ANY doubt — a describe that failed, a thing that is gone, an
 * attribute that is missing — because the caller's fallback for "don't know" is
 * to write, and a redundant write is merely wasteful where a skipped one leaves
 * a device unable to publish.
 */
async function thingScopeMatches(deviceId: string, scope: DeviceScope): Promise<boolean> {
  try {
    const thing = await iot.send(new DescribeThingCommand({ thingName: deviceId }));
    const attrs = thing.attributes ?? {};
    return (
      attrs[ORG_ATTRIBUTE] === scope.organizationId &&
      attrs[WORKSPACE_ATTRIBUTE] === scope.workspaceId
    );
  } catch (err) {
    console.warn(
      `[device-scope] could not read scope attributes for ${deviceId}; writing them`,
      err,
    );
    return false;
  }
}

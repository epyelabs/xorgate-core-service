import { IoTClient, UpdateThingCommand } from '@aws-sdk/client-iot';
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
 * instruction half, so they are written together and from one place. Getting
 * only the config message out would produce a device that publishes to a topic
 * the broker refuses; getting only the attributes out would produce a device
 * that is allowed to use a topic it does not know about. Neither is dangerous —
 * both fail closed — but both are confusing, so they move as a pair.
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

/**
 * Write the tenancy attributes onto the IoT thing, so the device policy's
 * topic variables resolve.
 *
 * Idempotent, and safe to call on every config publish: `UpdateThing` with the
 * same attributes is a no-op write. Best-effort by design — a failure here
 * means the device is refused when it tries the scoped topic and keeps using
 * the legacy one, which is exactly the state it was already in, so turning it
 * into a 5xx on a config save would be trading a working device for an error
 * message.
 *
 * NOTE the missing counterpart: nothing clears these when a device moves
 * workspace, because nothing moves a device between workspaces —
 * `PUT /devices/{id}` is metadata-only and no other route writes
 * `devices.workspace_id`. The day a move endpoint exists it has to call this,
 * and until then a stale attribute can only be produced by editing the database
 * by hand.
 */
export async function ensureThingScopeAttributes(
  deviceId: string,
  scope: DeviceScope,
): Promise<void> {
  try {
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
  } catch (err) {
    console.warn(
      `[device-scope] could not write scope attributes for ${deviceId}; ` +
        'it stays on the unscoped telemetry topic',
      err,
    );
  }
}

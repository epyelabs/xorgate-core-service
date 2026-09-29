import {
  DeleteSignalingChannelCommand,
  KinesisVideoClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis-video';
import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { deleteThing } from './iot-provisioning';
import { deviceStoragePrefixes } from './destroy-rules';
import { drainPrefix } from './s3-drain';

/**
 * Everything a device owns OUTSIDE the rows that cascade off `devices`: its
 * AWS IoT thing + certificate, its KVS signaling channels, the media and
 * telemetry objects it uploaded to the core bucket, and the two telemetry
 * tables that carry no FK (`telemetry_readings` is partitioned, which rules a
 * FK out; `telemetry_ingest_log` is keyed by S3 key). Deleting the row alone
 * leaves all of that behind — which is exactly what every DELETE did before
 * this module existed.
 *
 * One primitive, three callers: `DELETE /devices/{id}` for one device,
 * `DELETE /workspaces/{id}` and `DELETE /organizations/{id}` fanned out over
 * every device under them. Each caller runs this BEFORE its own row delete,
 * because the identifiers (thing name, channel ARNs) live on rows that
 * cascade away with the device.
 *
 * Best-effort by design for the AWS half. A thing that is already gone, a
 * channel that was never created, an S3 batch that fails: each is logged and
 * the teardown moves on, because the row delete that follows is the fact the
 * caller asked for and cannot be retried once it lands (404). The S3 drain is
 * bounded by a page budget so a device with months of segments cannot run the
 * Lambda into its timeout; whatever it leaves is expired by the bucket's
 * lifecycle rules (media 90 d, telemetry uploads likewise) and the tombstone
 * records `s3Drained: false` so the state is visible.
 */

const kvs = new KinesisVideoClient({});
const BUCKET = process.env.BUCKET_NAME;

/** ListObjectsV2 pages (1000 keys each) one request will drain per device before giving up. */
export const S3_PAGE_BUDGET_PER_DEVICE = 8;


export interface TeardownDevice {
  id: string;
  workspaceId: string;
  organizationId: string;
  serial: string | null;
}

export interface TeardownSummary {
  devices: number;
  /** Devices whose S3 prefixes were emptied within budget. */
  s3Drained: number;
  /** Devices that still had objects when the budget ran out; the lifecycle finishes. */
  s3Pending: number;
  /** Human-readable, already logged; returned so callers can decide to surface them. */
  errors: string[];
}

async function deleteChannel(channelArn: string): Promise<void> {
  try {
    await kvs.send(new DeleteSignalingChannelCommand({ ChannelARN: channelArn }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    throw err;
  }
}

/**
 * Tear down the AWS side and the FK-less rows for these devices, then write
 * their tombstones. Does NOT delete the `devices` rows — the caller does, in
 * whatever scope-checked statement it already has.
 */
export async function teardownDevices(
  devices: TeardownDevice[],
  deletedBy: string,
): Promise<TeardownSummary> {
  const summary: TeardownSummary = { devices: devices.length, s3Drained: 0, s3Pending: 0, errors: [] };
  if (devices.length === 0) return summary;
  const ids = devices.map((d) => d.id);

  const fail = (what: string, err: unknown) => {
    const message = `${what}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[device-teardown] ${message}`);
    summary.errors.push(message);
  };

  // Identifiers first: these rows cascade away with the device rows.
  const [identities, channels] = await Promise.all([
    db.query.deviceIdentities.findMany({
      where: inArray(schema.deviceIdentities.deviceId, ids),
      columns: { deviceId: true, iotThingName: true },
    }),
    db.query.kvsChannels.findMany({
      where: inArray(schema.kvsChannels.deviceId, ids),
      columns: { deviceId: true, channelArn: true, channelName: true },
    }),
  ]);

  const drained = new Map<string, boolean>();
  const removed = { things: [] as string[], channels: [] as string[] };
  for (const device of devices) {
    // IoT: thing, its certificates and the policy attachment. `deleteThing`
    // swallows its own errors (it was written for the claim-rollback path).
    // The thing name IS the device id, so a device with no identity row still
    // gets the attempt.
    const thingNames = new Set(
      identities.filter((i) => i.deviceId === device.id).map((i) => i.iotThingName),
    );
    thingNames.add(device.id);
    for (const thingName of thingNames) {
      if (await deleteThing(thingName)) removed.things.push(thingName);
      else fail(`IoT thing ${thingName}`, new Error('delete did not complete'));
    }

    for (const channel of channels.filter((c) => c.deviceId === device.id)) {
      try {
        await deleteChannel(channel.channelArn);
        removed.channels.push(channel.channelName);
      } catch (err) {
        fail(`KVS channel ${channel.channelName}`, err);
      }
    }

    const budget = { pages: S3_PAGE_BUDGET_PER_DEVICE };
    let complete = true;
    for (const prefix of deviceStoragePrefixes(device.id)) {
      if (!BUCKET) break;
      try {
        if (!(await drainPrefix(BUCKET, prefix, { budget })).complete) complete = false;
      } catch (err) {
        complete = false;
        fail(`S3 prefix ${prefix}`, err);
      }
    }
    drained.set(device.id, complete);
    if (complete) summary.s3Drained += 1;
    else summary.s3Pending += 1;
  }

  // The FK-less tables. These throw: a failure here means telemetry would
  // survive its device, which is a correctness problem rather than garbage.
  await db.delete(schema.telemetryReadings).where(inArray(schema.telemetryReadings.deviceId, ids));
  await db.delete(schema.telemetryIngestLog).where(inArray(schema.telemetryIngestLog.deviceId, ids));

  await db
    .insert(schema.deletedDevices)
    .values(
      devices.map((d) => ({
        id: d.id,
        workspaceId: d.workspaceId,
        organizationId: d.organizationId,
        serial: d.serial,
        s3Drained: drained.get(d.id) ?? false,
        deletedBy,
      })),
    )
    .onConflictDoNothing();

  // One structured line per teardown: the audit trail for "what did deleting
  // that device actually remove", and the only place the AWS half is visible.
  console.log(
    '[device-teardown]',
    JSON.stringify({
      deviceIds: ids,
      iotThings: removed.things,
      kvsChannels: removed.channels,
      s3Drained: summary.s3Drained,
      s3Pending: summary.s3Pending,
      errors: summary.errors,
    }),
  );

  return summary;
}

/** The devices under a set of workspaces, in the shape `teardownDevices` takes. */
export async function devicesInWorkspaces(
  workspaceIds: string[],
  organizationId: string,
): Promise<TeardownDevice[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db.query.devices.findMany({
    where: inArray(schema.devices.workspaceId, workspaceIds),
    columns: { id: true, workspaceId: true, serial: true },
  });
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    organizationId,
    serial: r.serial ?? null,
  }));
}

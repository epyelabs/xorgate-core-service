import {
  IoTClient,
  CreateThingCommand,
  CreateKeysAndCertificateCommand,
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  DescribeEndpointCommand,
  ListThingPrincipalsCommand,
  DetachThingPrincipalCommand,
  DetachPolicyCommand,
  UpdateCertificateCommand,
  DeleteCertificateCommand,
  DeleteThingCommand,
} from '@aws-sdk/client-iot';
import {
  KinesisVideoClient,
  CreateSignalingChannelCommand,
  DescribeSignalingChannelCommand,
} from '@aws-sdk/client-kinesis-video';
import { db, schema } from '../db/index';
import type { Device, DeviceModel } from '../db/schema';
import { ioCapabilitiesSchema } from '../schemas/capabilities';

// SDK clients created once at module load, reused across warm invocations.
const iotClient = new IoTClient({});
const kvsClient = new KinesisVideoClient({});

const errName = (err: unknown): string | undefined =>
  (err as { name?: string } | null)?.name;

export const AMAZON_ROOT_CA_URL =
  'https://www.amazontrust.com/repository/AmazonRootCA1.pem';

export interface ProvisionedChannel {
  streamKey: string;
  channelName: string;
  channelArn: string;
}

export interface ProvisionResult {
  thingName: string;
  // One-shot secret material — returned to the caller exactly once, never stored.
  certificatePem: string;
  privateKey: string;
  caUrl: string;
  // Account-stable IoT endpoints.
  dataEndpoint: string;
  credentialEndpoint: string;
  roleAlias: string;
  region: string;
  channels: ProvisionedChannel[];
}

/**
 * Mint an IoT thing + X.509 cert (attach the base policy), create a KVS
 * signaling channel per declared video stream, and persist the identity +
 * channel rows. `thingName` is the device's own UUID so the per-thing IoT
 * policy variables and the agent's clientId/topics all line up.
 *
 * The private key is returned exactly once (never written to the DB). Callers
 * are responsible for any idempotency check (e.g. refuse if the device already
 * has a `device_identities` row) before calling this.
 */
export async function provisionDevice(
  device: Device,
  model: DeviceModel | undefined,
): Promise<ProvisionResult> {
  const caps = ioCapabilitiesSchema.safeParse(model?.ioCapabilities);
  const videoStreamKeys = caps.success
    ? (caps.data.media?.video ?? []).map((v) => v.key)
    : [];

  const region = process.env.AWS_REGION!;
  const thingName = device.id;

  // --- IoT thing + certificate + policy ---
  try {
    await iotClient.send(
      new CreateThingCommand({
        thingName,
        thingTypeName: process.env.IOT_THING_TYPE_NAME,
      }),
    );
  } catch (err) {
    // Tolerate a thing left over from a prior partial run.
    if (errName(err) !== 'ResourceAlreadyExistsException') throw err;
  }

  const keys = await iotClient.send(
    new CreateKeysAndCertificateCommand({ setAsActive: true }),
  );
  await iotClient.send(
    new AttachPolicyCommand({
      policyName: process.env.IOT_POLICY_NAME!,
      target: keys.certificateArn!,
    }),
  );
  await iotClient.send(
    new AttachThingPrincipalCommand({
      thingName,
      principal: keys.certificateArn!,
    }),
  );

  // --- KVS signaling channel per video stream ---
  const channels: ProvisionedChannel[] = [];
  for (const streamKey of videoStreamKeys) {
    const channelName = `${device.id}-${streamKey}`;
    let channelArn: string | undefined;
    try {
      const res = await kvsClient.send(
        new CreateSignalingChannelCommand({ ChannelName: channelName }),
      );
      channelArn = res.ChannelARN;
    } catch (err) {
      if (errName(err) === 'ResourceInUseException') {
        const desc = await kvsClient.send(
          new DescribeSignalingChannelCommand({ ChannelName: channelName }),
        );
        channelArn = desc.ChannelInfo?.ChannelARN;
      } else {
        throw err;
      }
    }
    if (channelArn) channels.push({ streamKey, channelName, channelArn });
  }

  // --- Resolve account-stable IoT endpoints ---
  const [dataEp, credEp] = await Promise.all([
    iotClient.send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' })),
    iotClient.send(new DescribeEndpointCommand({ endpointType: 'iot:CredentialProvider' })),
  ]);
  const dataEndpoint = dataEp.endpointAddress!;
  const credentialEndpoint = credEp.endpointAddress!;
  const roleAlias = process.env.IOT_ROLE_ALIAS!;

  // --- Persist identity + channels (never the private key) ---
  await db.insert(schema.deviceIdentities).values({
    deviceId: device.id,
    iotThingName: thingName,
    certificateId: keys.certificateId!,
    certificateArn: keys.certificateArn!,
    policyName: process.env.IOT_POLICY_NAME!,
    roleAlias,
    credentialEndpoint,
  });
  if (channels.length > 0) {
    await db.insert(schema.kvsChannels).values(
      channels.map((c) => ({
        deviceId: device.id,
        streamKey: c.streamKey,
        channelName: c.channelName,
        channelArn: c.channelArn,
        region,
      })),
    );
  }

  return {
    thingName,
    certificatePem: keys.certificatePem!,
    privateKey: keys.keyPair?.PrivateKey!,
    caUrl: AMAZON_ROOT_CA_URL,
    dataEndpoint,
    credentialEndpoint,
    roleAlias,
    region,
    channels,
  };
}

/**
 * Best-effort teardown of a device's IoT identity: detach the cert from the
 * thing/policy, deactivate + delete the cert, and delete the thing. Used by the
 * claim handler to roll back when device-row linkage fails after provisioning,
 * and by services/device-teardown.ts when a device is deleted. Errors are
 * swallowed — the callers cannot do anything about them — but the return value
 * says whether the thing itself is gone, so a teardown can log the truth.
 */
export async function deleteThing(thingName: string): Promise<boolean> {
  try {
    const principals = await iotClient.send(
      new ListThingPrincipalsCommand({ thingName }),
    );
    for (const certArn of principals.principals ?? []) {
      await iotClient
        .send(new DetachThingPrincipalCommand({ thingName, principal: certArn }))
        .catch(() => undefined);
      await iotClient
        .send(
          new DetachPolicyCommand({
            policyName: process.env.IOT_POLICY_NAME!,
            target: certArn,
          }),
        )
        .catch(() => undefined);
      const certId = certArn.split('/').pop();
      if (certId) {
        await iotClient
          .send(
            new UpdateCertificateCommand({
              certificateId: certId,
              newStatus: 'INACTIVE',
            }),
          )
          .catch(() => undefined);
        await iotClient
          .send(new DeleteCertificateCommand({ certificateId: certId, forceDelete: true }))
          .catch(() => undefined);
      }
    }
    return await iotClient
      .send(new DeleteThingCommand({ thingName }))
      .then(() => true)
      .catch((err: unknown) => {
        // Already gone counts as gone: a device row whose thing was never
        // provisioned (or was removed by hand) must not read as a failure.
        return (err as { name?: string } | null)?.name === 'ResourceNotFoundException';
      });
  } catch {
    // swallow — best-effort cleanup on an already-failing path
    return false;
  }
}

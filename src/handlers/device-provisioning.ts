import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq, inArray } from 'drizzle-orm';
import {
  IoTClient,
  CreateThingCommand,
  CreateKeysAndCertificateCommand,
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  DescribeEndpointCommand,
} from '@aws-sdk/client-iot';
import {
  KinesisVideoClient,
  CreateSignalingChannelCommand,
  DescribeSignalingChannelCommand,
} from '@aws-sdk/client-kinesis-video';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  conflict,
  created,
  methodNotAllowed,
  notFound,
} from '../utils/responses';
import { ioCapabilitiesSchema } from '../schemas/capabilities';

// SDK clients created once at module load, reused across warm invocations.
const iotClient = new IoTClient({});
const kvsClient = new KinesisVideoClient({});

const errName = (err: unknown): string | undefined =>
  (err as { name?: string } | null)?.name;

async function projectIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.projects.findMany({
    where: eq(schema.projects.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

// POST /devices/{id}/provision — mint an IoT thing + X.509 cert + KVS channels so the
// device can obtain short-lived AWS creds via the IoT credential provider (no raw keys).
// The private key is returned exactly once and never stored.
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'POST') return methodNotAllowed(method, 'POST');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('device id required in path');

  let auth;
  try {
    auth = await requireOrgContext(event, ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgProjectIds = await projectIdsForOrg(auth.organizationId);
  if (orgProjectIds.length === 0) return notFound(`Device "${id}" not found`);

  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, id),
      inArray(schema.devices.projectId, orgProjectIds),
    ),
  });
  if (!device) return notFound(`Device "${id}" not found`);

  // Idempotency: provisioning is one-shot (the private key is only issued once).
  const existing = await db.query.deviceIdentities.findFirst({
    where: eq(schema.deviceIdentities.deviceId, device.id),
  });
  if (existing) {
    return conflict(
      `Device "${device.id}" is already provisioned (thing "${existing.iotThingName}"). Cert rotation is not yet supported.`,
    );
  }

  // Derive video stream keys from the device model's declared capabilities.
  const model = await db.query.deviceModels.findFirst({
    where: eq(schema.deviceModels.id, device.deviceModelId),
  });
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
  const channels: { streamKey: string; channelName: string; channelArn: string }[] = [];
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

  // --- One-shot credential bundle ---
  return created({
    device: { id: device.id, thingName },
    iot: {
      dataEndpoint,
      credentialEndpoint,
      roleAlias,
      certificatePem: keys.certificatePem,
      privateKey: keys.keyPair?.PrivateKey,
      caUrl: 'https://www.amazontrust.com/repository/AmazonRootCA1.pem',
    },
    mqtt: {
      telemetryTopic: `xorgate/devices/${device.id}/telemetry`,
      statusTopic: `xorgate/devices/${device.id}/status`,
    },
    kvs: { region, channels },
  });
};

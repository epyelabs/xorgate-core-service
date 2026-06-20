import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  conflict,
  created,
  methodNotAllowed,
  notFound,
} from '../utils/responses';
import { provisionDevice } from '../services/iot-provisioning';

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

  const model = await db.query.deviceModels.findFirst({
    where: eq(schema.deviceModels.id, device.deviceModelId),
  });

  // IoT thing + cert + policy, KVS channels, endpoint resolution, and identity
  // persistence all live in the shared provisioning service (reused by the
  // device-registration claim path).
  const result = await provisionDevice(device, model);

  // --- One-shot credential bundle ---
  return created({
    device: { id: device.id, thingName: result.thingName },
    iot: {
      dataEndpoint: result.dataEndpoint,
      credentialEndpoint: result.credentialEndpoint,
      roleAlias: result.roleAlias,
      certificatePem: result.certificatePem,
      privateKey: result.privateKey,
      caUrl: result.caUrl,
    },
    mqtt: {
      telemetryTopic: `xorgate/devices/${device.id}/telemetry`,
      statusTopic: `xorgate/devices/${device.id}/status`,
    },
    kvs: { region: result.region, channels: result.channels },
  });
};

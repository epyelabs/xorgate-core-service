import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { methodNotAllowed, notFound, ok } from '../utils/responses';

// GET /devices/{id}/kvs-channels — the device's KVS signaling channels (name/ARN/region)
// so the browser can run a WebRTC VIEWER. The browser mints its own scoped AWS creds via
// the Cognito identity pool, so this returns channel metadata only (no credentials).
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'GET') return methodNotAllowed(method, 'GET');

  const id = event.pathParameters?.id;
  if (!id) return notFound('Device "" not found');

  let auth;
  try {
    auth = await requireOrgContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${id}" not found`);

  // Org-ownership check (same pattern as devices.ts): the device must belong to a
  // workspace in the caller's organization.
  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, id),
      inArray(schema.devices.workspaceId, orgWorkspaceIds),
    ),
    columns: { id: true },
  });
  if (!device) return notFound(`Device "${id}" not found`);

  // Ownership already enforced via the device check above. Empty when the device
  // exists but isn't provisioned yet — the frontend renders a clean "no live video" state.
  const channels = await db.query.kvsChannels.findMany({
    where: eq(schema.kvsChannels.deviceId, id),
    orderBy: [asc(schema.kvsChannels.streamKey)],
    columns: {
      streamKey: true,
      channelName: true,
      channelArn: true,
      region: true,
    },
  });

  return ok({ channels });
};

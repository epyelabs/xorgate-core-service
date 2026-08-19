import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { methodNotAllowed, notFound, ok } from '../utils/responses';

// GET /v1/devices/{id}/video-channels — the device's live video channels
// (name/ref/region) so a viewer can join them. The viewer mints its own scoped
// credentials (POST /auth/live-credentials, or the identity pool for the first-party
// dashboard), so this returns channel metadata only, never credentials.
//
// Also serves the two unversioned aliases this route was renamed from:
// /devices/{id}/video-channels and /devices/{id}/kvs-channels. The file keeps its
// old name because it is internal; the ROUTE is what N11 renames.
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
  const rows = await db.query.kvsChannels.findMany({
    where: eq(schema.kvsChannels.deviceId, id),
    orderBy: [asc(schema.kvsChannels.streamKey)],
    columns: {
      streamKey: true,
      channelName: true,
      channelArn: true,
      region: true,
    },
  });

  // `channelRef` is `channelArn` under the N11 name (Phase 6): a consumer gets an
  // opaque handle rather than a field that names the cloud we happen to run on.
  // Both are sent, on BOTH the `/v1` route and its alias, because a field rename
  // cannot ride a path alias — an additive field is the only shape that leaves
  // xorgate-web (which reads `channelArn`) working. `channelArn` goes away with
  // the aliases; see ALIAS_SUNSET in src/openapi/scope.ts.
  const channels = rows.map((row) => ({ ...row, channelRef: row.channelArn }));

  return ok({ channels });
};

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { methodNotAllowed, notFound, ok } from '../utils/responses';

async function projectIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.projects.findMany({
    where: eq(schema.projects.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

// GET /devices/{id}/identity — the device's IoT X.509 identity metadata (thing name,
// certificate id, status, policy/role binding). Returns non-secret fields only: the
// private key is never stored, and certificateArn/credentialEndpoint are intentionally
// omitted. Reads Postgres only (no IoT call, no new IAM).
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

  const orgProjectIds = await projectIdsForOrg(auth.organizationId);
  if (orgProjectIds.length === 0) return notFound(`Device "${id}" not found`);

  // Org-ownership check (same pattern as devices.ts): the device must belong to a
  // project in the caller's organization.
  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, id),
      inArray(schema.devices.projectId, orgProjectIds),
    ),
    columns: { id: true },
  });
  if (!device) return notFound(`Device "${id}" not found`);

  // Ownership already enforced via the device check above. Null when the device exists
  // but isn't provisioned yet — the frontend renders a clean "not provisioned" state.
  const identity = await db.query.deviceIdentities.findFirst({
    where: eq(schema.deviceIdentities.deviceId, id),
    columns: {
      iotThingName: true,
      certificateId: true,
      policyName: true,
      roleAlias: true,
      status: true,
      createdAt: true,
    }, // certificateArn + credentialEndpoint intentionally excluded
  });

  return ok({ identity: identity ?? null });
};

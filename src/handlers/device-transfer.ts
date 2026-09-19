import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq, inArray } from 'drizzle-orm';
import { routeKey as canonicalRouteKey } from '../utils/route';
import {
  AuthError,
  authErrorResponse,
  requireOrgWideContext,
} from '../middleware/auth';
import type { OrgAuthContext } from '../types/index';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { deviceResponse } from '../services/device-view';
import {
  previewTransfer,
  transferDevice,
  TransferError,
  type TransferPreview,
  type TransferSummary,
} from '../services/device-transfer';
import {
  badRequest,
  errorResponse,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

/**
 * Transferring a device to another workspace — and, with an organization id, to
 * another organization the caller also administers.
 *
 * A sibling of `handlers/devices.ts` rather than another arm inside it, on the
 * phase text's reasoning: that file is already large, and transfer has an
 * authorization shape of its own (see below). The ordered sequence itself lives
 * in `services/device-transfer.ts`; this file is the HTTP skin — authorize,
 * resolve the destination, map `TransferError` onto a status code.
 *
 * ## Authorization
 *
 * `owner|admin`, matching `DELETE /devices/{id}` and workspace deletion. A
 * `member` may edit a device but must not give it away.
 *
 * `requireOrgWideContext`, not `requireOrgContext`: a transfer spans TWO
 * workspaces, and a workspace-scoped session token — the credential a consumer's
 * browser holds out in someone else's product — is confined to one by
 * construction. It could never be authorized for both ends, so the honest answer
 * is the 403 that gate already returns rather than a 404 that reads like the
 * destination does not exist.
 *
 * The same-org security check is the whole of the same-org case: both the device
 * and the destination workspace must be inside `resolveWorkspaceScope(auth)`. A
 * destination outside it is a **404**, not a 403 — confirming that another
 * tenant's workspace exists is itself a leak. (`POST /devices` returns a 400 for
 * a foreign workspace; that precedent is not followed here, deliberately.)
 *
 * ## Offline devices are a success
 *
 * The route is NOT gated on `status = 'online'`. Nothing on the device changes
 * during a transfer — certificates and identity are untouched and the scope is
 * never persisted on the box — so an offline device simply adopts the new
 * tenancy from the retained config the moment it next connects. It is in fact
 * the safer case. The response says so through `transfer.warnings` and
 * `transfer.adoption`, rather than pretending the device has already caught up.
 *
 * ## One thing this route cannot check
 *
 * A device running an agent older than `v0.0.6` has no unscoped-topic fallback,
 * so if a transfer leaves it unable to publish it can still strand until someone
 * restarts the process. That is an operational precondition (`xorgate update`
 * across the fleet), not something the API refuses on — `adoption: 'unknown'`
 * is the signal that a device has never reported a telemetry scope at all.
 */

/** The route's own body, kept narrow so an unknown field is a 400 rather than a silent no-op. */
interface TransferBody {
  workspaceId?: unknown;
  organizationId?: unknown;
}

/** `TransferSummary` as it goes on the wire: `transferId` reads as `id` under `transfer`. */
function transferResponse(summary: TransferSummary): Record<string, unknown> {
  const { transferId, ...rest } = summary;
  return { id: transferId, ...rest };
}

function previewResponse(preview: TransferPreview): TransferPreview {
  return preview;
}

/**
 * Where the device is going, resolved and authorized.
 *
 * Same-org is the whole of Phase 3: the destination must be a workspace the
 * caller's own organization owns. `organizationId` opens the cross-organization
 * fast path (Phase 4.4) and is resolved in `resolveCrossOrgDestination`.
 */
type Destination =
  | { ok: true; workspaceId: string }
  | { ok: false; response: APIGatewayProxyResultV2 };

/** `APIGatewayProxyResultV2` includes `string`, so a refusal is tagged rather than sniffed. */
const refuse = (response: APIGatewayProxyResultV2): Destination => ({ ok: false, response });

async function resolveDestination(
  auth: OrgAuthContext,
  workspaceId: string,
  organizationId: string | undefined,
): Promise<Destination> {
  if (organizationId && organizationId !== auth.organizationId) {
    return resolveCrossOrgDestination(auth, workspaceId, organizationId);
  }
  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (!orgWorkspaceIds.includes(workspaceId)) {
    return refuse(notFound(`Workspace "${workspaceId}" not found`));
  }
  return { ok: true, workspaceId };
}

/**
 * The both-membership fast path (README §2.4, §4.4).
 *
 * `auth.organizationId` resolves to exactly ONE organization, so a single
 * request cannot be authorized in two tenancies by the middleware. It can be
 * authorized here, by proving the CALLER holds `owner|admin` in the destination
 * too — which is the Alocate case (one operator, many organizations) and keeps
 * the common cross-org move one click instead of a code round-trip.
 *
 * A membership is a USER fact. An API key has no `users` row and is bound to one
 * organization by its own row, so a key can never satisfy this and is told to
 * use the offer handshake instead of being handed a confusing 404.
 */
async function resolveCrossOrgDestination(
  auth: OrgAuthContext,
  workspaceId: string,
  organizationId: string,
): Promise<Destination> {
  if (!auth.userId) {
    return refuse(
      errorResponse(
      403,
      'FORBIDDEN',
      'An API key is bound to one organization, so it cannot be authorized in the ' +
          'destination. Create a transfer offer instead and have the destination accept it.',
      ),
    );
  }
  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(schema.memberships.userId, auth.userId),
      eq(schema.memberships.organizationId, organizationId),
    ),
  });
  // 404, not 403: an organization the caller is not in must read as absent.
  if (!membership) return refuse(notFound(`Organization "${organizationId}" not found`));
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return refuse(
      errorResponse(
        403,
        'INSUFFICIENT_ROLE',
        `Requires one of: owner, admin in the destination organization. You have: ${membership.role}.`,
      ),
    );
  }
  const target = await db.query.workspaces.findFirst({
    where: and(
      eq(schema.workspaces.id, workspaceId),
      eq(schema.workspaces.organizationId, organizationId),
    ),
    columns: { id: true },
  });
  if (!target) return refuse(notFound(`Workspace "${workspaceId}" not found`));
  return { ok: true, workspaceId };
}

/** Does the caller's organization own this device today? */
async function callerOwnsDevice(
  auth: OrgAuthContext,
  deviceId: string,
): Promise<boolean> {
  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return false;
  const rows = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.id, deviceId),
        inArray(schema.devices.workspaceId, orgWorkspaceIds),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function transferErrorResponse(err: TransferError): APIGatewayProxyResultV2 {
  return errorResponse(err.statusCode, err.code, err.message);
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const deviceId = event.pathParameters?.id;

  let auth: OrgAuthContext;
  try {
    auth = await requireOrgWideContext(event, ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  if (!deviceId) return badRequest('device id required in path');

  // The device must be one the caller's organization owns TODAY. Checked before
  // anything else so a probe for a device in another tenant reads exactly like a
  // probe for a device that does not exist.
  if (!(await callerOwnsDevice(auth, deviceId))) {
    return notFound(`Device "${deviceId}" not found`);
  }

  if (routeKey === 'GET /devices/{id}/transfer/preview') {
    const workspaceId = event.queryStringParameters?.workspaceId;
    if (!workspaceId) return badRequest('workspaceId query parameter is required');
    const organizationId = event.queryStringParameters?.organizationId;
    const destination = await resolveDestination(auth, workspaceId, organizationId);
    if (!destination.ok) return destination.response;
    try {
      return ok({ preview: previewResponse(await previewTransfer(deviceId, workspaceId)) });
    } catch (err) {
      if (err instanceof TransferError) return transferErrorResponse(err);
      throw err;
    }
  }

  if (routeKey === 'POST /devices/{id}/transfer') {
    let body: TransferBody;
    try {
      body = JSON.parse(event.body ?? '{}') as TransferBody;
    } catch {
      return badRequest('Invalid JSON body');
    }
    if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
      return badRequest('workspaceId is required');
    }
    if (body.organizationId !== undefined && typeof body.organizationId !== 'string') {
      return badRequest('organizationId must be a string');
    }
    const unknownFields = Object.keys(body).filter(
      (k) => k !== 'workspaceId' && k !== 'organizationId',
    );
    if (unknownFields.length > 0) {
      return badRequest(`unknown field(s): ${unknownFields.join(', ')}`);
    }

    const destination = await resolveDestination(
      auth,
      body.workspaceId,
      body.organizationId as string | undefined,
    );
    if (!destination.ok) return destination.response;

    let summary: TransferSummary;
    try {
      summary = await transferDevice({
        deviceId,
        toWorkspaceId: destination.workspaceId,
        actor: { userId: auth.userId, apiKeyId: auth.apiKeyId },
      });
    } catch (err) {
      if (err instanceof TransferError) return transferErrorResponse(err);
      // The sequence threw after the first write. The engine has already rolled
      // back what it could and recorded where it stopped in `device_transfers`;
      // 502 rather than 500 because the failure is downstream (IoT), and the
      // message has to say plainly that nothing moved.
      console.error('device transfer failed', { deviceId, err });
      return errorResponse(
        502,
        'TRANSFER_FAILED',
        'The device could not be told about its new workspace, so the transfer was ' +
          'rolled back and nothing changed. Try again in a moment.',
      );
    }

    const device = await db.query.devices.findFirst({
      where: eq(schema.devices.id, deviceId),
    });
    if (!device) return notFound(`Device "${deviceId}" not found`);
    return ok({ device: deviceResponse(device), transfer: transferResponse(summary) });
  }

  return methodNotAllowed(method, 'GET, POST');
};

export const handler = apiHandler(restHandler);

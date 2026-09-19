import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
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
  attachmentsAtRiskOnOrgChange,
  previewTransfer,
  reconcileStaleTransfers,
  transferDevice,
  TransferError,
  type TransferPreview,
  type TransferSummary,
} from '../services/device-transfer';
import { generateRegistrationCode } from '../utils/registration-code';
import {
  badRequest,
  conflict,
  created,
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

/**
 * The device-scoped half of this handler: every route under `/devices/{id}/...`
 * requires `owner|admin` in the organization that owns the device TODAY.
 *
 * The ownership check runs before anything else, so a probe for a device in
 * another tenant reads exactly like a probe for a device that does not exist.
 */
async function deviceRoutes(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  deviceId: string,
): Promise<APIGatewayProxyResultV2> {
  let auth: OrgAuthContext;
  try {
    auth = await requireOrgWideContext(event, ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  if (!(await callerOwnsDevice(auth, deviceId))) {
    return notFound(`Device "${deviceId}" not found`);
  }

  if (routeKey === 'POST /devices/{id}/transfer-offers') {
    return createOffer(event, auth, deviceId);
  }
  if (routeKey === 'GET /devices/{id}/transfer-offers') {
    return listDeviceOffers(auth, deviceId);
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

  return methodNotAllowed(event.requestContext.http.method, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Transfer offers (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Handing a device to an organization you have no membership in.
 *
 * `auth.organizationId` resolves to exactly ONE organization, from a membership
 * row or the `X-Organization-Id` header, so one request cannot be authorized in
 * two tenancies. The destination therefore has to act for itself, and the shape
 * that lets it is the one `device_registrations` already uses for onboarding: a
 * long random code, a `pending` row with an expiry, and a route the other side
 * reaches holding nothing but the code.
 *
 * The code is a bearer token for exactly two things — reading the offer's
 * allowlisted preview, and resolving it. `offerPreview` below is that allowlist,
 * and it is deliberately thin: device name, device model, source organization
 * name. No serial, no device id, no telemetry, no configuration. Whoever holds
 * the code is by definition not yet entitled to the device.
 *
 * **There is no incoming inbox, and that is a property of the data model, not an
 * omission.** An offer names no destination — that is what makes it usable for a
 * handover to an organization whose id the source does not know — so a pending
 * offer is discoverable only by its code. `GET /transfer-offers` lists what the
 * caller's organization SENT, plus what it has already accepted. The destination
 * flow is: receive a code out of band, preview it, accept or decline.
 */

/** Seven days. A handover is slower than an install, which is why this is not the 15 minutes `device_registrations` uses. */
const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type OfferRow = typeof schema.deviceTransferOffers.$inferSelect;

/** The full view, for the organization that created the offer or accepted it. */
function offerView(
  row: OfferRow,
  extra: { deviceName?: string | null; direction: 'outgoing' | 'incoming' },
): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    direction: extra.direction,
    deviceId: row.deviceId,
    deviceName: extra.deviceName ?? null,
    from: {
      organizationId: row.fromOrganizationId,
      workspaceId: row.fromWorkspaceId,
    },
    acceptedBy: row.acceptedByOrganizationId
      ? {
          organizationId: row.acceptedByOrganizationId,
          workspaceId: row.acceptedWorkspaceId,
        }
      : null,
    transferId: row.transferId,
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The allowlist the CODE buys: enough to decide, and nothing more.
 *
 * Explicitly absent and explicitly tested for: `deviceId`, `serial`,
 * `workspaceId`, any telemetry, any configuration. A code that leaked would
 * otherwise be a read primitive against another tenant's fleet.
 */
function offerPreview(
  row: OfferRow,
  device: { name: string | null; modelId: string; modelName: string; modelSku: string } | null,
  fromOrganizationName: string,
): Record<string, unknown> {
  return {
    code: row.code,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    device: device
      ? {
          name: device.name,
          model: { id: device.modelId, name: device.modelName, sku: device.modelSku },
        }
      : null,
    from: { organizationName: fromOrganizationName },
  };
}

function expired(row: OfferRow): boolean {
  return row.status === 'pending' && row.expiresAt.getTime() < Date.now();
}

/**
 * Flip a stale `pending` row to `expired` on read, so no sweeper job is needed —
 * the same lazy expiry `device-registrations.ts` uses, and for the same reason:
 * the only thing that ever asks about an offer is someone reading it.
 */
async function lazyExpire(row: OfferRow): Promise<OfferRow> {
  if (!expired(row)) return row;
  const [flipped] = await db
    .update(schema.deviceTransferOffers)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(
      and(
        eq(schema.deviceTransferOffers.id, row.id),
        eq(schema.deviceTransferOffers.status, 'pending'),
      ),
    )
    .returning();
  return flipped ?? { ...row, status: 'expired' };
}

/** POST /devices/{id}/transfer-offers — the source mints a code. */
async function createOffer(
  event: APIGatewayProxyEventV2,
  auth: OrgAuthContext,
  deviceId: string,
): Promise<APIGatewayProxyResultV2> {
  if (event.body && event.body !== '{}' && event.body !== '') {
    let body: unknown;
    try {
      body = JSON.parse(event.body);
    } catch {
      return badRequest('Invalid JSON body');
    }
    const keys = Object.keys((body ?? {}) as Record<string, unknown>);
    if (keys.length > 0) return badRequest(`unknown field(s): ${keys.join(', ')}`);
  }

  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, deviceId),
    columns: { id: true, workspaceId: true, name: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

  // A device already mid-transfer must not also be offered: accepting the offer
  // would be a second concurrent tenancy change.
  await reconcileStaleTransfers(deviceId);

  const existing = await db.query.deviceTransferOffers.findFirst({
    where: and(
      eq(schema.deviceTransferOffers.deviceId, deviceId),
      eq(schema.deviceTransferOffers.status, 'pending'),
    ),
  });
  if (existing) {
    const current = await lazyExpire(existing);
    if (current.status === 'pending') {
      // Idempotent reuse, exactly as `POST /device-registrations` does it:
      // reopening the dialog must not burn a second claimable code for the same
      // device. 200 rather than 201 so a client can tell reuse from a mint.
      return ok({
        offer: offerView(current, { deviceName: device.name, direction: 'outgoing' }),
        willDetachWorkflowAttachments: await detachNames(deviceId, auth.organizationId),
      });
    }
  }

  const [row] = await db
    .insert(schema.deviceTransferOffers)
    .values({
      code: generateRegistrationCode(),
      deviceId,
      fromOrganizationId: auth.organizationId,
      fromWorkspaceId: device.workspaceId,
      // Exactly one of these, mirroring `device_registrations`: an API-key
      // caller has no `users` row to attribute to.
      createdByUserId: auth.userId,
      createdByApiKeyId: auth.apiKeyId,
      expiresAt: new Date(Date.now() + OFFER_TTL_MS),
    })
    .returning();

  return created({
    offer: offerView(row!, { deviceName: device.name, direction: 'outgoing' }),
    // README §4.5: the SOURCE loses these, and the source is not present when
    // the offer is accepted. Naming them here is the only moment at which it can
    // still reconsider. They detach only if the destination turns out to be a
    // different organization, which is the usual case for an offer.
    willDetachWorkflowAttachments: await detachNames(deviceId, auth.organizationId),
  });
}

async function detachNames(deviceId: string, organizationId: string): Promise<string[]> {
  const rows = await attachmentsAtRiskOnOrgChange(deviceId, organizationId);
  return rows.map((r) => r.templateName);
}

/** GET /devices/{id}/transfer-offers — every offer ever made for this device. */
async function listDeviceOffers(
  auth: OrgAuthContext,
  deviceId: string,
): Promise<APIGatewayProxyResultV2> {
  const rows = await db.query.deviceTransferOffers.findMany({
    where: eq(schema.deviceTransferOffers.deviceId, deviceId),
    orderBy: [desc(schema.deviceTransferOffers.createdAt)],
  });
  const offers = await Promise.all(rows.map((r) => lazyExpire(r)));
  return ok({
    offers: offers.map((r) =>
      offerView(r, {
        direction: r.fromOrganizationId === auth.organizationId ? 'outgoing' : 'incoming',
      }),
    ),
  });
}

/** The offer for a code, with lazy expiry applied. */
async function offerByCode(code: string): Promise<OfferRow | null> {
  const row = await db.query.deviceTransferOffers.findFirst({
    where: eq(schema.deviceTransferOffers.code, code),
  });
  if (!row) return null;
  return lazyExpire(row);
}

const OFFER_STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'expired'];

/** GET /transfer-offers — what this organization sent, plus what it accepted. */
async function listOffers(
  event: APIGatewayProxyEventV2,
  auth: OrgAuthContext,
): Promise<APIGatewayProxyResultV2> {
  const status = event.queryStringParameters?.status;
  if (status && !OFFER_STATUSES.includes(status)) {
    return badRequest(`status must be one of: ${OFFER_STATUSES.join(', ')}`);
  }
  const rows = await db.query.deviceTransferOffers.findMany({
    where: or(
      eq(schema.deviceTransferOffers.fromOrganizationId, auth.organizationId),
      eq(schema.deviceTransferOffers.acceptedByOrganizationId, auth.organizationId),
    ),
    orderBy: [desc(schema.deviceTransferOffers.createdAt)],
    limit: 200,
  });
  const offers = (await Promise.all(rows.map((r) => lazyExpire(r))))
    .filter((r) => !status || r.status === status)
    .map((r) =>
      offerView(r, {
        direction: r.fromOrganizationId === auth.organizationId ? 'outgoing' : 'incoming',
      }),
    );
  return ok({ offers });
}

/** GET /transfer-offers/{code} — the destination's preview. */
async function getOffer(code: string): Promise<APIGatewayProxyResultV2> {
  const row = await offerByCode(code);
  if (!row) return notFound('Transfer offer not found');
  const rows = await db
    .select({
      name: schema.devices.name,
      modelId: schema.deviceModels.id,
      modelName: schema.deviceModels.name,
      modelSku: schema.deviceModels.sku,
    })
    .from(schema.devices)
    .innerJoin(schema.deviceModels, eq(schema.devices.deviceModelId, schema.deviceModels.id))
    .where(eq(schema.devices.id, row.deviceId))
    .limit(1);
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, row.fromOrganizationId),
    columns: { name: true },
  });
  return ok({ offer: offerPreview(row, rows[0] ?? null, org?.name ?? 'Unknown organization') });
}

/** DELETE /transfer-offers/{code} — the SOURCE withdraws it. */
async function cancelOffer(
  auth: OrgAuthContext,
  code: string,
): Promise<APIGatewayProxyResultV2> {
  const row = await offerByCode(code);
  // 404 rather than 403 for an offer belonging to another organization: a code
  // the caller does not own must read as absent.
  if (!row || row.fromOrganizationId !== auth.organizationId) {
    return notFound('Transfer offer not found');
  }
  if (row.status !== 'pending') {
    return conflict(`This offer is already ${row.status}.`);
  }
  const [cancelled] = await db
    .update(schema.deviceTransferOffers)
    .set({ status: 'cancelled', resolvedAt: new Date(), resolvedByUserId: auth.userId })
    .where(
      and(
        eq(schema.deviceTransferOffers.id, row.id),
        eq(schema.deviceTransferOffers.status, 'pending'),
      ),
    )
    .returning();
  if (!cancelled) return conflict('This offer was resolved by someone else.');
  return { statusCode: 204, body: '' };
}

/** POST /transfer-offers/{code}/decline — the destination refuses it. */
async function declineOffer(
  auth: OrgAuthContext,
  code: string,
): Promise<APIGatewayProxyResultV2> {
  const row = await offerByCode(code);
  if (!row) return notFound('Transfer offer not found');
  if (row.status !== 'pending') return conflict(`This offer is already ${row.status}.`);
  const [declined] = await db
    .update(schema.deviceTransferOffers)
    .set({ status: 'declined', resolvedAt: new Date(), resolvedByUserId: auth.userId })
    .where(
      and(
        eq(schema.deviceTransferOffers.id, row.id),
        eq(schema.deviceTransferOffers.status, 'pending'),
      ),
    )
    .returning();
  if (!declined) return conflict('This offer was resolved by someone else.');
  // The source sees this through its own listing (Q3): the row it created now
  // reads `declined`, with `resolvedAt` set, rather than silently expiring.
  return ok({ offer: offerView(declined, { direction: 'incoming' }) });
}

/** POST /transfer-offers/{code}/accept — the destination takes the device. */
async function acceptOffer(
  event: APIGatewayProxyEventV2,
  auth: OrgAuthContext,
  code: string,
): Promise<APIGatewayProxyResultV2> {
  let body: { workspaceId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as { workspaceId?: unknown };
  } catch {
    return badRequest('Invalid JSON body');
  }
  if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
    return badRequest('workspaceId is required');
  }
  const unknownFields = Object.keys(body).filter((k) => k !== 'workspaceId');
  if (unknownFields.length > 0) {
    return badRequest(`unknown field(s): ${unknownFields.join(', ')}`);
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (!orgWorkspaceIds.includes(body.workspaceId)) {
    return notFound(`Workspace "${body.workspaceId}" not found`);
  }

  const row = await offerByCode(code);
  if (!row) return notFound('Transfer offer not found');
  if (row.status !== 'pending') return conflict(`This offer is already ${row.status}.`);
  if (row.fromOrganizationId === auth.organizationId) {
    return badRequest(
      'This offer was created by your own organization. Use POST /devices/{id}/transfer instead.',
    );
  }

  // The offer records where the device WAS. If the source has since handed it to
  // somebody else, the offer is a claim on a device its author no longer owns.
  const owner = await db
    .select({ organizationId: schema.workspaces.organizationId })
    .from(schema.devices)
    .innerJoin(schema.workspaces, eq(schema.devices.workspaceId, schema.workspaces.id))
    .where(eq(schema.devices.id, row.deviceId))
    .limit(1);
  if (owner[0]?.organizationId !== row.fromOrganizationId) {
    return conflict(
      'The device is no longer owned by the organization that offered it; this offer is stale.',
    );
  }

  // Race-safe state transition first, exactly as `claimRegistration` does it:
  // only one concurrent caller flips `pending`, so a double-accept is refused by
  // the database rather than by a check-then-act that two requests can both pass.
  const [claimed] = await db
    .update(schema.deviceTransferOffers)
    .set({
      status: 'accepted',
      acceptedByOrganizationId: auth.organizationId,
      acceptedWorkspaceId: body.workspaceId,
      resolvedAt: new Date(),
      resolvedByUserId: auth.userId,
    })
    .where(
      and(
        eq(schema.deviceTransferOffers.id, row.id),
        eq(schema.deviceTransferOffers.status, 'pending'),
        gt(schema.deviceTransferOffers.expiresAt, sql`now()`),
      ),
    )
    .returning();
  if (!claimed) return conflict('This offer was resolved by someone else, or has expired.');

  let summary: TransferSummary;
  try {
    summary = await transferDevice({
      deviceId: row.deviceId,
      toWorkspaceId: body.workspaceId,
      actor: { userId: auth.userId, apiKeyId: auth.apiKeyId },
      offerId: row.id,
    });
  } catch (err) {
    // Put the offer back so the code can be retried, the same rollback
    // `claimRegistration` performs when provisioning fails after the flip.
    await db
      .update(schema.deviceTransferOffers)
      .set({
        status: 'pending',
        acceptedByOrganizationId: null,
        acceptedWorkspaceId: null,
        resolvedAt: null,
        resolvedByUserId: null,
      })
      .where(eq(schema.deviceTransferOffers.id, row.id))
      .catch(() => undefined);
    if (err instanceof TransferError) return transferErrorResponse(err);
    console.error('transfer offer accept failed', { offerId: row.id, err });
    return errorResponse(
      502,
      'TRANSFER_FAILED',
      'The device could not be told about its new workspace, so the transfer was ' +
        'rolled back and the offer is still open. Try again in a moment.',
    );
  }

  const [linked] = await db
    .update(schema.deviceTransferOffers)
    .set({ transferId: summary.transferId })
    .where(eq(schema.deviceTransferOffers.id, row.id))
    .returning();

  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, row.deviceId),
  });
  if (!device) return notFound('Device not found');
  return ok({
    device: deviceResponse(device),
    transfer: transferResponse(summary),
    offer: offerView(linked ?? claimed, { deviceName: device.name, direction: 'incoming' }),
  });
}

/**
 * The code-scoped half. These routes are reached by an organization that has no
 * relationship to the device, so there is no device-ownership check to make —
 * the CODE is the authorization, and the role gate is about what the caller may
 * do inside its OWN organization.
 *
 * The preview alone takes no role: it hands back the allowlist above and
 * nothing else, and refusing a `viewer` who was sent a code would only mean they
 * cannot tell an admin what arrived.
 */
async function offerRoutes(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  code: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  const readOnly = routeKey === 'GET /transfer-offers/{code}' || routeKey === 'GET /transfer-offers';
  let auth: OrgAuthContext;
  try {
    auth = await requireOrgWideContext(event, readOnly ? undefined : ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  if (routeKey === 'GET /transfer-offers') return listOffers(event, auth);

  if (!code) return badRequest('offer code required in path');
  switch (routeKey) {
    case 'GET /transfer-offers/{code}':
      return getOffer(code);
    case 'DELETE /transfer-offers/{code}':
      return cancelOffer(auth, code);
    case 'POST /transfer-offers/{code}/accept':
      return acceptOffer(event, auth, code);
    case 'POST /transfer-offers/{code}/decline':
      return declineOffer(auth, code);
    default:
      return methodNotAllowed(event.requestContext.http.method, 'GET, POST, DELETE');
  }
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const routeKey = canonicalRouteKey(event);
  const deviceId = event.pathParameters?.id;
  const code = event.pathParameters?.code;

  if (routeKey.includes('/devices/{id}/')) {
    if (!deviceId) return badRequest('device id required in path');
    return deviceRoutes(event, routeKey, deviceId);
  }
  return offerRoutes(event, routeKey, code);
};

export const handler = apiHandler(restHandler);

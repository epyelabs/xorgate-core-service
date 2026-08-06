import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import type { DeviceRegistration } from '../db/schema';
import {
  badRequest,
  conflict,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { generateRegistrationCode } from '../utils/registration-code';
import { provisionDevice, deleteThing } from '../services/iot-provisioning';
import { publishDeviceConfig } from '../services/device-config';
import { initialConfigDocument } from '../config-registry/index';

const REGISTRATION_TTL_MS = 15 * 60 * 1000;

function apiBaseUrl(): string {
  const v = process.env.API_BASE_URL;
  if (!v) throw new Error('API_BASE_URL env var is not set');
  return v.replace(/\/$/, '');
}

interface RegistrationView {
  code: string;
  status: string;
  deviceId: string | null;
  expiresAt: string;
  installUrl: string;
}

function toView(row: DeviceRegistration): RegistrationView {
  return {
    code: row.code,
    status: row.status,
    deviceId: row.deviceId,
    expiresAt: row.expiresAt.toISOString(),
    installUrl: `${apiBaseUrl()}/get/${row.code}`,
  };
}

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

// Router: POST /device-registrations, GET /device-registrations/{code},
// POST /device-registrations/{code}/claim. All four routes hit this one Lambda;
// the gateway has no authorizer, so the claim branch simply skips requireOrgContext.
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const code = event.pathParameters?.code;
  const isClaim = event.rawPath.endsWith('/claim');

  if (method === 'POST' && code && isClaim) return claimRegistration(event, code);
  if (method === 'POST' && !code) return createRegistration(event);
  if (method === 'GET' && code) return getRegistration(event, code);
  return methodNotAllowed(method, 'GET, POST');
};

// POST /device-registrations (auth). Idempotent: returns the workspace's existing
// pending, un-expired registration instead of minting a new code, so reloading
// the dialog doesn't burn codes.
async function createRegistration(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let auth;
  try {
    auth = await requireOrgContext(event, ['owner', 'admin', 'member']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const workspaceId =
    event.headers['x-workspace-id'] ?? event.headers['X-Workspace-Id'];
  if (!workspaceId) {
    return badRequest('Select a workspace first (missing X-Workspace-Id header)');
  }
  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);
  if (!orgWorkspaceIds.includes(workspaceId)) {
    return badRequest('workspaceId does not belong to the active organization');
  }

  // Auto-pick the device model. Today there is exactly one seeded model; when
  // multiple exist this takes the most recent. (Future: the agent reports a GPIO
  // BOARD_ID that selects the model — deferred.)
  const model = await db.query.deviceModels.findFirst({
    orderBy: [desc(schema.deviceModels.createdAt)],
  });
  if (!model) {
    return badRequest('No device model is configured; seed a device model first');
  }

  const existing = await db.query.deviceRegistrations.findFirst({
    where: and(
      eq(schema.deviceRegistrations.workspaceId, workspaceId),
      eq(schema.deviceRegistrations.status, 'pending'),
      gt(schema.deviceRegistrations.expiresAt, sql`now()`),
    ),
    orderBy: [desc(schema.deviceRegistrations.createdAt)],
  });
  if (existing) return ok(toView(existing));

  const [row] = await db
    .insert(schema.deviceRegistrations)
    .values({
      code: generateRegistrationCode(),
      organizationId: auth.organizationId,
      workspaceId,
      deviceModelId: model.id,
      createdByUserId: auth.userId,
      expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS),
      // status omitted: column DEFAULT 'pending' fires.
    })
    .returning();

  return ok(toView(row!));
}

// GET /device-registrations/{code} (auth, org-scoped). Lazy-expire a stale
// pending row to `expired` on read so no sweeper job is needed.
async function getRegistration(
  event: APIGatewayProxyEventV2,
  code: string,
): Promise<APIGatewayProxyResultV2> {
  let auth;
  try {
    auth = await requireOrgContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const row = await db.query.deviceRegistrations.findFirst({
    where: and(
      eq(schema.deviceRegistrations.code, code),
      eq(schema.deviceRegistrations.organizationId, auth.organizationId),
    ),
  });
  if (!row) return notFound('Registration not found');

  if (row.status === 'pending' && row.expiresAt.getTime() < Date.now()) {
    const [flipped] = await db
      .update(schema.deviceRegistrations)
      .set({ status: 'expired' })
      .where(
        and(
          eq(schema.deviceRegistrations.id, row.id),
          eq(schema.deviceRegistrations.status, 'pending'),
        ),
      )
      .returning();
    if (flipped) return ok(toView(flipped));
  }

  return ok(toView(row));
}

// POST /device-registrations/{code}/claim (UNAUTHENTICATED — this is what
// install.sh on the device calls). Order:
//   1. Atomic UPDATE flips pending -> claimed (only one concurrent caller wins).
//   2. Insert the devices row (serial unique per workspace).
//   3. Provision IoT (thing + cert + KVS) via the shared service.
//   4. Link the device back to the registration.
// On failure after step 2 we delete the device row + IoT thing and revert the
// registration to pending so the operator can retry the same code.
async function claimRegistration(
  event: APIGatewayProxyEventV2,
  code: string,
): Promise<APIGatewayProxyResultV2> {
  let body: { serial?: string; hostname?: string; platform?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  // Step 1: race-safe state transition.
  const [reg] = await db
    .update(schema.deviceRegistrations)
    .set({ status: 'claimed', claimedAt: sql`now()` })
    .where(
      and(
        eq(schema.deviceRegistrations.code, code),
        eq(schema.deviceRegistrations.status, 'pending'),
        gt(schema.deviceRegistrations.expiresAt, sql`now()`),
      ),
    )
    .returning();

  if (!reg) {
    return notFound('Registration code not found, already used, or expired');
  }

  // A stable per-host serial; the install script derives it from machine-id.
  // Fall back to the (unique) code so we never violate the NOT NULL/serial rules.
  const serial = body.serial?.trim() || `xg-${reg.code}`;
  const name = body.hostname?.trim() || null;

  // Reject a re-registration of the same physical host (serial unique per
  // workspace) with a clean 409 rather than letting the unique index 500.
  const dup = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.workspaceId, reg.workspaceId),
      eq(schema.devices.serial, serial),
    ),
  });
  if (dup) {
    await revertClaim(reg.id);
    return conflict(
      'A device with this serial is already registered in the workspace; delete it first to re-provision.',
    );
  }

  // Step 2: create the device row.
  let device;
  try {
    [device] = await db
      .insert(schema.devices)
      .values({
        workspaceId: reg.workspaceId,
        deviceModelId: reg.deviceModelId,
        serial,
        name,
        // status omitted: column DEFAULT 'provisioned' fires.
        // rev 1 (not the 0 default) marks "the cloud has published a document";
        // rev 0 means the topic was never written. See step 5 below.
        config: initialConfigDocument(),
        configRev: 1,
        configUpdatedAt: new Date(),
      })
      .returning();
  } catch (err) {
    await revertClaim(reg.id);
    throw err;
  }

  // Step 3: provision IoT (thing + cert + policy + KVS channels).
  const model = await db.query.deviceModels.findFirst({
    where: eq(schema.deviceModels.id, reg.deviceModelId),
  });

  let result;
  try {
    result = await provisionDevice(device!, model);
  } catch (err) {
    // Roll back: delete the device row (cascades identity/channels), best-effort
    // delete the IoT thing, and revert the registration so the code can be retried.
    await db
      .delete(schema.devices)
      .where(eq(schema.devices.id, device!.id))
      .catch(() => undefined);
    await deleteThing(device!.id);
    await revertClaim(reg.id);
    throw err;
  }

  // Step 4: link the device to the registration.
  await db
    .update(schema.deviceRegistrations)
    .set({ deviceId: device!.id, serial })
    .where(eq(schema.deviceRegistrations.id, reg.id));

  // Step 5: seed the retained config topic (improve_device_settings_management,
  // Phase 2). Before this, the topic stayed EMPTY until someone opened the
  // settings page and saved — a freshly-onboarded device had nothing to apply
  // and no way to tell "no config yet" from "cloud says defaults". The document
  // is empty on purpose (absent namespace = device defaults), so this is a
  // `{v:1, rev:1, gnssAntBias:false, …}` marker, not a values freeze.
  // Best-effort: a publish failure must never fail a claim that has already
  // created the row, the thing and the cert — the next save republishes.
  try {
    await publishDeviceConfig(device!.id, device!.config, device!.configRev);
  } catch (err) {
    console.error('initial device config publish failed', {
      deviceId: device!.id,
      rev: device!.configRev,
      err,
    });
  }

  return ok({
    deviceId: device!.id,
    thingName: result.thingName,
    dataEndpoint: result.dataEndpoint,
    certPem: result.certificatePem,
    privateKey: result.privateKey,
    caUrl: result.caUrl,
    name: device!.name,
    // KVS WebRTC runtime config: the install script writes these to kvs.json so
    // the device-agent media collector can run a master per channel (IoT-cert
    // creds via the credential provider). Already on `result` — just surfaced.
    region: result.region,
    credentialEndpoint: result.credentialEndpoint,
    roleAlias: result.roleAlias,
    channels: result.channels.map((c) => ({
      streamKey: c.streamKey,
      channelName: c.channelName,
    })),
    // Recording-segment upload target (offline recording plan, Phase 2): the
    // install script writes this into kvs.json as `uploadBucket`; the agent's
    // uploader PUTs telemetry/v1/* + media-sessions/v1/* here with the same
    // IoT role-alias creds the KVS runtime uses.
    uploadBucket: process.env.BUCKET_NAME ?? null,
  });
}

async function revertClaim(registrationId: string): Promise<void> {
  await db
    .update(schema.deviceRegistrations)
    .set({ status: 'pending', claimedAt: null, deviceId: null })
    .where(eq(schema.deviceRegistrations.id, registrationId))
    .catch(() => undefined);
}

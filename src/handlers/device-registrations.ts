import { requestPath } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import type { DeviceRegistration } from '../db/schema';
import {
  badRequest,
  conflict,
  errorResponse,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { generateRegistrationCode } from '../utils/registration-code';
import { provisionDevice, deleteThing } from '../services/iot-provisioning';
import { publishDeviceConfig } from '../services/device-config';
import { resolveModel } from '../services/model-probe';
import { deriveHardwareBlock, type DeviceHardwareBlock } from '../schemas/capabilities';
import {
  CAMERA_SENSORS_KEY,
  cameraSensorMapSchema,
  checkCameraSensorMap,
  initialConfigDocument,
  type CameraSensorEntry,
  type CameraSensorsConfig,
  type ConfigDocument,
} from '../config-registry/index';
import { CAMERA_SENSOR_NONE, cameraSensor } from '../camera-catalog';
import { apiHandler } from '../utils/api-handler';
import {
  type AgentKind,
  isAgentKind,
  rustRegistrationEnabled,
  rustRegistrationFlag,
  storedAgent,
} from '../services/device-agent';

const REGISTRATION_TTL_MS = 15 * 60 * 1000;

function apiBaseUrl(): string {
  const v = process.env.API_BASE_URL;
  if (!v) throw new Error('API_BASE_URL env var is not set');
  // API_BASE_URL is a bare origin; the version lives here, with every other
  // route. The installer's two endpoints (`/v1/get/{code}` and
  // `/v1/device-registrations/{code}/claim`) are as versioned as the rest of
  // the API since the unversioned paths were deleted. Registration codes live
  // 15 minutes, so no previously-issued URL outlived the change.
  return `${v.replace(/\/$/, '')}/v1`;
}

interface RegistrationView {
  code: string;
  status: string;
  deviceId: string | null;
  expiresAt: string;
  installUrl: string;
  /** Which installer `installUrl` serves (dual-agent registration D3). */
  agent: AgentKind;
  /**
   * The per-port camera sensor choice the claim will seed
   * (plans/support-other-camera-models); null = none made, the claim uses the
   * model's sensor defaults. Present on RUST registrations only: a JS
   * registration's view has exactly the keys it always had.
   */
  cameras?: RegistrationCameras | null;
}

/** `device_registrations.cameras`: the `cameras` map of the `cameraSensors` namespace. */
type RegistrationCameras = Record<string, CameraSensorEntry>;

function toView(row: DeviceRegistration): RegistrationView {
  const agent = storedAgent(row.agent);
  return {
    code: row.code,
    status: row.status,
    deviceId: row.deviceId,
    expiresAt: row.expiresAt.toISOString(),
    installUrl: `${apiBaseUrl()}/get/${row.code}`,
    agent,
    ...(agent === 'rust' ? { cameras: row.cameras ?? null } : {}),
  };
}

/** Key-order-insensitive equality for two stored camera choices. */
function sameCameras(a: RegistrationCameras | null, b: RegistrationCameras | null): boolean {
  const canon = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
            .map(([k, w]) => [k, canon(w)]),
        )
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * Validate the `cameras` field of a registration body: the per-port map of the
 * `cameraSensors` namespace, judged by the namespace's own schema (shape, then
 * the catalog). `null` and `{}` both mean "no choice".
 *
 * Ports are NOT checked against a model here: the model may still be decided
 * by the probe at claim, and the claim drops entries for ports the resolved
 * model does not declare.
 */
function parseRegistrationCameras(
  input: unknown,
): { value: RegistrationCameras | null } | { error: string } {
  if (input === null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      error:
        'cameras: must be an object keyed by stream key, like {"cam0": {"sensor": "imx290"}}, or null',
    };
  }
  const parsed = cameraSensorMapSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `cameras.${issue.path.join('.')}` : 'cameras';
    return { error: `${path}: ${issue?.message ?? 'invalid'}` };
  }
  return { value: Object.keys(parsed.data).length > 0 ? parsed.data : null };
}

// Router: POST /device-registrations, GET /device-registrations/{code},
// POST /device-registrations/{code}/claim. All four routes hit this one Lambda;
// the gateway has no authorizer, so the claim branch simply skips requireOrgContext.
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const code = event.pathParameters?.code;
  const isClaim = requestPath(event).endsWith('/claim');

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

  // This is the one route where `X-Workspace-Id` is mandatory rather than a
  // filter. A workspace-scoped session token supplies it implicitly: the
  // credential already names exactly one workspace, so demanding a header the
  // caller has no freedom to choose differently would be ceremony. Sending a
  // CONTRADICTING one is still a 403, refused in the middleware before this runs.
  const workspaceId =
    event.headers['x-workspace-id'] ??
    event.headers['X-Workspace-Id'] ??
    auth.allowedWorkspaceId ??
    undefined;
  if (!workspaceId) {
    return badRequest('Select a workspace first (missing X-Workspace-Id header)');
  }
  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (!orgWorkspaceIds.includes(workspaceId)) {
    return badRequest('workspaceId does not belong to the active organization');
  }

  // Optional explicit model pick (cm4-support D3 override): when the operator
  // chooses a model in the Register dialog, the claim honors it and skips
  // probe-at-claim mapping (`model_pinned`).
  let body: { deviceModelId?: string; agent?: unknown; cameras?: unknown } = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  // Which agent the code installs (dual-agent registration D3). Absent = 'js',
  // today's installer. Rust is gated per stage (and optionally per workspace)
  // by RUST_AGENT_REGISTRATION, which fails closed (services/device-agent.ts).
  let agent: AgentKind = 'js';
  if (body.agent !== undefined) {
    if (!isAgentKind(body.agent)) {
      return errorResponse(400, 'INVALID_AGENT', 'agent must be "js" or "rust"');
    }
    agent = body.agent;
  }
  if (agent === 'rust' && !rustRegistrationEnabled(rustRegistrationFlag(), workspaceId)) {
    return errorResponse(
      409,
      'AGENT_NOT_ENABLED',
      'Rust agent registration is not enabled on this stage for this workspace.',
    );
  }
  // The per-port camera sensor choice (plans/support-other-camera-models). Only
  // the Rust agent manages camera sensors, so the field exists only for a Rust
  // registration: on a JS one it is refused rather than stored and ignored.
  // `undefined` = the request does not speak about cameras (a reused code keeps
  // what it has); `null` = clear the choice.
  let cameras: RegistrationCameras | null | undefined;
  if (body.cameras !== undefined) {
    if (agent !== 'rust') {
      return errorResponse(
        400,
        'INVALID_CAMERAS',
        'cameras applies only to Rust agent registrations (agent: "rust"); the JS agent does ' +
          'not manage camera sensors',
      );
    }
    const parsed = parseRegistrationCameras(body.cameras);
    if ('error' in parsed) return errorResponse(400, 'INVALID_CAMERAS', parsed.error);
    cameras = parsed.value;
  }
  let pinnedModelId: string | null = null;
  if (body.deviceModelId !== undefined) {
    if (typeof body.deviceModelId !== 'string') {
      return badRequest('deviceModelId must be a string');
    }
    const picked = await db.query.deviceModels.findFirst({
      where: eq(schema.deviceModels.id, body.deviceModelId),
    });
    if (!picked) return badRequest(`Device model "${body.deviceModelId}" not found`);
    pinnedModelId = picked.id;
  }

  // Auto-pick fallback model when the operator didn't choose one. This is only
  // a FALLBACK now: probe-at-claim (see claimRegistration) maps the device's
  // own hardware to a model row; when the probe is ambiguous the device keeps
  // this model and is flagged `needs_model` for one-click resolution in the UI.
  const model = await db.query.deviceModels.findFirst({
    orderBy: [desc(schema.deviceModels.createdAt)],
  });
  if (!model) {
    return badRequest('No device model is configured; seed a device model first');
  }

  // Reuse only a pending code for the SAME agent (Q-8.2). The agent decides
  // which script `GET /get/{code}` serves, so re-pinning it in place would
  // silently change what an already-copied install URL does; an agent change
  // mints a new code instead. The other agent's pending code stays valid until
  // it expires.
  const existing = await db.query.deviceRegistrations.findFirst({
    where: and(
      eq(schema.deviceRegistrations.workspaceId, workspaceId),
      eq(schema.deviceRegistrations.status, 'pending'),
      eq(schema.deviceRegistrations.agent, agent),
      gt(schema.deviceRegistrations.expiresAt, sql`now()`),
    ),
    orderBy: [desc(schema.deviceRegistrations.createdAt)],
  });
  if (existing) {
    // Idempotent reuse — but an operator changing the model pick in the dialog
    // must not be silently ignored on the reused row. Same for the camera
    // choice: it is re-pinned in place, never a reason to mint a new code.
    const repin: {
      deviceModelId?: string;
      modelPinned?: boolean;
      cameras?: RegistrationCameras | null;
    } = {};
    if (pinnedModelId && (existing.deviceModelId !== pinnedModelId || !existing.modelPinned)) {
      repin.deviceModelId = pinnedModelId;
      repin.modelPinned = true;
    }
    if (cameras !== undefined && !sameCameras(existing.cameras ?? null, cameras)) {
      repin.cameras = cameras;
    }
    if (Object.keys(repin).length > 0) {
      const [repinned] = await db
        .update(schema.deviceRegistrations)
        .set(repin)
        .where(eq(schema.deviceRegistrations.id, existing.id))
        .returning();
      return ok(toView(repinned!));
    }
    return ok(toView(existing));
  }

  const [row] = await db
    .insert(schema.deviceRegistrations)
    .values({
      code: generateRegistrationCode(),
      organizationId: auth.organizationId,
      workspaceId,
      deviceModelId: pinnedModelId ?? model.id,
      modelPinned: pinnedModelId !== null,
      agent,
      // Only when a choice was made: a JS registration, and a Rust one with no
      // choice, insert exactly the columns they always did (NULL by default).
      ...(cameras ? { cameras } : {}),
      // Exactly one of these is set. An API-key caller has no `users` row to
      // point at, so attribution moves to the key rather than being dropped.
      createdByUserId: auth.userId,
      createdByApiKeyId: auth.apiKeyId,
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

  // Org filter plus the workspace intersection. The registration row carries a
  // `workspace_id`, so this is the same narrowing every device read gets: a
  // workspace-scoped token polling a code minted for another tenant reads it as
  // missing, indistinguishable from another organization's.
  const visibleWorkspaceIds = await resolveWorkspaceScope(auth);
  if (visibleWorkspaceIds.length === 0) return notFound('Registration not found');

  const row = await db.query.deviceRegistrations.findFirst({
    where: and(
      eq(schema.deviceRegistrations.code, code),
      eq(schema.deviceRegistrations.organizationId, auth.organizationId),
      inArray(schema.deviceRegistrations.workspaceId, visibleWorkspaceIds),
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
  let body: {
    serial?: string;
    hostname?: string;
    platform?: string;
    /** `/proc/device-tree/model` — the D3 probe. */
    dtModel?: string;
    /** Cameras libcamera saw at install time; 0/absent = unknown (fresh install has no overlays yet). */
    cameras?: number;
    /** The installer's own idea of its agent (the Rust provisioner sends "rust"; JS sends none). */
    agent?: unknown;
  };
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

  // Step 1b: resolve the device model from the probe (cm4-support D3). An
  // operator-pinned registration wins outright; otherwise the probe narrows
  // the catalog by platform (+ camera count when known), and an ambiguous or
  // unrecognized probe keeps the registration's fallback model with
  // `needs_model` set for one-click resolution in the console.
  const regModel = await db.query.deviceModels.findFirst({
    where: eq(schema.deviceModels.id, reg.deviceModelId),
  });
  // The agent the REGISTRATION chose (see the cross-check below). Read here
  // because the camera choice, a Rust-only carry, feeds the model resolution.
  const agent = storedAgent(reg.agent);
  const chosenCameras: RegistrationCameras | null =
    agent === 'rust' ? (reg.cameras ?? null) : null;

  let resolvedModel = regModel;
  let needsModel = false;
  if (regModel && !reg.modelPinned) {
    const catalog = await db.query.deviceModels.findMany();
    const res = resolveModel(catalog, regModel, {
      dtModel: body.dtModel,
      cameras: body.cameras,
      // A fresh OS has no camera overlay yet, so the probe says 0. The number
      // of sensors the operator declared then stands in as the count
      // (plans/support-other-camera-models). Absent for a JS registration and
      // for a Rust one with no choice: the resolution is then what it was.
      ...(chosenCameras ? { declaredCameras: declaredSensorCount(chosenCameras) } : {}),
    });
    resolvedModel = res.model;
    needsModel = res.needsModel;
    console.log('claim model resolution', {
      code,
      dtModel: body.dtModel ?? null,
      cameras: body.cameras ?? null,
      modelId: res.model.id,
      sku: res.model.sku,
      needsModel,
      reason: res.reason,
    });
  }

  // The device runs the agent its REGISTRATION chose: that is what
  // `GET /get/{code}` served. The claim body's `agent` is only a cross-check; a
  // mismatch is logged and the registration's value kept.
  const claimedAgent = body.agent === undefined ? 'js' : body.agent;
  if (claimedAgent !== agent) {
    console.warn('claim agent mismatch; keeping the registration agent', {
      code,
      registrationAgent: agent,
      claimedAgent: typeof claimedAgent === 'string' ? claimedAgent.slice(0, 16) : typeof claimedAgent,
    });
  }

  // The camera sensors this device starts with (plans/support-other-camera-models):
  // RUST registrations only. Every new Rust device is managed from day one: per
  // camera port of the resolved model, the registration's choice, else the
  // model's own sensor. A JS claim seeds nothing and its document, its retained
  // message and its response are exactly what they were.
  const hardware = deriveHardwareBlock(resolvedModel?.ioCapabilities);
  const cameraSensors =
    agent === 'rust' ? seedCameraSensors(hardware, chosenCameras, { code }) : null;
  const initialConfig: ConfigDocument = initialConfigDocument();
  if (cameraSensors) initialConfig[CAMERA_SENSORS_KEY] = cameraSensors;

  // Step 2: create the device row.
  let device;
  try {
    [device] = await db
      .insert(schema.devices)
      .values({
        workspaceId: reg.workspaceId,
        deviceModelId: resolvedModel?.id ?? reg.deviceModelId,
        needsModel,
        serial,
        name,
        agent,
        // status omitted: column DEFAULT 'provisioned' fires.
        // rev 1 (not the 0 default) marks "the cloud has published a document";
        // rev 0 means the topic was never written. See step 5 below.
        config: initialConfig,
        configRev: 1,
        configUpdatedAt: new Date(),
      })
      .returning();
  } catch (err) {
    await revertClaim(reg.id);
    throw err;
  }

  // Step 3: provision IoT (thing + cert + policy + KVS channels). Channels are
  // minted from the RESOLVED model's `media.video` — a 1-camera model mints
  // one channel, so no phantom `cam1` on single-camera hardware.
  let result;
  try {
    result = await provisionDevice(device!, resolvedModel);
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
  //
  // A Rust claim's document may carry the seeded `cameraSensors`. The publisher
  // emits it because this device has never reported (`cameraSensorsEligibility`);
  // if the agent that connects turns out not to support it, the report mirror
  // withdraws it and republishes without it.
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
    // The resolved model + its hardware block (cm4-support plan). The install
    // script writes `hardware` to /etc/xorgate/hardware.json — the agent's
    // seed until the retained config message (which also carries it) arrives.
    // null for v1 models: the agent then keeps its legacy CM5 behavior.
    modelId: resolvedModel?.id ?? reg.deviceModelId,
    modelName: resolvedModel?.name ?? null,
    needsModel,
    hardware,
    // RUST claims with a seeded choice only (plans/support-other-camera-models):
    // exactly what was stored in `devices.config.cameraSensors`. The Rust
    // installer renders the camera lines of config.txt from it. Absent on every
    // JS claim, and on a Rust claim whose model declares no camera port.
    ...(cameraSensors ? { [CAMERA_SENSORS_KEY]: cameraSensors } : {}),
  });
}

/** How many ports of a choice declare a sensor (`none` = an empty port, not counted). */
function declaredSensorCount(cameras: RegistrationCameras): number {
  return Object.values(cameras).filter(
    (c) => c && typeof c === 'object' && c.sensor !== CAMERA_SENSOR_NONE,
  ).length;
}

/**
 * The `cameraSensors` document a new Rust device starts with, or null when
 * there is nothing to manage.
 *
 * Per camera port the resolved model declares, in model order:
 *   1. the registration's choice for that port, if it still passes the catalog
 *      (it was validated when stored; a catalog change since is possible);
 *   2. else the model's own `sensor`, if the catalog can select it;
 *   3. else the port is left out, i.e. UNMANAGED (a model naming a sensor the
 *      catalog does not know keeps today's behaviour for that port).
 *
 * A choice for a port the model does not declare is DROPPED, with a log line:
 * the model may have been resolved by the probe after the choice was made.
 * With no hardware block (a schemaVersion-1 model) there are no declared ports,
 * so nothing is seeded.
 */
function seedCameraSensors(
  hardware: DeviceHardwareBlock | null,
  chosen: RegistrationCameras | null,
  log: { code: string },
): CameraSensorsConfig | null {
  const ports = hardware?.video ?? [];
  const declared = new Set(ports.map((p) => p.key));
  const dropped = Object.keys(chosen ?? {}).filter((key) => !declared.has(key));
  if (dropped.length > 0) {
    console.warn('claim: camera choice dropped for ports the resolved model does not declare', {
      code: log.code,
      dropped,
      modelPorts: [...declared],
    });
  }

  const cameras: Record<string, CameraSensorEntry> = {};
  for (const port of ports) {
    const choice = chosen?.[port.key];
    if (choice) {
      const checked = checkCameraSensorMap({ [port.key]: choice });
      if ('value' in checked) {
        cameras[port.key] = checked.value[port.key];
        continue;
      }
      console.warn('claim: stored camera choice no longer valid, using the model default', {
        code: log.code,
        port: port.key,
        issues: checked.issues.map((i) => i.message),
      });
    }
    if (cameraSensor(port.sensor)) {
      cameras[port.key] = { sensor: port.sensor };
    } else {
      console.warn('claim: model sensor is not in the camera catalog, port left unmanaged', {
        code: log.code,
        port: port.key,
        sensor: port.sensor,
      });
    }
  }
  return Object.keys(cameras).length > 0 ? { cameras } : null;
}

async function revertClaim(registrationId: string): Promise<void> {
  await db
    .update(schema.deviceRegistrations)
    .set({ status: 'pending', claimedAt: null, deviceId: null })
    .where(eq(schema.deviceRegistrations.id, registrationId))
    .catch(() => undefined);
}

export const handler = apiHandler(restHandler);

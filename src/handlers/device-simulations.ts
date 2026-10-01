import { routeKey as canonicalRouteKey } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { provisionDevice, type ProvisionResult } from '../services/iot-provisioning';
import { publishDeviceConfig } from '../services/device-config';
import { teardownDevices } from '../services/device-teardown';
import { deviceResponse } from '../services/device-view';
import {
  buildSimBundle,
  countSimulations,
  deleteSimBundle,
  findSimulation,
  readCatalog,
  scenarioViews,
  SIM_ASSETS_VERSION,
  SIM_DEVICE_MODEL_SKU,
  simQuotas,
  simSerial,
  simulationView,
  writeSimBundle,
} from '../services/device-simulations';
import {
  SIMULATION_DEFAULTS,
  SIMULATION_SCENARIO_ID_PATTERN,
  validateNamespaceValue,
  type DeviceConfigDocument,
} from '../config-registry/index';
import {
  badRequest,
  created,
  errorResponse,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

/**
 * The device simulator, operator side (plans/xorgate-device-simulator, README
 * §3.2, Phase 3):
 *
 *   POST /device-simulations              create a simulated device (owner/admin)
 *   GET  /device-simulations/scenarios    the scenario catalog, thumbnails presigned
 *   GET  /device-simulations/{id}         desired + host-reported state of one sim
 *   POST /device-simulations/{id}/start   "Power on" a sim parked by power_off (Q8)
 *
 * `{id}` is the DEVICE id: a simulation is 1:1 with its device and has no id of
 * its own. Everything else about a sim — config, commands, sessions, delete —
 * goes through the ordinary `/devices/{id}` routes, because a simulated device
 * is a normal device. The host plane is `handlers/sim-hosts.ts`.
 */

const NAME_MAX = 120;

/** The initial config document of every sim (README §3.2 step 2). */
function initialSimConfig(scenarioId: string): DeviceConfigDocument {
  // The source device had cam1 disabled and never recorded it (README §1.4,
  // Q3): the console then shows what a real CM5 owner of that device saw.
  // bootDefer/gpsGate are not set: the agent forces both off in replay mode.
  const doc: Record<string, unknown> = {
    recording: { video: { cameras: { cam1: false } } },
    simulation: { ...SIMULATION_DEFAULTS, scenarioId },
  };
  // Validated through the registry so a schema change cannot make the create
  // route store a document every later PATCH would refuse.
  for (const [key, value] of Object.entries(doc)) {
    const parsed = validateNamespaceValue(key, value);
    if ('error' in parsed) throw new Error(`initial sim config is invalid: ${parsed.error}`);
    doc[key] = parsed.value;
  }
  return doc as DeviceConfigDocument;
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const id = event.pathParameters?.id;

  let auth;
  try {
    // Creating a sim provisions AWS resources and starting one consumes host
    // capacity: owner/admin, like the device power commands. Reads are open
    // to every member.
    auth = await requireOrgContext(event, method === 'GET' ? undefined : ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgWorkspaceIds = await resolveWorkspaceScope(auth);

  if (routeKey === 'GET /device-simulations/scenarios') {
    const catalog = await readCatalog(SIM_ASSETS_VERSION);
    return ok({
      assetsVersion: SIM_ASSETS_VERSION,
      defaultScenarioId: SIMULATION_DEFAULTS.scenarioId,
      scenarios: await scenarioViews(catalog, SIM_ASSETS_VERSION),
    });
  }

  if (routeKey === 'GET /device-simulations/{id}') {
    if (!id) return badRequest('device id required in path');
    const found = await findSimulation(id, orgWorkspaceIds);
    if (!found) return notFound(`Simulation "${id}" not found`);
    return ok({ simulation: simulationView(found.sim, found.device.config) });
  }

  if (routeKey === 'POST /device-simulations/{id}/start') {
    if (!id) return badRequest('device id required in path');
    const found = await findSimulation(id, orgWorkspaceIds);
    if (!found) return notFound(`Simulation "${id}" not found`);
    // Level + edge: the host powers a parked sim on only when this stamp is
    // newer than the park, so a repeated start is harmless and a start sent
    // while the sim is already running is a no-op on the host.
    const [sim] = await db
      .update(schema.deviceSimulations)
      .set({ desiredState: 'running', startRequestedAt: new Date() })
      .where(eq(schema.deviceSimulations.deviceId, id))
      .returning();
    if (!sim) return notFound(`Simulation "${id}" not found`);
    return ok({ simulation: simulationView(sim, found.device.config) });
  }

  if (routeKey === 'POST /device-simulations') {
    return createSimulation(event, auth, orgWorkspaceIds);
  }

  return methodNotAllowed(method, 'GET, POST');
};

async function createSimulation(
  event: APIGatewayProxyEventV2,
  auth: { organizationId: string; userId: string | null; apiKeyId: string | null },
  orgWorkspaceIds: string[],
): Promise<APIGatewayProxyResultV2> {
  let body: { workspaceId?: unknown; name?: unknown; scenarioId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('body must be an object');
  const unknownFields = Object.keys(body).filter((k) => !['workspaceId', 'name', 'scenarioId'].includes(k));
  if (unknownFields.length > 0) return badRequest(`unknown field(s): ${unknownFields.join(', ')}`);

  if (typeof body.workspaceId !== 'string' || !body.workspaceId) {
    return badRequest('workspaceId is required');
  }
  const workspaceId = body.workspaceId;
  if (!orgWorkspaceIds.includes(workspaceId)) {
    return badRequest('workspaceId does not belong to the active organization');
  }
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string') return badRequest('name must be a string');
    if (body.name.trim().length > NAME_MAX) return badRequest(`name must be at most ${NAME_MAX} characters`);
  }
  const requestedName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;

  // Scenario: the catalog is the only source of valid ids — the namespace's
  // pattern admits ids no pack carries, and a sim created on one would loop
  // on a missing asset.
  let scenarioId: string = SIMULATION_DEFAULTS.scenarioId;
  if (body.scenarioId !== undefined && body.scenarioId !== null) {
    if (typeof body.scenarioId !== 'string' || !SIMULATION_SCENARIO_ID_PATTERN.test(body.scenarioId)) {
      return badRequest('scenarioId must be a catalog scenario id');
    }
    scenarioId = body.scenarioId;
  }
  const catalog = await readCatalog(SIM_ASSETS_VERSION);
  const known = catalog.scenarios.map((s) => s.id);
  if (!known.includes(scenarioId)) {
    return badRequest(`unknown scenarioId "${scenarioId}" (known: ${known.join(', ')})`);
  }

  // 1. Quota (README Q7). Not atomic with the insert: two creates racing past
  //    the last slot can overshoot by one, which the host's own capacity cap
  //    (SIM_HOST_MAX_SIMS) still bounds. Not worth a lock for a dev tool.
  const quotas = simQuotas();
  const counts = await countSimulations(auth.organizationId);
  if (counts.org >= quotas.perOrg) {
    return errorResponse(
      409,
      'SIMULATION_QUOTA_EXCEEDED',
      `This organization already has ${counts.org} simulated device(s); the limit is ${quotas.perOrg}. ` +
        'Delete one to register another.',
      { scope: 'organization', limit: quotas.perOrg, count: counts.org },
    );
  }
  if (counts.global >= quotas.global) {
    return errorResponse(
      409,
      'SIMULATION_QUOTA_EXCEEDED',
      `The simulator is at capacity (${counts.global} of ${quotas.global} simulated devices). Try again later.`,
      { scope: 'global', limit: quotas.global, count: counts.global },
    );
  }

  const model = await db.query.deviceModels.findFirst({
    where: eq(schema.deviceModels.sku, SIM_DEVICE_MODEL_SKU),
  });
  if (!model) {
    return errorResponse(500, 'SIMULATION_MODEL_MISSING', `Device model ${SIM_DEVICE_MODEL_SKU} is not seeded.`);
  }

  // 2. The device row: a normal device, flagged simulated at birth.
  const serial = simSerial();
  const config = initialSimConfig(scenarioId);
  const [device] = await db
    .insert(schema.devices)
    .values({
      workspaceId,
      deviceModelId: model.id,
      serial,
      name: requestedName ?? `Simulator ${serial}`,
      simulated: true,
      config,
      // rev 1 marks "the cloud has published a document" (claim-route
      // convention); it is published once, below, after the thing exists.
      configRev: 1,
      configUpdatedAt: new Date(),
      uiPrefs: {},
    })
    .returning();

  const createdBy = auth.userId ?? auth.apiKeyId ?? 'unknown';
  // Undo everything on a failure after the row exists. The teardown primitive
  // is the one that knows every AWS resource a device can own; it also writes
  // a tombstone, which is the honest record of a device that briefly existed.
  const rollback = async (reason: string, err: unknown) => {
    console.error('device simulation create failed; rolling back', { deviceId: device!.id, reason, err });
    await teardownDevices(
      [{ id: device!.id, workspaceId, organizationId: auth.organizationId, serial }],
      `device-simulations:rollback:${createdBy}`,
    ).catch((e) => console.error('rollback teardown failed', { deviceId: device!.id, e }));
    await deleteSimBundle(device!.id).catch(() => undefined);
    await db
      .delete(schema.devices)
      .where(eq(schema.devices.id, device!.id))
      .catch(() => undefined);
  };

  // 3. Thing, cert, policy, one KVS channel per camera of the model.
  let result: ProvisionResult;
  try {
    result = await provisionDevice(device!, model);
  } catch (err) {
    await rollback('provision', err);
    return errorResponse(502, 'SIMULATION_PROVISION_FAILED', 'Provisioning the simulated device failed. Try again.');
  }

  // 4. Publish AFTER the thing exists: this is what writes the thing's scope
  //    attributes (backend-brief gotcha 8), and the retained document carries
  //    the scenario + cam1:false before the container ever connects. Not
  //    fatal: the agent's first report (rev 0 < 1) triggers a republish.
  try {
    await publishDeviceConfig(device!.id, device!.config, device!.configRev);
  } catch (err) {
    console.error('initial sim config publish failed', { deviceId: device!.id, err });
  }

  // 5. The bundle. Fatal: the private key exists nowhere else, so a sim whose
  //    secret did not land can never connect.
  try {
    await writeSimBundle(buildSimBundle(device!.id, result));
  } catch (err) {
    await rollback('bundle secret', err);
    return errorResponse(502, 'SIMULATION_PROVISION_FAILED', 'Storing the simulated device credentials failed. Try again.');
  }

  // 6. Desired state for the host; it picks the sim up within one pass.
  let sim;
  try {
    [sim] = await db
      .insert(schema.deviceSimulations)
      .values({ deviceId: device!.id, scenarioId, desiredState: 'running', createdBy })
      .returning();
  } catch (err) {
    await rollback('simulation row', err);
    throw err;
  }

  return created({ device: deviceResponse(device!), simulation: simulationView(sim!, device!.config) });
}

export const handler = apiHandler(restHandler);

import { requestPath } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';
import {
  ASSETS_VERSION_PATTERN,
  currentScenarioId,
  HOST_STATES,
  presignAssetPack,
  readSimBundle,
  SIM_ASSETS_VERSION,
} from '../services/device-simulations';
import { badRequest, errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

/**
 * The sim-host plane (plans/xorgate-device-simulator, README §3.5, Q10).
 *
 * Served by ONE `ANY /sim-hosts/{proxy+}` route (see api-stack.ts) and
 * dispatched here on the request path:
 *
 *   GET  /sim-hosts/desired            → {sims:[{deviceId, scenarioId, desiredState, assetsVersion, startRequestedAt?}]}
 *   GET  /sim-hosts/scenarios?assetsVersion=v1
 *                                      → {assetsVersion, expiresAt, files:{"<relPath>": "<presigned GET>"}}
 *   GET  /sim-hosts/bundles/{deviceId} → the provision bundle (Secrets Manager)
 *   POST /sim-hosts/heartbeat          ← {v:1, hostId, …, sims:[{deviceId, hostState, message, …}]}
 *
 * The shapes are the ones `device/xorgate-sim-host` already calls
 * (`src/source/http.ts`, `src/types.ts`); change both together.
 *
 * Authenticated ONLY by the dedicated `SIM_HOST_TOKEN` — a bearer that names no
 * user and no organization, because a host runs every organization's sims.
 * It lives in Secrets Manager (`SIM_HOST_TOKEN_SECRET`), is rotated by hand,
 * and no other route accepts it; conversely these routes accept nothing else,
 * so a stolen user token cannot read a sim's private key. During a rotation the
 * secret may hold `{"current": "...", "previous": "..."}` so the host can be
 * switched over without downtime; a plain string is a single token.
 *
 * v1 runs ONE host per stage (README §3.5), so `desired` lists every sim of the
 * stage and there is no assignment. A second live host reporting a sim another
 * host reported within HOST_OWNERSHIP_MS is logged and its report dropped —
 * visible, not silently re-assigned. Multi-host scheduling is a Fargate-era
 * follow-up.
 */

const sm = new SecretsManagerClient({});
const TOKEN_SECRET = process.env.SIM_HOST_TOKEN_SECRET ?? 'xorgate/sim-host-token';
/** A rotated token is picked up by every warm container within this long. */
const TOKEN_CACHE_MS = 5 * 60 * 1000;
/** A host that reported a sim this recently owns it; another host's report is dropped. */
export const HOST_OWNERSHIP_MS = 2 * 60 * 1000;
const HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_MAX = 1000;

let tokenCache: { digests: Buffer[]; at: number } | null = null;

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

async function acceptedTokenDigests(): Promise<Buffer[]> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.digests;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: TOKEN_SECRET }));
  const raw = (res.SecretString ?? '').trim();
  let tokens: string[] = [raw];
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { current?: unknown; previous?: unknown };
    tokens = [parsed.current, parsed.previous].filter((t): t is string => typeof t === 'string');
  }
  // A short token is a configuration mistake, never a credential.
  const digests = tokens.map((t) => t.trim()).filter((t) => t.length >= 32).map(digest);
  tokenCache = { digests, at: Date.now() };
  return digests;
}

type HostAuth = { hostId: string } | { error: APIGatewayProxyResultV2 };

async function authenticateHost(event: APIGatewayProxyEventV2): Promise<HostAuth> {
  const header = event.headers['authorization'] ?? event.headers['Authorization'] ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) {
    return { error: errorResponse(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header') };
  }
  let accepted: Buffer[];
  try {
    accepted = await acceptedTokenDigests();
  } catch (err) {
    console.error('sim-hosts: cannot read the host token secret', { secret: TOKEN_SECRET, err });
    return { error: errorResponse(503, 'SIM_HOST_TOKEN_UNAVAILABLE', 'The sim-host token is not configured.') };
  }
  const got = digest(presented);
  // Compare against every accepted digest without short-circuiting.
  let match = false;
  for (const d of accepted) match = timingSafeEqual(d, got) || match;
  if (!match) return { error: errorResponse(401, 'UNAUTHORIZED', 'Invalid sim-host token') };

  const hostId = (event.headers['x-sim-host-id'] ?? event.headers['X-Sim-Host-Id'] ?? '').trim();
  if (!HOST_ID_PATTERN.test(hostId)) {
    return { error: badRequest('X-Sim-Host-Id header is required ([A-Za-z0-9._:-], at most 64 characters)') };
  }
  return { hostId };
}

const heartbeatSchema = z
  .object({
    v: z.literal(1),
    hostId: z.string(),
    stage: z.string().optional(),
    version: z.string().optional(),
    reportedAt: z.number().optional(),
    capacity: z.object({ max: z.number(), running: z.number() }).partial().optional(),
    assets: z.record(z.object({ state: z.string(), message: z.string() }).partial()).optional(),
    sims: z
      .array(
        z
          .object({
            deviceId: z.string(),
            hostState: z.enum(HOST_STATES),
            message: z.string().optional().default(''),
            containerId: z.string().optional(),
            startedAt: z.number().optional(),
          })
          .passthrough(),
      )
      .max(500),
  })
  .passthrough();

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  // One `ANY /sim-hosts/{proxy+}` route serves the whole plane (the API stack
  // is at the CloudFormation resource limit), so dispatch on the real path.
  // Authenticate FIRST: an unauthenticated caller learns nothing, not even
  // which sub-paths exist.
  const sub = requestPath(event).replace(/^\/sim-hosts\/?/, '').replace(/\/+$/, '');
  const bundleMatch = /^bundles\/([^/]+)$/.exec(sub);
  const routeKey = `${method} /sim-hosts/${bundleMatch ? 'bundles/{deviceId}' : sub}`;

  const auth = await authenticateHost(event);
  if ('error' in auth) return auth.error;
  const { hostId } = auth;

  if (routeKey === 'GET /sim-hosts/desired') {
    const rows = await db
      .select({ sim: schema.deviceSimulations, config: schema.devices.config })
      .from(schema.deviceSimulations)
      .innerJoin(schema.devices, eq(schema.devices.id, schema.deviceSimulations.deviceId))
      .where(eq(schema.devices.simulated, true))
      .orderBy(schema.deviceSimulations.createdAt);
    return ok({
      sims: rows.map(({ sim, config }) => ({
        deviceId: sim.deviceId,
        scenarioId: currentScenarioId(config, sim),
        desiredState: sim.desiredState,
        assetsVersion: SIM_ASSETS_VERSION,
        ...(sim.startRequestedAt ? { startRequestedAt: new Date(sim.startRequestedAt).getTime() } : {}),
      })),
    });
  }

  if (routeKey === 'GET /sim-hosts/scenarios') {
    const version = event.queryStringParameters?.assetsVersion ?? SIM_ASSETS_VERSION;
    if (!ASSETS_VERSION_PATTERN.test(version)) return badRequest('assetsVersion must look like v1');
    const pack = await presignAssetPack(version);
    if (Object.keys(pack.files).length === 0) return notFound(`No asset pack demo-assets/${version}/`);
    return ok({ assetsVersion: version, expiresAt: pack.expiresAt, files: pack.files });
  }

  if (routeKey === 'GET /sim-hosts/bundles/{deviceId}') {
    let deviceId = '';
    try {
      deviceId = decodeURIComponent(bundleMatch![1]);
    } catch {
      // A malformed escape is not an id; fall through to the 404 below.
    }
    if (!UUID_PATTERN.test(deviceId)) return notFound(`Simulation "${deviceId}" not found`);
    // Only a live simulation's bundle: the secret is deleted with the device,
    // and this keeps a half-torn-down one from being served in between.
    const sim = await db.query.deviceSimulations.findFirst({
      where: eq(schema.deviceSimulations.deviceId, deviceId),
      columns: { deviceId: true },
    });
    if (!sim) return notFound(`Simulation "${deviceId}" not found`);
    const bundle = await readSimBundle(deviceId);
    if (!bundle) return notFound(`No bundle stored for simulation "${deviceId}"`);
    console.log('sim-hosts: bundle served', { deviceId, hostId });
    return ok(bundle);
  }

  if (routeKey === 'POST /sim-hosts/heartbeat') {
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return badRequest('Invalid JSON body');
    }
    const parsed = heartbeatSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return badRequest(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    const report = parsed.data;
    if (report.hostId !== hostId) return badRequest('hostId does not match the X-Sim-Host-Id header');

    let accepted = 0;
    const unknown: string[] = [];
    const conflicts: string[] = [];
    const now = new Date();
    for (const sim of report.sims) {
      if (!UUID_PATTERN.test(sim.deviceId)) {
        unknown.push(sim.deviceId);
        continue;
      }
      const updated = await db
        .update(schema.deviceSimulations)
        .set({
          hostId,
          hostState: sim.hostState,
          hostMessage: sim.message.slice(0, MESSAGE_MAX),
          hostReportedAt: now,
        })
        .where(
          and(
            eq(schema.deviceSimulations.deviceId, sim.deviceId),
            // Another host that reported this sim recently still owns it.
            sql`NOT coalesce(${schema.deviceSimulations.hostId} <> ${hostId} AND ${schema.deviceSimulations.hostReportedAt} > ${new Date(now.getTime() - HOST_OWNERSHIP_MS).toISOString()}::timestamptz, false)`,
          ),
        )
        .returning({ deviceId: schema.deviceSimulations.deviceId });
      if (updated.length > 0) {
        accepted += 1;
        continue;
      }
      const owned = await db.query.deviceSimulations.findFirst({
        where: and(
          eq(schema.deviceSimulations.deviceId, sim.deviceId),
          ne(schema.deviceSimulations.hostId, hostId),
          gt(schema.deviceSimulations.hostReportedAt, new Date(now.getTime() - HOST_OWNERSHIP_MS)),
        ),
        columns: { hostId: true },
      });
      if (owned) {
        conflicts.push(sim.deviceId);
        console.warn('sim-hosts: two hosts report the same sim; keeping the current owner', {
          deviceId: sim.deviceId,
          owner: owned.hostId,
          reporter: hostId,
        });
      } else {
        unknown.push(sim.deviceId);
      }
    }
    console.log('sim-hosts: heartbeat', {
      hostId,
      stage: report.stage,
      version: report.version,
      capacity: report.capacity,
      assets: report.assets,
      sims: report.sims.length,
      accepted,
      unknown: unknown.length,
      conflicts: conflicts.length,
    });
    return ok({ accepted, unknown, conflicts });
  }

  const known = ['desired', 'scenarios', 'heartbeat'].includes(sub) || bundleMatch;
  if (known) return methodNotAllowed(method, sub === 'heartbeat' ? 'POST' : 'GET');
  return notFound('Route not found');
};

export const handler = apiHandler(restHandler);

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import type { DeviceSimulation } from '../db/schema';
import type { ProvisionResult } from './iot-provisioning';
import { SIMULATION_SCENARIO_ID_PATTERN } from '../config-registry/simulation';

/**
 * The device simulator's cloud half (plans/xorgate-device-simulator, Phase 3).
 *
 * A simulated device is a NORMAL device row (`devices.simulated = true`) with a
 * normal IoT thing, cert and KVS channels; the container that plays it runs on
 * a sim host, which needs the one thing a real device keeps on its own disk:
 * the provision bundle. That bundle lives in Secrets Manager under
 * `xorgate/sim-devices/<deviceId>` — written once at create, read by the host
 * through `GET /sim-hosts/bundles/{id}`, deleted by device teardown.
 *
 * Scenario assets are NOT copied per sim: every sim replays from the shared,
 * non-expiring `demo-assets/<version>/` prefix of the core bucket, which the
 * host caches once and verifies against the pins in `catalog.json`.
 */

const s3 = new S3Client({});
const sm = new SecretsManagerClient({});

export const SIM_SECRET_PREFIX = 'xorgate/sim-devices/';
export const DEMO_ASSETS_PREFIX = 'demo-assets/';
/** The asset pack sims replay from today. A new pack is a new prefix, never an overwrite. */
export const SIM_ASSETS_VERSION = 'v1';
export const ASSETS_VERSION_PATTERN = /^v[0-9]{1,4}$/;
/** Argus CM5 Rev1 — the model the footage was recorded on (README Q3). */
export const SIM_DEVICE_MODEL_SKU = 'XG-RPI-REF-1';
/** Presigned URL lifetime for scenario assets and thumbnails. */
export const SIM_ASSET_URL_TTL_SECONDS = 3600;

export const HOST_STATES = ['pending', 'starting', 'running', 'stopped', 'error'] as const;
export type HostState = (typeof HOST_STATES)[number];
export const DESIRED_STATES = ['running', 'stopped'] as const;
export type DesiredState = (typeof DESIRED_STATES)[number];

function bucket(): string {
  const name = process.env.BUCKET_NAME;
  if (!name) throw new Error('BUCKET_NAME env var is not set');
  return name;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * README Q7: 2 per organization, 8 across the stage (the homelab's capacity).
 * Overridable per stage through `SIM_QUOTA_PER_ORG` / `SIM_QUOTA_GLOBAL`.
 */
export function simQuotas(): { perOrg: number; global: number } {
  return { perOrg: envInt('SIM_QUOTA_PER_ORG', 2), global: envInt('SIM_QUOTA_GLOBAL', 8) };
}

/** `SIM-` + 8 hex: unique per workspace like any serial, and obviously not hardware. */
export function simSerial(random: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += Math.floor(random() * 16).toString(16);
  return `SIM-${hex}`;
}

// ---------------------------------------------------------------------------
// Provision bundle (Secrets Manager)

/**
 * Exactly what `xorgate-sim-host` writes into a sim's `/creds` (its
 * `src/types.ts` SimBundle): cert + key, the MQTT endpoint, and the `kvs.json`
 * manifest the agent reads (region, credential endpoint, role alias,
 * channels). `caPem` is omitted: the host fetches the public Amazon root CA.
 */
export interface SimBundle {
  deviceId: string;
  iotDataEndpoint: string;
  uploadBucket?: string;
  certificatePem: string;
  privateKey: string;
  kvs: {
    region: string;
    credentialEndpoint: string;
    roleAlias: string;
    channels: { streamKey: string; channelName: string; channelArn: string }[];
  };
}

export function simSecretName(deviceId: string): string {
  return `${SIM_SECRET_PREFIX}${deviceId}`;
}

export function buildSimBundle(deviceId: string, result: ProvisionResult): SimBundle {
  const uploadBucket = process.env.BUCKET_NAME;
  return {
    deviceId,
    iotDataEndpoint: result.dataEndpoint,
    ...(uploadBucket ? { uploadBucket } : {}),
    certificatePem: result.certificatePem,
    privateKey: result.privateKey,
    kvs: {
      region: result.region,
      credentialEndpoint: result.credentialEndpoint,
      roleAlias: result.roleAlias,
      channels: result.channels.map((c) => ({
        streamKey: c.streamKey,
        channelName: c.channelName,
        channelArn: c.channelArn,
      })),
    },
  };
}

export async function writeSimBundle(bundle: SimBundle): Promise<void> {
  const name = simSecretName(bundle.deviceId);
  const value = JSON.stringify(bundle);
  try {
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: value }));
  } catch (err) {
    // Device ids are fresh uuids, so this is a retried create at most.
    if ((err as { name?: string }).name !== 'ResourceExistsException') throw err;
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  }
}

function isSecretGone(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  if (e.name === 'ResourceNotFoundException') return true;
  return e.name === 'InvalidRequestException' && /deletion/i.test(e.message ?? '');
}

/** The stored bundle, or null when the secret does not exist. */
export async function readSimBundle(deviceId: string): Promise<SimBundle | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: simSecretName(deviceId) }));
    return res.SecretString ? (JSON.parse(res.SecretString) as SimBundle) : null;
  } catch (err) {
    if (isSecretGone(err)) return null;
    throw err;
  }
}

/** Idempotent. Immediate (no recovery window): the key must not outlive its cert. */
export async function deleteSimBundle(deviceId: string): Promise<void> {
  try {
    await sm.send(
      new DeleteSecretCommand({ SecretId: simSecretName(deviceId), ForceDeleteWithoutRecovery: true }),
    );
  } catch (err) {
    if (!isSecretGone(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Scenario catalog (demo-assets/<version>/catalog.json)

export interface CatalogScenario {
  id: string;
  title: string;
  description?: string;
  durationMs?: number;
  thumbnail?: string;
  insights?: Record<string, unknown>;
  streams?: { streamKey: string; width?: number; height?: number; fps?: number }[];
}

export interface Catalog {
  v: number;
  seedSet?: string[];
  scenarios: CatalogScenario[];
}

/** Process-lifetime cache: a pack version is immutable once published. */
const catalogCache = new Map<string, Catalog>();

export async function readCatalog(version: string = SIM_ASSETS_VERSION): Promise<Catalog> {
  const cached = catalogCache.get(version);
  if (cached) return cached;
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket(), Key: `${DEMO_ASSETS_PREFIX}${version}/catalog.json` }),
  );
  const text = await res.Body!.transformToString();
  const parsed = JSON.parse(text) as Catalog;
  if (!parsed || !Array.isArray(parsed.scenarios)) {
    throw new Error(`demo-assets/${version}/catalog.json has no scenarios array`);
  }
  catalogCache.set(version, parsed);
  return parsed;
}

/** The console's view of one scenario: catalog facts + a presigned thumbnail. */
export interface ScenarioView {
  id: string;
  title: string;
  description: string | null;
  durationMs: number | null;
  distanceM: number | null;
  maxKph: number | null;
  streams: { streamKey: string; width: number | null; height: number | null; fps: number | null }[];
  thumbnailUrl: string | null;
}

export async function scenarioViews(
  catalog: Catalog,
  version: string = SIM_ASSETS_VERSION,
): Promise<ScenarioView[]> {
  return Promise.all(
    catalog.scenarios
      .filter((s) => typeof s.id === 'string' && SIMULATION_SCENARIO_ID_PATTERN.test(s.id))
      .map(async (s) => {
        const insights = (s.insights ?? {}) as { distanceM?: unknown; maxKph?: unknown };
        const thumbnailUrl =
          typeof s.thumbnail === 'string' && !s.thumbnail.includes('..')
            ? await presignAsset(version, s.thumbnail)
            : null;
        return {
          id: s.id,
          title: s.title ?? s.id,
          description: s.description ?? null,
          durationMs: typeof s.durationMs === 'number' ? s.durationMs : null,
          distanceM: typeof insights.distanceM === 'number' ? insights.distanceM : null,
          maxKph: typeof insights.maxKph === 'number' ? insights.maxKph : null,
          streams: (s.streams ?? []).map((st) => ({
            streamKey: st.streamKey,
            width: st.width ?? null,
            height: st.height ?? null,
            fps: st.fps ?? null,
          })),
          thumbnailUrl,
        };
      }),
  );
}

export function presignAsset(version: string, relPath: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket(), Key: `${DEMO_ASSETS_PREFIX}${version}/${relPath}` }),
    { expiresIn: SIM_ASSET_URL_TTL_SECONDS },
  );
}

/**
 * A presigned GET for EVERY object of a pack, keyed by its path under
 * `demo-assets/<version>/` (catalog.json included). The host verifies each file
 * against the pins in the catalog and scenario manifests, so this needs no
 * integrity logic of its own. 251 objects today; presigning is local signing,
 * not a request per object.
 */
export async function presignAssetPack(
  version: string,
): Promise<{ files: Record<string, string>; expiresAt: number }> {
  const prefix = `${DEMO_ASSETS_PREFIX}${version}/`;
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  // Stamped before signing, so the advertised expiry is never later than the real one.
  const expiresAt = Date.now() + SIM_ASSET_URL_TTL_SECONDS * 1000;
  const entries = await Promise.all(
    keys.map(async (key) => [key.slice(prefix.length), await presignAsset(version, key.slice(prefix.length))] as const),
  );
  return { files: Object.fromEntries(entries), expiresAt };
}

// ---------------------------------------------------------------------------
// Rows

/** How many simulations exist in an organization, and in the whole stage. */
export async function countSimulations(organizationId: string): Promise<{ org: number; global: number }> {
  const [row] = await db
    .select({
      global: sql<number>`count(*)::int`,
      org: sql<number>`count(*) filter (where ${schema.workspaces.organizationId} = ${organizationId}::uuid)::int`,
    })
    .from(schema.deviceSimulations)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.deviceSimulations.deviceId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.devices.workspaceId));
  return { org: Number(row?.org ?? 0), global: Number(row?.global ?? 0) };
}

/** The scenario a sim is on NOW: its `simulation` namespace, else what it was created with. */
export function currentScenarioId(
  config: unknown,
  sim: Pick<DeviceSimulation, 'scenarioId'>,
): string {
  const ns = (config as { simulation?: { scenarioId?: unknown } | null } | null)?.simulation;
  return typeof ns?.scenarioId === 'string' ? ns.scenarioId : sim.scenarioId;
}

export interface SimulationView {
  deviceId: string;
  /** The live scenario (the `simulation` namespace), falling back to the creation pick. */
  scenarioId: string;
  desiredState: DesiredState;
  startRequestedAt: string | null;
  hostId: string | null;
  hostState: HostState;
  hostMessage: string | null;
  hostReportedAt: string | null;
  createdBy: string;
  createdAt: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

export function simulationView(sim: DeviceSimulation, config: unknown): SimulationView {
  return {
    deviceId: sim.deviceId,
    scenarioId: currentScenarioId(config, sim),
    desiredState: sim.desiredState as DesiredState,
    startRequestedAt: iso(sim.startRequestedAt),
    hostId: sim.hostId,
    hostState: sim.hostState as HostState,
    hostMessage: sim.hostMessage,
    hostReportedAt: iso(sim.hostReportedAt),
    createdBy: sim.createdBy,
    createdAt: iso(sim.createdAt)!,
  };
}

/** Device + simulation rows for the given device ids, scoped to the caller's workspaces. */
export async function findSimulation(
  deviceId: string,
  workspaceIds: string[],
): Promise<{ device: typeof schema.devices.$inferSelect; sim: DeviceSimulation } | null> {
  if (workspaceIds.length === 0) return null;
  const rows = await db
    .select({ device: schema.devices, sim: schema.deviceSimulations })
    .from(schema.deviceSimulations)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.deviceSimulations.deviceId))
    .where(
      and(eq(schema.deviceSimulations.deviceId, deviceId), inArray(schema.devices.workspaceId, workspaceIds)),
    )
    .limit(1);
  return rows[0] ?? null;
}

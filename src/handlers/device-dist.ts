import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import type { OrgAuthContext } from '../types/index';
import { errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';
import {
  type AgentKind,
  isAgentKind,
  rustRegistrationEnabled,
  rustRegistrationFlag,
} from '../services/device-agent';
import { resolveWorkspaceScope } from '../services/workspace-scope';

/**
 * GET /device-dist/latest — what the newest published agent build IS
 * (device_update_management, Phase 2 / README §2.5).
 *
 * Serves `latest.json`, written by the device-agent CI in the same step as the
 * `xorgate-agent-latest.tar.gz` alias, so the manifest always describes exactly
 * what a `xorgate update` would install. The frontend diffs its `version`
 * against the build a device reports (`effective.agent.build.version`) to show
 * "Update available" — a plain string comparison, never an ordering: shas do not
 * sort, and a prod release tag and a dev sha are not comparable anyway.
 *
 * Read via the S3 SDK with an IAM grant scoped to this one key rather than by
 * HTTPS-fetching the public URL like the device does — the endpoint keeps
 * working if the dist bucket is ever made private, and it does not depend on
 * the Lambda having egress to the public internet.
 *
 * Access is any authenticated org member: the payload is a build number for
 * software whose bucket is public-read. `404` means CI has not published a
 * manifest yet (stage bootstrapped before this plan shipped), which the
 * frontend renders as "latest unknown" — the update button still works, it just
 * cannot advertise an available update.
 */

const s3 = new S3Client({});
const BUCKET = process.env.DEVICE_DIST_BUCKET ?? '';
const KEY = 'latest.json';

/**
 * The manifest key per agent (dual-agent registration D3). The Rust CI writes
 * `latest-rs.json` with the same five fields, last, after its tarball + sidecar.
 */
const AGENT_KEYS: Record<AgentKind, string> = { js: KEY, rust: 'latest-rs.json' };

/** Bounded so a wrong/oversized object can't be streamed into memory wholesale. */
const MAX_MANIFEST_BYTES = 8_192;

interface LatestBuild {
  version: string;
  channel: string | null;
  builtAt: string | null;
  packageVersion: string | null;
  tarball: string | null;
}

type ManifestRead =
  | { kind: 'ok'; latest: LatestBuild }
  | { kind: 'absent' }
  | { kind: 'error'; response: APIGatewayProxyResultV2 };

async function readManifest(key: string): Promise<ManifestRead> {
  let body: string;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    body = (await res.Body?.transformToString()) ?? '';
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return { kind: 'absent' };
    console.error('device-dist: reading the manifest failed', { bucket: BUCKET, key, err });
    return {
      kind: 'error',
      response: errorResponse(
        502,
        'DIST_MANIFEST_UNAVAILABLE',
        'Could not read the latest agent build manifest.',
      ),
    };
  }

  if (body.length === 0 || body.length > MAX_MANIFEST_BYTES) {
    console.error('device-dist: manifest is empty or oversized', { key, bytes: body.length });
    return { kind: 'error', response: invalidManifest() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error('device-dist: manifest is not valid JSON', { key });
    return { kind: 'error', response: invalidManifest() };
  }

  const manifest = parsed as Record<string, unknown>;
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (version.length === 0) {
    console.error('device-dist: manifest carries no version', { key });
    return { kind: 'error', response: invalidManifest() };
  }

  return {
    kind: 'ok',
    latest: {
      version,
      channel: str(manifest.channel),
      builtAt: str(manifest.builtAt),
      packageVersion: str(manifest.packageVersion),
      tarball: str(manifest.tarball),
    },
  };
}

function invalidManifest(): APIGatewayProxyResultV2 {
  return errorResponse(502, 'DIST_MANIFEST_INVALID', 'The agent build manifest is unreadable.');
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method !== 'GET') {
    return methodNotAllowed(event.requestContext.http.method, 'GET');
  }

  let auth;
  try {
    auth = await requireOrgWideContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  // `?agent=` selects the self-describing channel response. Its ABSENCE keeps
  // today's response, status and body byte for byte: Alocate's backend, mobile
  // and web read the no-parameter route as "the JS agent's latest".
  const query = event.queryStringParameters ?? {};
  const agentParam = Object.prototype.hasOwnProperty.call(query, 'agent') ? query.agent : undefined;
  if (agentParam !== undefined && !isAgentKind(agentParam)) {
    return errorResponse(400, 'INVALID_AGENT', 'agent must be "js" or "rust"');
  }

  if (!BUCKET) {
    console.error('device-dist: DEVICE_DIST_BUCKET is not configured');
    return errorResponse(
      500,
      'DIST_BUCKET_UNCONFIGURED',
      'The device distribution bucket is not configured for this stage.',
    );
  }

  if (agentParam === undefined) {
    const read = await readManifest(KEY);
    if (read.kind === 'absent') return notFound('No published agent build manifest yet');
    if (read.kind === 'error') return read.response;
    return ok({ latest: read.latest });
  }

  // The channel response (dual-agent registration D3): always names its agent,
  // so a console talking to an OLD backend (which ignores `?agent=` and answers
  // with the JS shape above) can tell. An unpublished manifest is `latest: null`
  // with 200, never a 404. Genuine read failures keep the 5xx codes above.
  const agent: AgentKind = agentParam;
  const read = await readManifest(AGENT_KEYS[agent]);
  if (read.kind === 'error') return read.response;
  return ok({
    agent,
    latest: read.kind === 'ok' ? read.latest : null,
    registrationEnabled: agent === 'js' ? true : await rustEnabledFor(event, auth),
  });
};

/**
 * `registrationEnabled` for Rust: the stage flag, evaluated for the caller's
 * `X-Workspace-Id`. The General tab sends none (an org-wide call), and only
 * `on` enables that case. An allow-list counts the header only when the
 * workspace really belongs to the caller's organization, so this cannot be used
 * to probe which workspace ids are allow-listed.
 */
async function rustEnabledFor(event: APIGatewayProxyEventV2, auth: OrgAuthContext): Promise<boolean> {
  const flag = rustRegistrationFlag();
  if (flag.mode !== 'allow') return rustRegistrationEnabled(flag, null);
  const workspaceId = event.headers?.['x-workspace-id'] ?? event.headers?.['X-Workspace-Id'];
  if (!workspaceId) return false;
  const visible = await resolveWorkspaceScope(auth);
  if (!visible.includes(workspaceId)) return false;
  return rustRegistrationEnabled(flag, workspaceId);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export const handler = apiHandler(restHandler);

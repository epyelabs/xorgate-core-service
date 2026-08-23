import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

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

/** Bounded so a wrong/oversized object can't be streamed into memory wholesale. */
const MAX_MANIFEST_BYTES = 8_192;

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method !== 'GET') {
    return methodNotAllowed(event.requestContext.http.method, 'GET');
  }

  try {
    await requireOrgWideContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  if (!BUCKET) {
    console.error('device-dist: DEVICE_DIST_BUCKET is not configured');
    return errorResponse(
      500,
      'DIST_BUCKET_UNCONFIGURED',
      'The device distribution bucket is not configured for this stage.',
    );
  }

  let body: string;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
    body = (await res.Body?.transformToString()) ?? '';
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') {
      return notFound('No published agent build manifest yet');
    }
    console.error('device-dist: reading the manifest failed', { bucket: BUCKET, key: KEY, err });
    return errorResponse(
      502,
      'DIST_MANIFEST_UNAVAILABLE',
      'Could not read the latest agent build manifest.',
    );
  }

  if (body.length === 0 || body.length > MAX_MANIFEST_BYTES) {
    console.error('device-dist: manifest is empty or oversized', { bytes: body.length });
    return errorResponse(502, 'DIST_MANIFEST_INVALID', 'The agent build manifest is unreadable.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error('device-dist: manifest is not valid JSON');
    return errorResponse(502, 'DIST_MANIFEST_INVALID', 'The agent build manifest is unreadable.');
  }

  const manifest = parsed as Record<string, unknown>;
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (version.length === 0) {
    console.error('device-dist: manifest carries no version');
    return errorResponse(502, 'DIST_MANIFEST_INVALID', 'The agent build manifest is unreadable.');
  }

  return ok({
    latest: {
      version,
      channel: str(manifest.channel),
      builtAt: str(manifest.builtAt),
      packageVersion: str(manifest.packageVersion),
      tarball: str(manifest.tarball),
    },
  });
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export const handler = apiHandler(restHandler);

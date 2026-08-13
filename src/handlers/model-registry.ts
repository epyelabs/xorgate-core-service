import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { methodNotAllowed, ok } from '../utils/responses';
import { MODEL_REGISTRY_PREFIX, type ModelManifest } from '../workflows/models/registry';
import { listModelManifests } from '../workflows/models/store';

/**
 * GET /model-registry — the S3 model registry (architecture.md §6) as JSON:
 * every models/<family>/<name>/<version>/manifest.json on the core bucket,
 * newest version first per model. Feeds the model-picker options in node
 * config forms; the engine resolves the same manifests at run time.
 *
 * Unlike the catalog (static per deployment) the registry changes when the
 * export CI publishes, so this lists S3 per cold container with a short
 * in-memory TTL instead of an ETag freeze.
 */

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; models: ModelManifest[] } | null = null;

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'GET') return methodNotAllowed(method, 'GET');

  try {
    await requireOrgWideContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  if (!BUCKET) throw new Error('model-registry: BUCKET_NAME unset');

  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    cache = { at: Date.now(), models: await listModelManifests(s3, BUCKET) };
  }
  return ok({ prefix: MODEL_REGISTRY_PREFIX, models: cache.models });
};

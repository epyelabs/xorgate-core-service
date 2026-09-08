import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { methodNotAllowed } from '../utils/responses';
import { platformCatalogPayload } from '../workflows/catalog';
import { apiHandler } from '../utils/api-handler';

/**
 * GET /workflow-catalog — the served node catalog (architecture.md §3.1): the
 * declarative half of every NodeTypeDef with config zod serialized to JSON
 * Schema. The FE palette, config forms, and edge validation derive from this;
 * publish validation derives from the same catalog instance server-side
 * (workflows/catalog.ts, the engine package's core catalog).
 *
 * The payload is static per deployment: computed once per cold start, ETag'd
 * with its content hash so repeat fetches are 304s.
 */

const payload = platformCatalogPayload;
const body = JSON.stringify(payload);
const etag = `"${payload.catalogVersion}"`;

const restHandler = async (
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

  const ifNoneMatch = event.headers['if-none-match'] ?? event.headers['If-None-Match'];
  if (ifNoneMatch?.includes(payload.catalogVersion)) {
    return { statusCode: 304, headers: { ETag: etag } };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      ETag: etag,
      // Clients must revalidate, but revalidation is a cheap 304.
      'Cache-Control': 'no-cache',
    },
    body,
  };
};

export const handler = apiHandler(restHandler);

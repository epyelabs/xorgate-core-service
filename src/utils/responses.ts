import { gzipSync } from 'node:zlib';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getRequestId } from './request-context';

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): APIGatewayProxyResultV2 {
  // The gateway request id, when the invocation came through utils/api-handler.
  // In the body (not only a header) so a consumer can quote it in a support
  // ticket from whatever their HTTP client logged.
  const requestId = getRequestId();
  const error: Record<string, unknown> = { code, message };
  if (details) error.details = details;
  if (requestId) error.requestId = requestId;
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error }),
  };
}

export function badRequest(message: string): APIGatewayProxyResultV2 {
  return errorResponse(400, 'BAD_REQUEST', message);
}

export function forbidden(message = 'Forbidden'): APIGatewayProxyResultV2 {
  return errorResponse(403, 'FORBIDDEN', message);
}

export function notFound(message: string): APIGatewayProxyResultV2 {
  return errorResponse(404, 'NOT_FOUND', message);
}

export function conflict(message: string): APIGatewayProxyResultV2 {
  return errorResponse(409, 'CONFLICT', message);
}

export function ok<T>(body: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function created<T>(body: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * 202: handed off, outcome not yet known. Used by device commands — the publish
 * succeeded, but whether the device acts on it is observed separately (it goes
 * offline, then comes back).
 */
export function accepted<T>(body: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function methodNotAllowed(method: string, allowed: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 405,
    headers: { 'Content-Type': 'application/json', Allow: allowed },
    body: JSON.stringify({
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${method} not allowed` },
    }),
  };
}

/** Bodies under this size are not worth the CPU or the base64 inflation. */
export const GZIP_MIN_BYTES = 1024;

/**
 * Gzip a JSON response when the caller can take it (telemetry-session-
 * artifacts plan, README D11). HTTP APIs have no compression setting, so the
 * function does it: `isBase64Encoded: true` + `Content-Encoding: gzip`, which
 * API Gateway passes through and every fetch() (browser, Node, RN) inflates
 * natively. `Vary: Accept-Encoding` so a shared cache keys both forms.
 *
 * Only for a 2xx string body at or above GZIP_MIN_BYTES that is not already
 * encoded; everything else is returned untouched. Measured on the Telemetry
 * History table (README §2.4): 141 814 B flat -> 7 302 B, about 19x.
 */
export function gzipIfAccepted(
  event: Pick<APIGatewayProxyEventV2, 'headers'>,
  result: APIGatewayProxyResultV2,
): APIGatewayProxyResultV2 {
  if (typeof result !== 'object' || result === null) return result;
  const r = result as APIGatewayProxyStructuredResultV2;
  if (typeof r.body !== 'string' || r.isBase64Encoded) return result;
  if ((r.statusCode ?? 200) < 200 || (r.statusCode ?? 200) >= 300) return result;
  if (Buffer.byteLength(r.body) < GZIP_MIN_BYTES) return result;
  const headers = r.headers ?? {};
  if (Object.keys(headers).some((k) => k.toLowerCase() === 'content-encoding')) return result;
  if (!acceptsGzip(event.headers)) return result;
  return {
    ...r,
    isBase64Encoded: true,
    body: gzipSync(r.body).toString('base64'),
    headers: { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' },
  };
}

/** `Accept-Encoding` lists gzip (or `*`) with a non-zero q. */
export function acceptsGzip(headers: APIGatewayProxyEventV2['headers'] | undefined): boolean {
  if (!headers) return false;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'accept-encoding');
  const raw = key ? headers[key] : undefined;
  if (!raw) return false;
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().split(';').map((p) => p.trim());
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

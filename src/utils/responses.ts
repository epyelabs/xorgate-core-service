import type { APIGatewayProxyResultV2 } from 'aws-lambda';
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

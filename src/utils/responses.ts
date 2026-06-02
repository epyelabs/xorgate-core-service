import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: details ? { code, message, details } : { code, message },
    }),
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

export function methodNotAllowed(method: string, allowed: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 405,
    headers: { 'Content-Type': 'application/json', Allow: allowed },
    body: JSON.stringify({
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${method} not allowed` },
    }),
  };
}

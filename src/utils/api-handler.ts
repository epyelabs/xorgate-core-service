import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { errorResponse } from './responses';
import { setRequestId } from './request-context';

/**
 * Wrapper for every REST-facing Lambda handler (the ones behind the HTTP API
 * route table; event-driven handlers like the ingest paths do not use it).
 *
 * Two jobs:
 *
 * 1. Stamp the invocation's request id into the ambient slot
 *    (utils/request-context.ts) so every error envelope built anywhere below
 *    carries `error.requestId`.
 * 2. Turn an unhandled throw into the uniform `{error:{...}}` envelope instead
 *    of API Gateway's bare `{"message":"Internal Server Error"}`. The code is
 *    `SERVER_ERROR`, matching the name `@xorgate/sdk` already gives an
 *    envelope-less 5xx, so consumers see one code either way. The error is
 *    logged with the request id first: that log line is what makes a quoted
 *    id findable in CloudWatch. (No Lambda-Errors alarm exists on the REST
 *    functions; only the ingest DLQs are alarmed, so catching here silences
 *    nothing that was being watched.)
 */
export function apiHandler(
  fn: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> {
  return async (event) => {
    const requestId = event.requestContext?.requestId;
    setRequestId(requestId);
    try {
      return await fn(event);
    } catch (err) {
      console.error(`[api] unhandled error (requestId ${requestId ?? 'unknown'})`, err);
      return errorResponse(500, 'SERVER_ERROR', 'Internal server error.');
    } finally {
      setRequestId(undefined);
    }
  };
}

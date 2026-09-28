import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { requestPath } from '../utils/route';

/**
 * DEV-ONLY webhook receiver (plans/xorgate-webhooks README D8). A Lambda
 * Function URL (auth NONE) deployed only when `--context webhookEcho=on`
 * (default on for dev, refused on prod by the stack), so tests never point an
 * endpoint at a public receiver. Logs each request as ONE JSON line (method,
 * path, query, headers, raw body) for assertions against CloudWatch, and
 * answers 204. `?status=<200-599>` forces that status, for retry tests.
 *
 * It does not verify signatures: it has no secret. Tests read the logged raw
 * body and headers and verify with the secret the API returned.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '';
  const requested = Number(event.queryStringParameters?.status);
  const status = Number.isInteger(requested) && requested >= 200 && requested <= 599 ? requested : 204;
  console.log(
    JSON.stringify({
      msg: 'webhook-echo',
      method: event.requestContext?.http?.method,
      path: requestPath(event),
      query: event.rawQueryString ?? '',
      headers: event.headers ?? {},
      body,
      respondedWith: status,
    }),
  );
  return { statusCode: status, body: status === 204 ? '' : JSON.stringify({ echo: true, status }) };
};

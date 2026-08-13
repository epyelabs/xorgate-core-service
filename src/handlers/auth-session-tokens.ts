import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeEndpointCommand, IoTClient } from '@aws-sdk/client-iot';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { classifyCredential } from '../services/api-key-auth';
import {
  assertWorkspaceInOrg,
  generateSessionToken,
  hashSessionToken,
  resolveTtlSeconds,
} from '../services/session-token-auth';
import {
  badRequest,
  created,
  errorResponse,
  forbidden,
  methodNotAllowed,
} from '../utils/responses';

/**
 * `POST /auth/session-tokens` — exchange an API key for a short-lived token a
 * browser or mobile app may hold.
 *
 * This is the whole third-party integration seam. The consumer's BACKEND holds
 * the `xg_` key, decides (by its own rules, about its own users, which xorgate
 * never learns) which slice of its data this end user may see, and asks for a
 * token narrowed to that slice. The token then goes to the browser, which uses
 * it as an ordinary bearer credential against the rest of this API.
 *
 * Two things are deliberately NOT accepted here:
 *
 * - **A Cognito ID token.** First-party browsers have their own plane and do not
 *   need an exchange; letting a person mint one would put a userless credential
 *   behind a user's session for no gain.
 * - **Another session token.** A token cannot mint a token. Otherwise a leaked
 *   token renews itself indefinitely and the expiry stops meaning anything,
 *   which is the entire reason the credential is short-lived.
 *
 * Both are refused on the credential's shape, before any lookup.
 */

const iotClient = new IoTClient({});

/**
 * The account-stable MQTT-over-WSS endpoint, resolved once per Lambda container.
 *
 * It rides along in the response so a third-party consumer's whole client
 * configuration is `{ baseUrl }`: the coordinates it would otherwise have to
 * hardcode arrive with the credential that authorizes them, and rotating them
 * needs no consumer redeploy. Same value `POST /devices/{id}/provision` returns
 * to a device, from the same call.
 */
let cachedRealtimeEndpoint: string | undefined;
async function realtimeEndpoint(): Promise<string> {
  if (cachedRealtimeEndpoint) return cachedRealtimeEndpoint;
  const res = await iotClient.send(
    new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }),
  );
  if (!res.endpointAddress) throw new Error('IoT data endpoint could not be resolved');
  cachedRealtimeEndpoint = res.endpointAddress;
  return cachedRealtimeEndpoint;
}

/** Test seam, and the reason the cache above is safe to keep for the container's life. */
export function resetRealtimeEndpointCache(): void {
  cachedRealtimeEndpoint = undefined;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'POST') return methodNotAllowed(method, 'POST');

  // Shape check before authentication, so the refusal is about what you sent
  // rather than about whether it verified.
  const authHeader = event.headers['authorization'] ?? event.headers['Authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const kind = classifyCredential(authHeader.slice(7));
    if (kind === 'jwt') {
      return errorResponse(
        401,
        'API_KEY_REQUIRED',
        'Minting a session token requires an API key. A signed-in user session ' +
          'already authenticates this API directly.',
      );
    }
    if (kind === 'sessionToken') {
      return errorResponse(
        401,
        'API_KEY_REQUIRED',
        'A session token cannot mint another session token. Ask the backend ' +
          'that holds your API key for a fresh one.',
      );
    }
  }

  let auth;
  try {
    // No role gate. Minting a token that is never more privileged than the key
    // itself is not an escalation, so any role a key can hold can mint one, and
    // the default `member` key — the one a consumer actually deploys — must be
    // able to. The token's own role gates are applied on each request it makes.
    auth = await requireOrgContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  // Belt and braces. The shape check above already sent every non-key credential
  // away, so this is unreachable; it exists so the insert below cannot be made
  // to write a NULL into a NOT NULL foreign key by some future refactor of the
  // check, which the compiler would otherwise let through.
  if (auth.apiKeyId === null) {
    return errorResponse(
      401,
      'API_KEY_REQUIRED',
      'Minting a session token requires an API key.',
    );
  }

  let body: { workspaceId?: unknown; ttlSeconds?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const ttl = resolveTtlSeconds(body.ttlSeconds);
  if (!ttl.ok) return badRequest(ttl.message);

  let workspaceId: string | null = null;
  if (body.workspaceId !== undefined && body.workspaceId !== null) {
    if (typeof body.workspaceId !== 'string') {
      return badRequest('workspaceId must be a string');
    }
    const rejection = await assertWorkspaceInOrg(body.workspaceId, auth.organizationId);
    if (rejection) return forbidden(rejection.message);
    workspaceId = body.workspaceId;
  }

  const plaintext = generateSessionToken();
  const expiresAt = new Date(Date.now() + ttl.ttlSeconds * 1000);

  const [row] = await db
    .insert(schema.sessionTokens)
    .values({
      hashedToken: hashSessionToken(plaintext),
      organizationId: auth.organizationId,
      workspaceId,
      // Inherited, never elevated. `auth.membershipRole` here is the KEY's role,
      // because this route only ever authenticates a key.
      role: auth.membershipRole,
      createdByKeyId: auth.apiKeyId,
      expiresAt,
    })
    .returning({ id: schema.sessionTokens.id });

  const live = {
    region: process.env.AWS_REGION ?? 'us-east-1',
    realtimeEndpoint: await realtimeEndpoint(),
  };

  // Flat, not a named envelope. Deliberate, and the same shape the integration
  // design committed to: this is a credential, not a resource, and there is no
  // `GET /auth/session-tokens/{id}` for `{session_token: …}` to be consistent
  // with. `POST /device-registrations` is the existing precedent for a bare
  // object. The plaintext is returned exactly once; only its SHA-256 is stored.
  return created({
    id: row!.id,
    token: plaintext,
    expiresAt: expiresAt.toISOString(),
    workspaceId,
    role: auth.membershipRole,
    live,
  });
};

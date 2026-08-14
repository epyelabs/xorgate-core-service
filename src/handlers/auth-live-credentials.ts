import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeEndpointCommand, IoTClient } from '@aws-sdk/client-iot';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import {
  ensureChannelTags,
  resolveLiveTtlSeconds,
  vendLiveCredentials,
} from '../services/live-credentials';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import {
  badRequest,
  created,
  errorResponse,
  methodNotAllowed,
} from '../utils/responses';

/**
 * `POST /auth/live-credentials` — exchange a xorgate credential for AWS
 * credentials that reach only the caller's own live plane.
 *
 * This is the endpoint that makes a third party's live plane real. Everything
 * before it stopped at REST: a consumer could read every documented endpoint at
 * its role and see only its own workspace's devices, and then could not receive
 * one telemetry frame or one second of video, because both live planes are
 * entered with AWS credentials and nothing vended a scoped set.
 *
 * **All three credential kinds are accepted, deliberately.**
 *
 * - An `xgs_` session token is the DIRECT profile: a third party's browser
 *   holds the token and calls this itself.
 * - An `xg_` key is the PROXIED profile: the consumer's backend holds the key,
 *   decides which of its own customers this end user is, and vends for that
 *   workspace. Its browser then touches no xorgate endpoint at all. This is
 *   Alocate's shape and it is the plan's acceptance test.
 * - A Cognito ID token is accepted because refusing it would be theatre. A
 *   signed-in user can already reach their whole organization's live plane
 *   through the identity pool, so an org-scoped credential from here grants
 *   nothing new and a workspace-scoped one grants strictly less. It is also
 *   what lets the first-party dashboard converge onto this mechanism later
 *   (phase file 4.3) without minting a second route.
 *
 * Note what the gate is NOT: `requireAnyMembership`, the user-only gate the
 * live-plane routes have used until now. Phase 2 recorded the reason
 * ("Phase 4 should mint a key-specific live path, not widen this gate") and
 * this is that path. `POST /iot/attach-policy` and `DELETE /live/access` still
 * resolve a Cognito IDENTITY, which a key genuinely does not have; this route
 * resolves a SCOPE, which all three credentials do.
 */

const iotClient = new IoTClient({});

/** Same value, same call and same reasoning as `auth-session-tokens.ts`. */
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

/** Test seam. */
export function resetRealtimeEndpointCache(): void {
  cachedRealtimeEndpoint = undefined;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'POST') return methodNotAllowed(method, 'POST');

  let auth;
  try {
    // No role gate. A `viewer` is exactly the role that should be able to
    // watch, and the credential this mints is read-only on both planes: the
    // ceiling role carries no `iot:Publish` and no `ConnectAsMaster`, so there
    // is nothing here for a write role to authorize.
    auth = await requireOrgContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  let body: { workspaceId?: unknown; ttlSeconds?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return badRequest('Invalid JSON body');
  }

  const ttl = resolveLiveTtlSeconds(body.ttlSeconds);
  if (!ttl.ok) return badRequest(ttl.message);

  // The scope the CREDENTIAL allows, re-read from the database on every vend
  // rather than trusted off the token. A credential naming a workspace that has
  // since been deleted resolves to the empty set here and is refused, instead
  // of being vended against a dangling id.
  const allowedWorkspaceIds = await resolveWorkspaceScope(auth);
  if (allowedWorkspaceIds.length === 0) {
    return errorResponse(
      403,
      'NO_WORKSPACE_IN_SCOPE',
      'This credential reaches no workspace, so there is no live plane to vend for.',
    );
  }

  // The scope the CALLER asked for, which may narrow but never widen. A
  // workspace-scoped session token has exactly one element in the set above, so
  // it can only ever re-state its own workspace.
  let workspaceId: string | null = auth.allowedWorkspaceId;
  if (body.workspaceId !== undefined && body.workspaceId !== null) {
    if (typeof body.workspaceId !== 'string') {
      return badRequest('workspaceId must be a string');
    }
    if (!allowedWorkspaceIds.includes(body.workspaceId)) {
      // 403 rather than 404: for the proxied profile this is a consumer backend
      // passing the wrong customer's workspace id, and "you may not scope to
      // that" is the actionable answer. It leaks only whether an id the caller
      // already typed is inside its own organization.
      return errorResponse(
        403,
        'WORKSPACE_NOT_IN_SCOPE',
        `Workspace "${body.workspaceId}" is not in this credential's scope.`,
      );
    }
    workspaceId = body.workspaceId;
  }

  // Video scoping is carried by tags on the signalling channels, so a channel
  // that has never been tagged is invisible to a scoped credential. Reconciling
  // here rather than on a schedule means the repair happens immediately before
  // the only operation that needs it, and costs one indexed SELECT returning
  // nothing once the backfill has run.
  await ensureChannelTags(workspaceId ? [workspaceId] : allowedWorkspaceIds);

  const credentials = await vendLiveCredentials(
    { organizationId: auth.organizationId, workspaceId },
    ttl.ttlSeconds,
  );

  // Flat, like `POST /auth/session-tokens` and for the same reason: a credential
  // is not a resource. The four SigV4-shaped fields ARE the `LiveCredentials`
  // type the SDK signs with, documented as opaque — a consumer hands the object
  // back and never reads a field. `live` rides along because the PROXIED
  // profile never calls the token endpoint and would otherwise have nowhere to
  // learn the coordinates its own frontend needs.
  return created({
    ...credentials,
    organizationId: auth.organizationId,
    workspaceId,
    live: {
      region: process.env.AWS_REGION ?? 'us-east-1',
      realtimeEndpoint: await realtimeEndpoint(),
    },
  });
};

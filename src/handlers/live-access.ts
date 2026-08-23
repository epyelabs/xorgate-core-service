import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AuthError, authErrorResponse, requireAuth } from '../middleware/auth';
import { resolveIdentityId, revokeLiveAccessForIdentity } from '../services/live-access';
import { badRequest, methodNotAllowed, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

/**
 * DELETE /live/access
 *
 * Revokes the caller's own live-plane access: detaches the browser policy from
 * the Cognito identity behind their token, after which the broker refuses their
 * next CONNECT. Self-service only — removing someone ELSE's access is a
 * consequence of removing their membership (DELETE /memberships/{id}), not a
 * separate privilege.
 *
 * Named `live/access` rather than `iot/detach-policy` deliberately: nothing on a
 * consumer-facing surface should require knowing xorgate runs on AWS IoT
 * (design note N11). The grant counterpart is still the older, AWS-named
 * `POST /iot/attach-policy`; both fold into `/v1/live/access` at the `/v1` cut,
 * where renaming an existing route costs nothing because that release aliases
 * old paths anyway.
 *
 * Authenticated but NOT membership-gated, unlike the grant: someone who has
 * just lost their last membership must still be able to clean up after
 * themselves, and revoking access can never be the privileged direction.
 */
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'DELETE') return methodNotAllowed(method, 'DELETE');

  let auth;
  try {
    auth = await requireAuth(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const authHeader =
    event.headers['authorization'] ?? event.headers['Authorization'];
  const idToken = authHeader!.slice(7);

  const identityId = await resolveIdentityId(idToken);
  if (!identityId) return badRequest('Could not resolve Cognito identity');

  // DetachPolicy on an identity that has nothing attached is a no-op, so this
  // is idempotent and returns the same shape either way.
  const { policyName } = await revokeLiveAccessForIdentity(auth.userId, identityId);

  return ok({ detached: true, identityId, policyName });
};

export const handler = apiHandler(restHandler);

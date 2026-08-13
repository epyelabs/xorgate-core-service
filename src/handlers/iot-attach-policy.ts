import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AuthError, authErrorResponse, requireAnyMembership } from '../middleware/auth';
import { grantLiveAccess, resolveIdentityId } from '../services/live-access';
import { badRequest, methodNotAllowed, ok } from '../utils/responses';

/**
 * POST /iot/attach-policy
 *
 * AWS IoT does NOT authorize MQTT for Cognito-federated principals via their IAM
 * role policy — it requires an AWS IoT policy attached to the *Cognito identity*.
 * This endpoint resolves the caller's identity (GetId with their verified idToken)
 * and attaches the browser IoT policy to it, so the browser can then connect /
 * subscribe over MQTT-over-WSS. Idempotent (AttachPolicy on an already-attached
 * identity is a no-op).
 *
 * Requires ORG MEMBERSHIP, not merely authentication. That gate is what makes
 * `DELETE /live/access` and the membership-removal detach mean anything: a
 * removed member who can still call this endpoint simply re-grants themselves
 * on the next page load, and the revoke is theatre.
 *
 * The identity id is recorded against the caller so a later membership removal
 * can find it (see services/live-access.ts).
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'POST') return methodNotAllowed(method, 'POST');

  let auth;
  try {
    auth = await requireAnyMembership(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  // requireAuth already validated the `Bearer ` prefix + token signature.
  const authHeader =
    event.headers['authorization'] ?? event.headers['Authorization'];
  const idToken = authHeader!.slice(7);

  const identityId = await resolveIdentityId(idToken);
  if (!identityId) return badRequest('Could not resolve Cognito identity');

  const { policyName } = await grantLiveAccess(auth.userId, identityId);

  return ok({ attached: true, identityId, policyName });
};

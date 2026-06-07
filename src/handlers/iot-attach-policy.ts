import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { IoTClient, AttachPolicyCommand } from '@aws-sdk/client-iot';
import { AuthError, authErrorResponse, requireAuth } from '../middleware/auth';
import { badRequest, methodNotAllowed, ok } from '../utils/responses';

const cognitoClient = new CognitoIdentityClient({});
const iotClient = new IoTClient({});

/**
 * POST /iot/attach-policy
 *
 * AWS IoT does NOT authorize MQTT for Cognito-federated principals via their IAM
 * role policy — it requires an AWS IoT policy attached to the *Cognito identity*.
 * This endpoint resolves the caller's identity (GetId with their verified idToken)
 * and attaches the browser IoT policy to it, so the browser can then connect /
 * subscribe over MQTT-over-WSS. Idempotent (AttachPolicy on an already-attached
 * identity is a no-op).
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'POST') return methodNotAllowed(method, 'POST');

  try {
    await requireAuth(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  // requireAuth already validated the `Bearer ` prefix + token signature.
  const authHeader =
    event.headers['authorization'] ?? event.headers['Authorization'];
  const idToken = authHeader!.slice(7);

  const identityPoolId = process.env.COGNITO_IDENTITY_POOL_ID!;
  const provider = process.env.COGNITO_USER_POOL_PROVIDER!; // cognito-idp.<region>.amazonaws.com/<userPoolId>
  const policyName = process.env.BROWSER_IOT_POLICY_NAME!;

  const { IdentityId } = await cognitoClient.send(
    new GetIdCommand({
      IdentityPoolId: identityPoolId,
      Logins: { [provider]: idToken },
    }),
  );
  if (!IdentityId) return badRequest('Could not resolve Cognito identity');

  await iotClient.send(
    new AttachPolicyCommand({ policyName, target: IdentityId }),
  );

  return ok({ attached: true, identityId: IdentityId, policyName });
};

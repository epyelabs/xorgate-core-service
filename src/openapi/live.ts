/**
 * The endpoints that exist only to bootstrap the live plane. Live video and
 * live telemetry do not flow through this API: the browser talks to AWS Kinesis
 * Video Streams and AWS IoT Core directly, with credentials it mints from the
 * Cognito identity pool. These endpoints hand out the metadata and the
 * authorization needed to do that, and take the authorization away again.
 */
export const livePaths = {
  '/devices/{id}/kvs-channels': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    get: {
      operationId: 'getDeviceKvsChannels',
      summary: "List the device's KVS signaling channels",
      description:
        'Channel METADATA only, one entry per provisioned video stream, and no credentials: a ' +
        'viewer obtains its own scoped AWS credentials from the Cognito identity pool and then ' +
        'runs the KVS WebRTC VIEWER role against these channels. An empty array means the device ' +
        'is not provisioned yet, which is a 200 rather than a 404. Video frames never traverse ' +
        'this API.',
      tags: ['Live'],
      responses: {
        '200': {
          description: 'KVS channels, possibly empty if the device is not provisioned.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['channels'],
                properties: {
                  channels: { type: 'array', items: { $ref: '#/components/schemas/KvsChannel' } },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/iot/attach-policy': {
    post: {
      operationId: 'attachIotPolicy',
      summary: 'Authorize the caller to subscribe to live telemetry over MQTT',
      description:
        'AWS IoT does not authorize MQTT for Cognito-federated principals through their IAM role. ' +
        'It requires an IoT policy attached to the Cognito IDENTITY. This endpoint resolves the ' +
        "caller's identity from the bearer token and attaches the browser policy to it, after " +
        'which the browser can connect over MQTT-over-WSS and subscribe to ' +
        '`xorgate/devices/{deviceId}/telemetry`. Idempotent, so calling it on every page load is ' +
        'fine.\n\n' +
        '**Use the returned `identityId` as the prefix of your MQTT client id.** The policy scopes ' +
        '`iot:Connect` to `client/<identityId>*`, so a CONNECT presenting any other client id is ' +
        'refused. Append something random after the identity id (xorgate-web uses ' +
        '`<identityId>-<role>-<uuid>`): one identity legitimately holds several concurrent ' +
        'connections, and two browser tabs of the same user resolve to the SAME identity id, so a ' +
        'bare identity id would make your own connections displace each other.\n\n' +
        'Requires membership of at least one organization, not merely a valid token. Losing your ' +
        'last membership therefore ends live access rather than merely un-attaching a policy you ' +
        'could immediately re-attach.\n\n' +
        'Note the current policy is org-blind in what it lets you SUBSCRIBE to: it authorizes the ' +
        'telemetry topic space broadly rather than per organization, so it is safe for first-party ' +
        'use and NOT yet safe to hand to a third party. Narrowing the subscribe scope is tracked ' +
        'as platform-readiness work. Connect scoping and revocation are done.\n\n' +
        '**Cognito ID token only.** The grant attaches to the caller\'s Cognito identity, which an ' +
        'API key does not have; a key is refused with `401 USER_CREDENTIAL_REQUIRED`. Live-plane ' +
        'access for key-authenticated consumers is separate work.',
      tags: ['Live'],
      security: [{ BearerAuth: [] }],
      responses: {
        '200': {
          description: 'Policy attached to the caller identity.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['attached', 'identityId', 'policyName'],
                properties: {
                  attached: { type: 'boolean' },
                  identityId: {
                    type: 'string',
                    description:
                      'The Cognito identity id the policy was attached to, and the required ' +
                      'prefix of the MQTT client id you connect with.',
                    example: 'us-east-1:00000000-0000-0000-0000-000000000000',
                  },
                  policyName: { type: 'string' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/live/access': {
    delete: {
      operationId: 'revokeLiveAccess',
      summary: 'Revoke your own access to the live plane',
      description:
        'The counterpart to `POST /iot/attach-policy`: detaches the browser policy from the ' +
        "Cognito identity behind your bearer token, after which the broker refuses that " +
        'identity\'s next CONNECT and any live subscription dies on its next reconnect. ' +
        'Idempotent — revoking access you do not have returns the same 200.\n\n' +
        'Self-service only. Revoking someone else\'s live access is a consequence of removing ' +
        'their membership: `DELETE /memberships/{id}` detaches automatically when the removal ' +
        'takes away their LAST organization membership. It deliberately does not fire while the ' +
        'user still belongs to another organization, because the browser policy is one shared ' +
        'org-blind policy and they remain entitled to it.\n\n' +
        'Unlike the grant, this needs only a valid token and no organization membership: someone ' +
        'who has just lost their last membership must still be able to clean up after themselves.' +
        '\n\n**Cognito ID token only**, for the same reason as the grant: there is no Cognito ' +
        'identity behind an API key to detach from (`401 USER_CREDENTIAL_REQUIRED`).',
      tags: ['Live'],
      security: [{ BearerAuth: [] }],
      responses: {
        '200': {
          description: 'Policy detached from the caller identity.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['detached', 'identityId', 'policyName'],
                properties: {
                  detached: { type: 'boolean' },
                  identityId: {
                    type: 'string',
                    description: 'The Cognito identity id the policy was detached from.',
                    example: 'us-east-1:00000000-0000-0000-0000-000000000000',
                  },
                  policyName: { type: 'string' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
};

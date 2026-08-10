/**
 * The two endpoints that exist only to bootstrap the live plane. Live video and
 * live telemetry do not flow through this API: the browser talks to AWS Kinesis
 * Video Streams and AWS IoT Core directly, with credentials it mints from the
 * Cognito identity pool. These endpoints hand out the metadata and the
 * authorization needed to do that.
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
        'Note the current policy is org-blind: it authorizes the telemetry topic space broadly ' +
        'rather than per organization, so it is safe for first-party use and NOT yet safe to hand ' +
        'to a third party. Narrowing it is tracked as platform-readiness work.',
      tags: ['Live'],
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
                    description: 'The Cognito identity id the policy was attached to.',
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

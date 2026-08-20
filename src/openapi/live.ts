/**
 * The endpoints that exist only to bootstrap the live plane. Live video and
 * live telemetry do not flow through this API: the client speaks the streaming
 * protocols directly, entered with a signed connection rather than a bearer
 * token. These endpoints hand out the metadata and the authorization needed to
 * do that, and take the authorization away again.
 *
 * Two N11 renames landed here at the `/v1` cut (Phase 6 of
 * plans/platform-auth-and-live-plane): `kvs-channels` became `video-channels`,
 * and `iot/attach-policy` became `POST /live/access`, joining the
 * `DELETE /live/access` Phase 1 shipped. The old paths answered unversioned
 * during a short alias period and were deleted with it.
 *
 * The video-channel operation is a CONSUMER path, so it drops AWS vocabulary
 * entirely. The two access operations are the first-party dashboard's own path
 * and say so, which is why they still name Cognito: N11 keeps "Cognito ID
 * token" in first-party auth sections rather than pretending it away.
 */
export const livePaths = {
  '/devices/{id}/video-channels': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    get: {
      operationId: 'getDeviceVideoChannels',
      summary: "List the device's live video channels",
      description:
        'Channel METADATA only, one entry per provisioned video stream, and no credentials: a ' +
        'viewer obtains its own scoped credentials from `POST /auth/live-credentials` and then ' +
        'joins these channels as a viewer. An empty array means the device is not provisioned ' +
        'yet, which is a 200 rather than a 404. Video frames never traverse this API.',
      tags: ['Live'],
      responses: {
        '200': {
          description: 'Video channels, possibly empty if the device is not provisioned.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['channels'],
                properties: {
                  channels: { type: 'array', items: { $ref: '#/components/schemas/VideoChannel' } },
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
  '/live/access': {
    post: {
      operationId: 'grantLiveAccess',
      summary: 'Authorize the caller to subscribe to live telemetry',
      description:
        'The first-party dashboard\'s own path onto the live plane. It resolves the caller\'s ' +
        'Cognito identity from the bearer token and authorizes that identity to connect to the ' +
        'realtime broker and subscribe to `xorgate/devices/{deviceId}/telemetry`. Idempotent, so ' +
        'calling it on every page load is fine.\n\n' +
        '**Third parties do not use this.** `POST /auth/live-credentials` is the third-party ' +
        'entry to the live plane: it needs no Cognito identity, works with any of the three ' +
        'credentials, and comes back scoped to the caller\'s organization or workspace. This ' +
        'operation exists because a browser federated through the identity pool is authorized by ' +
        'a different mechanism, and it is org-blind in what it lets you SUBSCRIBE to.\n\n' +
        '**Use the returned `identityId` as the prefix of your client id.** Connect is scoped to ' +
        '`client/<identityId>*`, so a connection presenting any other client id is refused. ' +
        'Append something random after the identity id (xorgate-web uses ' +
        '`<identityId>-<role>-<uuid>`): one identity legitimately holds several concurrent ' +
        'connections, and two browser tabs of the same user resolve to the SAME identity id, so a ' +
        'bare identity id would make your own connections displace each other.\n\n' +
        'Requires membership of at least one organization, not merely a valid token. Losing your ' +
        'last membership therefore ends live access rather than merely un-attaching something you ' +
        'could immediately re-attach.\n\n' +
        '**Cognito ID token only.** The grant hangs off the caller\'s Cognito identity, which an ' +
        'API key does not have; a key is refused with `401 USER_CREDENTIAL_REQUIRED`.',
      tags: ['Live'],
      security: [{ BearerAuth: [] }],
      responses: {
        '200': {
          description: 'The caller identity is authorized.',
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
                      'The Cognito identity id that was authorized, and the required prefix of ' +
                      'the client id you connect with.',
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
    delete: {
      operationId: 'revokeLiveAccess',
      summary: 'Revoke your own access to the live plane',
      description:
        'The counterpart to `POST /live/access`: withdraws the authorization from the Cognito ' +
        "identity behind your bearer token, after which the broker refuses that identity's next " +
        'connection and any live subscription dies on its next reconnect. Idempotent — revoking ' +
        'access you do not have returns the same 200.\n\n' +
        'Self-service only. Revoking someone else\'s live access is a consequence of removing ' +
        'their membership: `DELETE /memberships/{id}` revokes automatically when the removal ' +
        'takes away their LAST organization membership. It deliberately does not fire while the ' +
        'user still belongs to another organization, because the grant is one shared org-blind ' +
        'authorization and they remain entitled to it.\n\n' +
        'Unlike the grant, this needs only a valid token and no organization membership: someone ' +
        'who has just lost their last membership must still be able to clean up after themselves.' +
        '\n\n**Cognito ID token only**, for the same reason as the grant: there is no Cognito ' +
        'identity behind an API key to revoke (`401 USER_CREDENTIAL_REQUIRED`).',
      tags: ['Live'],
      security: [{ BearerAuth: [] }],
      responses: {
        '200': {
          description: 'The caller identity is no longer authorized.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['detached', 'identityId', 'policyName'],
                properties: {
                  detached: { type: 'boolean' },
                  identityId: {
                    type: 'string',
                    description: 'The Cognito identity id the authorization was removed from.',
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

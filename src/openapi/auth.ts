/**
 * The credential-exchange endpoint. One operation, and it is the seam a
 * third-party integration is built on: a consumer's server turns the API key it
 * must never ship into a short-lived token its browser may hold.
 */
export const authPaths = {
  '/auth/session-tokens': {
    post: {
      operationId: 'createSessionToken',
      summary: 'Exchange an API key for a short-lived session token',
      description:
        'Mints an `xgs_` **session token**: the only xorgate credential a browser or a mobile ' +
        'binary may hold. Call this from your SERVER, with your API key, after your own ' +
        'authorization decision about your own user. The token goes to the client; the key never ' +
        'leaves your infrastructure.\n\n' +
        'xorgate never learns who your user is. You authorize the person, xorgate authorizes the ' +
        'key, and `workspaceId` is how you express the first decision in terms the second one can ' +
        'enforce.\n\n' +
        '**API key only.** A Cognito ID token is `401 API_KEY_REQUIRED` (a signed-in session ' +
        'already authenticates this API directly and needs no exchange), and a session token ' +
        'cannot mint another one — otherwise a leaked token would renew itself forever and the ' +
        'expiry would mean nothing.\n\n' +
        '**The token is never more privileged than the key.** It inherits the key\'s `role`, and ' +
        'the role in force on any request is the LOWER of the token\'s and the key\'s CURRENT ' +
        'role, so downgrading a key downgrades its live tokens rather than leaving them ' +
        'privileged until they expire.\n\n' +
        '**`workspaceId` is enforced, not advisory.** Omit it and the token sees the whole ' +
        'organization, exactly as the key does. Supply it and the token is confined to that one ' +
        'workspace: device-scoped reads and writes are narrowed to it, an `X-Workspace-Id` header ' +
        'naming a different workspace is `403 WORKSPACE_MISMATCH`, and organization-wide ' +
        'operations (memberships, API keys, organization settings, workspace writes) answer ' +
        '`403 WORKSPACE_SCOPED` whatever the role. This is what lets you map your own customers ' +
        'onto workspaces and hand each of them a credential that cannot reach the others.\n\n' +
        '**Revocation.** Deleting the minting key with `DELETE /api-keys/{id}` destroys every ' +
        'token it minted, immediately. That is the emergency stop; there is no per-token revoke ' +
        'endpoint, because the maximum lifetime is an hour.\n\n' +
        'The response carries the live-plane coordinates alongside the token, so a client\'s ' +
        'entire configuration is the API base URL. The plaintext token is returned exactly once ' +
        'and only its SHA-256 is stored; there is no way to read it back.',
      tags: ['Auth'],
      security: [{ ApiKeyAuth: [] }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateSessionTokenInput' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Token minted. The plaintext is shown here and nowhere else.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SessionToken' },
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
};

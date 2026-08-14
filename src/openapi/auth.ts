/**
 * The credential-exchange endpoints. Two operations, and between them they are
 * the seam a third-party integration is built on: a consumer's server turns the
 * API key it must never ship into a short-lived token its browser may hold, and
 * either of those is exchanged again for the credentials the live plane is
 * entered with.
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
  '/auth/live-credentials': {
    post: {
      operationId: 'createLiveCredentials',
      summary: 'Vend credentials for the live plane, scoped to one tenant',
      description:
        'Returns the short-lived credentials the **live plane** is entered with. Live telemetry ' +
        'and live video are streaming protocols that this API does not carry, so they are not ' +
        'authorized by a bearer token the way the endpoints above are; they are entered with a ' +
        'signed connection, and this is what signs it.\n\n' +
        '**Treat the response as opaque.** Hand the object to the SDK and never read a field. ' +
        'The field names are dictated by the signing algorithm rather than chosen, which is ' +
        'exactly why they are not something to build against.\n\n' +
        '**Any credential may call this**, and which one you use is the difference between the ' +
        'two integration shapes. A session token is the DIRECT shape: your client holds the ' +
        'token and calls this itself. An API key is the PROXIED shape: your server calls this ' +
        'with the target `workspaceId` and hands the result to your client, which then touches ' +
        'no xorgate endpoint at all. A signed-in user session works too, and gets its ' +
        'organization.\n\n' +
        '**The scope is the boundary, on both planes.** Credentials vended for a workspace ' +
        'receive that workspace\'s devices\' telemetry and can view that workspace\'s devices\' ' +
        'video, and are refused a sibling workspace\'s — not filtered, refused, by the ' +
        'credential itself rather than by anything you have to remember to do. A ' +
        'workspace-scoped session token can only ever vend for its own workspace; anything else ' +
        'is `403 WORKSPACE_NOT_IN_SCOPE`.\n\n' +
        '**Lifetime is at most an hour and there is no refresh.** Cache what you get and mint ' +
        'again shortly before `expiration`; the SDK does this for you. There is no revoke ' +
        'endpoint, for the same reason session tokens have none — deleting the API key behind ' +
        'the credential is the emergency stop, and nothing vended survives an hour anyway.\n\n' +
        '**A device whose video has never been viewed under this scheme may need one extra ' +
        'call to become viewable**: the video plane is scoped by labels written onto the ' +
        'signalling channels, and vending is what reconciles them. If a channel comes back ' +
        'unviewable, vend again.',
      tags: ['Auth'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateLiveCredentialsInput' },
          },
        },
      },
      responses: {
        '201': {
          description:
            'Credentials minted. Opaque; pass them to the SDK unread.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LiveCredentials' },
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

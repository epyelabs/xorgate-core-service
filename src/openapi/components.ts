import { openApiSchemas } from './schemas';

/**
 * `components`: security schemes, reusable parameters (including the shared
 * list dialect), schemas, and the canned responses every path module refers to.
 *
 * The list dialect lives here on purpose: `src/utils/list-params.ts` gives every
 * paginated endpoint the same `limit`/`offset`/`order`/`sort`/`status`/`from`/
 * `to` handling, so the document should describe it once and `$ref` it, rather
 * than restate it per endpoint and let the copies drift.
 */

/** `limit`/`offset`/`order` + the time-range bounds, shared by every list route. */
const listParameters = {
  LimitQuery: {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, default: 100 },
    description:
      'Page size. Default 100; the endpoint maximum is 500 everywhere the shared list dialect ' +
      'applies. A value above the maximum, a non-integer, or a value below 1 is a 400. (Before ' +
      'API productization the over-maximum case was silently clamped; it now rejects, so a ' +
      'consumer cannot ship a page that quietly shows 500 of 4,000 rows.)',
  },
  OffsetQuery: {
    name: 'offset',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0, default: 0 },
    description: 'Rows to skip. A non-integer is a 400; an offset past the end returns an empty page.',
  },
  OrderQuery: {
    name: 'order',
    in: 'query',
    required: false,
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
    description: 'Sort direction of the sort column this endpoint uses.',
  },
  FromQuery: {
    name: 'from',
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description: 'Range start (inclusive), ISO-8601. Must be earlier than `to`.',
  },
  ToQuery: {
    name: 'to',
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description: 'Range end (exclusive), ISO-8601.',
  },
} as const;

const headerAndPathParameters = {
  OrganizationIdHeader: {
    name: 'X-Organization-Id',
    in: 'header',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description:
      'Active organization UUID. Resolution order: this header if present (it must match one of ' +
      'your memberships, else `403 FORBIDDEN`), otherwise your sole membership. A caller who ' +
      'belongs to more than one organization and omits it gets `400 ORGANIZATION_REQUIRED`, and a ' +
      'caller who belongs to none gets `403 NO_ORGANIZATION`. Practically: always send it. ' +
      'When the credential is an API key the organization comes from the key itself, so this ' +
      'header is optional and never required; sending one that is not the key\'s organization is ' +
      '`403 FORBIDDEN`, deliberately not a silent override.',
  },
  WorkspaceIdHeader: {
    name: 'X-Workspace-Id',
    in: 'header',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description:
      'Optional workspace UUID. On `GET /devices` it filters the result to that workspace (a ' +
      'workspace outside the active organization yields an EMPTY page, not an error). Required on ' +
      '`POST /device-registrations`.\n\n' +
      'One credential changes what this header means. For a **workspace-scoped session token** ' +
      'the workspace is already fixed, so the header is redundant: sending the token\'s own ' +
      'workspace is accepted, sending a different one is `403 WORKSPACE_MISMATCH` rather than an ' +
      'empty result, and omitting it on `POST /device-registrations` is fine because the token ' +
      'supplies it.',
  },
  IdPath: {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  },
  SessionIdPath: {
    name: 'sessionId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  },
  SegmentSeqPath: {
    name: 'seq',
    in: 'path',
    required: true,
    schema: { type: 'integer', minimum: 0 },
    description: 'Segment sequence number within the session (0-based).',
  },
  RegistrationCodePath: {
    name: 'code',
    in: 'path',
    required: true,
    schema: { type: 'string' },
    description: 'The registration code from `POST /device-registrations`.',
  },
} as const;

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

export function openApiComponents(): Record<string, unknown> {
  return {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'A Cognito **ID** token (not an access token). Users are created just-in-time on first ' +
          'successful verification. This is what a signed-in browser session sends. A handful of ' +
          'operations accept ONLY this, because they describe or act on a person: `GET /me`, both ' +
          '`/organizations` collection operations, and the two live-access operations.',
      },
      ApiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'xorgate API key',
        description:
          'An API key from `POST /api-keys`, sent in the same header as a token: ' +
          '`Authorization: Bearer xg_...`. The server tells the two apart by the `xg_` prefix, so ' +
          'no extra header is involved. A key is bound to one organization by the row it was ' +
          'minted from, which makes `X-Organization-Id` redundant; sending a DIFFERENT ' +
          'organization is `403 FORBIDDEN` rather than an ignored header. The key acts with its ' +
          'own `role` (default `member`), so every role gate in this document applies to it ' +
          'unchanged. Keys carry no user, so operations that need one refuse them with ' +
          '`401 USER_CREDENTIAL_REQUIRED`.',
      },
      SessionTokenAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'xorgate session token',
        description:
          'A short-lived token from `POST /auth/session-tokens`, sent in the same header as the ' +
          'other two: `Authorization: Bearer xgs_...`. This is the only xorgate credential a ' +
          'browser or a mobile binary should ever hold — your server exchanges its API key for ' +
          'one, per end user, per request if you like.\n\n' +
          'It carries the key\'s organization and the key\'s role (never more), expires within ' +
          'the hour, and dies the moment the key that minted it is deleted. It can also be ' +
          'confined to ONE workspace, which is the only place in this API where a workspace is a ' +
          'boundary rather than a filter: such a token sees that workspace\'s devices and ' +
          'nothing else, gets `403 WORKSPACE_MISMATCH` for an `X-Workspace-Id` naming another ' +
          'workspace, and `403 WORKSPACE_SCOPED` on organization-wide operations regardless of ' +
          'its role. Like a key it has no user, so person-scoped operations refuse it with ' +
          '`401 USER_CREDENTIAL_REQUIRED`.',
      },
    },
    parameters: { ...headerAndPathParameters, ...listParameters },
    schemas: openApiSchemas(),
    responses: {
      Unauthorized: errorResponse(
        'No usable credential. `UNAUTHORIZED` for a missing, malformed or expired bearer token; ' +
          '`INVALID_API_KEY`, `API_KEY_REVOKED` or `API_KEY_EXPIRED` for an `xg_` key that does ' +
          'not verify; `INVALID_SESSION_TOKEN`, `SESSION_TOKEN_REVOKED` or ' +
          '`SESSION_TOKEN_EXPIRED` for an `xgs_` token that does not (revoked also covers a token ' +
          'whose minting key was revoked or deleted, and expired covers one whose key expired — ' +
          'the holder cannot act on the key either way, so the token-shaped code is the useful ' +
          'one); `USER_CREDENTIAL_REQUIRED` when a key or a token was sent to an operation that ' +
          'needs a signed-in user; and `API_KEY_REQUIRED` on `POST /auth/session-tokens`, which ' +
          'takes only a key.',
      ),
      Forbidden: errorResponse(
        'Not a member of the requested organization (`FORBIDDEN`), a member of none ' +
          '(`NO_ORGANIZATION`), or a member without the required role (`INSUFFICIENT_ROLE`). ' +
          'An API key sent with an `X-Organization-Id` other than its own is `FORBIDDEN`, and a ' +
          'key whose `role` is below the operation is `INSUFFICIENT_ROLE`. A workspace-scoped ' +
          'session token adds two of its own, neither of which a role can satisfy: ' +
          '`WORKSPACE_MISMATCH` for an `X-Workspace-Id` that contradicts the token, and ' +
          '`WORKSPACE_SCOPED` for an operation that is organization-wide.',
      ),
      NotFound: errorResponse(
        'No such resource, or it belongs to another organization. Cross-tenant reads are ' +
          'deliberately indistinguishable from missing ones (`NOT_FOUND`).',
      ),
      BadRequest: errorResponse(
        'Invalid body or query parameters (`BAD_REQUEST`), or a multi-organization caller who ' +
          'omitted `X-Organization-Id` (`ORGANIZATION_REQUIRED`).',
      ),
      Conflict: errorResponse('The resource is in a state that refuses this operation (`CONFLICT`).'),
      MethodNotAllowed: {
        description:
          'The path exists but not with this method (`METHOD_NOT_ALLOWED`). The response carries ' +
          'an `Allow` header listing the methods this path does accept.',
        headers: {
          Allow: {
            schema: { type: 'string', example: 'GET, POST, DELETE' },
            description: 'Comma-separated methods this path accepts.',
          },
        },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      NoContent: { description: 'Deleted. Empty body.' },
      DeviceCommandAccepted: {
        description:
          'Command published to the device. Delivery to the broker only. The device may still ' +
          'reject it as expired or already-executed, and the real outcome is observed via device status.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['requestId', 'command', 'expiresAt'],
              properties: {
                requestId: {
                  type: 'string',
                  format: 'uuid',
                  description: 'Replay key. The device refuses to execute the same one twice.',
                },
                command: { type: 'string', enum: ['reboot', 'power_off', 'refresh', 'update'] },
                expiresAt: {
                  type: 'integer',
                  format: 'int64',
                  description: 'Epoch ms after which the device refuses the command.',
                },
              },
            },
          },
        },
      },
      DeviceCommandPublishFailed: errorResponse(
        'Delivering the command to the device failed (`COMMAND_PUBLISH_FAILED`). Retry.',
      ),
    },
  };
}

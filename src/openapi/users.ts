/**
 * `GET /me`: identity plus everything needed to pick an active organization.
 * `PATCH /me` and the `/me/avatar` pair: the caller's own profile.
 *
 * All four are scoped to the caller by the bearer token alone — there is no id
 * in any path, so none of them takes `X-Organization-Id` or consults a
 * membership role. Passwords are NOT here: the browser changes those against
 * Cognito directly and they never pass through this API.
 */
export const usersPaths = {
  '/me': {
    get: {
      operationId: 'getMe',
      summary: 'Current user, memberships, and organizations',
      description:
        'The bootstrap call. It resolves the bearer token to a user (creating the row on first ' +
        'sight) and returns every organization the caller belongs to, which is how a client learns ' +
        'what to put in `X-Organization-Id`. `memberships` are the plain rows, not the enriched ' +
        'roster shape that `GET /memberships` returns. This is the only org-aware endpoint that ' +
        'never needs the tenancy header.\n\n' +
        '**Cognito ID token only.** An `xg_` API key is refused here with ' +
        '`401 USER_CREDENTIAL_REQUIRED`: this operation describes a person, and a key has no ' +
        'user behind it.',
      tags: ['Users'],
      security: [{ BearerAuth: [] }],
      responses: {
        '200': {
          description: 'Current user payload',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['user', 'memberships', 'organizations'],
                properties: {
                  user: { $ref: '#/components/schemas/User' },
                  memberships: { type: 'array', items: { $ref: '#/components/schemas/Membership' } },
                  organizations: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Organization' },
                    description:
                      'Empty for a brand-new user. Create one with `POST /organizations` before ' +
                      'calling anything org-scoped.',
                  },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    patch: {
      operationId: 'updateMe',
      summary: "Update the caller's own profile",
      description:
        'Sets the display name on the caller\'s `users` row. `null` clears it, and clients fall ' +
        'back to the email address. Nothing else about a user is editable here: the email is the ' +
        'Cognito sign-in and the tier and platform role are not self-service.\n\n' +
        'The name is NOT written back to the Cognito `name` attribute. That attribute seeds the ' +
        'row the first time a token is seen and has no reader afterwards; this row is the ' +
        'profile.\n\n' +
        '**Cognito ID token only.** An `xg_` API key is refused with `401 USER_CREDENTIAL_REQUIRED`: this operation acts on a person, and a key has no user behind it.',
      tags: ['Users'],
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  nullable: true,
                  minLength: 1,
                  maxLength: 120,
                  description: 'Trimmed before storing. `null` clears the name.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { $ref: '#/components/responses/MeUser' },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/me/avatar': {
    put: {
      operationId: 'uploadMyAvatar',
      summary: "Replace the caller's profile picture",
      description:
        'The image arrives as base64 in the body rather than through a presigned PUT: clients ' +
        'downscale to a 512px square first, so the payload is tens of kilobytes and one round ' +
        'trip writes both the object and the row that points at it.\n\n' +
        'The declared `contentType` is checked against the bytes themselves — a payload whose ' +
        'magic number disagrees with its label is refused, because the declared type is what ' +
        'gets served back on the presigned GET. The stored object is private; the response ' +
        'carries a fresh `avatarUrl` for it.\n\n' +
        '**Cognito ID token only.** An `xg_` API key is refused with `401 USER_CREDENTIAL_REQUIRED`: this operation acts on a person, and a key has no user behind it.',
      tags: ['Users'],
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['contentType', 'data'],
              properties: {
                contentType: {
                  type: 'string',
                  enum: ['image/jpeg', 'image/png', 'image/webp'],
                  description: 'Must match what the bytes actually are.',
                },
                data: {
                  type: 'string',
                  format: 'byte',
                  description:
                    'Base64 with no `data:` prefix. Decodes to at most 1.5 MB; larger is a 400.',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': { $ref: '#/components/responses/MeUser' },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    delete: {
      operationId: 'deleteMyAvatar',
      summary: "Remove the caller's profile picture",
      description:
        'Clears the picture; clients fall back to initials. Idempotent — a caller with no ' +
        'picture gets the same 200.\n\n' +
        '**Cognito ID token only.** An `xg_` API key is refused with `401 USER_CREDENTIAL_REQUIRED`: this operation acts on a person, and a key has no user behind it.',
      tags: ['Users'],
      security: [{ BearerAuth: [] }],
      responses: {
        '200': { $ref: '#/components/responses/MeUser' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
};

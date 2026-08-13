export const apiKeysPaths = {
  '/api-keys': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listApiKeys',
      summary: 'List API keys for the active organization',
      description:
        'Unpaginated, newest first, and includes revoked and expired keys. The envelope key is ' +
        '`api_keys` (snake_case, mirroring the Postgres table name) while its contents are ' +
        'camelCase. That inconsistency is deliberate and stays on the wire; the SDKs present it ' +
        'as `apiKeys`. `keyPrefix` is null on keys minted before that column existed and cannot ' +
        'be recovered for them.',
      tags: ['API Keys'],
      responses: {
        '200': {
          description: 'API key metadata. The hashed key is never returned.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['api_keys'],
                properties: {
                  api_keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    post: {
      operationId: 'createApiKey',
      summary: 'Mint a new API key (owner/admin only)',
      description:
        'Returns the plaintext key exactly once, as `plaintext_key`. Only its SHA-256 is stored, ' +
        'so a lost key cannot be recovered, only replaced. Send the result as ' +
        '`Authorization: Bearer xg_...` to any organization-scoped operation in this document.\n\n' +
        'A key may not be minted more privileged than the caller minting it: an `admin` cannot ' +
        'mint an `owner` key (`403`), because that would be a one-step escalation to deleting the ' +
        'organization.',
      tags: ['API Keys'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'scope'],
              properties: {
                name: { type: 'string' },
                scope: {
                  type: 'string',
                  enum: ['edge', 'cloud', 'client'],
                  description: 'Recorded on the key. Nothing enforces it yet.',
                },
                role: {
                  type: 'string',
                  enum: ['owner', 'admin', 'member', 'viewer'],
                  default: 'member',
                  description:
                    'The role the key acts with. Defaults to `member`, which is the right level ' +
                    'for a data-plane consumer: it can register and manage devices and ' +
                    'workspaces but cannot manage people, keys or the organization itself. ' +
                    'Capped at the minting caller\'s own role.',
                },
                expiresAt: {
                  type: 'string',
                  format: 'date-time',
                  nullable: true,
                  description:
                    'Opt-in expiry, ISO-8601, must be in the future. Omit or send null for a key ' +
                    'that never expires.',
                },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'API key created. `plaintext_key` is shown only here.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['api_key', 'plaintext_key'],
                properties: {
                  api_key: { $ref: '#/components/schemas/ApiKey' },
                  plaintext_key: {
                    type: 'string',
                    example: 'xg_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0',
                    description: 'Save this. It is not retrievable later.',
                  },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/api-keys/{id}': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    delete: {
      operationId: 'deleteApiKey',
      summary: 'Permanently delete an API key (owner/admin only)',
      description:
        'A hard delete, not a revocation: the row is removed and `revokedAt` is never used by this ' +
        'endpoint. The key stops authenticating immediately and thereafter reads as unknown ' +
        '(`401 INVALID_API_KEY`) rather than revoked. Rotation is therefore mint-then-delete, and ' +
        'a deleted key leaves no record of having existed.\n\n' +
        '**Every session token minted from this key dies with it, immediately.** That cascade is ' +
        'the emergency stop for a leaked browser credential: there is no per-token revoke ' +
        'endpoint, so if you need to end sessions now, delete the key they came from. Mint the ' +
        'replacement key first if you also need the integration to keep working.',
      tags: ['API Keys'],
      responses: {
        '204': { $ref: '#/components/responses/NoContent' },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
};

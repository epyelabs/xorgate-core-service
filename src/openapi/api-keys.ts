export const apiKeysPaths = {
  '/api-keys': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listApiKeys',
      summary: 'List API keys for the active organization',
      description:
        'Unpaginated, newest first. The envelope key is `api_keys` (snake_case, mirroring the ' +
        'Postgres table name) while its contents are camelCase. That inconsistency is deliberate ' +
        'and stays on the wire; the SDKs present it as `apiKeys`.',
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
        'so a lost key cannot be recovered, only replaced. Note that minting is currently all a ' +
        'key does: no endpoint accepts one as a credential yet, so a key is useful for provisioning ' +
        'ahead of that work rather than for calling this API today.',
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
        'endpoint.',
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

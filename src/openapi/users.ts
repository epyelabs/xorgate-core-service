/** `GET /me`: identity plus everything needed to pick an active organization. */
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
        'never needs the tenancy header.',
      tags: ['Users'],
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
  },
};

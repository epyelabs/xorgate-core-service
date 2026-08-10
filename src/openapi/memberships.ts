export const membershipsPaths = {
  '/memberships': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listMemberships',
      summary: 'List members of the active organization',
      description:
        'The roster. Unpaginated (one `memberships` array, no `page` block), and each row is ' +
        'enriched with its member\'s `user` so a UI renders names and emails without a second ' +
        'round-trip.',
      tags: ['Memberships'],
      responses: {
        '200': {
          description: 'List of memberships, each enriched with its member identity',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['memberships'],
                properties: {
                  memberships: { type: 'array', items: { $ref: '#/components/schemas/MembershipWithUser' } },
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
      operationId: 'addMembership',
      summary: 'Add a user to the active organization (owner/admin only)',
      description:
        'Adds a member by `userId` or `email`. If an `email` has no account yet, a Cognito account ' +
        'is provisioned and the invitee is emailed a temporary password to set on first sign-in. ' +
        '`invited` is true when a new account was created and emailed. Adding someone who is ' +
        'already a member is a 400, not a no-op.',
      tags: ['Memberships'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              description: 'Provide either `userId` or `email` to identify the user.',
              properties: {
                userId: { type: 'string' },
                email: { type: 'string', format: 'email' },
                role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'], default: 'member' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Membership created (invitee provisioned + emailed when `invited` is true)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['membership', 'invited'],
                properties: {
                  membership: { $ref: '#/components/schemas/Membership' },
                  invited: {
                    type: 'boolean',
                    description: 'True when a new Cognito account was created and emailed an invitation.',
                  },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/memberships/{id}': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    delete: {
      operationId: 'removeMembership',
      summary: 'Remove a member (owner/admin only)',
      description:
        'Removing the last remaining owner is refused with a 403, so an organization can never be ' +
        'left ownerless.',
      tags: ['Memberships'],
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

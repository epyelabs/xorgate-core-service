export const membershipsPaths = {
  '/memberships': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listMemberships',
      summary: 'List members of the active organization',
      description:
        'The roster, paginated with the shared list dialect (default order is ASCENDING by join ' +
        'date, the one list endpoint whose default is not `desc`). Each row is enriched with its ' +
        'member\'s `user` so a UI renders names and emails without a second round-trip.',
      parameters: [
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        {
          name: 'order',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
          description: 'Sort direction. Default `asc` here (join order), unlike other lists.',
        },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['createdAt', 'role'], default: 'createdAt' },
          description: 'Sort column. Anything else is a 400.',
        },
      ],
      tags: ['Memberships'],
      responses: {
        '200': {
          description: 'List of memberships, each enriched with its member identity',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['memberships', 'page'],
                properties: {
                  memberships: { type: 'array', items: { $ref: '#/components/schemas/MembershipWithUser' } },
                  page: { $ref: '#/components/schemas/PageMeta' },
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
        'is provisioned and the invitee is emailed a temporary password to set on first sign-in; ' +
        'the invitation names this organization and the caller. `invited` is true when a new ' +
        'account was created and emailed. Someone who already has an account gets no credential, ' +
        'so they are emailed a notice that they were added instead. Either email is best-effort ' +
        'and never fails the request. Adding someone who is already a member is a 400, not a no-op.',
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
    patch: {
      operationId: 'updateMembershipRole',
      summary: "Change a member's role (owner/admin only)",
      description:
        'Changes the role in place; before this existed the only way to change a role was to ' +
        'remove and re-invite the member. Two guards beyond the owner/admin gate: owner-level ' +
        'changes (granting `owner`, or changing an existing owner\'s role) need the caller to be ' +
        'an owner themselves, and demoting the LAST owner is refused with a 403 so an ' +
        'organization can never lock itself out. Setting the role a member already has is a ' +
        'no-op 200.',
      tags: ['Memberships'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['role'],
              properties: {
                role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'] },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'The updated membership',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['membership'],
                properties: {
                  membership: { $ref: '#/components/schemas/Membership' },
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
    delete: {
      operationId: 'removeMembership',
      summary: 'Remove a member, or leave the organization',
      description:
        'Owners and admins can remove any member. Any member can remove THEIR OWN membership ' +
        '(leave); addressing someone else\'s with a lower role is a 403. Removing the last ' +
        'remaining owner is refused with a 403 either way, so an organization can never be ' +
        'left ownerless — hand ownership over first, or delete the organization.\n\n' +
        'Side effect: if this removal takes away the member\'s LAST organization membership, their ' +
        'live-plane access is revoked too (see `DELETE /live/access`), and any live subscription ' +
        'they hold dies on its next reconnect. Members who still belong to another organization ' +
        'keep live access.',
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

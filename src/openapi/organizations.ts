export const organizationsPaths = {
  '/organizations': {
    get: {
      operationId: 'listOrganizations',
      summary: 'List organizations the caller is a member of',
      description:
        'Unpaginated: the whole set comes back in one `organizations` array with no `page` block. ' +
        'A user belongs to a handful of organizations at most.',
      tags: ['Organizations'],
      responses: {
        '200': {
          description: 'List of organizations',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organizations'],
                properties: {
                  organizations: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    post: {
      operationId: 'createOrganization',
      summary: 'Create a new organization and become its owner',
      description:
        'Bootstraps an organization for the caller and inserts a `memberships` row with ' +
        '`role: owner`. Does NOT require `X-Organization-Id` (the caller may have no orgs yet), ' +
        'which makes it the one write a brand-new user can perform.',
      tags: ['Organizations'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'slug'],
              properties: {
                name: { type: 'string' },
                slug: { type: 'string', description: 'Unique across all organizations.' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Organization created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organization'],
                properties: { organization: { $ref: '#/components/schemas/Organization' } },
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
  '/organizations/{id}': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    get: {
      operationId: 'getOrganization',
      summary: 'Get the active organization',
      description:
        'The `{id}` must be the ACTIVE organization (the one resolved from `X-Organization-Id` or ' +
        'from a sole membership). Reading a different organization you belong to means switching ' +
        'the header, not changing the path.',
      tags: ['Organizations'],
      responses: {
        '200': {
          description: 'Organization',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organization'],
                properties: { organization: { $ref: '#/components/schemas/Organization' } },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      operationId: 'updateOrganization',
      summary: 'Update name or slug (owner/admin only)',
      description:
        'Partial update: send only the fields you want changed. An empty body is a 400, and ' +
        'targeting an organization other than the active one is a 403.',
      tags: ['Organizations'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              properties: {
                name: { type: 'string' },
                slug: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Organization updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organization'],
                properties: { organization: { $ref: '#/components/schemas/Organization' } },
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
      operationId: 'deleteOrganization',
      summary: 'Delete the organization (owner only)',
      description:
        'Cascades: workspaces, devices, API keys and memberships under this organization go with ' +
        'it. There is no undo and no soft-delete.',
      tags: ['Organizations'],
      responses: {
        '204': { $ref: '#/components/responses/NoContent' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
};

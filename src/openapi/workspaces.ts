export const workspacesPaths = {
  '/workspaces': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listWorkspaces',
      summary: 'List workspaces in the active organization',
      description:
        'Unpaginated. Workspaces are the unit devices belong to, so this is usually the second ' +
        'call a client makes after `GET /me`.\n\n' +
        'A workspace-scoped session token lists exactly one workspace: its own. Any other reads ' +
        'as `404` from `GET /workspaces/{id}`, indistinguishable from a workspace in another ' +
        'organization.',
      tags: ['Workspaces'],
      responses: {
        '200': {
          description: 'List of workspaces',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspaces'],
                properties: {
                  workspaces: { type: 'array', items: { $ref: '#/components/schemas/Workspace' } },
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
      operationId: 'createWorkspace',
      summary: 'Create a workspace in the active organization',
      description:
        'Open to role `member`, which is what makes programmatic customer onboarding work: a ' +
        'consumer running its own multi-tenancy creates one workspace per customer with its ' +
        'default-role API key.\n\n' +
        'Workspace WRITES are organization-wide, so a workspace-scoped session token is refused ' +
        'with `403 WORKSPACE_SCOPED` whatever role it carries. Creating and deleting tenants is ' +
        "your backend's job, done with the key; a browser-held credential that could delete its " +
        'own tenant would be a liability with no matching use.',
      tags: ['Workspaces'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'slug'],
              properties: {
                name: { type: 'string' },
                slug: { type: 'string' },
                description: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Workspace created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspace'],
                properties: { workspace: { $ref: '#/components/schemas/Workspace' } },
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
  '/workspaces/{id}': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    get: {
      operationId: 'getWorkspace',
      summary: 'Get a workspace',
      tags: ['Workspaces'],
      responses: {
        '200': {
          description: 'Workspace',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspace'],
                properties: { workspace: { $ref: '#/components/schemas/Workspace' } },
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
      operationId: 'updateWorkspace',
      summary: 'Update a workspace',
      description:
        'Partial update. An empty body is a 400. Organization-wide, like every workspace write: a ' +
        'workspace-scoped session token gets `403 WORKSPACE_SCOPED`.',
      tags: ['Workspaces'],
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
                description: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Workspace updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspace'],
                properties: { workspace: { $ref: '#/components/schemas/Workspace' } },
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
      operationId: 'deleteWorkspace',
      summary: 'Delete a workspace',
      description:
        'Cascades to the devices in it, and to their sessions and telemetry, and to any session ' +
        'token scoped to it. Organization-wide: a workspace-scoped session token gets ' +
        '`403 WORKSPACE_SCOPED`.',
      tags: ['Workspaces'],
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

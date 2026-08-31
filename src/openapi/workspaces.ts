export const workspacesPaths = {
  '/workspaces': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listWorkspaces',
      summary: 'List workspaces in the active organization',
      description:
        'Paginated with the shared list dialect. Workspaces are the unit devices belong to, so ' +
        'this is usually the second call a client makes after `GET /me`.\n\n' +
        'A workspace-scoped session token lists exactly one workspace: its own. Any other reads ' +
        'as `404` from `GET /workspaces/{id}`, indistinguishable from a workspace in another ' +
        'organization.',
      tags: ['Workspaces'],
      parameters: [
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['updatedAt', 'createdAt', 'name'], default: 'updatedAt' },
          description: 'Sort column. Anything else is a 400.',
        },
      ],
      responses: {
        '200': {
          description: 'List of workspaces',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspaces', 'page'],
                properties: {
                  workspaces: { type: 'array', items: { $ref: '#/components/schemas/Workspace' } },
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
  '/workspaces/{id}/logo': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    put: {
      operationId: 'uploadWorkspaceLogo',
      summary: 'Replace the workspace logo',
      description:
        'Identical in every respect to `PUT /organizations/{id}/logo` — base64 body, declared ' +
        'type checked against the bytes, private object, presigned `logoUrl` on the response — ' +
        'one level down. Organization-wide, like every workspace write: a workspace-scoped ' +
        'session token gets `403 WORKSPACE_SCOPED`.',
      tags: ['Workspaces'],
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
        '200': {
          description: 'Logo replaced',
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
      operationId: 'deleteWorkspaceLogo',
      summary: 'Remove the workspace logo',
      description:
        'Clears the logo; clients fall back to the initials of the name. Idempotent — a ' +
        'workspace with no logo answers 200 with `logoUrl: null`.',
      tags: ['Workspaces'],
      responses: {
        '200': {
          description: 'Logo removed',
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
  },
};

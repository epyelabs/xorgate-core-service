export const organizationsPaths = {
  '/organizations': {
    get: {
      operationId: 'listOrganizations',
      summary: 'List organizations the caller is a member of',
      description:
        'Paginated with the shared list dialect (a user belongs to a handful of organizations at ' +
        'most, so the default page size of 100 is effectively "all of them").\n\n' +
        '**Cognito ID token only.** The result is defined by the caller\'s memberships, which an ' +
        'API key does not have; a key is refused with `401 USER_CREDENTIAL_REQUIRED`. A key ' +
        'already knows its one organization.',
      tags: ['Organizations'],
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['createdAt', 'name'], default: 'createdAt' },
          description: 'Sort column. Anything else is a 400.',
        },
      ],
      responses: {
        '200': {
          description: 'List of organizations',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organizations', 'page'],
                properties: {
                  organizations: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
                  page: { $ref: '#/components/schemas/PageMeta' },
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
        'which makes it the one write a brand-new user can perform.\n\n' +
        '**Cognito ID token only** (`401 USER_CREDENTIAL_REQUIRED` for an API key). The new ' +
        'organization needs an owner, and an owner is a user. This is a known limit for a ' +
        'consumer that wants to onboard its own customers programmatically: today it maps them ' +
        'onto WORKSPACES inside its one organization, which a default `member` key can create. ' +
        'Organizations for a consumer are provisioned out of band.',
      tags: ['Organizations'],
      security: [{ BearerAuth: [] }],
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
        'Destroys the organization and everything under it: every workspace and every device ' +
        '(each torn down the way `DELETE /devices/{id}` is — IoT identity, video channels, ' +
        'uploaded media, telemetry), API keys and the session tokens minted from them, ' +
        'memberships, workflow templates, connector credentials in Secrets Manager, and the ' +
        'logos. Members whose only organization this was lose live-plane access. There is no ' +
        'undo and no soft-delete; a minimal deletion record (id, slug, counts, who, when) is kept.',
      tags: ['Organizations'],
      responses: {
        '204': { $ref: '#/components/responses/NoContent' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/organizations/{id}/logo': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    put: {
      operationId: 'uploadOrganizationLogo',
      summary: 'Replace the organization logo (owner/admin only)',
      description:
        'The image arrives as base64 in the body rather than through a presigned PUT: clients ' +
        'fit it into a 512px square first, so the payload is tens of kilobytes and one round ' +
        'trip writes both the object and the row that points at it.\n\n' +
        'The declared `contentType` is checked against the bytes themselves — a payload whose ' +
        'magic number disagrees with its label is refused, because the declared type is what ' +
        'gets served back on the presigned GET. The stored object is private; the response ' +
        'carries a fresh `logoUrl` for it, and the previous object is deleted only after the ' +
        'row points at the new one.\n\n' +
        'Organization-wide, like every organization write: `{id}` must be the active ' +
        'organization, and a workspace-scoped session token gets `403 WORKSPACE_SCOPED`.',
      tags: ['Organizations'],
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
      operationId: 'deleteOrganizationLogo',
      summary: 'Remove the organization logo (owner/admin only)',
      description:
        'Clears the logo; clients fall back to the initials of the name. Idempotent — an ' +
        'organization with no logo answers 200 with `logoUrl: null`.',
      tags: ['Organizations'],
      responses: {
        '200': {
          description: 'Logo removed',
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
  },
};

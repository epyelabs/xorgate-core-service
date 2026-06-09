import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const OPENAPI_SPEC = (baseUrl: string) => ({
  openapi: '3.0.3',
  info: {
    title: 'Xorgate Core API',
    version: '0.1.0',
    description:
      'Backend API for organizations, projects, devices, and platform-level device models. ' +
      'Most endpoints require a Bearer JWT (Cognito ID token). Org-scoped endpoints additionally ' +
      'resolve the active organization from the `X-Organization-Id` header (omit if the caller belongs to a single org).',
  },
  servers: [{ url: baseUrl }],
  security: [{ BearerAuth: [] }],
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    parameters: {
      OrganizationIdHeader: {
        name: 'X-Organization-Id',
        in: 'header',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description:
          'Active organization UUID. Required when the caller belongs to more than one organization.',
      },
      ProjectIdHeader: {
        name: 'X-Project-Id',
        in: 'header',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description:
          'Optional project UUID. When present on GET /devices, the response is filtered to devices in this project. Must belong to the active organization.',
      },
      IdPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    },
    schemas: {
      ApiError: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      User: {
        type: 'object',
        required: ['id', 'email', 'tier', 'role'],
        properties: {
          id: { type: 'string', description: 'Cognito sub' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string', nullable: true },
          tier: { type: 'string', enum: ['free', 'pro', 'team'] },
          role: { type: 'string', enum: ['user', 'admin'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Organization: {
        type: 'object',
        required: ['id', 'name', 'slug'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Membership: {
        type: 'object',
        required: ['id', 'userId', 'organizationId', 'role'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string' },
          organizationId: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      ApiKey: {
        type: 'object',
        required: ['id', 'organizationId', 'name', 'scope'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          organizationId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          scope: { type: 'string', enum: ['edge', 'cloud', 'client'] },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          revokedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Project: {
        type: 'object',
        required: ['id', 'organizationId', 'name', 'slug'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          organizationId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          description: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      DeviceModel: {
        type: 'object',
        required: ['id', 'name', 'sku'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          sku: { type: 'string' },
          ioCapabilities: {
            type: 'object',
            additionalProperties: true,
            description:
              'Structured capabilities (jsonb): { schemaVersion, media{video[],audio[]}, sensors{imu}, comm{gps,signal}, system }. ' +
              'Drives telemetry metrics and media stream keys (cam0/cam1/audio0).',
            nullable: true,
          },
          firmwareChannel: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Device: {
        type: 'object',
        required: ['id', 'projectId', 'deviceModelId', 'serial', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          deviceModelId: { type: 'string', format: 'uuid' },
          serial: { type: 'string' },
          name: { type: 'string', nullable: true },
          firmwareVersion: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['provisioned', 'online', 'offline', 'decommissioned'],
          },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      DeviceProvisioning: {
        type: 'object',
        required: ['device', 'iot', 'mqtt', 'kvs'],
        description:
          'One-shot credential bundle returned by POST /devices/{id}/provision. ' +
          'certificatePem and privateKey are shown only here and are never stored server-side.',
        properties: {
          device: {
            type: 'object',
            required: ['id', 'thingName'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              thingName: { type: 'string', description: 'AWS IoT thing name (equals the device id).' },
            },
          },
          iot: {
            type: 'object',
            required: ['dataEndpoint', 'credentialEndpoint', 'roleAlias', 'certificatePem', 'caUrl'],
            properties: {
              dataEndpoint: {
                type: 'string',
                description: 'AWS IoT Core data endpoint (iot:Data-ATS); MQTT over mTLS on port 8883.',
              },
              credentialEndpoint: {
                type: 'string',
                description: 'AWS IoT credential-provider endpoint used with the role alias to obtain short-lived AWS creds.',
              },
              roleAlias: { type: 'string', description: 'IoT role alias the device assumes for KVS + S3 access.' },
              certificatePem: { type: 'string', description: 'X.509 device certificate (PEM). Shown once.' },
              privateKey: {
                type: 'string',
                nullable: true,
                description: 'Device private key (PEM). Shown once, never stored.',
              },
              caUrl: { type: 'string', format: 'uri', description: 'Amazon Root CA 1 download URL.' },
            },
          },
          mqtt: {
            type: 'object',
            required: ['telemetryTopic', 'statusTopic'],
            properties: {
              telemetryTopic: { type: 'string', example: 'xorgate/devices/{id}/telemetry' },
              statusTopic: { type: 'string', example: 'xorgate/devices/{id}/status' },
            },
          },
          kvs: {
            type: 'object',
            required: ['region', 'channels'],
            properties: {
              region: { type: 'string' },
              channels: {
                type: 'array',
                description: 'One signaling channel per declared video stream.',
                items: {
                  type: 'object',
                  required: ['streamKey', 'channelName', 'channelArn'],
                  properties: {
                    streamKey: { type: 'string', example: 'cam0' },
                    channelName: { type: 'string', description: '`${deviceId}-${streamKey}`' },
                    channelArn: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      KvsChannel: {
        type: 'object',
        required: ['streamKey', 'channelName', 'channelArn', 'region'],
        description: 'A KVS WebRTC signaling channel for the browser viewer.',
        properties: {
          streamKey: { type: 'string', example: 'cam0' },
          channelName: { type: 'string', description: '`${deviceId}-${streamKey}`' },
          channelArn: { type: 'string' },
          region: { type: 'string', example: 'us-east-1' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Unauthorized',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      Forbidden: {
        description: 'Forbidden',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      NotFound: {
        description: 'Not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      BadRequest: {
        description: 'Bad request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      Conflict: {
        description: 'Conflict',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      NoContent: { description: 'No content' },
    },
  },
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Service health',
        tags: ['Meta'],
        security: [],
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'stage'],
                  properties: {
                    ok: { type: 'boolean' },
                    stage: { type: 'string', enum: ['dev', 'prod'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/me': {
      get: {
        operationId: 'getMe',
        summary: 'Current user, memberships, and organizations',
        tags: ['User'],
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
                    organizations: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/organizations': {
      get: {
        operationId: 'listOrganizations',
        summary: 'List organizations the caller is a member of',
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
        },
      },
      post: {
        operationId: 'createOrganization',
        summary: 'Create a new organization and become its owner',
        description:
          'Bootstraps an organization for the caller and inserts a `memberships` row with `role: owner`. ' +
          'Does NOT require `X-Organization-Id` (the caller may have no orgs yet).',
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
        },
      },
    },
    '/organizations/{id}': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getOrganization',
        summary: 'Get the active organization',
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
        tags: ['Organizations'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
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
        tags: ['Organizations'],
        responses: {
          '204': { $ref: '#/components/responses/NoContent' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/memberships': {
      parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listMemberships',
        summary: 'List members of the active organization',
        tags: ['Memberships'],
        responses: {
          '200': {
            description: 'List of memberships',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['memberships'],
                  properties: {
                    memberships: { type: 'array', items: { $ref: '#/components/schemas/Membership' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        operationId: 'addMembership',
        summary: 'Add a user to the active organization (owner/admin only)',
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
            description: 'Membership created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['membership'],
                  properties: { membership: { $ref: '#/components/schemas/Membership' } },
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
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      delete: {
        operationId: 'removeMembership',
        summary: 'Remove a member (owner/admin only; cannot remove the last owner)',
        tags: ['Memberships'],
        responses: {
          '204': { $ref: '#/components/responses/NoContent' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api-keys': {
      parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listApiKeys',
        summary: 'List API keys for the active organization',
        tags: ['API Keys'],
        responses: {
          '200': {
            description: 'List of API key metadata (hashed_key is never returned)',
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
        },
      },
      post: {
        operationId: 'createApiKey',
        summary: 'Mint a new API key (owner/admin only)',
        description:
          'Returns the plaintext key exactly once. Persist it client-side immediately — it cannot be retrieved later.',
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
                  scope: { type: 'string', enum: ['edge', 'cloud', 'client'] },
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
                    plaintext_key: { type: 'string', description: 'Save this — not retrievable later.' },
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
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      delete: {
        operationId: 'deleteApiKey',
        summary: 'Permanently delete an API key (owner/admin only)',
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
    '/projects': {
      parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listProjects',
        summary: 'List projects in the active organization',
        tags: ['Projects'],
        responses: {
          '200': {
            description: 'List of projects',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['projects'],
                  properties: {
                    projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        operationId: 'createProject',
        summary: 'Create a project in the active organization',
        tags: ['Projects'],
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
            description: 'Project created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['project'],
                  properties: { project: { $ref: '#/components/schemas/Project' } },
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
    '/projects/{id}': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getProject',
        summary: 'Get a project',
        tags: ['Projects'],
        responses: {
          '200': {
            description: 'Project',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['project'],
                  properties: { project: { $ref: '#/components/schemas/Project' } },
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
        operationId: 'updateProject',
        summary: 'Update a project',
        tags: ['Projects'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
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
            description: 'Project updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['project'],
                  properties: { project: { $ref: '#/components/schemas/Project' } },
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
        operationId: 'deleteProject',
        summary: 'Delete a project',
        tags: ['Projects'],
        responses: {
          '204': { $ref: '#/components/responses/NoContent' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/device-models': {
      get: {
        operationId: 'listDeviceModels',
        summary: 'List the platform-wide device model catalog',
        description:
          'Read access is open to any authenticated user. Mutations require a platform-admin role (users.role = "admin").',
        tags: ['Device Models'],
        responses: {
          '200': {
            description: 'List of device models',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device_models'],
                  properties: {
                    device_models: { type: 'array', items: { $ref: '#/components/schemas/DeviceModel' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        operationId: 'createDeviceModel',
        summary: 'Add a device model (platform admin only)',
        tags: ['Device Models'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'sku'],
                properties: {
                  name: { type: 'string' },
                  sku: { type: 'string' },
                  ioCapabilities: { type: 'object', additionalProperties: true, nullable: true },
                  firmwareChannel: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Device model created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device_model'],
                  properties: { device_model: { $ref: '#/components/schemas/DeviceModel' } },
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
    '/device-models/{id}': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }],
      get: {
        operationId: 'getDeviceModel',
        summary: 'Get a device model',
        tags: ['Device Models'],
        responses: {
          '200': {
            description: 'Device model',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device_model'],
                  properties: { device_model: { $ref: '#/components/schemas/DeviceModel' } },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        operationId: 'updateDeviceModel',
        summary: 'Update a device model (platform admin only)',
        tags: ['Device Models'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  sku: { type: 'string' },
                  ioCapabilities: { type: 'object', additionalProperties: true, nullable: true },
                  firmwareChannel: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Device model updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device_model'],
                  properties: { device_model: { $ref: '#/components/schemas/DeviceModel' } },
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
        operationId: 'deleteDeviceModel',
        summary: 'Delete a device model (platform admin only)',
        tags: ['Device Models'],
        responses: {
          '204': { $ref: '#/components/responses/NoContent' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/devices': {
      parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listDevices',
        summary: 'List devices in the active organization',
        description:
          'Returns every device whose project belongs to the active organization. ' +
          'Pass X-Project-Id to filter the results to a single project.',
        parameters: [{ $ref: '#/components/parameters/ProjectIdHeader' }],
        tags: ['Devices'],
        responses: {
          '200': {
            description: 'List of devices',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['devices'],
                  properties: {
                    devices: { type: 'array', items: { $ref: '#/components/schemas/Device' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        operationId: 'createDevice',
        summary: 'Register a device under a project in the active organization',
        tags: ['Devices'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId', 'deviceModelId', 'serial'],
                properties: {
                  projectId: { type: 'string', format: 'uuid' },
                  deviceModelId: { type: 'string', format: 'uuid' },
                  serial: { type: 'string' },
                  name: { type: 'string', nullable: true },
                  firmwareVersion: { type: 'string', nullable: true },
                  status: {
                    type: 'string',
                    enum: ['provisioned', 'online', 'offline', 'decommissioned'],
                    default: 'provisioned',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Device created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device'],
                  properties: { device: { $ref: '#/components/schemas/Device' } },
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
    '/devices/{id}': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getDevice',
        summary: 'Get a device',
        tags: ['Devices'],
        responses: {
          '200': {
            description: 'Device',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device'],
                  properties: { device: { $ref: '#/components/schemas/Device' } },
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
        operationId: 'updateDevice',
        summary: 'Update mutable device fields',
        tags: ['Devices'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', nullable: true },
                  firmwareVersion: { type: 'string', nullable: true },
                  status: {
                    type: 'string',
                    enum: ['provisioned', 'online', 'offline', 'decommissioned'],
                  },
                  lastSeenAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Device updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['device'],
                  properties: { device: { $ref: '#/components/schemas/Device' } },
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
        operationId: 'deleteDevice',
        summary: 'Delete a device',
        tags: ['Devices'],
        responses: {
          '204': { $ref: '#/components/responses/NoContent' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/devices/{id}/provision': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      post: {
        operationId: 'provisionDevice',
        summary: 'Provision device identity (owner/admin only)',
        description:
          'Mints an AWS IoT thing + X.509 certificate, attaches the device policy, and creates a KVS signaling ' +
          'channel per declared video stream. Returns the certificate, private key, and connection endpoints ' +
          'exactly once — persist them on the device immediately, they cannot be retrieved later. Idempotent: a ' +
          'second call for an already-provisioned device returns 409.',
        tags: ['Devices'],
        responses: {
          '201': {
            description: 'Device provisioned. Credential bundle shown only here.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceProvisioning' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/devices/{id}/kvs-channels': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getDeviceKvsChannels',
        summary: 'List the device\'s KVS signaling channels (for the browser viewer)',
        description:
          'Returns the device\'s KVS WebRTC signaling channels (one per provisioned video stream). The browser ' +
          'obtains its own scoped AWS credentials via the Cognito identity pool, so this endpoint returns channel ' +
          'metadata only (no credentials). An empty array means the device is not yet provisioned.',
        tags: ['Devices'],
        responses: {
          '200': {
            description: 'KVS channels (possibly empty if the device is not provisioned).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['channels'],
                  properties: {
                    channels: { type: 'array', items: { $ref: '#/components/schemas/KvsChannel' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
});

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Xorgate Core API — Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    });
  </script>
</body>
</html>`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const reqPath = event.rawPath;
  const baseUrl = process.env.DOCS_BASE_URL ?? '/';

  if (reqPath === '/openapi.json') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        ...CORS_HEADERS,
      },
      body: JSON.stringify(OPENAPI_SPEC(baseUrl)),
    };
  }

  if (reqPath.startsWith('/docs')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: SWAGGER_UI_HTML,
    };
  }

  return {
    statusCode: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  };
};

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const OPENAPI_SPEC = (baseUrl: string) => ({
  openapi: '3.0.3',
  info: {
    title: 'Xorgate Core API',
    version: '0.1.0',
    description:
      'Backend API for organizations, workspaces, devices, and platform-level device models. ' +
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
      WorkspaceIdHeader: {
        name: 'X-Workspace-Id',
        in: 'header',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description:
          'Optional workspace UUID. When present on GET /devices, the response is filtered to devices in this workspace. Must belong to the active organization.',
      },
      IdPath: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      RecordingIdPath: {
        name: 'recordingId',
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
      // A membership enriched with its member's identity, as returned by the
      // GET /memberships roster. `user` is null only if the referenced user row
      // is missing (normally impossible — a membership cascades with its user).
      MembershipWithUser: {
        type: 'object',
        required: ['id', 'userId', 'organizationId', 'role', 'user'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string' },
          organizationId: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'] },
          createdAt: { type: 'string', format: 'date-time' },
          user: {
            type: 'object',
            nullable: true,
            required: ['id', 'email', 'name'],
            properties: {
              id: { type: 'string' },
              email: { type: 'string', format: 'email' },
              name: { type: 'string', nullable: true },
            },
          },
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
      Workspace: {
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
        required: ['id', 'workspaceId', 'deviceModelId', 'serial', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          workspaceId: { type: 'string', format: 'uuid' },
          deviceModelId: { type: 'string', format: 'uuid' },
          serial: { type: 'string' },
          name: { type: 'string', nullable: true },
          firmwareVersion: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['provisioned', 'online', 'offline', 'decommissioned'],
          },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          persistTelemetry: {
            type: 'boolean',
            description: 'Opt-in: when true, telemetry is written to the DB (default false).',
          },
          autoRecord: {
            type: 'boolean',
            description: 'Opt-in: when true, streams are auto-recorded while live (default false).',
          },
          gnssAntBias: {
            type: 'boolean',
            description:
              'GPS antenna mode: true powers an active antenna (DC bias over the coax), false (default) = passive antenna, bias off. ' +
              'Changes are delivered to the device via a retained MQTT config message.',
          },
          activeStreamsViewType: {
            type: 'string',
            enum: ['card', 'map'],
            description: 'Layout for the Active Streams tab: card grid (default) or location-first map view.',
          },
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
      TelemetryReading: {
        type: 'object',
        required: ['ts', 'metric'],
        description:
          'One telemetry reading (raw) or one downsample bucket (when `interval` was given; ' +
          '`value` is then the bucket average and `ts` the bucket start).',
        properties: {
          ts: { type: 'string', format: 'date-time' },
          metric: { type: 'string', example: 'imu.z' },
          value: { type: 'number', nullable: true },
          unit: { type: 'string', nullable: true, example: 'm/s^2' },
        },
      },
      DeviceLatest: {
        type: 'object',
        required: ['ts', 'metric'],
        description: 'The most recent reading for one (device, metric) pair.',
        properties: {
          metric: { type: 'string', example: 'system.cpu_temp' },
          value: { type: 'number', nullable: true },
          unit: { type: 'string', nullable: true, example: '°C' },
          ts: { type: 'string', format: 'date-time' },
        },
      },
      Recording: {
        type: 'object',
        required: ['id', 'deviceId', 'streamKey', 'status', 'trigger', 'startedAt'],
        description:
          'A cloud-side recording of one stream, captured by a headless KVS viewer (Fargate) ' +
          'and stored as a single MP4 in S3. The row flips to `completed` once the upload lands.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          streamKey: { type: 'string', example: 'cam0' },
          status: { type: 'string', enum: ['recording', 'completed', 'failed'] },
          trigger: { type: 'string', enum: ['manual', 'auto'] },
          startedAt: { type: 'string', format: 'date-time' },
          endedAt: { type: 'string', format: 'date-time', nullable: true },
          s3Key: {
            type: 'string',
            nullable: true,
            description: 'media/v1/<deviceId>/<streamKey>/<id>.mp4',
          },
          sizeBytes: { type: 'integer', nullable: true },
          durationMs: { type: 'integer', nullable: true },
          taskArn: { type: 'string', nullable: true, description: 'Fargate task ARN (while recording).' },
          createdAt: { type: 'string', format: 'date-time' },
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
            description: 'List of memberships, each enriched with its member’s identity',
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
        },
      },
      post: {
        operationId: 'addMembership',
        summary: 'Add a user to the active organization (owner/admin only)',
        description:
          'Adds a member by `userId` or `email`. If an `email` has no account yet, a ' +
          'Cognito account is provisioned and the invitee is emailed a temporary ' +
          'password to set on first sign-in. `invited` is true when a new account was ' +
          'created and emailed.',
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
    '/workspaces': {
      parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listWorkspaces',
        summary: 'List workspaces in the active organization',
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
        },
      },
      post: {
        operationId: 'createWorkspace',
        summary: 'Create a workspace in the active organization',
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
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
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
        tags: ['Workspaces'],
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
        tags: ['Workspaces'],
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
          'Returns every device whose workspace belongs to the active organization. ' +
          'Pass X-Workspace-Id to filter the results to a single workspace.',
        parameters: [{ $ref: '#/components/parameters/WorkspaceIdHeader' }],
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
        summary: 'Register a device under a workspace in the active organization',
        tags: ['Devices'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['workspaceId', 'deviceModelId', 'serial'],
                properties: {
                  workspaceId: { type: 'string', format: 'uuid' },
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
                  persistTelemetry: { type: 'boolean' },
                  autoRecord: { type: 'boolean' },
                  gnssAntBias: { type: 'boolean' },
                  activeStreamsViewType: {
                    type: 'string',
                    enum: ['card', 'map'],
                  },
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
    '/devices/{id}/recordings': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listRecordings',
        summary: 'List recordings for a device',
        tags: ['Recordings'],
        responses: {
          '200': {
            description: 'Recordings, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['recordings'],
                  properties: {
                    recordings: { type: 'array', items: { $ref: '#/components/schemas/Recording' } },
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
      post: {
        operationId: 'startRecording',
        summary: 'Start recording one stream (or all)',
        description:
          'Launches a cloud viewer-recorder (Fargate) for the given stream. Pass `{"all": true}` to start ' +
          'one recorder per media channel. Trigger is "manual".',
        tags: ['Recordings'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Provide `streamKey`, or `all: true` to record every channel.',
                properties: {
                  streamKey: { type: 'string', example: 'cam0' },
                  all: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Started. `recording` for a single stream; `recordings` for `{all:true}`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    recording: { $ref: '#/components/schemas/Recording' },
                    recordings: { type: 'array', items: { $ref: '#/components/schemas/Recording' } },
                  },
                },
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
    '/devices/{id}/recordings/{recordingId}': {
      parameters: [
        { $ref: '#/components/parameters/IdPath' },
        { $ref: '#/components/parameters/RecordingIdPath' },
        { $ref: '#/components/parameters/OrganizationIdHeader' },
      ],
      delete: {
        operationId: 'deleteRecording',
        summary: 'Delete a recording (stops it if active; removes the S3 object)',
        tags: ['Recordings'],
        responses: {
          '204': { $ref: '#/components/responses/NoContent' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/devices/{id}/recordings/{recordingId}/stop': {
      parameters: [
        { $ref: '#/components/parameters/IdPath' },
        { $ref: '#/components/parameters/RecordingIdPath' },
        { $ref: '#/components/parameters/OrganizationIdHeader' },
      ],
      post: {
        operationId: 'stopRecording',
        summary: 'Stop an active recording',
        description:
          'Stops the recorder task. The MP4 is finalized and uploaded asynchronously; the row flips to ' +
          '`completed` shortly after via the S3 finalize event.',
        tags: ['Recordings'],
        responses: {
          '200': {
            description: 'Stop requested.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['recording'],
                  properties: { recording: { $ref: '#/components/schemas/Recording' } },
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
    '/devices/{id}/recordings/{recordingId}/playback': {
      parameters: [
        { $ref: '#/components/parameters/IdPath' },
        { $ref: '#/components/parameters/RecordingIdPath' },
        { $ref: '#/components/parameters/OrganizationIdHeader' },
      ],
      get: {
        operationId: 'getRecordingPlayback',
        summary: 'Get a presigned playback URL for a recording',
        tags: ['Recordings'],
        responses: {
          '200': {
            description: 'Presigned S3 GET URL for the MP4.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url', 'expiresIn'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    expiresIn: { type: 'integer', description: 'URL TTL in seconds.' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/devices/{id}/telemetry': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getDeviceTelemetry',
        summary: 'Query historical telemetry over a time range',
        description:
          'Returns telemetry_readings rows for the device over `[from, to)` (max 31 days), ordered by `ts`. ' +
          'With `interval` (seconds) the result is downsampled server-side: readings are grouped into ' +
          '`interval`-wide buckets per metric and averaged. Without it, raw rows are returned up to a hard cap; ' +
          '`truncated: true` signals the cap was hit (narrow the range or pass `interval`).',
        tags: ['Devices'],
        parameters: [
          {
            name: 'from',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
            description: 'Range start (inclusive), ISO-8601.',
          },
          {
            name: 'to',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
            description: 'Range end (exclusive), ISO-8601.',
          },
          {
            name: 'metric',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Comma-separated metric filter (max 20), e.g. `imu.accel_x,imu.euler_yaw,gps.lat`.',
          },
          {
            name: 'interval',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 86400 },
            description: 'Downsample bucket width in seconds.',
          },
        ],
        responses: {
          '200': {
            description: 'Telemetry readings (raw or bucket-averaged), ordered by ts then metric.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['readings', 'bucketSeconds', 'truncated'],
                  properties: {
                    readings: { type: 'array', items: { $ref: '#/components/schemas/TelemetryReading' } },
                    bucketSeconds: {
                      type: 'integer',
                      nullable: true,
                      description: 'Echo of `interval`; null when raw rows were returned.',
                    },
                    truncated: {
                      type: 'boolean',
                      description: 'True when the row cap was hit and the result is incomplete.',
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
    '/devices/{id}/telemetry/latest': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getDeviceTelemetryLatest',
        summary: "The device's most recent reading per metric",
        description:
          'Returns the device_latest rows (one per metric, last-writer-wins), ordered by metric. ' +
          'Empty when the device has never reported telemetry.',
        tags: ['Devices'],
        responses: {
          '200': {
            description: 'Latest reading per metric.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['latest'],
                  properties: {
                    latest: { type: 'array', items: { $ref: '#/components/schemas/DeviceLatest' } },
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
    '/devices/{id}/telemetry/readings': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getDeviceTelemetryReadings',
        summary: 'Paginated raw telemetry readings for the history table',
        description:
          'Returns raw (un-averaged) telemetry_readings rows for one page, paginated over DISTINCT ' +
          'timestamps so a page boundary never splits a sample. Defaults to the latest samples ' +
          '(`order=desc`) with no time window. `limit`/`offset` count timestamps (samples), not rows. ' +
          'The `page.total` field is the total distinct-timestamp count matching the filter.',
        tags: ['Devices'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            description: 'Timestamps (samples) per page.',
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, default: 0 },
            description: 'Timestamps to skip (page offset).',
          },
          {
            name: 'order',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            description: 'Sort direction by ts.',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            description: 'Optional range start (inclusive), ISO-8601.',
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            description: 'Optional range end (exclusive), ISO-8601.',
          },
          {
            name: 'metric',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Comma-separated metric filter (max 20), e.g. `imu.accel_x,gps.lat`.',
          },
        ],
        responses: {
          '200': {
            description: 'One page of raw readings, ordered by ts then metric.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['readings', 'page'],
                  properties: {
                    readings: { type: 'array', items: { $ref: '#/components/schemas/TelemetryReading' } },
                    page: {
                      type: 'object',
                      required: ['limit', 'offset', 'order', 'total'],
                      properties: {
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        order: { type: 'string', enum: ['asc', 'desc'] },
                        total: { type: 'integer', description: 'Total distinct timestamps matching the filter.' },
                      },
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

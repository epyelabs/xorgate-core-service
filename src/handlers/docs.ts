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
      SessionIdPath: {
        name: 'sessionId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      SegmentSeqPath: {
        name: 'seq',
        in: 'path',
        required: true,
        schema: { type: 'integer', minimum: 0 },
        description: 'Segment sequence number within the session (0-based).',
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
          imuMount: {
            type: 'object',
            nullable: true,
            description:
              'IMU mounting correction: how the sensor is physically rotated relative to the vehicle ' +
              '(ZYX euler, degrees). Delivered to the device via a retained MQTT config message; when ' +
              'enabled, the agent publishes vehicle-frame euler angles (the raw quaternion stays sensor-frame). ' +
              'null = never configured.',
            properties: {
              enabled: { type: 'boolean' },
              rollDeg: { type: 'number' },
              pitchDeg: { type: 'number' },
              yawDeg: { type: 'number' },
            },
          },
          imuView: {
            type: 'object',
            nullable: true,
            description:
              'Camera direction for the web 3D orientation view (azimuth/elevation, degrees). ' +
              'Cloud-only; null = the built-in default 3/4 angle.',
            properties: {
              azimuthDeg: { type: 'number' },
              elevationDeg: { type: 'number' },
            },
          },
          recordingConfig: {
            allOf: [{ $ref: '#/components/schemas/RecordingConfig' }],
            nullable: true,
            description:
              'On-device recording config. Delivered to the device via a retained MQTT config ' +
              'message and applied live by the agent. null = never configured from the cloud ' +
              '(recording off by default; any device-local settings are left untouched).',
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      RecordingConfig: {
        type: 'object',
        additionalProperties: false,
        description:
          'On-device recording settings (`recording` namespace). All fields optional — omitted ' +
          'fields fall back to device defaults. Unknown keys and out-of-range values are rejected.',
        properties: {
          telemetry: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean', description: 'Record telemetry locally (default false).' },
              rateHz: {
                type: 'integer',
                minimum: 1,
                maximum: 20,
                description:
                  'Target sample rate. Each sensor group is additionally capped by its native cadence ' +
                  '(IMU 20 Hz, GPS 1 Hz, system 1 Hz). Default 10.',
              },
            },
          },
          video: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean', description: 'Record camera video locally (default false).' },
              preset: {
                type: 'string',
                enum: ['1080p30-4mbps', '1080p15-2mbps', '720p30-2mbps'],
                description: 'Closed quality preset table (bounded CPU cost). Default 1080p15-2mbps.',
              },
              segmentSeconds: {
                type: 'integer',
                minimum: 10,
                maximum: 300,
                description: 'Segment length — the unit of upload, retry and eviction. Default 60.',
              },
            },
          },
          upload: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: {
                type: 'string',
                enum: ['auto', 'off'],
                description: 'auto (default): drain segments to S3 whenever connected; off: keep local only.',
              },
            },
          },
          retention: {
            type: 'object',
            additionalProperties: false,
            properties: {
              maxBytes: {
                type: 'integer',
                minimum: 536870912,
                maximum: 1099511627776,
                description: 'Local recordings quota in bytes (oldest segments evicted first). Default 10 GiB.',
              },
              minFreeBytes: {
                type: 'integer',
                minimum: 0,
                maximum: 68719476736,
                description: 'Free-disk floor in bytes; recording evicts/stops before crossing it. Default 2 GiB.',
              },
            },
          },
        },
      },
      MediaSession: {
        type: 'object',
        required: ['id', 'deviceId', 'streamKey', 'startedAt', 'status'],
        description:
          'A continuous on-device recording run for one camera (offline recording plan). Sessions are ' +
          'per-camera: a dual-camera drive is two sessions with near-identical startedAt. `status` is ' +
          'advisory — a session closes ~10 min after segments stop arriving and reopens if a straggler ' +
          'segment lands later.',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Device-minted UUIDv7 (sorts by start time).' },
          deviceId: { type: 'string', format: 'uuid' },
          streamKey: { type: 'string', example: 'cam0' },
          startedAt: { type: 'string', format: 'date-time' },
          endedAt: { type: 'string', format: 'date-time', nullable: true },
          codec: { type: 'string', nullable: true, example: 'h264' },
          width: { type: 'integer', nullable: true },
          height: { type: 'integer', nullable: true },
          fps: { type: 'integer', nullable: true },
          bitrateKbps: { type: 'integer', nullable: true },
          source: { type: 'string', nullable: true, example: 'device-offline' },
          status: { type: 'string', enum: ['open', 'closed'] },
          timeSource: {
            type: 'string',
            nullable: true,
            enum: ['ntp', 'rtc', 'unsynced'],
            description: 'Device clock quality at session start; "unsynced" timestamps may be wrong wall-clock.',
          },
          lastSegmentAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Server-side arrival time of the most recent segment (upload can lag recording).',
          },
          createdAt: { type: 'string', format: 'date-time' },
          segmentCount: { type: 'integer', description: 'Rollup (list endpoint only).' },
          totalBytes: { type: 'integer', description: 'Rollup (list endpoint only).' },
          totalDurationMs: { type: 'integer', description: 'Rollup (list endpoint only).' },
        },
      },
      MediaSegment: {
        type: 'object',
        required: ['id', 'deviceId', 'sessionId', 'streamKey', 's3Key', 'seq', 'startTs', 'durationMs'],
        description:
          'One ~60 s MP4 segment of a media session. `finalized: false` = crash-cut partial ' +
          '(fragmented MP4, playable up to the cut). When stitching, prefer the next segment\'s ' +
          'startTs delta over durationMs (segment 0 includes ~2 s pipeline startup).',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          sessionId: { type: 'string', format: 'uuid' },
          streamKey: { type: 'string', example: 'cam0' },
          s3Key: {
            type: 'string',
            description: 'media-sessions/v1/<deviceId>/<streamKey>/<sessionId>/<seq>.mp4',
          },
          seq: { type: 'integer' },
          startTs: { type: 'string', format: 'date-time' },
          durationMs: { type: 'integer' },
          keyframe: { type: 'boolean' },
          sizeBytes: { type: 'integer', nullable: true },
          finalized: { type: 'boolean' },
          meta: {
            type: 'object',
            additionalProperties: true,
            nullable: true,
            description: 'Sidecar provenance passthrough (anchor, timeSource, startMono).',
          },
          uploadedAt: { type: 'string', format: 'date-time' },
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
      DeviceCommandAccepted: {
        description:
          'Command published to the device. Delivery to the broker only — the device may still ' +
          'reject it as expired or already-executed, and the real outcome is observed via device status.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['requestId', 'command', 'expiresAt'],
              properties: {
                requestId: {
                  type: 'string',
                  format: 'uuid',
                  description: 'Replay key. The device refuses to execute the same one twice.',
                },
                command: { type: 'string', enum: ['reboot', 'power_off'] },
                expiresAt: {
                  type: 'integer',
                  format: 'int64',
                  description: 'Epoch ms after which the device refuses the command.',
                },
              },
            },
          },
        },
      },
      DeviceCommandPublishFailed: {
        description: 'Delivering the command to the device failed (COMMAND_PUBLISH_FAILED). Retry.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
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
                  imuMount: {
                    type: 'object',
                    nullable: true,
                    description:
                      'IMU mounting correction (ZYX euler, degrees); null clears it. ' +
                      'Delivered to the device as a retained MQTT config message.',
                    properties: {
                      enabled: { type: 'boolean' },
                      rollDeg: { type: 'number' },
                      pitchDeg: { type: 'number' },
                      yawDeg: { type: 'number' },
                    },
                  },
                  imuView: {
                    type: 'object',
                    nullable: true,
                    description:
                      '3D orientation view camera (degrees); elevation is clamped to ±85. null resets to default.',
                    properties: {
                      azimuthDeg: { type: 'number' },
                      elevationDeg: { type: 'number' },
                    },
                  },
                  recordingConfig: {
                    allOf: [{ $ref: '#/components/schemas/RecordingConfig' }],
                    nullable: true,
                    description:
                      'On-device recording settings. Validated strictly (closed preset table, bounded ' +
                      'numbers, unknown keys rejected 400) and delivered to the device as a retained MQTT ' +
                      'config message; the agent applies it live within a few seconds. null clears the ' +
                      'cloud-managed config (the device keeps its current local settings). Note: toggling ' +
                      'video recording or changing its preset briefly restarts the live stream.',
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
    '/devices/{id}/reboot': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      post: {
        operationId: 'rebootDevice',
        summary: 'Reboot a device (owner/admin only)',
        description:
          'Publishes a one-shot reboot command to the device over MQTT and returns immediately — 202 means the ' +
          'command was delivered to the broker, not that the device has rebooted. Observe the outcome via the ' +
          'device status: it goes offline, then back online. The device must be online (409 otherwise): commands ' +
          'are not retained, so there is nothing for an offline device to pick up later. The command expires ' +
          '60 seconds after issue and carries a request id the device refuses to execute twice, so a stale or ' +
          'redelivered command cannot cause a surprise reboot.',
        tags: ['Devices'],
        responses: {
          '202': { $ref: '#/components/responses/DeviceCommandAccepted' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
          '502': { $ref: '#/components/responses/DeviceCommandPublishFailed' },
        },
      },
    },
    '/devices/{id}/power-off': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      post: {
        operationId: 'powerOffDevice',
        summary: 'Power off a device (owner/admin only)',
        description:
          'Publishes a one-shot power-off command to the device over MQTT. Same delivery semantics and guards as ' +
          'the reboot command, but NOT remotely recoverable: the device stays off until someone physically powers ' +
          'it back on. The device must be online (409 otherwise).',
        tags: ['Devices'],
        responses: {
          '202': { $ref: '#/components/responses/DeviceCommandAccepted' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
          '502': { $ref: '#/components/responses/DeviceCommandPublishFailed' },
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
    '/devices/{id}/sessions': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listMediaSessions',
        summary: 'List device-recorded media sessions',
        description:
          'Sessions recorded on the device itself (offline recording plan) and uploaded segment-by-segment ' +
          'to S3 — distinct from cloud /recordings. Filterable by streamKey, status (open|closed) and ' +
          'from/to; the time filter matches sessions OVERLAPPING [from, to), not just those started inside ' +
          'it. Each row carries computed rollups (segmentCount, totalBytes, totalDurationMs).',
        tags: ['Media Sessions'],
        parameters: [
          {
            name: 'streamKey',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Filter to one camera, e.g. cam0.',
          },
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['open', 'closed'] },
          },
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'order', in: 'query', required: false, schema: { type: 'string', enum: ['asc', 'desc'] } },
          {
            name: 'sort',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['startedAt', 'createdAt'] },
          },
        ],
        responses: {
          '200': {
            description: 'Sessions with per-session rollups, newest first by default.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sessions'],
                  properties: {
                    sessions: { type: 'array', items: { $ref: '#/components/schemas/MediaSession' } },
                    page: {
                      type: 'object',
                      properties: {
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        order: { type: 'string', enum: ['asc', 'desc'] },
                        total: { type: 'integer' },
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
    '/devices/{id}/sessions/{sessionId}': {
      parameters: [
        { $ref: '#/components/parameters/IdPath' },
        { $ref: '#/components/parameters/SessionIdPath' },
        { $ref: '#/components/parameters/OrganizationIdHeader' },
      ],
      delete: {
        operationId: 'deleteMediaSession',
        summary: 'Delete a device-recorded media session',
        description:
          'Deletes every segment object (video + sidecar) from storage and removes the session and its ' +
          'segment index rows. Owner/admin only — device-recorded sessions are not re-creatable. A segment ' +
          'still uploading from the device after the delete recreates the session index (at-least-once ' +
          'ingest); delete again once the device has drained.',
        tags: ['Media Sessions'],
        responses: {
          '204': { description: 'Session deleted.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/devices/{id}/sessions/{sessionId}/segments': {
      parameters: [
        { $ref: '#/components/parameters/IdPath' },
        { $ref: '#/components/parameters/SessionIdPath' },
        { $ref: '#/components/parameters/OrganizationIdHeader' },
      ],
      get: {
        operationId: 'listMediaSessionSegments',
        summary: 'List a session\'s full segment index',
        description:
          'The whole ordered index in one response (seq asc = chronological) — this is the replay/' +
          'stitching input, so it is deliberately unpaginated.',
        tags: ['Media Sessions'],
        responses: {
          '200': {
            description: 'Session + ordered segments.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'segments'],
                  properties: {
                    session: { $ref: '#/components/schemas/MediaSession' },
                    segments: { type: 'array', items: { $ref: '#/components/schemas/MediaSegment' } },
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
    '/devices/{id}/sessions/{sessionId}/segments/{seq}/playback': {
      parameters: [
        { $ref: '#/components/parameters/IdPath' },
        { $ref: '#/components/parameters/SessionIdPath' },
        { $ref: '#/components/parameters/SegmentSeqPath' },
        { $ref: '#/components/parameters/OrganizationIdHeader' },
      ],
      get: {
        operationId: 'getMediaSegmentPlayback',
        summary: 'Get a presigned playback URL for one segment',
        tags: ['Media Sessions'],
        responses: {
          '200': {
            description: 'Presigned S3 GET URL for the segment MP4 (1 h TTL).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url', 'expiresIn', 'segment'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    expiresIn: { type: 'integer', description: 'URL TTL in seconds.' },
                    segment: { $ref: '#/components/schemas/MediaSegment' },
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

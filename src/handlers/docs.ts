import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  configOpenApiSchemas,
  configPatchRequestSchema,
  uiPrefsPatchRequestSchema,
} from '../config-registry/openapi';

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
          config: {
            allOf: [{ $ref: '#/components/schemas/DeviceConfig' }],
            description:
              'Everything this device is told, in one namespaced document. Written by ' +
              'PATCH /devices/{id}/config and published as a retained MQTT message.',
          },
          configRev: {
            type: 'integer',
            description:
              'Monotonic config revision, bumped on every config write and carried on the ' +
              'retained message as `rev`. The device applies a document newer than its ' +
              'last-applied rev; `configRev > reportedConfig.rev` on an online device means the ' +
              'change is still pending.',
          },
          configUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
          uiPrefs: {
            allOf: [{ $ref: '#/components/schemas/DeviceUiPrefs' }],
            description: 'Cloud-only presentation preferences. Never delivered to the device.',
          },
          reportedConfig: {
            type: 'object',
            additionalProperties: true,
            nullable: true,
            description:
              'Last config report from the device, mirrored off ' +
              '`xorgate/devices/{id}/config/reported`; null until the device has reported at ' +
              'least once (a pre-Phase-3 agent never does). Shape: `{ v, deviceId, ts, rev, ' +
              'origin, effective, status }` — `rev` is the last desired revision the device ' +
              'applied (0 = never received one), `origin` is `cloud`/`local`/`boot`, ' +
              '`effective` holds the post-clamp values actually in force (an absent namespace ' +
              'means device defaults, and `gnssAntBias` is the value the modem daemon applied, ' +
              'not the one requested), and `status` carries a per-namespace ' +
              '`{ state: applied|adjusted|rejected, at, detail?, reason? }`. There is no ' +
              '`pending` state on the wire — the reader computes it as ' +
              '`configRev > reportedConfig.rev` on an online device. `effective.agent.mode` is ' +
              'reported-only (`sim`/`real`): it is never cloud-settable and never gets a ' +
              '`status` entry. `effective.sim` (SIM presence, state, ICCID, phone number, ' +
              'carrier, registration) and `effective.uplink` (which interface carries the ' +
              'default route) are reported-only in exactly the same way — a device cannot be ' +
              'TOLD its ICCID, so neither is a config namespace and neither ever carries a ' +
              '`status`. Both are ABSENT when the device has not reported them, which means ' +
              'unknown and never "no SIM". `effective.apn` is reported-only too: the modem ' +
              "daemon's APN apply machinery — `{ applied, requested?, state: " +
              'in-force|applying|rolled-back|rejected, last_error?, changed_at? }`. `applied` is ' +
              "the APN actually in the modem's data context (the `cellular` namespace's " +
              '`effective.cellular.apn` mirrors it while a change is in flight); an ABSENT ' +
              '`apn` block means the daemon predates the rollback machinery, and a UI must ' +
              'refuse to write the `cellular` namespace to such a device — there is no safety ' +
              'net there. An `origin: "local"` report additionally carries `changed`, the ' +
              'namespaces a local writer altered on the device (`null` = reverted to device ' +
              'defaults); those are validated and merged into `config`, which bumps `configRev` ' +
              'and republishes — unless a newer cloud revision already landed, in which case ' +
              'the cloud value wins and the local change is discarded.',
          },
          reportedAt: { type: 'string', format: 'date-time', nullable: true },
          gnssAntBias: {
            type: 'boolean',
            deprecated: true,
            description:
              'DEPRECATED — read `config.gnssAntBias`. Dual-written during the transition window ' +
              'and dropped by a follow-up migration.',
          },
          activeStreamsViewType: {
            type: 'string',
            enum: ['card', 'map'],
            deprecated: true,
            description: 'DEPRECATED — read `uiPrefs.activeStreamsViewType`.',
          },
          imuMount: {
            allOf: [{ $ref: '#/components/schemas/ImuMountConfig' }],
            nullable: true,
            deprecated: true,
            description: 'DEPRECATED — read `config.imuMount`.',
          },
          imuView: {
            type: 'object',
            nullable: true,
            deprecated: true,
            description: 'DEPRECATED — read `uiPrefs.imuView`.',
            properties: {
              azimuthDeg: { type: 'number' },
              elevationDeg: { type: 'number' },
            },
          },
          recordingConfig: {
            allOf: [{ $ref: '#/components/schemas/RecordingConfig' }],
            nullable: true,
            deprecated: true,
            description: 'DEPRECATED — read `config.recording`.',
          },
          lteRecoveryConfig: {
            allOf: [{ $ref: '#/components/schemas/LteRecoveryConfig' }],
            nullable: true,
            deprecated: true,
            description: 'DEPRECATED — read `config.lteRecovery`.',
          },
          timeSyncConfig: {
            allOf: [{ $ref: '#/components/schemas/TimeSyncConfig' }],
            nullable: true,
            deprecated: true,
            description: 'DEPRECATED — read `config.timeSync`.',
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      // ---- Device config blocks: GENERATED from src/config-registry ----------
      // Bounds, enums, additionalProperties and every field description come
      // from the same zod schemas that validate the request and build the
      // retained MQTT message. The hand-written blocks these replace had
      // drifted: `powerShedding` claimed additionalProperties:false while
      // omitting the three thermal keys the API already accepted.
      ...configOpenApiSchemas(),
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
            enum: ['ntp', 'gps', 'nitz', 'rtc', 'unsynced'],
            description:
              'Device clock quality at session start; "unsynced" timestamps may be wrong wall-clock. "gps"/"nitz" = offline clock step from GNSS / modem NITZ time while NTP was pending.',
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
      RecordingRun: {
        type: 'object',
        required: ['key', 'fromTs', 'toTs', 'streamKeys', 'sessionCount', 'sessions'],
        description:
          'One drive, as a human means it: the media sessions whose intervals are within 60 s of each ' +
          'other, clustered server-side. A session that is still open has no endedAt, so its interval ' +
          'end is estimated as startedAt + the duration uploaded so far — which means an open run\'s ' +
          'toTs grows as its backlog drains.',
        properties: {
          key: {
            type: 'string',
            format: 'uuid',
            description:
              'The earliest member session\'s id — a stable identity across polls. (There is no run row ' +
              'in the database and no device-side run id.)',
          },
          fromTs: {
            type: 'string',
            format: 'date-time',
            description: 'Earliest member startedAt. With toTs, the run\'s composite-replay window.',
          },
          toTs: { type: 'string', format: 'date-time', description: 'Latest member interval end.' },
          streamKeys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Every camera that recorded in this run, sorted.',
          },
          sessionCount: { type: 'integer' },
          segmentCount: { type: 'integer', description: 'Summed over the members.' },
          totalBytes: { type: 'integer', description: 'Summed over the members.' },
          anyOpen: { type: 'boolean', description: 'Some member may still be receiving segments.' },
          anyUnsynced: {
            type: 'boolean',
            description: 'Some member recorded with an unsynchronized device clock.',
          },
          sessions: {
            type: 'array',
            items: { $ref: '#/components/schemas/MediaSession' },
            description: 'The members, ordered by startedAt then streamKey.',
          },
        },
      },
      MediaSegment: {
        type: 'object',
        required: ['id', 'deviceId', 'sessionId', 'streamKey', 's3Key', 'seq', 'startTs', 'durationMs'],
        description:
          'One ~60 s MP4 segment of a media session. `finalized: false` = crash-cut partial ' +
          '(fragmented MP4, playable up to the cut). When stitching, prefer the next segment\'s ' +
          'startTs delta over durationMs (segment 0 includes ~2 s pipeline startup). ' +
          'Ingest drops segments whose startTs is more than MEDIA_SEGMENT_MAX_FUTURE_MS ' +
          '(default 24 h) ahead of server time — a device with a catastrophically wrong ' +
          'clock is rejected loudly rather than indexed where no query will find it.',
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
      ReplayManifest: {
        type: 'object',
        required: ['deviceId', 'from', 'to', 'sessions', 'urlExpiresAt'],
        description:
          'Everything a replay player needs in one response: per-session gap-aware timelines plus a ' +
          'presigned GET URL per segment. All timestamps are epoch milliseconds (the replay-clock unit), ' +
          'unlike the ISO strings elsewhere in this API. Format-neutral by design: no codec strings or ' +
          'playlist syntax — clients parse media details from the segment bytes.',
        properties: {
          deviceId: { type: 'string', format: 'uuid' },
          from: {
            type: 'integer',
            description:
              'Epoch ms start of the whole replay: the requested range (range mode) or the earliest ' +
              'covered instant incl. any evicted-head gap (session mode).',
          },
          to: { type: 'integer', description: 'Epoch ms end of the whole replay.' },
          urlExpiresAt: {
            type: 'integer',
            description:
              'Epoch ms after which segment URLs may stop working (real TTL minus a safety margin) — ' +
              'refetch the manifest before this.',
          },
          sessions: {
            type: 'array',
            description:
              'One entry per session with media in the replay (a dual-camera range yields two). A ' +
              'sessionId request whose segments have all expired returns the session with empty ' +
              'segments/gaps, for telemetry-only replay.',
            items: {
              type: 'object',
              required: ['id', 'streamKey', 'status', 'segments', 'gaps'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                streamKey: { type: 'string', example: 'cam0' },
                status: { type: 'string', enum: ['open', 'closed'] },
                timeSource: {
                  type: 'string',
                  nullable: true,
                  enum: ['ntp', 'gps', 'nitz', 'rtc', 'unsynced'],
                  description:
                    '"unsynced" = wall-clock correlation with telemetry is untrustworthy; "gps"/"nitz" = offline clock step while NTP was pending.',
                },
                codec: { type: 'string', nullable: true, example: 'h264' },
                width: { type: 'integer', nullable: true },
                height: { type: 'integer', nullable: true },
                fps: { type: 'integer', nullable: true },
                segments: {
                  type: 'array',
                  description: 'Ordered by startTs. Segment i covers [startTs, startTs + effectiveDurationMs).',
                  items: {
                    type: 'object',
                    required: ['seq', 'startTs', 'effectiveDurationMs', 'finalized', 'url'],
                    properties: {
                      seq: { type: 'integer' },
                      startTs: { type: 'integer', description: 'Epoch ms.' },
                      effectiveDurationMs: {
                        type: 'integer',
                        description:
                          'Next-segment startTs delta when contiguous, else the recorded durationMs — ' +
                          'deltas beat durations (rotation timestamps are accurate; durations drift).',
                      },
                      finalized: {
                        type: 'boolean',
                        description: 'False = crash-cut partial; playable up to the cut.',
                      },
                      anchor: {
                        type: 'string',
                        nullable: true,
                        enum: ['fstat', 'computed', 'boundary'],
                        description:
                          'startTs provenance. "fstat" seq-0 rows include ~2 s of pipeline startup, so ' +
                          'the first seam may hold a ~2 s buffered hole.',
                      },
                      sizeBytes: { type: 'integer', nullable: true, description: 'For prefetch budgeting.' },
                      url: { type: 'string', format: 'uri', description: 'Presigned S3 GET for the MP4.' },
                    },
                  },
                },
                gaps: {
                  type: 'array',
                  description:
                    'Holes > 2 s with no media, computed server-side so every client renders the same ' +
                    'timeline; the replay clock free-runs (or skips) across them.',
                  items: {
                    type: 'object',
                    required: ['fromTs', 'toTs', 'reason'],
                    properties: {
                      fromTs: { type: 'integer', description: 'Epoch ms.' },
                      toTs: { type: 'integer', description: 'Epoch ms.' },
                      reason: { type: 'string', enum: ['missing-segments', 'evicted-head'] },
                    },
                  },
                },
              },
            },
          },
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
      TelemetryTableColumn: {
        type: 'object',
        required: ['key', 'unit'],
        description:
          'One column of the history table. The array order IS the column order, and every ' +
          'row\'s `v` array is positional against it.',
        properties: {
          key: { type: 'string', example: 'imu.accel_x' },
          unit: {
            type: 'string',
            nullable: true,
            example: 'm/s^2',
            description:
              'Taken from device_latest, so it is stable across pages rather than scraped from ' +
              'whatever this page happened to contain. Null when the metric has no known unit.',
          },
        },
      },
      TelemetryTableRow: {
        type: 'object',
        required: ['ts', 'v'],
        description:
          'One sample: a timestamp and its values. `v` is POSITIONAL against `columns` and its ' +
          'length always equals `columns.length` — trailing nulls are never trimmed.',
        properties: {
          ts: { type: 'string', format: 'date-time' },
          v: {
            type: 'array',
            items: { type: 'number', nullable: true },
            description: 'null means no reading for that column at this timestamp.',
            example: [0.12, null, 47.3],
          },
        },
      },
      TelemetryReadingsPage: {
        type: 'object',
        required: ['limit', 'offset', 'order', 'total', 'totalIsCapped'],
        description: 'Pagination block. `limit`/`offset` count timestamps (samples), not rows.',
        properties: {
          limit: { type: 'integer', description: 'The REQUESTED page size, even if the page was trimmed to the addressable window.' },
          offset: { type: 'integer' },
          order: { type: 'string', enum: ['asc', 'desc'] },
          total: {
            type: 'integer',
            description:
              'Addressable distinct timestamps under this filter, capped at 10,000. ' +
              'Exact when totalIsCapped is false.',
          },
          totalIsCapped: {
            type: 'boolean',
            description: 'True when more samples match than `total` reports.',
          },
          coveredFrom: {
            type: 'string',
            format: 'date-time',
            description: 'Oldest addressable sample under this filter. Absent when nothing matches.',
          },
          coveredTo: {
            type: 'string',
            format: 'date-time',
            description: 'Newest addressable sample under this filter. Absent when nothing matches.',
          },
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
                command: { type: 'string', enum: ['reboot', 'power_off', 'refresh'] },
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
        summary: 'Update device metadata (name / firmware)',
        description:
          'Metadata only. `status` and `lastSeenAt` are machine-managed (telemetry ingest, the ' +
          'MQTT last-will, and the offline sweeper own them) and are rejected 400. Device config ' +
          'moved to PATCH /devices/{id}/config and PATCH /devices/{id}/ui-prefs; the old ' +
          'per-namespace body fields are still accepted for the transition window, forwarded ' +
          'through the same validation into `config`/`uiPrefs`, and logged as deprecated.',
        tags: ['Devices'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  name: { type: 'string', nullable: true },
                  firmwareVersion: { type: 'string', nullable: true },
                  gnssAntBias: {
                    type: 'boolean',
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/config.',
                  },
                  activeStreamsViewType: {
                    type: 'string',
                    enum: ['card', 'map'],
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/ui-prefs.',
                  },
                  imuMount: {
                    allOf: [{ $ref: '#/components/schemas/ImuMountConfig' }],
                    nullable: true,
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/config.',
                  },
                  imuView: {
                    type: 'object',
                    nullable: true,
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/ui-prefs.',
                    properties: {
                      azimuthDeg: { type: 'number' },
                      elevationDeg: { type: 'number' },
                    },
                  },
                  recordingConfig: {
                    allOf: [{ $ref: '#/components/schemas/RecordingConfig' }],
                    nullable: true,
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/config (`recording`).',
                  },
                  lteRecoveryConfig: {
                    allOf: [{ $ref: '#/components/schemas/LteRecoveryConfig' }],
                    nullable: true,
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/config (`lteRecovery`).',
                  },
                  timeSyncConfig: {
                    allOf: [{ $ref: '#/components/schemas/TimeSyncConfig' }],
                    nullable: true,
                    deprecated: true,
                    description: 'DEPRECATED — use PATCH /devices/{id}/config (`timeSync`).',
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
    '/devices/{id}/config': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      patch: {
        operationId: 'patchDeviceConfig',
        summary: 'Update device config namespaces',
        description:
          'Writes one or more namespaces of the device config document, bumps `configRev`, and ' +
          'publishes the whole document as a retained MQTT message on ' +
          '`xorgate/devices/{id}/config`. Each present namespace is validated and replaced ' +
          'WHOLE — the device replaces namespaces the same way, so a partial namespace would ' +
          'silently drop the keys it omits. `null` reverts a namespace to device defaults. ' +
          'Returns 502 when the row was written but the retained publish failed (the device has ' +
          'NOT been told — re-save to retry).',
        tags: ['Devices'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: configPatchRequestSchema() } },
        },
        responses: {
          '200': {
            description: 'Config updated and published',
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
          '502': {
            description: 'Saved, but delivering it to the device failed',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/devices/{id}/ui-prefs': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      patch: {
        operationId: 'patchDeviceUiPrefs',
        summary: 'Update cloud-only presentation preferences',
        description:
          'Cloud-only: nothing here is delivered to the device, nothing is published, and ' +
          '`configRev` is not bumped. `null` resets a pref to its default.',
        tags: ['Devices'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: uiPrefsPatchRequestSchema() } },
        },
        responses: {
          '200': {
            description: 'Preferences updated',
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
    '/devices/{id}/refresh-state': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      post: {
        operationId: 'refreshDeviceState',
        summary: 'Ask the device to re-probe and re-report its state now',
        description:
          'Publishes a one-shot READ-ONLY refresh command over MQTT: the device re-probes what it can ' +
          '(SIM identity, applied APN, antenna bias) and publishes a fresh config report immediately, ' +
          'instead of on its hourly heartbeat. 202 means the command was delivered to the broker; observe ' +
          'the outcome by re-reading the device until `reportedAt` advances. The device rate-limits ' +
          'refreshes (~1 per 30 s) and a re-probe takes up to ~45 s to land. Ordinary member access — ' +
          'nothing on the device changes. The device must be online (409 otherwise).',
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
    '/devices/{id}/sessions': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'listMediaSessions',
        summary: 'List device-recorded media sessions',
        description:
          'Sessions recorded on the device itself (offline recording plan) and uploaded segment-by-segment ' +
          'to S3. Filterable by streamKey, status (open|closed) and ' +
          'from/to; the time filter matches sessions OVERLAPPING [from, to), not just those started inside ' +
          'it. Each row carries computed rollups (segmentCount, totalBytes, totalDurationMs). ' +
          'Pass group=runs to paginate RECORDING RUNS instead of sessions: one drive with N cameras is ' +
          'N sessions, and a run is the set of sessions whose intervals are within 60 s of each other. ' +
          'Under group=runs the response returns `runs` instead of `sessions` (members nested), ' +
          '`page.total` counts runs, and every filter selects which RUNS to return rather than which ' +
          'sessions to cluster — so streamKey=cam0 returns the runs cam0 recorded in, with all of their ' +
          'cameras present, and a from/to range returns overlapping runs whole rather than clipped.',
        tags: ['Media Sessions'],
        parameters: [
          {
            name: 'group',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['runs'] },
            description:
              'Group and paginate by recording run. Requires sort=startedAt (a run has no createdAt).',
          },
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
            description:
              'Sessions with per-session rollups, newest first by default — or, with group=runs, ' +
              'recording runs with their member sessions nested. `page.total` counts whichever noun ' +
              'was returned.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/MediaSession' },
                      description: 'Present unless group=runs.',
                    },
                    runs: {
                      type: 'array',
                      description: 'Present only with group=runs.',
                      items: { $ref: '#/components/schemas/RecordingRun' },
                    },
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
    '/devices/{id}/replay-manifest': {
      parameters: [{ $ref: '#/components/parameters/IdPath' }, { $ref: '#/components/parameters/OrganizationIdHeader' }],
      get: {
        operationId: 'getReplayManifest',
        summary: 'Get a gap-aware replay manifest with presigned segment URLs',
        description:
          'One response feeds a whole replay: per-session timelines (effective durations + gaps, computed ' +
          'server-side) and a presigned GET URL per segment. Address it by sessionId (single session) OR by ' +
          'from/to (every session overlapping the range, segments clipped to it; optional streamKey filter) ' +
          '— never both. Caps: 600 segments total, and in range mode 10 sessions / 24 h. Refetch before ' +
          '`urlExpiresAt` (epoch ms) — URLs die after ~1 h.',
        tags: ['Media Sessions'],
        parameters: [
          {
            name: 'sessionId',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'uuid' },
            description: 'Single-session mode. Mutually exclusive with from/to.',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            description: 'Range mode start (with `to`). ISO-8601, like the telemetry endpoints.',
          },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          {
            name: 'streamKey',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Range mode only: limit to one camera, e.g. cam0.',
          },
        ],
        responses: {
          '200': {
            description: 'The replay manifest. Timestamps are epoch ms.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['replay'],
                  properties: { replay: { $ref: '#/components/schemas/ReplayManifest' } },
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
        summary: 'One page of the telemetry history table',
        description:
          'Returns raw (un-averaged) stored samples for one page, paginated over DISTINCT ' +
          'timestamps so a page boundary never splits a sample. Defaults to the latest samples ' +
          '(`order=desc`) with no time window. `limit`/`offset` count timestamps (samples), not rows.\n\n' +
          '**Two response shapes, selected by `shape`.** `shape=table` (the DEFAULT) returns the ' +
          'table being displayed: an ordered `columns` list with stable units, and one `rows` entry ' +
          'per timestamp whose `v` array is positional against `columns`. `shape=flat` returns the ' +
          'original `readings: [{ts, metric, value, unit}]` rows — the same raw-rows contract as ' +
          '`/telemetry` and `/telemetry/recent`. The table shape is roughly 10x smaller on the wire ' +
          '(this API does not compress) and its column set does not vary with the page contents.\n\n' +
          '`page.total` is the distinct-timestamp count, **bounded at 10,000**: when more samples ' +
          'match, `page.totalIsCapped` is `true` and only the first 10,000 in the requested `order` ' +
          'are addressable (newest first by default). `page.coveredFrom`/`coveredTo` give the ISO ' +
          'span of that addressable slice. Narrow `from`/`to` to reach beyond it; an `offset` past ' +
          'the cap returns an empty page, not an error.',
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
            description:
              'Comma-separated metric filter (max 20), e.g. `imu.accel_x,gps.lat`. Under ' +
              '`shape=table` this also fixes the column set (the columns and the filter are one ' +
              'value). Omit it and the columns are derived from the device model\'s capabilities.',
          },
          {
            name: 'shape',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['table', 'flat'], default: 'table' },
            description:
              'Response shape. `table` (default) returns `columns` + positional `rows`; `flat` ' +
              'returns the raw `readings` rows.',
          },
        ],
        responses: {
          '200': {
            description:
              'One page of the history table (`shape=table`), or of raw readings ordered by ts ' +
              'then metric (`shape=flat`).',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      title: 'Table shape (default)',
                      type: 'object',
                      required: ['columns', 'rows', 'columnSource', 'page'],
                      properties: {
                        columns: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/TelemetryTableColumn' },
                        },
                        rows: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/TelemetryTableRow' },
                        },
                        columnSource: {
                          type: 'string',
                          enum: ['request', 'model', 'data'],
                          description:
                            'Where the column set came from. `request` — your `metric` filter. ' +
                            '`model` — the device model\'s io_capabilities. `data` — the model ' +
                            'declares nothing usable, so columns were discovered from this page\'s ' +
                            'rows and may vary between pages. `data` with an empty `columns` means ' +
                            'the model declares nothing AND this page has no data.',
                        },
                        page: { $ref: '#/components/schemas/TelemetryReadingsPage' },
                      },
                    },
                    {
                      title: 'Flat shape (shape=flat)',
                      type: 'object',
                      required: ['readings', 'page'],
                      properties: {
                        readings: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/TelemetryReading' },
                        },
                        page: { $ref: '#/components/schemas/TelemetryReadingsPage' },
                      },
                    },
                  ],
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

import {
  configPatchRequestSchema,
  uiPrefsPatchRequestSchema,
} from '../config-registry/openapi';

/** Shared prose for the four one-shot command routes. */
const commandResponses = {
  '202': { $ref: '#/components/responses/DeviceCommandAccepted' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '404': { $ref: '#/components/responses/NotFound' },
  '405': { $ref: '#/components/responses/MethodNotAllowed' },
  '409': { $ref: '#/components/responses/Conflict' },
  '502': { $ref: '#/components/responses/DeviceCommandPublishFailed' },
};

const deviceIdParams = [
  { $ref: '#/components/parameters/IdPath' },
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];

export const devicesPaths = {
  '/devices': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listDevices',
      summary: 'List devices in the active organization',
      description:
        'Every device whose workspace belongs to the active organization, paginated with the ' +
        'shared list dialect. Pass `X-Workspace-Id` to narrow it to one workspace; a workspace ' +
        'outside the active organization returns an EMPTY page rather than an error, so an empty ' +
        'result never distinguishes "no devices" from "wrong workspace".',
      parameters: [
        { $ref: '#/components/parameters/WorkspaceIdHeader' },
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['updatedAt', 'createdAt', 'lastSeenAt', 'serial', 'name'],
            default: 'updatedAt',
          },
          description: 'Sort column. Anything else is a 400.',
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['provisioned', 'online', 'offline', 'decommissioned'],
          },
          description:
            'Filter by device status. An empty value or the literal `any` means "no filter"; any ' +
            'other unknown value is a 400.',
        },
      ],
      tags: ['Devices'],
      responses: {
        '200': {
          description: 'One page of devices',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['devices', 'page'],
                properties: {
                  devices: { type: 'array', items: { $ref: '#/components/schemas/Device' } },
                  page: { $ref: '#/components/schemas/PageMeta' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    post: {
      operationId: 'createDevice',
      summary: 'Register a device under a workspace in the active organization',
      description:
        'Creates the row only. It has no IoT identity until `POST /devices/{id}/provision`, and no ' +
        'agent until someone installs one. For onboarding a physical device, prefer the ' +
        'registration-code flow, which does all three in one pass.',
      tags: ['Devices'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['workspaceId', 'deviceModelId', 'serial'],
              properties: {
                workspaceId: {
                  type: 'string',
                  format: 'uuid',
                  description: 'Must belong to the active organization, else 400.',
                },
                deviceModelId: { type: 'string', format: 'uuid' },
                serial: { type: 'string', description: 'Unique within the workspace.' },
                name: { type: 'string', nullable: true },
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
    parameters: deviceIdParams,
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
      summary: 'Update device metadata',
      description:
        'Metadata only. `status` and `lastSeenAt` are machine-managed (telemetry ingest, the MQTT ' +
        'last-will, and the offline sweeper own them) and are rejected 400. Device config moved to ' +
        'PATCH /devices/{id}/config and PATCH /devices/{id}/ui-prefs; the old per-namespace body ' +
        'fields below are still accepted for the transition window, forwarded through the same ' +
        'validation into `config`/`uiPrefs`, and logged as deprecated.',
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
                gnssAntBias: {
                  type: 'boolean',
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/config.',
                },
                activeStreamsViewType: {
                  type: 'string',
                  enum: ['card', 'map'],
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/ui-prefs.',
                },
                imuMount: {
                  allOf: [{ $ref: '#/components/schemas/ImuMountConfig' }],
                  nullable: true,
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/config.',
                },
                imuView: {
                  type: 'object',
                  nullable: true,
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/ui-prefs.',
                  properties: {
                    azimuthDeg: { type: 'number' },
                    elevationDeg: { type: 'number' },
                  },
                },
                recordingConfig: {
                  allOf: [{ $ref: '#/components/schemas/RecordingConfig' }],
                  nullable: true,
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/config (`recording`).',
                },
                lteRecoveryConfig: {
                  allOf: [{ $ref: '#/components/schemas/LteRecoveryConfig' }],
                  nullable: true,
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/config (`lteRecovery`).',
                },
                timeSyncConfig: {
                  allOf: [{ $ref: '#/components/schemas/TimeSyncConfig' }],
                  nullable: true,
                  deprecated: true,
                  description: 'DEPRECATED. Use PATCH /devices/{id}/config (`timeSync`).',
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
        '502': {
          description:
            'A legacy config field was accepted and saved, but publishing the retained document ' +
            'to the device failed (`CONFIG_PUBLISH_FAILED`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
    delete: {
      operationId: 'deleteDevice',
      summary: 'Delete a device',
      description:
        'Removes the row and everything cascading off it (identity, video channels, sessions, ' +
        'telemetry). The AWS IoT thing and certificate are NOT torn down by this endpoint.',
      tags: ['Devices'],
      responses: {
        '204': { $ref: '#/components/responses/NoContent' },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/devices/{id}/config': {
    parameters: deviceIdParams,
    patch: {
      operationId: 'patchDeviceConfig',
      summary: 'Update device config namespaces',
      description:
        'Writes one or more namespaces of the device config document, bumps `configRev`, and ' +
        'publishes the whole document as a retained MQTT message on `xorgate/devices/{id}/config`. ' +
        'Each present namespace is validated and replaced WHOLE, because the device replaces ' +
        'namespaces the same way and a partial namespace would silently drop the keys it omits. ' +
        '`null` reverts a namespace to device defaults. Returns 502 when the row was written but ' +
        'the retained publish failed: the device has NOT been told yet, though it self-heals on ' +
        'its next config report.',
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
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '502': {
          description:
            'Saved, but delivering it to the device failed (`CONFIG_PUBLISH_FAILED`). It will be ' +
            'delivered automatically the next time the device reports in.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },
  '/devices/{id}/ui-prefs': {
    parameters: deviceIdParams,
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
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/devices/{id}/provision': {
    parameters: deviceIdParams,
    post: {
      operationId: 'provisionDevice',
      summary: 'Provision device identity (owner/admin only)',
      description:
        'Mints an AWS IoT thing + X.509 certificate, attaches the device policy, and creates a ' +
        'video channel per declared video stream. Returns the certificate, private key, and ' +
        'connection endpoints exactly once, so persist them on the device immediately. A second ' +
        'call for an already-provisioned device returns 409; certificate rotation is not supported ' +
        'yet.',
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
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': { $ref: '#/components/responses/Conflict' },
      },
    },
  },
  '/devices/{id}/identity': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getDeviceIdentity',
      summary: "The device's IoT identity metadata",
      description:
        'Non-secret fields of the X.509 identity minted at provisioning time: thing name, ' +
        'certificate id, policy, role alias, status. `identity` is NULL (with a 200, not a 404) ' +
        'when the device exists but has not been provisioned, so a client can render a clean ' +
        '"not provisioned" state. Reads the database only; it does not call AWS IoT, so a ' +
        'certificate revoked out of band still reads `active` here.',
      tags: ['Devices'],
      responses: {
        '200': {
          description: 'Identity metadata, or null when the device is not provisioned.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['identity'],
                properties: {
                  identity: {
                    allOf: [{ $ref: '#/components/schemas/DeviceIdentity' }],
                    nullable: true,
                  },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/devices/{id}/reboot': {
    parameters: deviceIdParams,
    post: {
      operationId: 'rebootDevice',
      summary: 'Reboot a device (owner/admin only)',
      description:
        'Publishes a one-shot reboot command over MQTT and returns immediately. 202 means the ' +
        'command was delivered to the broker, not that the device has rebooted; observe the ' +
        'outcome via the device status, which goes offline and then back online. The device must ' +
        'be online (409 otherwise), because commands are not retained and there is nothing for an ' +
        'offline device to pick up later. The command expires 60 seconds after issue and carries a ' +
        'request id the device refuses to execute twice, so a stale or redelivered command cannot ' +
        'cause a surprise reboot.',
      tags: ['Devices'],
      responses: commandResponses,
    },
  },
  '/devices/{id}/power-off': {
    parameters: deviceIdParams,
    post: {
      operationId: 'powerOffDevice',
      summary: 'Power off a device (owner/admin only)',
      description:
        'Same delivery semantics and guards as reboot, but NOT remotely recoverable: the device ' +
        'stays off until someone physically powers it back on. The device must be online (409 ' +
        'otherwise).',
      tags: ['Devices'],
      responses: commandResponses,
    },
  },
  '/devices/{id}/refresh-state': {
    parameters: deviceIdParams,
    post: {
      operationId: 'refreshDeviceState',
      summary: 'Ask the device to re-probe and re-report its state now',
      description:
        'A one-shot READ-ONLY command: the device re-probes what it can (SIM identity, applied ' +
        'APN, antenna bias) and publishes a fresh config report immediately instead of on its ' +
        'hourly heartbeat. Observe the outcome by re-reading the device until `reportedAt` ' +
        'advances. The device rate-limits refreshes to roughly one per 30 s and a re-probe takes ' +
        'up to about 45 s to land. Ordinary member access, since nothing on the device changes. ' +
        'The device must be online (409 otherwise).',
      tags: ['Devices'],
      responses: commandResponses,
    },
  },
  '/devices/{id}/update': {
    parameters: deviceIdParams,
    post: {
      operationId: 'updateDeviceAgent',
      summary: 'Install the latest agent build on a device (owner/admin only)',
      description:
        'Publishes a one-shot update command over MQTT. The device starts a systemd one-shot that ' +
        'downloads the latest published build (see GET /device-dist/latest), installs it, and ' +
        'restarts the agent, so the device drops offline for roughly a minute or two. Latest-only: ' +
        'there is no version parameter. A failed install rolls back, leaving the device on its ' +
        'current build. IMPORTANT: 202 means the command reached the broker, NOT that the update ' +
        'succeeded, and the ack could not tell you either (the agent is restarted mid-update). ' +
        'Observe the outcome by polling GET /devices/{id} until `agentVersion` changes; an ' +
        'unchanged build after the device returns online means the update failed and rolled back ' +
        '(diagnose on the device with `journalctl -u xorgate-updater`). The device must be online ' +
        '(409 otherwise). Pressing this twice is harmless: `systemctl start` on an already-running ' +
        'one-shot coalesces into the run in flight.',
      tags: ['Devices'],
      responses: commandResponses,
    },
  },
  '/device-dist/latest': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'getLatestAgentBuild',
      summary: 'The newest published device-agent build',
      description:
        'Returns the manifest the device-agent CI publishes alongside the `latest` tarball alias, ' +
        'which is exactly what a device update would install for this stage. Fleet-wide, not ' +
        'per-device. Compare `version` against a device\'s reported build (`agentVersion`) by ' +
        'STRING EQUALITY only: shas do not order, and a dev sha and a prod release tag are not ' +
        'comparable. 404 means CI has not published a manifest for this stage yet, which is ' +
        '"latest unknown" rather than an error.',
      tags: ['Devices'],
      responses: {
        '200': {
          description: 'The latest published build.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['latest'],
                properties: {
                  latest: {
                    type: 'object',
                    required: ['version'],
                    properties: {
                      version: { type: 'string', example: 'a1b2c3d' },
                      channel: { type: 'string', nullable: true, example: 'dev' },
                      builtAt: { type: 'string', format: 'date-time', nullable: true },
                      packageVersion: { type: 'string', nullable: true, example: '0.2.0' },
                      tarball: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '500': {
          description: 'This stage has no distribution bucket configured (`DIST_BUCKET_UNCONFIGURED`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        '502': {
          description:
            'The manifest object is unreadable, empty, oversized, or carries no version ' +
            '(`DIST_MANIFEST_UNAVAILABLE`, `DIST_MANIFEST_INVALID`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },
};

/**
 * Device simulations (plans/xorgate-device-simulator, Phase 3).
 *
 * The four `/device-simulations` operations. The sim host's own plane
 * (`/sim-hosts/*`) is classified out of scope in `scope.ts`: it is private to
 * the host and is served by one proxy route.
 */

const simulationResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['simulation'],
        properties: { simulation: { $ref: '#/components/schemas/DeviceSimulation' } },
      },
    },
  },
});

const simulationIdParams = [
  {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'The simulated DEVICE id. A simulation is 1:1 with its device and has no id of its own.',
  },
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];

export const deviceSimulationsPaths = {
  '/device-simulations': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    post: {
      operationId: 'createDeviceSimulation',
      summary: 'Register a simulated device',
      description:
        'Creates a device that is the real device agent replaying a recorded drive in a ' +
        'container on a simulator host: online within a couple of minutes, live video, moving on ' +
        'the map, five seeded recorded sessions, and no hardware. In order: a quota check ' +
        '(`409 SIMULATION_QUOTA_EXCEEDED`; 2 per organization and 8 overall by default), a ' +
        'device row (serial `SIM-<8 hex>`, model Argus CM5 Rev1, `simulated: true`, cam1 ' +
        'disabled, the `simulation` namespace set), the same IoT thing, certificate and video ' +
        'channels a real device gets, the first config publish, and the credentials handed to ' +
        'the host. Any failure after the row exists is rolled back and is a ' +
        '`502 SIMULATION_PROVISION_FAILED`. From then on it is a normal device: configure, ' +
        'command, browse and DELETE it through `/devices/{id}`. To switch scenario, PATCH the ' +
        "device's `simulation` namespace (whole) and send `POST /devices/{id}/reboot`.",
      tags: ['Device Simulations'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['workspaceId'],
              properties: {
                workspaceId: {
                  type: 'string',
                  format: 'uuid',
                  description: 'Must belong to the active organization, else 400.',
                },
                name: {
                  type: 'string',
                  nullable: true,
                  maxLength: 120,
                  description: 'Defaults to `Simulator SIM-<8 hex>`.',
                },
                scenarioId: {
                  type: 'string',
                  nullable: true,
                  pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
                  description:
                    'A scenario from `GET /device-simulations/scenarios`; an id the catalog does ' +
                    'not carry is a 400. Defaults to the catalog default.',
                },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'The simulated device and its simulation. The host picks it up within one pass.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['device', 'simulation'],
                properties: {
                  device: { $ref: '#/components/schemas/Device' },
                  simulation: { $ref: '#/components/schemas/DeviceSimulation' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '409': { $ref: '#/components/responses/Conflict' },
        '502': {
          description: 'Provisioning failed and was rolled back (`SIMULATION_PROVISION_FAILED`). Retry.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },
  '/device-simulations/scenarios': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listSimulationScenarios',
      summary: 'List the scenarios a simulated device can replay',
      description:
        'The scenario catalog of the current asset pack: recorded drives a simulated device ' +
        'replays on a loop. Thumbnail URLs are presigned and expire after an hour.',
      tags: ['Device Simulations'],
      responses: {
        '200': {
          description: 'The catalog',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['assetsVersion', 'defaultScenarioId', 'scenarios'],
                properties: {
                  assetsVersion: { type: 'string', example: 'v1' },
                  defaultScenarioId: {
                    type: 'string',
                    description: 'What `POST /device-simulations` uses when no `scenarioId` is sent.',
                  },
                  scenarios: { type: 'array', items: { $ref: '#/components/schemas/SimulationScenario' } },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/device-simulations/{id}': {
    parameters: simulationIdParams,
    get: {
      operationId: 'getDeviceSimulation',
      summary: 'Read a simulated device\'s simulation state',
      description:
        'What the host has been asked to do (`desiredState`, `startRequestedAt`) and what it last ' +
        'reported (`hostState`, `hostMessage`, `hostReportedAt`). A device that is not simulated ' +
        'is a 404.',
      tags: ['Device Simulations'],
      responses: {
        '200': simulationResponse('The simulation'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/device-simulations/{id}/start': {
    parameters: simulationIdParams,
    post: {
      operationId: 'startDeviceSimulation',
      summary: 'Power on a simulated device',
      description:
        'The power button a powered-off simulated device lacks. A `power_off` command parks the ' +
        'sim and it stays off (the host reports `hostState: stopped`); this sets ' +
        '`desiredState: running` and stamps `startRequestedAt`, and the host powers the sim on ' +
        'at its next pass. Idempotent; on a running sim it changes nothing the device notices.',
      tags: ['Device Simulations'],
      responses: {
        '200': simulationResponse('Start requested'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
};

export const deviceSimulationSchemas: Record<string, unknown> = {
  DeviceSimulation: {
    type: 'object',
    required: ['deviceId', 'scenarioId', 'desiredState', 'hostState', 'createdBy', 'createdAt'],
    properties: {
      deviceId: { type: 'string', format: 'uuid' },
      scenarioId: {
        type: 'string',
        description:
          "The scenario the device is on now: its `simulation` config namespace, or the one it was " +
          'created with when the namespace is absent.',
      },
      desiredState: { type: 'string', enum: ['running', 'stopped'] },
      startRequestedAt: { type: 'string', format: 'date-time', nullable: true },
      hostId: { type: 'string', nullable: true, description: 'The host that last reported this simulation.' },
      hostState: {
        type: 'string',
        enum: ['pending', 'starting', 'running', 'stopped', 'error'],
        description:
          '`pending` until a host first reports it. `running` means the agent in the container is ' +
          'connected, not merely that the container is up; `stopped` is a sim parked by ' +
          '`power_off` (see `POST /device-simulations/{id}/start`).',
      },
      hostMessage: { type: 'string', nullable: true },
      hostReportedAt: { type: 'string', format: 'date-time', nullable: true },
      createdBy: { type: 'string', description: 'User id or API key id.' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  SimulationScenario: {
    type: 'object',
    required: ['id', 'title', 'streams'],
    properties: {
      id: { type: 'string', example: 'city-2026-09-27' },
      title: { type: 'string' },
      description: { type: 'string', nullable: true },
      durationMs: { type: 'integer', nullable: true, description: 'One lap.' },
      distanceM: { type: 'number', nullable: true },
      maxKph: { type: 'number', nullable: true },
      streams: {
        type: 'array',
        items: {
          type: 'object',
          required: ['streamKey'],
          properties: {
            streamKey: { type: 'string' },
            width: { type: 'integer', nullable: true },
            height: { type: 'integer', nullable: true },
            fps: { type: 'number', nullable: true },
          },
        },
      },
      thumbnailUrl: { type: 'string', format: 'uri', nullable: true, description: 'Presigned, one hour.' },
    },
  },
};

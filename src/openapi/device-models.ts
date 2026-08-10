export const deviceModelsPaths = {
  '/device-models': {
    get: {
      operationId: 'listDeviceModels',
      summary: 'List the platform-wide device model catalog',
      description:
        'The catalog is PLATFORM-wide, not per organization, so this endpoint takes no tenancy ' +
        'header and every authenticated caller sees the same rows. Unpaginated. Writes need the ' +
        'platform-admin role (`users.role = "admin"`), which is separate from any membership role. ' +
        'The envelope keys are `device_models` / `device_model` (snake_case, mirroring the table ' +
        'name) with camelCase contents; the SDKs present them as `deviceModels` / `deviceModel`.',
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
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
    post: {
      operationId: 'createDeviceModel',
      summary: 'Add a device model (platform admin only)',
      description:
        '`ioCapabilities` is what makes a model useful: it declares the video/audio stream keys ' +
        'that become KVS channels at provisioning time, and the telemetry metrics that become the ' +
        'default history columns. It is NOT validated here, but it IS parsed at provisioning ' +
        'time, and a document that fails that parse provisions zero KVS channels. Check it ' +
        'against the schema before you send it.',
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
                ioCapabilities: {
                  allOf: [{ $ref: '#/components/schemas/IoCapabilities' }],
                  nullable: true,
                },
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
      description:
        'Partial update; an empty body is a 400. Changing `ioCapabilities` does not retro-provision ' +
        'KVS channels on devices already created from this model.',
      tags: ['Device Models'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              properties: {
                name: { type: 'string' },
                sku: { type: 'string' },
                ioCapabilities: {
                  allOf: [{ $ref: '#/components/schemas/IoCapabilities' }],
                  nullable: true,
                },
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
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
};

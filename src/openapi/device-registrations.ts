/**
 * Device onboarding by registration code.
 *
 * Two of these four operations are marked `x-internal: true`: they are the
 * install script's private contract, not public API. `GET /get/{code}` serves a
 * shell script, and the claim route is UNAUTHENTICATED and returns one-shot
 * X.509 private key material. They stay documented here so the route-coverage
 * drift guard keeps seeing them, and the documentation site drops every
 * `x-internal` operation before generating pages.
 */
export const deviceRegistrationsPaths = {
  '/device-registrations': {
    parameters: [
      { $ref: '#/components/parameters/OrganizationIdHeader' },
      { $ref: '#/components/parameters/WorkspaceIdHeader' },
    ],
    post: {
      operationId: 'createDeviceRegistration',
      summary: 'Mint a device registration code',
      description:
        'Starts onboarding: returns a short-lived code and the `installUrl` to run on the device. ' +
        '`X-Workspace-Id` is REQUIRED here (unlike on `GET /devices`, where it is a filter), ' +
        'because the code carries the workspace the future device will land in. Idempotent per ' +
        'workspace: while a pending, un-expired code exists it is returned again instead of ' +
        'minting a new one, so reloading a dialog does not burn codes. The device model is picked ' +
        'automatically (the most recently created one), and a deployment with no device models is ' +
        'a 400. Note the success status is 200, not 201, even when a code is created.',
      tags: ['Device Registrations'],
      responses: {
        '200': {
          description: 'A pending registration, freshly minted or the existing un-expired one.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceRegistration' },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/device-registrations/{code}': {
    parameters: [
      { $ref: '#/components/parameters/RegistrationCodePath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    get: {
      operationId: 'getDeviceRegistration',
      summary: 'Poll a registration code',
      description:
        'How a client watches onboarding finish: poll until `status` is `claimed` and `deviceId` ' +
        'is set. Reading also lazily expires a stale pending row, so the `expired` status appears ' +
        'on read rather than on a schedule. Scoped to the active organization, so another ' +
        'organization\'s code is a 404.',
      tags: ['Device Registrations'],
      responses: {
        '200': {
          description: 'The registration',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceRegistration' },
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
  '/device-registrations/{code}/claim': {
    parameters: [{ $ref: '#/components/parameters/RegistrationCodePath' }],
    post: {
      operationId: 'claimDeviceRegistration',
      summary: 'Claim a registration code (internal, installer only)',
      description:
        'INTERNAL. Called unauthenticated by the install script running on the device. It flips ' +
        'the code to `claimed`, creates the device row, provisions its AWS IoT identity, and ' +
        'returns the certificate and PRIVATE KEY once. Not part of the public API surface: treat ' +
        'the installer as the only client.',
      tags: ['Device Registrations'],
      security: [],
      'x-internal': true,
      responses: {
        '200': { description: 'Device created and provisioned. Response withheld from public docs.' },
        '400': { $ref: '#/components/responses/BadRequest' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': { $ref: '#/components/responses/Conflict' },
      },
    },
  },
  '/get/{code}': {
    parameters: [{ $ref: '#/components/parameters/RegistrationCodePath' }],
    get: {
      operationId: 'getInstallScript',
      summary: 'Device install script (internal, installer only)',
      description:
        'INTERNAL. Serves the bash installer for a registration code as ' +
        '`text/x-shellscript`, unauthenticated. Invalid, used, or expired codes still return a ' +
        'runnable script that prints the reason and exits non-zero, so the operator sees the ' +
        'problem instead of bash silently doing nothing.',
      tags: ['Device Registrations'],
      security: [],
      'x-internal': true,
      responses: {
        '200': {
          description: 'The install script.',
          content: { 'text/x-shellscript': { schema: { type: 'string' } } },
        },
        '400': { description: 'Missing code. Body is a failing shell script.' },
        '404': { description: 'Unknown code. Body is a failing shell script.' },
        '410': { description: 'Code already used or expired. Body is a failing shell script.' },
        '500': { description: 'Server misconfiguration. Body is a failing shell script.' },
      },
    },
  },
};

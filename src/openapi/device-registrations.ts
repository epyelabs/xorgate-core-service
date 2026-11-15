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
        'minting a new one, so reloading a dialog does not burn codes. The device model defaults ' +
        'to the most recently created one, and a deployment with no device models is a 400 — but ' +
        'the default is only a FALLBACK: the claim maps the device\'s own hardware probe to a ' +
        'model row (probe-at-claim), unless `deviceModelId` is passed here to pin the model ' +
        'explicitly (the claim then skips the probe). Passing `deviceModelId` while a pending ' +
        'code exists re-pins that code\'s model in place. `agent` picks the installer the code ' +
        'serves (`js`, the default, or `rust`); a pending code is reused only for the SAME agent, ' +
        'so changing the agent mints a new code. `rust` is gated per stage, and optionally per ' +
        'workspace: while it is not enabled the request is a 409 `AGENT_NOT_ENABLED`. Note the ' +
        'success status is 200, not 201, even when a code is created.',
      tags: ['Device Registrations'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                deviceModelId: {
                  type: 'string',
                  format: 'uuid',
                  description:
                    'Pin the device model explicitly instead of probe-at-claim mapping. ' +
                    'Unknown ids are a 400.',
                },
                agent: {
                  type: 'string',
                  enum: ['js', 'rust'],
                  default: 'js',
                  description:
                    'Which device agent the installer installs. Absent = `js`. Any other value is ' +
                    'a 400 `INVALID_AGENT`; `rust` while this stage does not enable it for the ' +
                    'workspace is a 409 `AGENT_NOT_ENABLED` (see `GET /device-dist/latest?agent=rust` ' +
                    '`registrationEnabled`).',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'A pending registration, freshly minted or the existing un-expired one.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceRegistration' },
            },
          },
        },
        '400': {
          description:
            'Bad request, including an unknown `agent` (`INVALID_AGENT`) or `deviceModelId`.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': {
          description:
            '`agent: "rust"` while Rust-agent registration is not enabled on this stage for this ' +
            'workspace (`AGENT_NOT_ENABLED`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
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
        'returns the certificate and PRIVATE KEY once. The body may carry a hardware probe ' +
        '(`dtModel` = /proc/device-tree/model, `cameras` = libcamera count, 0 = unknown) that ' +
        'picks the device model unless the registration pinned one; an ambiguous probe keeps ' +
        'the registration\'s model and flags the device `needsModel`. The response embeds the ' +
        'resolved model\'s device-facing `hardware` block (null for schemaVersion-1 models), ' +
        'which the installer writes to /etc/xorgate/hardware.json. Not part of the public API ' +
        'surface: treat the installer as the only client.',
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
        '`text/x-shellscript`, unauthenticated. The registration\'s `agent` picks it: `js` gets ' +
        'the JS agent installer, `rust` a bootstrap that downloads, verifies and runs the Rust ' +
        'agent\'s own provisioner. Invalid, used, or expired codes still return a ' +
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
        '409': {
          description:
            'A `rust` code while Rust-agent registration is not enabled here. Body is a failing ' +
            'shell script.',
        },
        '410': { description: 'Code already used or expired. Body is a failing shell script.' },
        '500': { description: 'Server misconfiguration. Body is a failing shell script.' },
      },
    },
  },
};

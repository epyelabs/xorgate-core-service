import { openApiComponents } from './components';
import { metaPaths } from './meta';
import { usersPaths } from './users';
import { organizationsPaths } from './organizations';
import { membershipsPaths } from './memberships';
import { apiKeysPaths } from './api-keys';
import { workspacesPaths } from './workspaces';
import { deviceModelsPaths } from './device-models';
import { devicesPaths } from './devices';
import { deviceRegistrationsPaths } from './device-registrations';
import { mediaSessionsPaths } from './media-sessions';
import { telemetryPaths } from './telemetry';
import { livePaths } from './live';
import { searchPaths } from './search';

/**
 * The OpenAPI document, assembled from one module per resource.
 *
 * `handlers/docs.ts` serves this at `GET /openapi.json`, and the documentation
 * site generates its API reference from a checked-in snapshot of it. Two things
 * keep it honest:
 *
 * - `test/openapi-route-coverage.test.ts` diffs `paths` against the CDK route
 *   table, so a new route fails CI until it is documented or classified in
 *   `scope.ts`.
 * - the device-config schemas are generated from the same zod registry that
 *   validates the requests, so they cannot drift at all.
 *
 * Everything else is hand-written against its handler. When you change a
 * handler's parameters or response envelope, change its module here in the same
 * commit.
 */

/**
 * Tag order drives the section order of the generated reference, and every tag
 * an operation uses MUST be declared here or the docs generator drops that
 * operation on the floor.
 *
 * `x-displayName` is not optional decoration. Without it the docs generator
 * derives a label from the tag NAME by inserting a space before every capital,
 * which renders "API Keys" as "A P I Keys". Set it on every tag so an acronym
 * added later cannot reintroduce that; the URL slug still comes from `name`.
 */
const TAGS = [
  {
    name: 'Users',
    'x-displayName': 'Users',
    description: 'Who the caller is, and which organizations they can act in.',
  },
  {
    name: 'Organizations',
    'x-displayName': 'Organizations',
    description: 'The billing and ownership boundary. Everything else hangs off one.',
  },
  {
    name: 'Memberships',
    'x-displayName': 'Memberships',
    description: 'Who belongs to an organization, and with what role.',
  },
  {
    name: 'API Keys',
    'x-displayName': 'API Keys',
    description: 'Organization-scoped keys. Mint-only today: no endpoint accepts one as a credential yet.',
  },
  {
    name: 'Workspaces',
    'x-displayName': 'Workspaces',
    description: 'The grouping devices belong to, one level below an organization.',
  },
  {
    name: 'Device Models',
    'x-displayName': 'Device Models',
    description:
      'The platform-wide hardware catalog. Reading is open to any authenticated caller; writing needs a platform admin.',
  },
  {
    name: 'Devices',
    'x-displayName': 'Devices',
    description:
      'Device records, their configuration document, their IoT identity, and the one-shot commands you can send them.',
  },
  {
    name: 'Device Registrations',
    'x-displayName': 'Device Registrations',
    description: 'Onboarding a physical device with a short-lived code and the install script.',
  },
  {
    name: 'Telemetry',
    'x-displayName': 'Telemetry',
    description: 'Stored sensor readings. The live 1 Hz feed does not come through this API.',
  },
  {
    name: 'Media Sessions',
    'x-displayName': 'Media Sessions',
    description:
      'Video recorded on the device and uploaded as segments: sessions, runs, segment index, playback URLs, and replay manifests.',
  },
  {
    name: 'Live',
    'x-displayName': 'Live',
    description:
      'Bootstrap for the live plane: KVS channel metadata and the IoT policy attachment a browser needs.',
  },
  {
    name: 'Search',
    'x-displayName': 'Search',
    description: 'Cross-resource lookup within the active organization.',
  },
  { name: 'Meta', 'x-displayName': 'Meta', description: 'Health probe and this document.' },
];

const DESCRIPTION = [
  'The REST API behind xorgate: organizations, workspaces, devices, device configuration,',
  'recorded media, and stored telemetry.',
  '',
  '**Authentication.** Every endpoint except `/health` and this document requires',
  '`Authorization: Bearer <token>`, where the token is a Cognito **ID** token (not an access',
  'token). A user row is created on first successful verification. API keys can be minted but',
  'are not yet accepted as credentials.',
  '',
  '**Tenancy.** Org-scoped endpoints resolve the active organization from the `X-Organization-Id`',
  'header, falling back to your sole membership if you have exactly one. A caller in more than one',
  'organization who omits the header gets `400 ORGANIZATION_REQUIRED`, so clients should always',
  'send it. `X-Workspace-Id` narrows `GET /devices` and is required by',
  '`POST /device-registrations`.',
  '',
  '**Envelopes.** Responses are always a named object, never a bare array: `{devices, page}`,',
  '`{device}`, `{organizations}`. Fields are camelCase; three envelope KEYS are snake_case',
  '(`api_keys`, `api_key`/`plaintext_key`, `device_model`/`device_models`) because they mirror',
  'their Postgres table names, and that stays as-is on the wire. DELETE returns `204` with an',
  'empty body, device commands return `202`, and errors are uniformly',
  '`{"error": {"code", "message", "details?"}}`.',
  '',
  '**Pagination.** Only `GET /devices`, `GET /devices/{id}/sessions` and',
  '`GET /devices/{id}/telemetry/readings` paginate; they accept `limit`/`offset`/`order`/`sort`',
  'and return a `page` block. Every other list endpoint returns its whole collection unbounded:',
  'organizations, memberships, workspaces, device models, API keys, KVS channels, and a session',
  "segment index. `GET /devices/{id}/telemetry` is not a list endpoint either. It caps rows and",
  'reports `truncated`.',
  '',
  '**What is not here.** Live telemetry and live video bypass this API entirely: the client',
  'subscribes to AWS IoT Core over MQTT-over-WSS and connects to Kinesis Video Streams WebRTC',
  'with its own credentials. See the Live section for the two endpoints that bootstrap that. The',
  'Workflows and AI surface is deliberately undocumented while it is still moving.',
].join('\n');

/** Build the served document. `baseUrl` becomes the single `servers` entry. */
export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Xorgate Core API',
      version: '0.2.0',
      description: DESCRIPTION,
    },
    servers: [{ url: baseUrl }],
    security: [{ BearerAuth: [] }],
    tags: TAGS,
    components: openApiComponents(),
    // Spread order is the reading order: it decides the order of the generated
    // reference sections, so keep it aligned with TAGS above.
    paths: {
      ...usersPaths,
      ...organizationsPaths,
      ...membershipsPaths,
      ...apiKeysPaths,
      ...workspacesPaths,
      ...deviceModelsPaths,
      ...devicesPaths,
      ...deviceRegistrationsPaths,
      ...telemetryPaths,
      ...mediaSessionsPaths,
      ...livePaths,
      ...searchPaths,
      ...metaPaths,
    },
  };
}

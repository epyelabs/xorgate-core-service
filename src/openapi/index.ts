import { openApiComponents } from './components';
import { versionedPath } from './scope';
import { metaPaths } from './meta';
import { usersPaths } from './users';
import { organizationsPaths } from './organizations';
import { membershipsPaths } from './memberships';
import { apiKeysPaths } from './api-keys';
import { authPaths } from './auth';
import { workspacesPaths } from './workspaces';
import { deviceModelsPaths } from './device-models';
import { devicesPaths } from './devices';
import { deviceRegistrationsPaths } from './device-registrations';
import { deviceSimulationsPaths } from './device-simulations';
import { transferOffersPaths } from './transfer-offers';
import { mediaSessionsPaths } from './media-sessions';
import { telemetryPaths } from './telemetry';
import { livePaths } from './live';
import { searchPaths } from './search';
import { workflowTemplatesPaths } from './workflow-templates';
import { deviceWebhooksPaths, webhookEventsSection, webhooksPaths } from './webhooks';

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
    description:
      'Organization-scoped keys. Send one as `Authorization: Bearer xg_...` to authenticate any ' +
      'organization-scoped operation, at the role the key was minted with.',
  },
  {
    name: 'Auth',
    'x-displayName': 'Auth',
    description:
      'Exchanging an API key for a short-lived token your client can hold. The one endpoint a ' +
      'third-party integration is built on.',
  },
  {
    name: 'Workspaces',
    'x-displayName': 'Workspaces',
    description:
      'The grouping devices belong to, one level below an organization. Also the tenancy unit ' +
      'for a consumer running its own multi-tenancy: a session token can be confined to one.',
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
    name: 'Device Simulations',
    'x-displayName': 'Device Simulations',
    description:
      'Devices with no hardware: the real device agent replaying a recorded drive on a loop, ' +
      'hosted for you. Create one here; everything else about it is a normal device under ' +
      '/devices.',
  },
  {
    name: 'Transfer Offers',
    'x-displayName': 'Transfer Offers',
    description:
      'Handing a device to an organization you have no membership in. The source mints a code, ' +
      'the destination redeems it. A move between workspaces of the SAME organization needs none ' +
      'of this — see POST /devices/{id}/transfer.',
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
      'Bootstrap for the live plane: video channel metadata, and the access grant the ' +
      'first-party dashboard needs.',
  },
  {
    name: 'Workflow Templates',
    'x-displayName': 'Workflow Templates',
    description:
      'The reusable processing graphs an organization has authored, and the tags a program ' +
      'finds them by. Reading only: authoring happens in the editor.',
  },
  {
    name: 'Webhooks',
    'x-displayName': 'Webhooks',
    description:
      'Signed HTTPS callbacks when something happens: a device goes online or offline, a ' +
      'recording session starts, ends or completes, a workflow emits an event. Register an ' +
      'endpoint once, then route to it from a device (`PUT /devices/{id}/webhooks`) or from a ' +
      "workflow's Emit Event node. Deliveries follow Standard Webhooks and are retried for about " +
      '44 hours. The payload of each event type is under `x-webhooks`.',
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
  '**Versioning.** Every path in this document is served under `/v1`, and that prefix is part',
  'of the path rather than of the host, so a base URL is a bare origin such as',
  '`https://api-dev.xorgate.io` and the operations below append `/v1/...` to it. There is no',
  'unversioned surface: a request without the prefix is a 404.',
  '',
  '**Authentication.** Every endpoint except `/health` and this document requires',
  '`Authorization: Bearer <credential>`, and there are three kinds, told apart by their prefix in',
  'that one header. A Cognito **ID** token (not an access token) authenticates a person; a user',
  'row is created on first successful verification. An **API key** from `POST /api-keys` (`xg_`)',
  'authenticates a program and acts inside the organization it was minted from with its own',
  '`role`; it is a server-side credential and must never reach a browser. A **session token**',
  'from `POST /auth/session-tokens` (`xgs_`) is what a browser or a mobile app holds instead: your',
  'server exchanges its key for one, it expires within the hour, it is never more privileged than',
  'the key, and it can be confined to a single workspace.',
  '',
  'Most operations take any of the three. The exceptions are narrow and deliberate: eight',
  'operations accept only an ID token, because they describe or act on a person (the four `/me`',
  'operations, `GET`/`POST /organizations`, and the two live-access operations), and',
  '`POST /auth/session-tokens` accepts only an API key.',
  '',
  '**Tenancy.** Org-scoped endpoints resolve the active organization from the `X-Organization-Id`',
  'header, falling back to your sole membership if you have exactly one. A caller in more than one',
  'organization who omits the header gets `400 ORGANIZATION_REQUIRED`, so clients should always',
  'send it. An API key or session token needs no header at all: its organization is fixed by the',
  'row behind it, and a header naming a different organization is `403 FORBIDDEN`.',
  '`X-Workspace-Id` narrows `GET /devices` and is required by `POST /device-registrations`.',
  '',
  '**Workspaces are a filter, with one exception.** For a person or an API key, every workspace in',
  'the organization is visible and `X-Workspace-Id` merely narrows a list. For a session token',
  'minted with a `workspaceId` it is an enforced BOUNDARY: device reads and writes are confined to',
  'that workspace, a contradicting `X-Workspace-Id` is `403 WORKSPACE_MISMATCH`, and',
  'organization-wide operations (memberships, API keys, organization settings, workspace writes)',
  'are `403 WORKSPACE_SCOPED` whatever role the token carries. That is how a consumer running its',
  'own multi-tenancy maps its customers onto workspaces and hands each one a credential that',
  'cannot reach the others.',
  '',
  '**Envelopes.** Responses are always a named object, never a bare array: `{devices, page}`,',
  '`{device}`, `{organizations}`. Fields are camelCase; three envelope KEYS are snake_case',
  '(`api_keys`, `api_key`/`plaintext_key`, `device_model`/`device_models`) because they mirror',
  'their Postgres table names, and that stays as-is on the wire. DELETE returns `204` with an',
  'empty body, device commands return `202`, and errors are uniformly',
  '`{"error": {"code", "message", "details?"}}`.',
  '',
  '**Pagination.** Only `GET /devices`, `GET /devices/{id}/sessions`,',
  '`GET /devices/{id}/telemetry/readings`, `GET /devices/{id}/telemetry/sessions` and',
  '`GET /workflow-templates`, `GET /webhooks` and `GET /webhooks/{id}/deliveries` paginate; they accept',
  '`limit`/`offset`/`order`/`sort`',
  'and return a `page` block. Every other list endpoint returns its whole collection unbounded:',
  'organizations, memberships, workspaces, device models, API keys, video channels, the',
  'workflow-template tag vocabulary, and a session',
  "segment index `GET /devices/{id}/telemetry` is not a list endpoint either. It caps rows and",
  'reports `truncated`.',
  '',
  '**The live plane.** Live telemetry and live video do not flow through this API: they are',
  'streaming protocols the client speaks directly, entered with a signed connection rather than',
  'with a bearer token. `POST /auth/live-credentials` is what signs it, and any of the three',
  'credentials may call it. What comes back is confined to the same tenant the calling credential',
  'is: a credential vended for a workspace receives that workspace\'s devices and is refused a',
  'sibling workspace\'s, on both planes and by the credential itself. Treat the response as',
  'opaque. The two operations in the Live section are the first-party dashboard\'s own path and',
  'are not part of a third-party integration.',
  '',
  '**What is not here.** The Workflows and AI surface is deliberately undocumented while it is',
  'still moving. The three exceptions are the workflow-template READS below, which exist because',
  'a program discovers templates by tag and acts on them; authoring a template, publishing it,',
  'attaching it to a device and reading its runs are all still editor-side and undocumented.',
].join('\n');

/** Re-key a `paths` object under the version prefix, preserving order. */
function withVersionPrefix(
  paths: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(paths).map(([path, item]) => [versionedPath(path), item]),
  );
}

/** Build the served document. `baseUrl` becomes the single `servers` entry. */
export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Xorgate Core API',
      // 0.9.0: recorded telemetry became S3 artifacts. The replay manifest
      // gained `replay.telemetry` (presigned overview + raw segments per
      // telemetry session, with insights) and `GET /devices/{id}/telemetry/
      // sessions` lists the index. Purely additive; old clients ignore the
      // new field.
      //
      // 0.8.0: workflow templates gained tags, and the three READ operations a
      // program needs to find a template by one came into the document. Purely
      // additive.
      //
      // 0.7.0: the unversioned paths are gone. `/v1` is the whole surface, the
      // two renamed-from paths no longer answer, and the deprecated
      // `channelArn` field was removed from `VideoChannel`. The most breaking
      // release this document has had, which is exactly why it happened before
      // anyone outside xorgate consumed it.
      // 0.10.0: webhooks. The endpoint registry, its delivery log, the event
      // catalog and a device's routes (tag Webhooks), plus the per-event
      // payloads under `x-webhooks` (3.0.3 has no `webhooks` section). Purely
      // additive.
      // 0.11.0: device simulations. `Device.simulated`, `GET /devices?simulated=`,
      // the `simulation` config namespace, and the Device Simulations section
      // (create, scenarios, read, start). The sim host's plane is private.
      // Purely additive.
      // 0.12.0: device SMS inbox. `POST /devices/{id}/sms-reads`, `GET
      // .../sms-reads/latest` and `GET .../sms-reads/{readId}`, plus the
      // `SmsRead` schema. Purely additive.
      // 0.13.0: device SMS clear. `POST /devices/{id}/sms/clear` (owner/admin),
      // `SmsRead.action` (`read` | `clear`) and `SmsReadResult.cleared`.
      // Purely additive.
      // 0.14.0: OBD-II peripherals. `IoCapabilities` v2 gains the optional
      // `peripherals.obd` section (adapter, transport, rateHz, fields, info),
      // which declares the `obd.<field>` metric namespace the way `comm.gps`
      // declares `gps.*`. Purely additive (plans/obd2-bluetooth-integration).
      // 0.15.0: the `obd` config namespace (adapter MAC, PIN, poll rate,
      // fields, power source; accepted only for a model that declares
      // `peripherals.obd`), the `obd_scan` / `obd_forget` device commands
      // (`POST /devices/{id}/commands/obd-scan|obd-forget`) and
      // `Device.obdScanRequestedAt`. Purely additive (P3).
      // 0.16.0: the `vehicle` session insight (OBD-II: engine-on / idle /
      // live-link time, rpm and coolant maxima, fuel and odometer start/end,
      // refuel and DTC events) in `TelemetryInsights`, and a `vehicle`
      // roll-up per session and in the totals of the windowed insights
      // (`TelemetryWindowVehicle`). Purely additive (P4).
      // 0.17.0: engine torque. The OBD field vocabulary (`peripherals.obd.fields`,
      // the `obd` namespace's `fields`) gains `engine_torque_pct` (PID 62, %),
      // `reference_torque` (PID 63, Nm) and the derived `engine_torque` (Nm),
      // appended after `link`. Purely additive.
      // 0.18.0: the `deviceStatus` session insight in `TelemetryInsights`
      // (status-LED time per code and per health flag, worst code, LED-state
      // intervals) over the new `system.led_state` / `system.health_flags`
      // metrics. Purely additive (plans/include-led-status-in-telemetry P2).
      // 0.19.0: clock-step correction. Nullable `clockCorrectionMs` on
      // `MediaSession`, `TelemetrySession` and the replay manifest's sessions;
      // the manifest caps a segment's recorded duration at nominal + 10 s so a
      // clock-step-inflated row never bridges the step. Purely additive
      // (plans/clock-step-correction P1).
      version: '0.19.0',
      description: DESCRIPTION,
    },
    // The BARE origin. The version lives in the path keys below, not here, so
    // that overriding `servers` for a dev stage or a proxy cannot silently drop
    // `/v1` and land on the deprecated unversioned aliases. The docs site does
    // exactly that override (scripts/generate-openapi.mjs rewrites `servers`
    // from NEXT_PUBLIC_API_BASE_URL), which is what makes this load-bearing
    // rather than stylistic. Decision N6a: the SDK owns the version segment the
    // same way, appending it to a bare `baseUrl`.
    servers: [{ url: baseUrl }],
    // Any of the three credentials, on every operation that does not say
    // otherwise. Two kinds of exception, each overriding this in its own module:
    // the operations that need a PERSON take `[{ BearerAuth: [] }]`, and the
    // token-minting endpoint takes `[{ ApiKeyAuth: [] }]`.
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }, { SessionTokenAuth: [] }],
    tags: TAGS,
    components: openApiComponents(),
    // Spread order is the reading order: it decides the order of the generated
    // reference sections, so keep it aligned with TAGS above.
    // Every path key gains `/v1`. Applied here, once, rather than written into
    // each module: the modules stay readable in the canonical unversioned
    // spelling that `scope.ts` and the route table also use, and retiring or
    // bumping the prefix is a one-line change in one place.
    // Event payloads a receiver implements (OAS 3.1 `webhooks`, as the 3.0
    // extension). Not paths: nothing here is served by the API.
    'x-webhooks': webhookEventsSection(),
    paths: withVersionPrefix({
      ...usersPaths,
      ...organizationsPaths,
      ...membershipsPaths,
      ...apiKeysPaths,
      ...authPaths,
      ...workspacesPaths,
      ...deviceModelsPaths,
      ...devicesPaths,
      ...deviceRegistrationsPaths,
      ...deviceSimulationsPaths,
      ...transferOffersPaths,
      ...telemetryPaths,
      ...mediaSessionsPaths,
      ...livePaths,
      ...workflowTemplatesPaths,
      ...webhooksPaths,
      ...deviceWebhooksPaths,
      ...searchPaths,
      ...metaPaths,
    }),
  };
}

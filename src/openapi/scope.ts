/**
 * What the public OpenAPI document is expected to describe.
 *
 * This is the single source of truth shared by the spec assembler and the drift
 * guard (`test/openapi-route-coverage.test.ts`), which reads the route table out
 * of `lib/stacks/api-stack.ts` and diffs it against `paths`. Anything not listed
 * here has to be documented, so a new route fails the test until someone writes
 * it up or classifies it on purpose.
 *
 * Every route key and path in this module is written in its CANONICAL,
 * UNVERSIONED form (`GET /devices`). The `/v1` prefix is applied at exactly two
 * boundaries: `index.ts` applies it to the document's path keys, and the drift
 * guard applies it when matching the document against the route table. Keeping
 * the prefix out of the lists below means one constant governs it.
 */

/** `METHOD /path` keys, matching the CDK route table verbatim. */
export type RouteKey = string;

/**
 * The one version prefix the public API is served under, introduced by Phase 6
 * of plans/platform-auth-and-live-plane.
 *
 * `src/utils/route.ts` carries the same constant for the Lambda bundles (which
 * do not import the OpenAPI assembler); `test/route-versioning.test.ts` asserts
 * the two agree.
 */
export const API_VERSION_PREFIX = '/v1';

/** `/devices` -> `/v1/devices`. */
export function versionedPath(path: string): string {
  return `${API_VERSION_PREFIX}${path}`;
}

/** `GET /devices` -> `GET /v1/devices`. */
export function versionedRoute(routeKey: RouteKey): RouteKey {
  const space = routeKey.indexOf(' ');
  return `${routeKey.slice(0, space)} ${versionedPath(routeKey.slice(space + 1))}`;
}

/** True when a route key names a `/v1` route. */
export function isVersionedRoute(routeKey: RouteKey): boolean {
  return routeKey.includes(` ${API_VERSION_PREFIX}/`);
}

/** `GET /v1/devices` -> `GET /devices`. A no-op on an already-canonical key. */
export function unversionRoute(routeKey: RouteKey): RouteKey {
  const space = routeKey.indexOf(' ');
  const path = routeKey.slice(space + 1);
  if (!path.startsWith(`${API_VERSION_PREFIX}/`)) return routeKey;
  return `${routeKey.slice(0, space)} ${path.slice(API_VERSION_PREFIX.length)}`;
}

/**
 * Routes that exist but must never read as public API. They stay in the
 * document (omitting them would make the drift guard toothless) but carry
 * `x-internal: true`, and the docs site drops every operation with that flag
 * before generating pages.
 *
 * `GET /get/{code}` serves the device install script (shell, unauthenticated),
 * and `POST /device-registrations/{code}/claim` returns one-shot X.509 private
 * key material to that script. Both are the installer's private contract.
 */
export const INTERNAL_ROUTES: readonly RouteKey[] = [
  'GET /get/{code}',
  'POST /device-registrations/{code}/claim',
];

/**
 * The Workflows/AI surface. Deliberately undocumented: it is still moving and
 * is out of scope for the SDK-and-API plan. Matched as path prefixes.
 *
 * It IS served under `/v1` like everything else. It was briefly left
 * unversioned, on the theory that a `/v1` prefix is a stability promise a
 * moving surface should not make, and because twinning it while every other
 * route also carried an alias would have pushed the stack near
 * CloudFormation's 500-resource limit. Deleting the aliases removed both
 * objections at once: the stack is smaller than it was before `/v1` existed,
 * and one prefix for the whole API is what lets a client hold a single base
 * URL. Undocumented is not the same as unversioned.
 */
export const OUT_OF_SCOPE_PATH_PREFIXES: readonly string[] = [
  '/workflow-templates',
  '/workflow-runs',
  '/workflow-catalog',
  '/model-registry',
  '/organization-credentials',
  '/devices/{id}/workflows',
  '/devices/{id}/workflow-runs',
  // xorgate-models (plans/xorgate-models): the datasets, training and
  // registry surface is Phase 1 and moving; documented when it settles (M6).
  '/datasets',
  '/training-jobs',
  '/models',
  // The device simulator's host plane (plans/xorgate-device-simulator) — not
  // moving, but PRIVATE: it accepts only the dedicated sim-host token, one
  // operation returns X.509 private key material, and it is served by a
  // single `ANY /sim-hosts/{proxy+}` route (the API stack is at the
  // CloudFormation resource limit), which no per-operation document could
  // describe. Its contract lives in src/handlers/sim-hosts.ts and
  // device/xorgate-sim-host/src/source/http.ts.
  '/sim-hosts',
];

/**
 * The exceptions carved out of the prefixes above, at ROUTE-key granularity.
 *
 * Workflow templates gained tags, and the consumer that needs them is a program
 * holding an organization API key: it lists templates by tag and reads one back.
 * `@xorgate/sdk` models exactly those three reads, and an SDK resource whose
 * endpoints appear nowhere in the reference is not something a consumer can be
 * asked to trust, so the reads are documented.
 *
 * The AUTHORING surface stays out on the original reasoning, which the reads do
 * not share: creating, updating, deleting, saving a draft, publishing,
 * restoring, simulating and the usage list are all still moving, and a template
 * is authored in the editor rather than by a consumer. Note that `POST` and
 * `GET` on `/workflow-templates` therefore land on opposite sides of this line,
 * which is why the classification is per route key and not per path.
 */
export const IN_SCOPE_ROUTES: readonly RouteKey[] = [
  'GET /workflow-templates',
  'GET /workflow-templates/tags',
  'GET /workflow-templates/{id}',
];

/**
 * True when a PATH belongs to a surface this document deliberately skips.
 *
 * Path granularity cannot see the `IN_SCOPE_ROUTES` exceptions, so prefer
 * `isOutOfScopeRoute` wherever a method is available.
 */
export function isOutOfScopePath(path: string): boolean {
  return OUT_OF_SCOPE_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** True when a ROUTE belongs to a surface this document deliberately skips. */
export function isOutOfScopeRoute(routeKey: RouteKey): boolean {
  const canonical = unversionRoute(routeKey);
  if (IN_SCOPE_ROUTES.includes(canonical)) return false;
  return isOutOfScopePath(canonical.slice(canonical.indexOf(' ') + 1));
}

/** True when a route is documented but flagged `x-internal`. */
export function isInternalRoute(routeKey: RouteKey): boolean {
  return INTERNAL_ROUTES.includes(routeKey);
}

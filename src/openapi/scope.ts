/**
 * What the public OpenAPI document is expected to describe, and how the `/v1`
 * cut divides the route table into a documented surface and a deprecated one.
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
 * the prefix out of the lists below is what makes the sunset a deletion rather
 * than a rewrite.
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
 * These routes are ALSO deliberately not versioned. Twinning them under `/v1`
 * would have cost roughly 54 more CloudFormation resources in a stack already
 * at 292 of the 500-resource hard limit, and a `/v1` prefix is a stability
 * promise this surface explicitly does not make. The consequence, recorded
 * because it is what bounds the alias period: xorgate-web calls these routes,
 * so it cannot move to `/v1` by changing one base-URL constant, and the aliases
 * below cannot be retired until this surface is productized and versioned.
 */
export const OUT_OF_SCOPE_PATH_PREFIXES: readonly string[] = [
  '/workflow-templates',
  '/workflow-runs',
  '/workflow-catalog',
  '/model-registry',
  '/organization-credentials',
  '/devices/{id}/workflows',
  '/devices/{id}/workflow-runs',
];

/** True when a route belongs to a surface this document deliberately skips. */
export function isOutOfScopePath(path: string): boolean {
  return OUT_OF_SCOPE_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** True when a route is documented but flagged `x-internal`. */
export function isInternalRoute(routeKey: RouteKey): boolean {
  return INTERNAL_ROUTES.includes(routeKey);
}

/**
 * The N11 route renames (design note N11 in plans/xorgate-sdk-and-api): nothing
 * on a consumer-facing surface should require knowing xorgate runs on AWS.
 *
 * Key is the OLD route, which keeps answering unversioned and is NOT an
 * operation in the document. Value is the route that replaced it, which is
 * documented and is the only spelling served under `/v1`. So
 * `/v1/devices/{id}/kvs-channels` does not exist, on purpose: the versioned
 * surface carries new names only.
 *
 * `POST /iot/attach-policy` moves to `POST /live/access`, joining the
 * `DELETE /live/access` that Phase 1 already shipped under the new name.
 */
export const RENAMED_ROUTE_ALIASES: Readonly<Record<RouteKey, RouteKey>> = {
  'GET /devices/{id}/kvs-channels': 'GET /devices/{id}/video-channels',
  'POST /iot/attach-policy': 'POST /live/access',
};

/**
 * Routes deliberately served ONLY under `/v1`, with no unversioned alias.
 *
 * Empty at the cut, and it should stay empty until the aliases are retired:
 * every route that existed on 2026-08-19 has a caller that predates `/v1`. A
 * route added AFTER the cut belongs here, because there is no legacy caller for
 * it to be an alias for, and adding one would mean shipping a deprecated path
 * on the same day as the route itself.
 */
export const ALIAS_EXEMPT_ROUTES: readonly RouteKey[] = [];

/**
 * THE ALIAS SUNSET, written down at introduction time because the docs plan's
 * Q4 note warns that unbounded aliases never get removed.
 *
 * Every in-scope route is served twice: at `/v1/...` and at its bare path. The
 * bare paths are deprecated from the day they were twinned (2026-08-19) and end
 * when BOTH of these are true:
 *
 *   1. the Workflows REST surface above is productized and gains `/v1` twins,
 *      and
 *   2. xorgate-web's `VITE_API_BASE_URL` points at `<api host>/v1`, and its two
 *      renamed calls (`kvs-channels`, `iot/attach-policy`) have moved.
 *
 * It is a release, not a date. Step 1 is listed first because it BLOCKS step 2:
 * xorgate-web calls the workflow routes, so it cannot move to `/v1` wholesale
 * while they are unversioned.
 *
 * Retiring them is one commit: delete `RENAMED_ROUTE_ALIASES`, delete the
 * `alias` handling in `addRoutes` in `lib/stacks/api-stack.ts`, and delete the
 * two alias tests in `test/openapi-route-coverage.test.ts`. The guard is the
 * checklist: it fails until all three are consistent.
 */
export const ALIAS_SUNSET = {
  introducedOn: '2026-08-19',
  endsWhen: 'the Workflows surface is versioned AND xorgate-web calls /v1',
} as const;

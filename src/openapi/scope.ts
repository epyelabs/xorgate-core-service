/**
 * What the public OpenAPI document is expected to describe.
 *
 * This is the single source of truth shared by the spec assembler and the drift
 * guard (`test/openapi-route-coverage.test.ts`), which reads the route table out
 * of `lib/stacks/api-stack.ts` and diffs it against `paths`. Anything not listed
 * here has to be documented, so a new route fails the test until someone writes
 * it up or classifies it on purpose.
 */

/** `METHOD /path` keys, matching the CDK route table verbatim. */
export type RouteKey = string;

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

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Reading the request's route in a way that survives the `/v1` prefix.
 *
 * Phase 6 of plans/platform-auth-and-live-plane declares every in-scope route
 * TWICE: once under `/v1` (the public, documented name) and once at its legacy
 * unversioned path (the alias xorgate-web still calls). API Gateway reports the
 * route the request actually matched, so the same handler sees BOTH
 * `PATCH /devices/{id}/config` and `PATCH /v1/devices/{id}/config`.
 *
 * The Phase 6 plan asserted that handlers are "path-suffix driven and should
 * need no logic change". That is false, and it is the reason this module
 * exists. Eight `event.routeKey` reads across five handlers compare against a
 * LITERAL route key, and one `event.rawPath` read compares a literal path:
 *
 * - `device-commands.ts` looks the command up in a map keyed by route
 * - `device-sessions.ts`, `device-workflows.ts`, `workflow-runs.ts`,
 *   `workflow-simulations.ts`, `workflow-templates.ts`,
 *   `organization-credentials.ts` switch on it
 * - `devices.ts` compares it to two literals
 * - `docs.ts` compares `rawPath` to `/openapi.json` exactly
 *
 * Every one of those would silently stop matching under `/v1` and fall through
 * to a 404 or a 405. The four `rawPath.endsWith(...)` reads
 * (`device-registrations.ts`, `telemetry-history.ts`) happen to survive, but
 * they go through here too: a handler should not have to know whether its own
 * comparison style is accidentally prefix-proof.
 *
 * `test/route-versioning.test.ts` fails the build if a handler reads
 * `event.routeKey` or `event.rawPath` directly instead of calling these.
 */

/**
 * The one version prefix the API serves. Kept here rather than imported from
 * `src/openapi/scope.ts` on purpose: this module is bundled into every Lambda
 * and the OpenAPI assembler is not. `test/route-versioning.test.ts` asserts the
 * two constants agree, so they cannot drift apart.
 */
export const VERSION_PREFIX = '/v1';

/** Strip a leading `/v1` from a path. `/v1` alone normalizes to `/`. */
function stripVersion(path: string): string {
  if (path === VERSION_PREFIX) return '/';
  return path.startsWith(`${VERSION_PREFIX}/`) ? path.slice(VERSION_PREFIX.length) : path;
}

/**
 * The matched route in its canonical, unversioned form, e.g.
 * `PATCH /devices/{id}/config` whether the caller used `/v1` or not.
 *
 * Handlers dispatch on this. It means a route's dispatch arm is written once,
 * in the unversioned spelling, and keeps working when the aliases are deleted
 * at sunset.
 */
export function routeKey(event: APIGatewayProxyEventV2): string {
  const raw = event.routeKey;
  const space = raw.indexOf(' ');
  if (space === -1) return raw; // `$default`, and anything else without a path
  return `${raw.slice(0, space)} ${stripVersion(raw.slice(space + 1))}`;
}

/**
 * The request path in its canonical, unversioned form, e.g. `/openapi.json`
 * whether the caller asked for `/openapi.json` or `/v1/openapi.json`.
 *
 * This is `rawPath`, so it carries the caller's real ids rather than the
 * route's `{id}` placeholders. Use `routeKey` unless you specifically need
 * those.
 */
export function requestPath(event: APIGatewayProxyEventV2): string {
  return stripVersion(event.rawPath);
}

/** True when the caller reached this handler through a `/v1` route. */
export function isVersionedRequest(event: APIGatewayProxyEventV2): boolean {
  return event.rawPath === VERSION_PREFIX || event.rawPath.startsWith(`${VERSION_PREFIX}/`);
}

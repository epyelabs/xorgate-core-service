import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { VERSION_PREFIX, isVersionedRequest, requestPath, routeKey } from '../src/utils/route';

/**
 * The half of the `/v1` cut that lives inside the Lambdas.
 *
 * The Phase 6 plan claimed handlers are "path-suffix driven and should need no
 * logic change" under `/v1`. They are not: eight `event.routeKey` reads compare
 * against literal route keys and one `event.rawPath` read compares a literal
 * path, and every one of them would silently stop matching once the same
 * handler started receiving `/v1/...` as well. This file is what keeps that
 * fixed, and keeps it fixed for the next handler somebody writes.
 */

const HANDLERS_DIR = join(__dirname, '..', 'src', 'handlers');

/** A minimal event: only the fields these helpers read. */
function event(fields: { routeKey?: string; rawPath?: string }): APIGatewayProxyEventV2 {
  return {
    routeKey: fields.routeKey ?? '$default',
    rawPath: fields.rawPath ?? '/',
  } as APIGatewayProxyEventV2;
}

describe('route helpers', () => {
  it('canonicalizes a versioned route key', () => {
    expect(routeKey(event({ routeKey: 'PATCH /v1/devices/{id}/config' }))).toBe(
      'PATCH /devices/{id}/config',
    );
  });

  it('leaves an unversioned route key alone', () => {
    expect(routeKey(event({ routeKey: 'PATCH /devices/{id}/config' }))).toBe(
      'PATCH /devices/{id}/config',
    );
  });

  it('survives a route key with no path', () => {
    expect(routeKey(event({ routeKey: '$default' }))).toBe('$default');
  });

  it('canonicalizes a versioned path', () => {
    expect(requestPath(event({ rawPath: '/v1/openapi.json' }))).toBe('/openapi.json');
    expect(requestPath(event({ rawPath: '/openapi.json' }))).toBe('/openapi.json');
  });

  it('normalizes the bare prefix to root', () => {
    expect(requestPath(event({ rawPath: '/v1' }))).toBe('/');
  });

  it('does not strip a prefix that merely starts the same way', () => {
    // `/v1beta/...` is not `/v1/...`, and a `startsWith(VERSION_PREFIX)` written
    // without the trailing slash would mangle it.
    expect(requestPath(event({ rawPath: '/v1beta/devices' }))).toBe('/v1beta/devices');
    expect(routeKey(event({ routeKey: 'GET /v1beta/devices' }))).toBe('GET /v1beta/devices');
  });

  it('reports whether the caller used the versioned surface', () => {
    expect(isVersionedRequest(event({ rawPath: '/v1/devices' }))).toBe(true);
    expect(isVersionedRequest(event({ rawPath: '/devices' }))).toBe(false);
    expect(isVersionedRequest(event({ rawPath: '/v1beta/devices' }))).toBe(false);
  });

  it('agrees with the prefix the OpenAPI document uses', async () => {
    const { API_VERSION_PREFIX } = await import('../src/openapi/scope');
    expect(VERSION_PREFIX).toBe(API_VERSION_PREFIX);
  });
});

describe('handlers read the route through the helpers', () => {
  /**
   * The structural guard. Every route-dependent branch in every handler has to
   * go through `src/utils/route.ts`, because the failure mode of NOT doing so is
   * invisible: the handler keeps compiling, keeps passing its own tests, and
   * returns 404 or 405 only for callers who used `/v1`.
   *
   * Comments are stripped first so that documenting the trap (which several of
   * these handlers now do) cannot trip the scanner.
   */
  const files = readdirSync(HANDLERS_DIR).filter((f) => f.endsWith('.ts'));

  it('finds the handlers', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('reads event.routeKey nowhere directly', () => {
    const offenders = files.filter((file) =>
      /event\.routeKey/.test(stripComments(readFileSync(join(HANDLERS_DIR, file), 'utf8'))),
    );
    expect(
      offenders,
      'use routeKey(event) from src/utils/route: a literal comparison against event.routeKey ' +
        'does not match the /v1 twin of the same route',
    ).toEqual([]);
  });

  it('reads event.rawPath nowhere directly', () => {
    const offenders = files.filter((file) =>
      /event\.rawPath/.test(stripComments(readFileSync(join(HANDLERS_DIR, file), 'utf8'))),
    );
    expect(offenders, 'use requestPath(event) from src/utils/route').toEqual([]);
  });
});

/** Strip block and line comments, so prose about a trap is not the trap. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

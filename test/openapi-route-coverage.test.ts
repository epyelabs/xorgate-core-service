import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/index';
import {
  ALIAS_EXEMPT_ROUTES,
  API_VERSION_PREFIX,
  INTERNAL_ROUTES,
  RENAMED_ROUTE_ALIASES,
  isOutOfScopePath,
  isVersionedRoute,
  unversionRoute,
  versionedRoute,
} from '../src/openapi/scope';

/**
 * THE drift guard. The OpenAPI document is hand-written, so the only thing that
 * can stop it rotting is a test that reads the real route table and refuses to
 * pass when the two disagree.
 *
 * The route table lives in CDK (`lib/stacks/api-stack.ts`), declared as a series
 * of `addRoutes({ path, methods })` calls. Parsing that text is cruder than
 * importing the stack, but importing it would mean synthesizing the whole app
 * (Lambdas, buckets, IoT) inside a unit test. The parser is defended by a floor
 * on the number of routes it finds, so a refactor that changes the declaration
 * shape fails loudly here instead of quietly matching nothing.
 *
 * Since Phase 6 the table also carries the `/v1` cut. `addRoutes` is a LOCAL
 * helper in the stack that declares each route twice, so this file has to model
 * the same expansion the helper performs. The risk that creates — a rule modeled
 * in two places — is closed by `declares no route outside the twinning helper`
 * below, which is what stops a route from reaching the API without going
 * through the helper at all.
 */

const API_STACK = join(__dirname, '..', 'lib', 'stacks', 'api-stack.ts');

/** Trips if `addRoutes` is ever reshaped so the regex stops matching. */
const MIN_EXPECTED_ROUTES = 40;

/** One `addRoutes({...})` call, before the `/v1` expansion. */
interface Declaration {
  path: string;
  methods: string[];
  versioned: boolean;
  alias: boolean;
}

const ADD_ROUTES_RE =
  /addRoutes\(\{\s*path:\s*["'`]([^"'`]+)["'`],\s*methods:\s*\[([\s\S]*?)\],([\s\S]*?)\n\s*\}\);/g;

function declarations(): Declaration[] {
  const source = readFileSync(API_STACK, 'utf8');
  const out: Declaration[] = [];
  for (const match of source.matchAll(ADD_ROUTES_RE)) {
    const [, path, methodsText, rest] = match;
    const methods = [...methodsText.matchAll(/HttpMethod\.([A-Z]+)/g)].map((m) => m[1]);
    expect(methods.length, `no methods parsed for ${path}`).toBeGreaterThan(0);
    out.push({
      path,
      methods,
      versioned: !/\bversioned:\s*false\b/.test(rest),
      alias: !/\balias:\s*false\b/.test(rest),
    });
  }
  return out;
}

/** Every route key the API actually serves, after the helper's expansion. */
function declaredRoutes(): string[] {
  const routes: string[] = [];
  for (const decl of declarations()) {
    for (const method of decl.methods) {
      const key = `${method} ${decl.path}`;
      if (decl.versioned) routes.push(versionedRoute(key));
      if (decl.alias) routes.push(key);
    }
  }
  return routes;
}

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'];

interface Operation {
  tags?: string[];
  'x-internal'?: boolean;
}

function documentedOperations(): Map<string, Operation> {
  const doc = buildOpenApiDocument('https://api.example.test') as {
    paths: Record<string, Record<string, unknown>>;
  };
  const out = new Map<string, Operation>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [key, value] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(key)) continue;
      out.set(`${key.toUpperCase()} ${path}`, value as Operation);
    }
  }
  return out;
}

describe('OpenAPI route coverage', () => {
  const routes = declaredRoutes();
  const documented = documentedOperations();

  it('parses the CDK route table', () => {
    expect(routes.length).toBeGreaterThanOrEqual(MIN_EXPECTED_ROUTES);
    expect(new Set(routes).size, 'duplicate route declarations').toBe(routes.length);
  });

  it('documents every in-scope route', () => {
    const missing = routes
      .filter(isVersionedRoute)
      .filter((route) => !isOutOfScopePath(unversionRoute(route).slice(route.indexOf(' ') + 1)))
      .filter((route) => !documented.has(route));
    expect(
      missing,
      'undocumented routes. Add them to src/openapi/, or classify them in src/openapi/scope.ts.',
    ).toEqual([]);
  });

  it('documents no route that does not exist', () => {
    const declared = new Set(routes);
    const stale = [...documented.keys()].filter((route) => !declared.has(route));
    expect(stale, 'documented routes with no entry in the CDK route table').toEqual([]);
  });

  it('never documents the Workflows/AI surface', () => {
    const leaked = [...documented.keys()].filter((route) => {
      const canonical = unversionRoute(route);
      return isOutOfScopePath(canonical.slice(canonical.indexOf(' ') + 1));
    });
    expect(leaked, 'out-of-scope routes leaked into the public document').toEqual([]);
  });

  it('flags the installer-only routes as internal', () => {
    for (const route of INTERNAL_ROUTES) {
      const operation = documented.get(versionedRoute(route));
      expect(operation, `${route} is missing from the document`).toBeDefined();
      expect(operation?.['x-internal'], `${route} must carry x-internal: true`).toBe(true);
    }
  });

  it('marks nothing else internal', () => {
    const flagged = [...documented.entries()]
      .filter(([, operation]) => operation['x-internal'])
      .map(([route]) => unversionRoute(route));
    expect(flagged.sort()).toEqual([...INTERNAL_ROUTES].sort());
  });
});

/**
 * The `/v1` cut and its alias period. These tests are the sunset checklist:
 * retiring the aliases means deleting them, and until someone does, they stop
 * the deprecated half from being dropped by accident or documented by mistake.
 *
 * The thing they exist to catch is asymmetric: a test that only proves `/v1/foo`
 * works proves nothing about whether `foo` still answers, and `foo` is the half
 * that keeps xorgate-web alive.
 */
describe('the /v1 alias period', () => {
  const decls = declarations();
  const routes = declaredRoutes();
  const documented = documentedOperations();
  const declared = new Set(routes);

  it('declares no route outside the twinning helper', () => {
    // Without this, a route added with `this.api.addRoutes` would exist under
    // exactly one name and every other test here would still pass, because
    // they all read the same text this rule protects.
    const source = readFileSync(API_STACK, 'utf8');
    const direct = [...source.matchAll(/this\.api\.addRoutes\(/g)].length;
    expect(
      direct,
      'this.api.addRoutes may only be called by the addRoutes helper (twice: /v1 and the alias)',
    ).toBe(2);
  });

  it('serves every documented route under /v1', () => {
    const bare = [...documented.keys()].filter((route) => !isVersionedRoute(route));
    expect(bare, 'the document must describe the /v1 names only').toEqual([]);
  });

  it('keeps an unversioned alias for every /v1 route', () => {
    const missing = routes
      .filter(isVersionedRoute)
      .map(unversionRoute)
      .filter((route) => !ALIAS_EXEMPT_ROUTES.includes(route))
      .filter((route) => !declared.has(route));
    expect(
      missing,
      'these /v1 routes lost their unversioned alias. If that is deliberate, the alias sunset ' +
        'has arrived: read ALIAS_SUNSET in src/openapi/scope.ts and retire the whole set, or add ' +
        'the route to ALIAS_EXEMPT_ROUTES if it postdates the cut.',
    ).toEqual([]);
  });

  it('documents no alias as an operation', () => {
    const documentedAliases = [...documented.keys()].filter((route) => !isVersionedRoute(route));
    expect(documentedAliases, 'aliases are a deprecation note, not operations').toEqual([]);
  });

  it('serves both halves of every N11 rename, and only the new name under /v1', () => {
    for (const [oldRoute, newRoute] of Object.entries(RENAMED_ROUTE_ALIASES)) {
      expect(declared.has(oldRoute), `${oldRoute} must keep answering unversioned`).toBe(true);
      expect(declared.has(newRoute), `${newRoute} must be served`).toBe(true);
      expect(declared.has(versionedRoute(newRoute)), `${newRoute} must be served under /v1`).toBe(
        true,
      );
      expect(
        declared.has(versionedRoute(oldRoute)),
        `${oldRoute} must NOT exist under /v1: the versioned surface carries new names only`,
      ).toBe(false);
      expect(documented.has(versionedRoute(newRoute)), `${newRoute} must be documented`).toBe(true);
      expect(documented.has(oldRoute), `${oldRoute} must not be documented`).toBe(false);
    }
  });

  it('leaves the Workflows surface unversioned', () => {
    const versionedOutOfScope = decls
      .filter((decl) => isOutOfScopePath(decl.path))
      .filter((decl) => decl.versioned)
      .map((decl) => decl.path);
    expect(
      versionedOutOfScope,
      'the Workflows surface makes no /v1 promise; see OUT_OF_SCOPE_PATH_PREFIXES',
    ).toEqual([]);
  });

  it('keeps the renamed response field additive until sunset', () => {
    // A field rename cannot ride a path alias: both spellings have to be on the
    // wire, on BOTH routes, or xorgate-web (which reads `channelArn`) breaks.
    // The document describes `channelRef` as required and `channelArn` as
    // deprecated, and the handler has to actually send both.
    const doc = buildOpenApiDocument('https://api.example.test') as {
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, { deprecated?: boolean }> }> };
    };
    const schema = doc.components.schemas.VideoChannel;
    expect(schema, 'VideoChannel schema is gone').toBeDefined();
    expect(schema.required).toContain('channelRef');
    expect(schema.required, 'the deprecated spelling must not be required').not.toContain('channelArn');
    expect(
      schema.properties?.channelArn?.deprecated,
      'channelArn must stay documented AND flagged deprecated while it is still sent',
    ).toBe(true);

    const handler = readFileSync(
      join(__dirname, '..', 'src', 'handlers', 'device-kvs-channels.ts'),
      'utf8',
    );
    expect(
      /channelRef:\s*row\.channelArn/.test(handler),
      'device-kvs-channels must still map channelArn onto channelRef',
    ).toBe(true);
  });

  it('agrees with the prefix the handlers strip', async () => {
    const { VERSION_PREFIX } = await import('../src/utils/route');
    expect(VERSION_PREFIX).toBe(API_VERSION_PREFIX);
  });
});

describe('OpenAPI document shape', () => {
  const doc = buildOpenApiDocument('https://api.example.test') as {
    tags: { name: string }[];
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };

  it('declares every tag its operations use', () => {
    // fumadocs-openapi groups pages by tag and silently DROPS an operation whose
    // tag is not declared at the top level, so an undeclared tag is a page that
    // never gets generated rather than a visible error.
    const declared = new Set(doc.tags.map((tag) => tag.name));
    const used = new Set<string>();
    for (const item of Object.values(doc.paths)) {
      for (const [key, value] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(key)) continue;
        for (const tag of (value as Operation).tags ?? []) used.add(tag);
      }
    }
    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
  });

  it('gives every tag an x-displayName', () => {
    // Without it, fumadocs labels the section by running `idToTitle` over the
    // tag NAME, which inserts a space before every capital: "API Keys" rendered
    // as "A P I Keys". Any future acronym tag would hit the same thing.
    const missing = (doc.tags as { name: string; 'x-displayName'?: string }[])
      .filter((tag) => !tag['x-displayName'])
      .map((tag) => tag.name);
    expect(missing).toEqual([]);
  });

  it('gives every operation a tag and an operationId', () => {
    const untagged: string[] = [];
    const ids = new Map<string, string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [key, value] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(key)) continue;
        const operation = value as Operation & { operationId?: string };
        const route = `${key.toUpperCase()} ${path}`;
        if (!operation.tags?.length || !operation.operationId) untagged.push(route);
        if (operation.operationId) {
          expect(ids.has(operation.operationId), `duplicate operationId ${operation.operationId}`).toBe(
            false,
          );
          ids.set(operation.operationId, route);
        }
      }
    }
    expect(untagged).toEqual([]);
  });

  it('names only declared security schemes', () => {
    // A security requirement naming a scheme that does not exist is not an
    // error in any renderer: the operation simply shows as needing nothing.
    // That reads as "this endpoint is public", which is the worst possible way
    // for a typo to fail.
    const schemes = new Set(
      Object.keys(
        (doc.components as unknown as { securitySchemes: Record<string, unknown> })
          .securitySchemes,
      ),
    );
    const used = new Set<string>();
    const collect = (requirements: unknown) => {
      for (const requirement of (requirements ?? []) as Record<string, unknown>[]) {
        for (const name of Object.keys(requirement)) used.add(name);
      }
    };
    collect((doc as unknown as { security?: unknown }).security);
    for (const item of Object.values(doc.paths)) {
      for (const [key, value] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(key)) continue;
        collect((value as { security?: unknown }).security);
      }
    }
    expect([...used].filter((name) => !schemes.has(name)), 'undeclared security scheme').toEqual(
      [],
    );
    // Both schemes are meant to be reachable; an unused one means an override
    // swallowed it everywhere.
    expect([...schemes].filter((name) => !used.has(name)), 'unused security scheme').toEqual([]);
  });

  it('resolves every local $ref', () => {
    const serialized = JSON.stringify(doc);
    const refs = new Set(
      [...serialized.matchAll(/"\$ref":"#\/components\/(\w+)\/([^"]+)"/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      ),
    );
    const components = doc.components as unknown as Record<string, Record<string, unknown>>;
    const dangling = [...refs].filter((ref) => {
      const [group, name] = ref.split('/');
      return components[group]?.[name] === undefined;
    });
    expect(dangling, 'dangling $ref').toEqual([]);
  });
});

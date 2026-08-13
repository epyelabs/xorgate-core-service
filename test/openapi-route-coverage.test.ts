import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/index';
import { INTERNAL_ROUTES, isOutOfScopePath } from '../src/openapi/scope';

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
 */

const API_STACK = join(__dirname, '..', 'lib', 'stacks', 'api-stack.ts');

/** Trips if `addRoutes` is ever reshaped so the regex stops matching. */
const MIN_EXPECTED_ROUTES = 40;

const ADD_ROUTES_RE =
  /addRoutes\(\{\s*path:\s*["'`]([^"'`]+)["'`],\s*methods:\s*\[([\s\S]*?)\]/g;

function declaredRoutes(): string[] {
  const source = readFileSync(API_STACK, 'utf8');
  const routes: string[] = [];
  for (const match of source.matchAll(ADD_ROUTES_RE)) {
    const path = match[1];
    const methods = [...match[2].matchAll(/HttpMethod\.([A-Z]+)/g)].map((m) => m[1]);
    expect(methods.length, `no methods parsed for ${path}`).toBeGreaterThan(0);
    for (const method of methods) routes.push(`${method} ${path}`);
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
      .filter((route) => !isOutOfScopePath(route.slice(route.indexOf(' ') + 1)))
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
    const leaked = [...documented.keys()].filter((route) =>
      isOutOfScopePath(route.slice(route.indexOf(' ') + 1)),
    );
    expect(leaked, 'out-of-scope routes leaked into the public document').toEqual([]);
  });

  it('flags the installer-only routes as internal', () => {
    for (const route of INTERNAL_ROUTES) {
      const operation = documented.get(route);
      expect(operation, `${route} is missing from the document`).toBeDefined();
      expect(operation?.['x-internal'], `${route} must carry x-internal: true`).toBe(true);
    }
  });

  it('marks nothing else internal', () => {
    const flagged = [...documented.entries()]
      .filter(([, operation]) => operation['x-internal'])
      .map(([route]) => route);
    expect(flagged.sort()).toEqual([...INTERNAL_ROUTES].sort());
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

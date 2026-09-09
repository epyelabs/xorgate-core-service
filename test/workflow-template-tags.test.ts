import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  MAX_TAGS_PER_TEMPLATE,
  MAX_TAG_LENGTH,
  normalizeTag,
  normalizeTags,
  parseTagFilter,
} from '../src/utils/tags';
import { buildOpenApiDocument } from '../src/openapi/index';
import { IN_SCOPE_ROUTES, isOutOfScopeRoute, versionedRoute } from '../src/openapi/scope';
import { createWorkflowTemplateSchema, updateWorkflowTemplateSchema } from '../src/schemas/workflows';

/**
 * Free-form tags on a workflow template.
 *
 * The rules matter more than usual because a tag is a lookup key a consumer
 * holding an API key writes into its own configuration: `geofence` typed on the
 * platform and `geofence` typed in Alocate have to be the same string, and a
 * value that could never match must fail loudly rather than return nothing.
 */

function event(query: Record<string, string> | undefined = undefined): APIGatewayProxyEventV2 {
  return {
    requestContext: { requestId: 'req-1', http: { method: 'GET' } },
    headers: {},
    queryStringParameters: query,
  } as unknown as APIGatewayProxyEventV2;
}

function message(result: { error: APIGatewayProxyResultV2 }): string {
  return JSON.parse((result.error as { body: string }).body).error.message;
}

describe('tag normalization', () => {
  it('corrects case and surrounding whitespace rather than rejecting them', () => {
    expect(normalizeTag('  Geofence  ')).toBe('geofence');
    expect(normalizeTag('ZONE-A')).toBe('zone-a');
  });

  it('accepts digits, dot, underscore and hyphen after the first character', () => {
    for (const tag of ['geofence', 'zone-a', 'v1.2', 'alocate_geofence', '4wd', 'a']) {
      expect(normalizeTag(tag), tag).toBe(tag);
    }
  });

  it('refuses anything that is not a lookup key', () => {
    for (const tag of ['', '   ', '-leading', '.leading', '_leading', 'has space', 'sla/sh', 'a,b', 'é', 'tag#1']) {
      expect(normalizeTag(tag), tag).toBeNull();
    }
  });

  it('refuses a tag longer than the maximum, at exactly one character over', () => {
    expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH))).toBe('a'.repeat(MAX_TAG_LENGTH));
    expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
  });

  it('dedupes after normalizing, and keeps first-seen order', () => {
    const result = normalizeTags(['Geofence', 'zone-a', ' geofence ', 'GEOFENCE']);
    expect(result).toEqual({ tags: ['geofence', 'zone-a'] });
  });

  it('names the offending value in the refusal', () => {
    const result = normalizeTags(['geofence', 'not a tag']);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('"not a tag"');
  });

  it('caps the set, counting AFTER dedupe', () => {
    const many = Array.from({ length: MAX_TAGS_PER_TEMPLATE }, (_, i) => `tag-${i}`);
    expect(normalizeTags(many)).toEqual({ tags: many });
    // 21 values, but only 20 distinct ones: that is 20 tags, not 21.
    expect(normalizeTags([...many, 'TAG-0'])).toEqual({ tags: many });
    expect('error' in normalizeTags([...many, 'tag-extra'])).toBe(true);
  });

  it('turns an empty list into an empty set, which is how a caller clears tags', () => {
    expect(normalizeTags([])).toEqual({ tags: [] });
  });
});

describe('the ?tag= filter', () => {
  it('is absent when the parameter is missing or blank', () => {
    expect(parseTagFilter(event())).toEqual({ tags: [] });
    expect(parseTagFilter(event({}))).toEqual({ tags: [] });
    expect(parseTagFilter(event({ tag: '' }))).toEqual({ tags: [] });
    expect(parseTagFilter(event({ tag: '   ' }))).toEqual({ tags: [] });
  });

  it('reads the comma-joined form API Gateway produces for a repeated parameter', () => {
    // `?tag=geofence&tag=speeding` reaches the Lambda as one comma-joined value
    // under payload v2, and a comma can never occur inside a tag.
    expect(parseTagFilter(event({ tag: 'geofence,speeding' }))).toEqual({
      tags: ['geofence', 'speeding'],
    });
  });

  it('normalizes the filter the same way a write is normalized', () => {
    expect(parseTagFilter(event({ tag: 'Geofence, ZONE-A ' }))).toEqual({
      tags: ['geofence', 'zone-a'],
    });
  });

  it('ignores empty entries, so a trailing comma is harmless', () => {
    expect(parseTagFilter(event({ tag: 'geofence,' }))).toEqual({ tags: ['geofence'] });
    expect(parseTagFilter(event({ tag: 'geofence,,speeding' }))).toEqual({
      tags: ['geofence', 'speeding'],
    });
  });

  it('rejects a value that could never be a stored tag, rather than matching nothing', () => {
    const result = parseTagFilter(event({ tag: 'not a tag' }));
    expect('error' in result).toBe(true);
    const res = (result as { error: APIGatewayProxyResultV2 }).error;
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(message(result as { error: APIGatewayProxyResultV2 })).toContain('"not a tag"');
  });

  it('caps the number of values', () => {
    const many = Array.from({ length: MAX_TAGS_PER_TEMPLATE + 1 }, (_, i) => `tag-${i}`);
    const result = parseTagFilter(event({ tag: many.join(',') }));
    expect('error' in result).toBe(true);
    expect(message(result as { error: APIGatewayProxyResultV2 })).toContain('at most 20');
  });
});

describe('the write schemas', () => {
  it('accept tags on create and on update, and treat absent as untouched', () => {
    expect(createWorkflowTemplateSchema.parse({ name: 'T' }).tags).toBeUndefined();
    expect(createWorkflowTemplateSchema.parse({ name: 'T', tags: ['A'] }).tags).toEqual(['A']);
    expect(updateWorkflowTemplateSchema.parse({}).tags).toBeUndefined();
    // An empty array is a real instruction: clear them.
    expect(updateWorkflowTemplateSchema.parse({ tags: [] }).tags).toEqual([]);
  });

  it('leave the tag RULES to utils/tags, so the query filter cannot disagree', () => {
    // The schema takes bare strings; normalization is what rejects them.
    expect(createWorkflowTemplateSchema.safeParse({ name: 'T', tags: ['not a tag'] }).success).toBe(
      true,
    );
    expect('error' in normalizeTags(['not a tag'])).toBe(true);
  });
});

describe('the handler', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'handlers', 'workflow-templates.ts'),
    'utf8',
  );

  it('filters with an ANY-of array overlap, which is what the GIN index serves', () => {
    expect(source).toContain('arrayOverlaps(schema.workflowTemplates.tags');
  });

  it('normalizes on both write paths', () => {
    // Two call sites: POST and PUT. A third would mean a path that stores a
    // tag nobody can filter for.
    expect(source.match(/normalizeTags\(/g)?.length).toBe(2);
  });

  it('serves tags on every template response', () => {
    // toSummary is the one mapper; the detail response spreads it.
    expect(source).toContain('tags: t.tags ?? []');
  });
});

describe('the public document', () => {
  const doc = buildOpenApiDocument('https://api.example.test') as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };

  it('documents the three reads and nothing else from the workflows surface', () => {
    expect([...IN_SCOPE_ROUTES]).toEqual([
      'GET /workflow-templates',
      'GET /workflow-templates/tags',
      'GET /workflow-templates/{id}',
    ]);
    for (const route of IN_SCOPE_ROUTES) {
      const [method, path] = route.split(' ');
      expect(doc.paths[`/v1${path}`]?.[method.toLowerCase()], route).toBeDefined();
      expect(isOutOfScopeRoute(versionedRoute(route)), route).toBe(false);
    }
  });

  it('keeps the authoring surface out, including the POST that shares a path', () => {
    for (const route of [
      'POST /workflow-templates',
      'PUT /workflow-templates/{id}',
      'DELETE /workflow-templates/{id}',
      'PUT /workflow-templates/{id}/draft',
      'GET /workflow-templates/{id}/usage',
      'POST /workflow-templates/{id}/simulations',
      'GET /workflow-runs',
    ]) {
      expect(isOutOfScopeRoute(versionedRoute(route)), route).toBe(true);
    }
    expect(doc.paths['/v1/workflow-templates']?.['post']).toBeUndefined();
  });

  it('describes the tag filter as a repeatable array', () => {
    const parameters = doc.paths['/v1/workflow-templates']['get']['parameters'] as Array<{
      name?: string;
      explode?: boolean;
      schema?: { type?: string; maxItems?: number };
    }>;
    const tag = parameters.find((p) => p.name === 'tag');
    expect(tag).toBeDefined();
    expect(tag?.explode).toBe(true);
    expect(tag?.schema?.type).toBe('array');
    expect(tag?.schema?.maxItems).toBe(MAX_TAGS_PER_TEMPLATE);
  });

  it('states the tag rules once, on the schema the responses point at', () => {
    const doc2 = buildOpenApiDocument('https://api.example.test') as {
      components: { schemas: Record<string, { pattern?: string; maxLength?: number }> };
    };
    const tag = doc2.components.schemas['WorkflowTemplateTag'];
    expect(tag.pattern).toBe('^[a-z0-9][a-z0-9._-]*$');
    expect(tag.maxLength).toBe(MAX_TAG_LENGTH);
  });
});

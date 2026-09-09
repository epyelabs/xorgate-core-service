import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest } from './responses';

/**
 * Free-form tags on a workflow template: the one place their shape is decided.
 *
 * Tags are how a program finds a template it did not create. Alocate's
 * Geofencing backend holds an organization API key, lists templates by tag, and
 * acts on what comes back, so a tag is an identifier a consumer writes into a
 * config file rather than a label only a person reads. That is what these rules
 * are for: lowercase and trimmed, so `Geofence` and `geofence ` cannot become
 * two labels for one intent; a restricted charset, so a tag survives a URL
 * unescaped; and a cap, so the column stays an index rather than a document.
 *
 * Normalization runs on WRITE (the stored array is already canonical) and again
 * on the filter, so `?tag=Geofence` matches the row stored as `geofence`.
 */

/** A tag starts alphanumeric, then allows dot, underscore and hyphen. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_TEMPLATE = 20;

/**
 * Canonical form of one tag, or `null` when it cannot be one.
 *
 * Case and surrounding whitespace are corrected rather than rejected: they are
 * typing, not intent. Everything else fails, because silently dropping a tag
 * leaves a caller believing a template is findable when it is not.
 */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase();
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) return null;
  return TAG_PATTERN.test(tag) ? tag : null;
}

/** The message a rejected tag produces, shared by the body and query paths. */
export function tagRejectionMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'A tag cannot be empty';
  if (trimmed.length > MAX_TAG_LENGTH) {
    return `A tag cannot be longer than ${MAX_TAG_LENGTH} characters`;
  }
  return (
    `Tag "${trimmed}" is invalid: use lowercase letters, digits, ".", "_" and "-", ` +
    'starting with a letter or digit'
  );
}

/** Either the canonical list or the one message explaining the refusal. */
export type NormalizeTagsResult = { tags: string[] } | { error: string };

/**
 * Normalizes a whole list, preserving first-seen order and dropping duplicates
 * that differed only by case or whitespace. Reports the first offender rather
 * than every one: the error envelope carries a single message.
 */
export function normalizeTags(raw: readonly string[]): NormalizeTagsResult {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const tag = normalizeTag(value);
    if (tag === null) return { error: tagRejectionMessage(value) };
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS_PER_TEMPLATE) {
    return { error: `A template can carry at most ${MAX_TAGS_PER_TEMPLATE} tags` };
  }
  return { tags };
}

/**
 * `?tag=` on a list endpoint, in the `parseListParams` idiom: either a `400`
 * response or the normalized filter.
 *
 * One parameter, two spellings that reach the Lambda as the same string. API
 * Gateway's payload v2 comma-joins repeated query parameters, and a comma
 * cannot occur inside a tag, so `?tag=a&tag=b` and `?tag=a,b` are
 * indistinguishable here and mean the same thing. Empty entries are ignored,
 * which is what makes a trailing comma harmless.
 */
export function parseTagFilter(
  event: APIGatewayProxyEventV2,
): { error: APIGatewayProxyResultV2 } | { tags: string[] } {
  const raw = event.queryStringParameters?.tag;
  if (raw === undefined || raw.trim() === '') return { tags: [] };
  const parts = raw.split(',').filter((part) => part.trim() !== '');
  const result = normalizeTags(parts);
  if ('error' in result) return { error: badRequest(result.error) };
  return { tags: result.tags };
}

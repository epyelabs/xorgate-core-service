/**
 * Naming rules shared by the datasets and models handlers (pure; no AWS, no
 * DB). The model name rule is the engine's own `SEGMENT_RE` from
 * `@xorgate/workflow-engine/local` (model-ref.ts): what a node's `model`
 * config may carry before an optional `@<version>` pin, and therefore what an
 * organization may name a trained model. Kept as a literal here so the Lambda
 * bundles do not pull the local host module in for one regex; the smoke
 * asserts the two agree by round-tripping names through `parseModelName`.
 */

export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MODEL_NAME_MAX = 64;

/** A `null` result means the name is valid; otherwise the reason. */
export function modelNameError(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'Model name is required';
  if (name.length > MODEL_NAME_MAX) return `Model name must be at most ${MODEL_NAME_MAX} characters`;
  if (name.includes('@')) return 'Model name must not contain "@" (the version pin is separate)';
  if (!MODEL_NAME_RE.test(name)) {
    return 'Model name must start with a letter or digit and contain only letters, digits, ".", "_" or "-"';
  }
  return null;
}

export const DATASET_NAME_MAX = 80;
export const DATASET_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `Yard cameras (west)` -> `yard-cameras-west`; never empty. */
export function slugifyDatasetName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64)
    .replace(/-$/, '');
  return base || 'dataset';
}

/** `base`, then `base-2`, `base-3`, ... against the slugs already taken. */
export function freeSlugFrom(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export const CLASS_NAME_MAX = 48;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function classNameError(name: string): string | null {
  if (typeof name !== 'string') return 'Class name must be a string';
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Class name is required';
  if (trimmed.length > CLASS_NAME_MAX) return `Class name must be at most ${CLASS_NAME_MAX} characters`;
  if (CONTROL_CHARS.test(trimmed)) return 'Class name must not contain control characters';
  return null;
}

/**
 * S3 key helpers for the three Models prefixes on the core bucket (design
 * §4a) and the gate every presign handler applies: a key is only ever signed
 * when it lies under the prefix of the entity the caller was authorized on.
 *
 *   datasets/<datasetId>/items/<itemId>.<ext>                 originals
 *   datasets/<datasetId>/versions/<n>/{dataset.json, annotations.coco.json, splits.json, images/<itemId>.<ext>}
 *   training/<jobId>/...                                       M3
 *   org-models/<orgId>/<family>/<name>/<version>/{manifest.json, model.onnx}
 *
 * Keys carry ids, never tenancy; the organization comes from the row.
 */

export const DATASETS_PREFIX = 'datasets/';
export const TRAINING_PREFIX = 'training/';
export const ORG_MODELS_PREFIX = 'org-models/';
/** The platform registry root the engine read before M2 (workflows/models/registry.ts). */
export const PLATFORM_MODELS_PREFIX = 'models/';

export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];
export const IMAGE_EXTENSIONS: Record<ImageContentType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };

/** Q6: 20 MiB per image, 5,000 items per dataset, 500 frames per import. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ITEMS_PER_DATASET = 5000;
export const MAX_IMPORT_FRAMES = 500;

export function datasetPrefix(datasetId: string): string {
  return `${DATASETS_PREFIX}${datasetId}/`;
}
export function datasetItemsPrefix(datasetId: string): string {
  return `${datasetPrefix(datasetId)}items/`;
}
export function datasetItemKey(datasetId: string, itemId: string, ext: string): string {
  return `${datasetItemsPrefix(datasetId)}${itemId}.${ext}`;
}
export function datasetVersionPrefix(datasetId: string, version: number): string {
  return `${datasetPrefix(datasetId)}versions/${version}/`;
}
export function versionImageKey(datasetId: string, version: number, itemId: string, ext: string): string {
  return `${datasetVersionPrefix(datasetId, version)}images/${itemId}.${ext}`;
}
/** The `file_name` the COCO file carries, relative to the version root. */
export function versionImageFileName(itemId: string, ext: string): string {
  return `images/${itemId}.${ext}`;
}
export const VERSION_FILES = ['dataset.json', 'annotations.coco.json', 'splits.json'] as const;

export function trainingPrefix(jobId: string): string {
  return `${TRAINING_PREFIX}${jobId}/`;
}

/** `org-models/<orgId>/`: the organization's registry root (Q4). */
export function orgModelsRoot(orgId: string): string {
  return `${ORG_MODELS_PREFIX}${orgId}/`;
}
export function orgModelPrefix(orgId: string, family: string, name: string, version: number): string {
  return `${orgModelsRoot(orgId)}${family}/${name}/${version}/`;
}

/**
 * The presign gate. A key qualifies only when it starts with the prefix AND
 * cannot climb out of it: no `..` segment, no empty segment, no leading
 * slash, and something after the prefix.
 */
export function isKeyUnder(prefix: string, key: string): boolean {
  if (!prefix.endsWith('/')) return false;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  if (rest.length === 0) return false;
  const segments = rest.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/** The item id and extension out of an items key, or null when the key is not one. */
export function parseItemKey(datasetId: string, key: string): { itemId: string; ext: string } | null {
  const prefix = datasetItemsPrefix(datasetId);
  if (!isKeyUnder(prefix, key)) return null;
  const rest = key.slice(prefix.length);
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png)$/.exec(rest);
  if (!m) return null;
  return { itemId: m[1], ext: m[2] };
}

/** The last path segment as a download filename (`model.onnx`, `dataset.json`). */
export function keyFileName(key: string): string {
  const i = key.lastIndexOf('/');
  return i === -1 ? key : key.slice(i + 1);
}

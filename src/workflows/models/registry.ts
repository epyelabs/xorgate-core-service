/**
 * Model registry contracts (architecture.md §6). The registry is an S3 PREFIX
 * on the existing core bucket, not a separate bucket (one bucket to grant, the
 * data is small, and lifecycle needs match; recorded as an M2 session 2
 * decision):
 *
 *   models/<family>/<name>/<version>/model.onnx
 *   models/<family>/<name>/<version>/manifest.json   (this module's schema)
 *
 * `family` matches NodeTypeDef.runtime.modelRef.family ("detection", "depth");
 * `name` is what node config carries ("yolov8n"); `version` is a positive
 * integer directory, highest wins when a consumer asks for "latest".
 *
 * The manifest turns pre/post-processing into DATA (open_questions.md Q1): the
 * TS engine reads input geometry, normalization, class names, and NMS
 * parameters from here instead of hard-coding them per model. The export CI
 * (model-export/) is the only writer.
 *
 * xorgate-models M2 (design §4e): the same layout also lives under a second
 * ROOT per organization, `org-models/<orgId>/`, written by the platform's
 * training finalizer. Every helper below takes an optional root (default: the
 * platform root) so the store can walk a root chain; the platform-root
 * constants and one-argument shapes are unchanged for existing callers.
 */

export const MODEL_REGISTRY_PREFIX = 'models/';
/** `org-models/`: the parent of every organization root (`org-models/<orgId>/`). */
export const ORG_MODEL_REGISTRY_PREFIX = 'org-models/';

// The manifest schema and its type come from the engine package (the engine
// reads pre/post-processing from the manifest; the platform only stores and
// lists them). `family` is an open string there with MODEL_FAMILIES as the
// known values, exactly as the package's registry contract says.
export { MODEL_FAMILIES, modelManifestSchema } from '@xorgate/workflow-engine';
export type { ModelManifest } from '@xorgate/workflow-engine';

/** The organization's registry root for the run-manifest `orgId`. */
export function orgModelRegistryRoot(orgId: string): string {
  return `${ORG_MODEL_REGISTRY_PREFIX}${orgId}/`;
}

/**
 * The resolution chain for a run: the organization's root first, then the
 * platform root (the local host's `--models-dir` semantics and the secret
 * reader's org-then-platform order). Runs without an `orgId` see the
 * platform root only.
 */
export function modelRootsFor(orgId: string | null | undefined): string[] {
  return orgId ? [orgModelRegistryRoot(orgId), MODEL_REGISTRY_PREFIX] : [MODEL_REGISTRY_PREFIX];
}

export function modelVersionPrefix(
  family: string,
  name: string,
  version: number,
  root: string = MODEL_REGISTRY_PREFIX,
): string {
  return `${root}${family}/${name}/${version}/`;
}
export function modelNamePrefix(family: string, name: string, root: string = MODEL_REGISTRY_PREFIX): string {
  return `${root}${family}/${name}/`;
}
export function modelOnnxKey(
  family: string,
  name: string,
  version: number,
  root: string = MODEL_REGISTRY_PREFIX,
): string {
  return `${modelVersionPrefix(family, name, version, root)}model.onnx`;
}
export function modelManifestKey(
  family: string,
  name: string,
  version: number,
  root: string = MODEL_REGISTRY_PREFIX,
): string {
  return `${modelVersionPrefix(family, name, version, root)}manifest.json`;
}

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
 */

export const MODEL_REGISTRY_PREFIX = 'models/';

// The manifest schema and its type come from the engine package (the engine
// reads pre/post-processing from the manifest; the platform only stores and
// lists them). `family` is an open string there with MODEL_FAMILIES as the
// known values, exactly as the package's registry contract says.
export { MODEL_FAMILIES, modelManifestSchema } from '@xorgate/workflow-engine';
export type { ModelManifest } from '@xorgate/workflow-engine';

export function modelVersionPrefix(family: string, name: string, version: number): string {
  return `${MODEL_REGISTRY_PREFIX}${family}/${name}/${version}/`;
}
export function modelNamePrefix(family: string, name: string): string {
  return `${MODEL_REGISTRY_PREFIX}${family}/${name}/`;
}
export function modelOnnxKey(family: string, name: string, version: number): string {
  return `${modelVersionPrefix(family, name, version)}model.onnx`;
}
export function modelManifestKey(family: string, name: string, version: number): string {
  return `${modelVersionPrefix(family, name, version)}manifest.json`;
}

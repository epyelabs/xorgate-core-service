import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  MODEL_REGISTRY_PREFIX,
  modelManifestKey,
  modelManifestSchema,
  modelNamePrefix,
  modelOnnxKey,
  type ModelManifest,
} from './registry';

/**
 * S3 access for the model registry roots. Used by the GET /model-registry
 * handler (platform listing), GET /models (the merged read), and the Fargate
 * engine target (resolve + download through a ROOT CHAIN, design §4e). The
 * engine CORE never touches this; model executors reach it through the
 * EngineSourceReader.fetchModel seam their target supplies.
 */

async function getJson(s3: S3Client, bucket: string, key: string): Promise<unknown> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  return JSON.parse(body ?? 'null');
}

/** A manifest plus the root it was found under (what `downloadModel` needs). */
export interface ResolvedModel {
  manifest: ModelManifest;
  root: string;
}

/**
 * Every manifest under `root` (default: the platform root), newest version
 * first per (family, name). Unparseable manifests are skipped with a warning:
 * one bad upload must not take the picker down.
 */
export async function listModelManifests(
  s3: S3Client,
  bucket: string,
  root: string = MODEL_REGISTRY_PREFIX,
): Promise<ModelManifest[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: root,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith('/manifest.json')) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const manifests: ModelManifest[] = [];
  for (const key of keys) {
    try {
      manifests.push(modelManifestSchema.parse(await getJson(s3, bucket, key)));
    } catch (err) {
      console.warn('model-registry: skipping invalid manifest', { key, err });
    }
  }
  return manifests.sort(
    (a, b) =>
      a.family.localeCompare(b.family) || a.name.localeCompare(b.name) || b.version - a.version,
  );
}

/** The integer version directories under `<root><family>/<name>/`, newest first. */
export async function listModelVersions(
  s3: S3Client,
  bucket: string,
  family: string,
  name: string,
  root: string = MODEL_REGISTRY_PREFIX,
): Promise<number[]> {
  const prefix = modelNamePrefix(family, name, root);
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' }),
  );
  return (res.CommonPrefixes ?? [])
    .map((p) => Number((p.Prefix ?? '').slice(prefix.length).replace(/\/$/, '')))
    .filter((v) => Number.isInteger(v) && v > 0)
    .sort((a, b) => b - a);
}

function describeRoots(roots: readonly string[], bucket: string): string {
  return roots.map((r) => `s3://${bucket}/${r}`).join(', ');
}

/**
 * Resolves the latest version of `<root><family>/<name>/` and validates its
 * manifest against its path. Throws with an actionable message when the
 * model is absent from every root in the chain.
 */
export async function resolveLatestModel(
  s3: S3Client,
  bucket: string,
  family: string,
  name: string,
  roots: readonly string[] = [MODEL_REGISTRY_PREFIX],
): Promise<ModelManifest> {
  return (await resolveLatestModelIn(s3, bucket, family, name, roots)).manifest;
}

export async function resolveLatestModelIn(
  s3: S3Client,
  bucket: string,
  family: string,
  name: string,
  roots: readonly string[] = [MODEL_REGISTRY_PREFIX],
): Promise<ResolvedModel> {
  for (const root of roots) {
    const versions = await listModelVersions(s3, bucket, family, name, root);
    if (versions.length === 0) continue;
    const manifest = modelManifestSchema.parse(
      await getJson(s3, bucket, modelManifestKey(family, name, versions[0], root)),
    );
    if (manifest.name !== name || manifest.family !== family || manifest.version !== versions[0]) {
      throw new Error(
        `Model manifest at ${modelManifestKey(family, name, versions[0], root)} disagrees with its path (${manifest.family}/${manifest.name}/${manifest.version})`,
      );
    }
    return { manifest, root };
  }
  throw new Error(
    `Model "${name}" (family ${family}) is not in the registry at ${describeRoots(roots, bucket)}; train or publish it first`,
  );
}

/**
 * Resolves a registry model: a pinned `version` reads that manifest directly
 * (the package's `name@version` rule, split by `parseModelName` in the host),
 * otherwise the newest version; each root in the chain is tried in order and
 * the first that has the model wins (an organization name shadows a platform
 * name for that organization, the local root semantics). Both shapes validate
 * the manifest against its path.
 */
export async function resolveModel(
  s3: S3Client,
  bucket: string,
  family: string,
  name: string,
  version?: number,
  roots: readonly string[] = [MODEL_REGISTRY_PREFIX],
): Promise<ModelManifest> {
  return (await resolveModelIn(s3, bucket, family, name, version, roots)).manifest;
}

export async function resolveModelIn(
  s3: S3Client,
  bucket: string,
  family: string,
  name: string,
  version?: number,
  roots: readonly string[] = [MODEL_REGISTRY_PREFIX],
): Promise<ResolvedModel> {
  if (version === undefined) return resolveLatestModelIn(s3, bucket, family, name, roots);
  let lastErr: unknown = null;
  for (const root of roots) {
    const key = modelManifestKey(family, name, version, root);
    let manifest: ModelManifest;
    try {
      manifest = modelManifestSchema.parse(await getJson(s3, bucket, key));
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (manifest.name !== name || manifest.family !== family || manifest.version !== version) {
      throw new Error(
        `Model manifest at ${key} disagrees with its path (${manifest.family}/${manifest.name}/${manifest.version})`,
      );
    }
    return { manifest, root };
  }
  throw new Error(
    `Model "${name}@${version}" (family ${family}) is not in the registry at ${describeRoots(roots, bucket)}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Downloads model.onnx for a resolved manifest into `dir`; returns the local path. */
export async function downloadModel(
  s3: S3Client,
  bucket: string,
  manifest: ModelManifest,
  dir: string,
  root: string = MODEL_REGISTRY_PREFIX,
): Promise<string> {
  const key = modelOnnxKey(manifest.family, manifest.name, manifest.version, root);
  const localPath = path.join(dir, `${manifest.family}-${manifest.name}-${manifest.version}.onnx`);
  await mkdir(dir, { recursive: true });
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty model object at s3://${bucket}/${key}`);
  await pipeline(res.Body as Readable, createWriteStream(localPath));
  return localPath;
}

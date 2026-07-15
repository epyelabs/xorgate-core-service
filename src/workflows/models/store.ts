import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  MODEL_REGISTRY_PREFIX,
  modelManifestSchema,
  modelNamePrefix,
  modelOnnxKey,
  type ModelManifest,
} from './registry';

/**
 * S3 access for the model registry prefix. Used by the GET /model-registry
 * handler (listing) and the Fargate engine target (resolve + download). The
 * engine CORE never touches this; model executors reach it through the
 * EngineSourceReader.fetchModel seam their target supplies.
 */

async function getJson(s3: S3Client, bucket: string, key: string): Promise<unknown> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  return JSON.parse(body ?? 'null');
}

/**
 * Every manifest under models/, newest version first per (family, name).
 * Unparseable manifests are skipped with a warning: one bad upload must not
 * take the picker down.
 */
export async function listModelManifests(
  s3: S3Client,
  bucket: string,
): Promise<ModelManifest[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: MODEL_REGISTRY_PREFIX,
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

/**
 * Resolves the latest version of models/<family>/<name>/ and validates its
 * manifest. Throws with an actionable message when the model is absent (the
 * registry is populated out-of-band by the export CI).
 */
export async function resolveLatestModel(
  s3: S3Client,
  bucket: string,
  family: string,
  name: string,
): Promise<ModelManifest> {
  const prefix = modelNamePrefix(family, name);
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' }),
  );
  const versions = (res.CommonPrefixes ?? [])
    .map((p) => Number((p.Prefix ?? '').slice(prefix.length).replace(/\/$/, '')))
    .filter((v) => Number.isInteger(v) && v > 0)
    .sort((a, b) => b - a);
  if (versions.length === 0) {
    throw new Error(
      `Model "${name}" (family ${family}) is not in the registry at s3://${bucket}/${prefix}; publish it with model-export/ first`,
    );
  }
  const manifest = modelManifestSchema.parse(
    await getJson(s3, bucket, `${prefix}${versions[0]}/manifest.json`),
  );
  if (manifest.name !== name || manifest.family !== family || manifest.version !== versions[0]) {
    throw new Error(
      `Model manifest at ${prefix}${versions[0]}/manifest.json disagrees with its path (${manifest.family}/${manifest.name}/${manifest.version})`,
    );
  }
  return manifest;
}

/** Downloads model.onnx for a resolved manifest into `dir`; returns the local path. */
export async function downloadModel(
  s3: S3Client,
  bucket: string,
  manifest: ModelManifest,
  dir: string,
): Promise<string> {
  const key = modelOnnxKey(manifest.family, manifest.name, manifest.version);
  const localPath = path.join(dir, `${manifest.family}-${manifest.name}-${manifest.version}.onnx`);
  await mkdir(dir, { recursive: true });
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty model object at s3://${bucket}/${key}`);
  await pipeline(res.Body as Readable, createWriteStream(localPath));
  return localPath;
}

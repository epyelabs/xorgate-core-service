import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { parseStoredClasses } from '../models/classes';
import { datasetVersionPrefix, versionImageKey } from '../models/keys';
import type { Split, SplitAssignment } from '../models/split';
import {
  buildVersionFiles,
  prepareVersion,
  type PreparedVersion,
  type VersionAnnotationInput,
  type VersionConfig,
  type VersionItemInput,
} from '../models/version';
import { copyObject, getJsonObject, mapBounded, putJsonObject } from './dataset-store';

/**
 * Dataset versions (design §4b, §4d step 5): the DB half of `prepareVersion`
 * plus the builder the `version_build` job runs. A version is a prefix on the
 * core bucket that IS a forge dataset v1: images copied server-side
 * (`CopyObject`, never through the Lambda), then `annotations.coco.json`,
 * `splits.json` and `dataset.json` LAST, so a prefix with a `dataset.json` is
 * always complete.
 */

const COPY_CONCURRENCY = 8;

export interface VersionInputs {
  dataset: typeof schema.datasets.$inferSelect;
  items: VersionItemInput[];
  annotations: VersionAnnotationInput[];
}

function extOf(s3Key: string): string {
  const dot = s3Key.lastIndexOf('.');
  return dot === -1 ? 'jpg' : s3Key.slice(dot + 1);
}

/** The items a version is built from: human-labeled, plus AI pre-labels when asked. */
export async function loadVersionInputs(
  dataset: typeof schema.datasets.$inferSelect,
  includeAiLabeled: boolean,
): Promise<VersionInputs> {
  const statuses = includeAiLabeled ? ['labeled', 'ai_labeled'] : ['labeled'];
  const rows = await db
    .select({
      id: schema.datasetItems.id,
      s3Key: schema.datasetItems.s3Key,
      width: schema.datasetItems.width,
      height: schema.datasetItems.height,
      groupKey: schema.datasetItems.groupKey,
      source: schema.datasetItems.source,
    })
    .from(schema.datasetItems)
    .where(and(eq(schema.datasetItems.datasetId, dataset.id), inArray(schema.datasetItems.status, statuses)))
    .orderBy(schema.datasetItems.createdAt);
  const items: VersionItemInput[] = rows.map((r) => ({
    id: r.id,
    ext: extOf(r.s3Key),
    width: r.width,
    height: r.height,
    groupKey: r.groupKey,
    source: r.source,
  }));
  const annotations: VersionAnnotationInput[] = [];
  // inArray over up to 5,000 ids in chunks the Data API's parameter limit tolerates.
  for (let i = 0; i < items.length; i += 500) {
    const ids = items.slice(i, i + 500).map((it) => it.id);
    const anns = await db
      .select({
        itemId: schema.datasetAnnotations.itemId,
        classId: schema.datasetAnnotations.classId,
        x1: schema.datasetAnnotations.x1,
        y1: schema.datasetAnnotations.y1,
        x2: schema.datasetAnnotations.x2,
        y2: schema.datasetAnnotations.y2,
        source: schema.datasetAnnotations.source,
        confidence: schema.datasetAnnotations.confidence,
      })
      .from(schema.datasetAnnotations)
      .where(inArray(schema.datasetAnnotations.itemId, ids));
    for (const a of anns) annotations.push(a);
  }
  return { dataset, items, annotations };
}

/** The previous ready version's `splits.json`, for `keepPrevious`. */
export async function loadPreviousSplits(bucket: string, datasetId: string, beforeVersion: number): Promise<SplitAssignment> {
  const prev = await db
    .select({ version: schema.datasetVersions.version, s3Prefix: schema.datasetVersions.s3Prefix })
    .from(schema.datasetVersions)
    .where(and(eq(schema.datasetVersions.datasetId, datasetId), eq(schema.datasetVersions.status, 'ready')))
    .orderBy(schema.datasetVersions.version);
  const candidates = prev.filter((p) => p.version < beforeVersion);
  const last = candidates[candidates.length - 1];
  if (!last) return {};
  const raw = await getJsonObject(bucket, `${last.s3Prefix}splits.json`);
  if (!raw || typeof raw !== 'object') return {};
  const out: SplitAssignment = {};
  for (const [id, split] of Object.entries(raw as Record<string, unknown>)) {
    if (split === 'train' || split === 'val' || split === 'test') out[id] = split as Split;
  }
  return out;
}

export function versionConfigOf(row: typeof schema.datasetVersions.$inferSelect): VersionConfig {
  const cfg = (row.splitConfig ?? {}) as Partial<VersionConfig> & { split?: Partial<VersionConfig['split']> };
  return {
    split: { train: cfg.split?.train ?? 0.8, val: cfg.split?.val ?? 0.2, test: cfg.split?.test ?? 0 },
    seed: cfg.seed ?? 0,
    keepPrevious: cfg.keepPrevious ?? false,
    includeAiLabeled: cfg.includeAiLabeled ?? false,
  };
}

export async function prepareVersionFromDb(
  bucket: string,
  dataset: typeof schema.datasets.$inferSelect,
  version: number,
  config: VersionConfig,
): Promise<{ prepared: PreparedVersion; inputs: VersionInputs }> {
  const inputs = await loadVersionInputs(dataset, config.includeAiLabeled);
  const keep = config.keepPrevious ? await loadPreviousSplits(bucket, dataset.id, version) : {};
  const prepared = prepareVersion(parseStoredClasses(dataset.classes), inputs.items, inputs.annotations, config, keep);
  return { prepared, inputs };
}

/**
 * The `version_build` job. Idempotent under SQS redelivery through the
 * `dispatched_at` claim; a failure of any kind closes the row `failed` with
 * the message (the prefix may hold partial images, never a `dataset.json`).
 */
export async function buildDatasetVersion(bucket: string, versionId: string, log: (m: string) => void): Promise<void> {
  const row = await db.query.datasetVersions.findFirst({ where: eq(schema.datasetVersions.id, versionId) });
  if (!row) {
    log(`version ${versionId} not found, acking`);
    return;
  }
  if (row.status !== 'building') return;
  const claimed = await db
    .update(schema.datasetVersions)
    .set({ dispatchedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.datasetVersions.id, versionId),
        eq(schema.datasetVersions.status, 'building'),
        isNull(schema.datasetVersions.dispatchedAt),
      ),
    )
    .returning({ id: schema.datasetVersions.id });
  if (claimed.length === 0) {
    log(`version ${versionId} already claimed, acking`);
    return;
  }
  const dataset = await db.query.datasets.findFirst({ where: eq(schema.datasets.id, row.datasetId) });
  if (!dataset) {
    await fail(versionId, 'Dataset no longer exists');
    return;
  }
  try {
    const config = versionConfigOf(row);
    const { prepared, inputs } = await prepareVersionFromDb(bucket, dataset, row.version, config);
    if (!prepared.health.ok) {
      await db
        .update(schema.datasetVersions)
        .set({
          status: 'failed',
          error: prepared.health.errors.map((e) => e.message).join('; '),
          health: prepared.health,
          stats: prepared.stats,
          classNames: prepared.classNames,
          updatedAt: new Date(),
        })
        .where(eq(schema.datasetVersions.id, versionId));
      return;
    }
    const prefix = datasetVersionPrefix(dataset.id, row.version);
    const itemKeys = new Map(inputs.items.map((it) => [it.id, it]));
    const itemRows = await db
      .select({ id: schema.datasetItems.id, s3Key: schema.datasetItems.s3Key })
      .from(schema.datasetItems)
      .where(inArray(schema.datasetItems.id, [...itemKeys.keys()].slice(0, 5000)));
    const s3KeyById = new Map(itemRows.map((r) => [r.id, r.s3Key]));
    await mapBounded(inputs.items, COPY_CONCURRENCY, async (it) => {
      const from = s3KeyById.get(it.id);
      if (!from) throw new Error(`item ${it.id} has no object key`);
      await copyObject(bucket, from, versionImageKey(dataset.id, row.version, it.id, it.ext));
    });
    const createdAt = new Date().toISOString();
    const files = buildVersionFiles(prepared, {
      datasetId: dataset.id,
      datasetName: dataset.name,
      version: row.version,
      createdAt,
      message: row.message,
    });
    await putJsonObject(bucket, `${prefix}annotations.coco.json`, files.coco);
    await putJsonObject(bucket, `${prefix}splits.json`, files.splits);
    await putJsonObject(bucket, `${prefix}dataset.json`, files.header); // last: the completeness marker
    await db
      .update(schema.datasetVersions)
      .set({
        status: 'ready',
        classNames: prepared.classNames,
        stats: prepared.stats,
        health: prepared.health,
        readyAt: new Date(),
        updatedAt: new Date(),
        error: null,
      })
      .where(eq(schema.datasetVersions.id, versionId));
    log(
      `version ${dataset.slug} v${row.version} ready: ${prepared.images.length} image(s), ${prepared.boxes.length} box(es), splits ${JSON.stringify(prepared.splitCounts)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`version ${versionId} failed: ${message}`);
    await fail(versionId, message);
  }
}

async function fail(versionId: string, message: string): Promise<void> {
  await db
    .update(schema.datasetVersions)
    .set({ status: 'failed', error: message.slice(0, 2000), updatedAt: new Date() })
    .where(eq(schema.datasetVersions.id, versionId));
}

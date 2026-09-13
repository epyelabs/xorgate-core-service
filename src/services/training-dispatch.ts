import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  CreateTrainingJobCommand,
  SageMakerClient,
  StopTrainingJobCommand,
  type CreateTrainingJobCommandInput,
} from '@aws-sdk/client-sagemaker';
import { db, schema } from '../db/index';
import { parseStoredClasses } from '../models/classes';
import { datasetVersionPrefix, trainingPrefix } from '../models/keys';
import {
  buildCreateTrainingJobRequest,
  jobSpecKey,
  type CreateTrainingJobRequest,
  type TrainingTarget,
} from '../models/training';
import { buildVersionFiles, prepareVersion } from '../models/version';
import { copyObject, mapBounded, putJsonObject } from './dataset-store';

/**
 * `train | autolabel` dispatch (design §4d step 2). The message names the row;
 * the row is claimed atomically with `dispatched_at IS NULL`, exactly as the
 * version build and the workflow dispatcher do, so an SQS redelivery is a
 * no-op. The job spec is written to S3 and handed to the container through the
 * `job` channel; `CreateTrainingJob` is the only AWS call that starts work.
 */

const sagemaker = new SageMakerClient({});
const COPY_CONCURRENCY = 8;

function stage(): string {
  return process.env.STAGE ?? 'dev';
}

export interface ComputeBlock {
  target: TrainingTarget;
  instanceType: string;
  spot: boolean;
  maxMinutes: number;
  volumeSizeGb?: number;
}

export async function dispatchTrainingJob(bucket: string, jobId: string, log: (m: string) => void): Promise<void> {
  const row = await db.query.modelTrainingJobs.findFirst({ where: eq(schema.modelTrainingJobs.id, jobId) });
  if (!row) {
    log(`job ${jobId} not found, acking`);
    return;
  }
  if (row.status !== 'queued') {
    log(`job ${jobId} is ${row.status}, acking`);
    return;
  }
  const claimed = await db
    .update(schema.modelTrainingJobs)
    .set({ dispatchedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.modelTrainingJobs.id, jobId),
        eq(schema.modelTrainingJobs.status, 'queued'),
        isNull(schema.modelTrainingJobs.dispatchedAt),
      ),
    )
    .returning({ id: schema.modelTrainingJobs.id });
  if (claimed.length === 0) {
    log(`job ${jobId} already claimed, acking`);
    return;
  }

  const imageUri = process.env.FORGE_IMAGE_URI;
  const roleArn = process.env.FORGE_EXECUTION_ROLE_ARN;
  try {
    if (!imageUri) throw new Error('FORGE_IMAGE_URI is not configured');
    if (!roleArn) throw new Error('FORGE_EXECUTION_ROLE_ARN is not configured');
    const compute = (row.compute ?? {}) as ComputeBlock;
    const spec = row.spec as Record<string, unknown>;
    const modelsRoot = ((row.artifacts ?? {}) as { modelsRoot?: string }).modelsRoot ?? null;

    const datasetPrefix =
      row.task === 'train' ? await trainDatasetPrefix(row) : await buildAssistDataset(bucket, row, log);

    await putJsonObject(bucket, jobSpecKey(jobId), spec);

    const request: CreateTrainingJobRequest = buildCreateTrainingJobRequest({
      stage: stage(),
      jobId,
      orgId: row.organizationId,
      bucket,
      imageUri,
      roleArn,
      target: compute.target,
      instanceType: compute.instanceType,
      spot: compute.spot,
      maxMinutes: compute.maxMinutes,
      volumeSizeGb: compute.volumeSizeGb,
      datasetPrefix,
      modelsRoot,
    });
    // The pure builder's shape is the request; the SDK's literal-union types
    // for instance type and input mode are narrower than the allow-list, so
    // the cast is at this one boundary and nowhere else.
    await sagemaker.send(new CreateTrainingJobCommand(request as unknown as CreateTrainingJobCommandInput));
    await db
      .update(schema.modelTrainingJobs)
      .set({
        status: 'dispatched',
        externalRef: request.TrainingJobName,
        progress: { phase: 'starting' },
        updatedAt: new Date(),
      })
      .where(eq(schema.modelTrainingJobs.id, jobId));
    log(
      `job ${jobId} (${row.task}) dispatched as ${request.TrainingJobName} on ${compute.instanceType}${compute.spot ? ' spot' : ''}, MaxRuntimeInSeconds ${request.StoppingCondition.MaxRuntimeInSeconds}, dataset channel s3://${bucket}/${datasetPrefix}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`job ${jobId} dispatch failed: ${message}`);
    await db
      .update(schema.modelTrainingJobs)
      .set({ status: 'failed', error: `dispatch: ${message}`.slice(0, 2000), endedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.modelTrainingJobs.id, jobId));
  }
}

/** A ready version's prefix IS a forge dataset v1; the channel points straight at it. */
async function trainDatasetPrefix(row: typeof schema.modelTrainingJobs.$inferSelect): Promise<string> {
  if (!row.datasetVersionId) throw new Error('train job has no dataset version');
  const version = await db.query.datasetVersions.findFirst({
    where: eq(schema.datasetVersions.id, row.datasetVersionId),
  });
  if (!version) throw new Error(`dataset version ${row.datasetVersionId} no longer exists`);
  if (version.status !== 'ready') throw new Error(`dataset version ${version.version} is ${version.status}, not ready`);
  return version.s3Prefix || datasetVersionPrefix(version.datasetId, version.version);
}

/**
 * An assist job labels items that are in no version, so it gets a scratch
 * forge dataset v1 of its own under `training/<jobId>/dataset/`: the same
 * writers a version uses, every image in `train` (the forge's autolabel path
 * asks for splits but not for validation instances), no annotations. Image ids
 * are the dataset item ids, which is what makes the labels file map straight
 * back onto rows.
 */
async function buildAssistDataset(
  bucket: string,
  row: typeof schema.modelTrainingJobs.$inferSelect,
  log: (m: string) => void,
): Promise<string> {
  if (!row.datasetId) throw new Error('autolabel job has no dataset');
  const dataset = await db.query.datasets.findFirst({ where: eq(schema.datasets.id, row.datasetId) });
  if (!dataset) throw new Error(`dataset ${row.datasetId} no longer exists`);
  const params = ((row.spec ?? {}) as { platform?: { items?: string; maxItems?: number } }).platform ?? {};
  const statuses = params.items === 'all' ? ['unlabeled', 'ai_labeled', 'labeled'] : ['unlabeled', 'ai_labeled'];
  const maxItems = params.maxItems ?? 500;
  const items = await db
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
    .orderBy(schema.datasetItems.createdAt)
    .limit(maxItems);
  if (items.length === 0) throw new Error('no item matches the assist filter');
  const prefix = `${trainingPrefix(row.id)}dataset/`;
  const prepared = prepareVersion(
    parseStoredClasses(dataset.classes),
    items.map((it) => ({
      id: it.id,
      ext: extOf(it.s3Key),
      width: it.width,
      height: it.height,
      groupKey: it.groupKey,
      source: it.source,
    })),
    [],
    // Everything in `train`: the forge refuses a dataset whose images have no
    // split, and an assist run has no validation split to speak of.
    { split: { train: 1, val: 0, test: 0 }, seed: 0, keepPrevious: false, includeAiLabeled: true },
  );
  await mapBounded(items, COPY_CONCURRENCY, async (it) => {
    await copyObject(bucket, it.s3Key, `${prefix}images/${it.id}.${extOf(it.s3Key)}`);
  });
  const files = buildVersionFiles(prepared, {
    datasetId: dataset.id,
    datasetName: dataset.name,
    // Version 0: a scratch dataset, not one of the dataset's own versions.
    version: 0,
    createdAt: new Date().toISOString(),
    message: `assist job ${row.id}`,
  });
  await putJsonObject(bucket, `${prefix}annotations.coco.json`, files.coco);
  await putJsonObject(bucket, `${prefix}splits.json`, files.splits);
  await putJsonObject(bucket, `${prefix}dataset.json`, files.header); // last: the completeness marker
  log(`job ${row.id} assist dataset: ${items.length} image(s) under s3://${bucket}/${prefix}`);
  return prefix;
}

function extOf(s3Key: string): string {
  const dot = s3Key.lastIndexOf('.');
  return dot === -1 ? 'jpg' : s3Key.slice(dot + 1);
}

/** `POST /training-jobs/{id}/cancel`: SageMaker stops the job; the finalizer closes the row. */
export async function stopTrainingJob(externalRef: string): Promise<void> {
  await sagemaker.send(new StopTrainingJobCommand({ TrainingJobName: externalRef }));
}

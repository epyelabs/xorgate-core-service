import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { routeKey as canonicalRouteKey } from '../utils/route';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, conflict, created, errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { apiHandler } from '../utils/api-handler';
import type { MembershipRole } from '../types/index';
import { isKeyUnder, trainingPrefix } from '../models/keys';
import { createTrainingJobSchema } from '../models/schemas';
import {
  buildTrainJobSpec,
  jobArtifactsPrefix,
  jobProgressKey,
  RECIPE_LICENSES,
  TERMINAL_TRAINING_STATUSES,
} from '../models/training';
import { summarizeProgress } from '../models/forge-result';
import { datasetS3, presignGet } from '../services/dataset-store';
import { enqueueModelJob } from '../services/model-jobs';
import { stopTrainingJob } from '../services/training-dispatch';
import { closeJob } from '../services/training-finalize';
import {
  activeJobsForOrg,
  chooseCompute,
  concurrencyMessage,
  isTerminal,
  resolveOutputVersion,
  toJobResponse,
} from '../services/training-jobs';

/**
 * Training jobs (xorgate-models design §4c, §4d):
 *
 *   GET|POST /training-jobs                 list (paged) | start a train job
 *   GET      /training-jobs/{id}            row + a bounded tail of progress.jsonl + the artifact index
 *   POST     /training-jobs/{id}/cancel     StopTrainingJob (a queued job closes straight away)
 *   GET      /training-jobs/{id}/artifact-url?key=   presigned GET gated to training/<jobId>/
 *
 * Roles (Q5): every member reads; `admin` and `owner` start and cancel jobs,
 * because a job costs money. Org-wide (`requireOrgWideContext`): a dataset
 * version has no workspace.
 */

const BUCKET = process.env.BUCKET_NAME;
const START_ROLES: MembershipRole[] = ['owner', 'admin'];
const PROGRESS_TAIL_BYTES = 256 * 1024;
const PROGRESS_TAIL_LINES = 200;
const ARTIFACT_INDEX_MAX = 200;

function safeJson(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return {};
  }
}

/** The last bytes of `progress.jsonl` while the job runs; absent before the first sync. */
async function progressTail(bucket: string, jobId: string) {
  const key = jobProgressKey(jobId);
  try {
    const res = await datasetS3().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=-${PROGRESS_TAIL_BYTES}` }),
    );
    const text = (await res.Body?.transformToString()) ?? '';
    // A ranged read can start mid-line; the first partial line is dropped.
    const body = text.startsWith('{') ? text : text.slice(text.indexOf('\n') + 1);
    return summarizeProgress(body, PROGRESS_TAIL_LINES);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'InvalidRange' || name === 'NotFound') return null;
    throw err;
  }
}

/** Everything the job wrote under `training/<jobId>/artifacts/`, for the detail page. */
async function artifactIndex(bucket: string, jobId: string) {
  const prefix = jobArtifactsPrefix(jobId);
  const res = await datasetS3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: ARTIFACT_INDEX_MAX }));
  return (res.Contents ?? [])
    .filter((o) => o.Key)
    .map((o) => ({ key: o.Key as string, name: (o.Key as string).slice(prefix.length), bytes: o.Size ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const restHandler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const id = event.pathParameters?.id;

  let auth;
  try {
    auth = await requireOrgWideContext(event, method === 'GET' ? undefined : START_ROLES);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgId = auth.organizationId;
  if (!BUCKET) throw new Error('training-jobs: BUCKET_NAME is not configured');

  if (routeKey === 'GET /training-jobs') {
    const parsed = parseListParams(event, { sortable: ['createdAt', 'updatedAt'], defaultSort: 'createdAt' });
    if ('error' in parsed) return parsed.error;
    const { limit, offset, order, sortBy } = parsed;
    const qs = event.queryStringParameters ?? {};
    const where = and(
      eq(schema.modelTrainingJobs.organizationId, orgId),
      qs.status ? eq(schema.modelTrainingJobs.status, qs.status) : undefined,
      qs.task ? eq(schema.modelTrainingJobs.task, qs.task) : undefined,
      qs.datasetId ? eq(schema.modelTrainingJobs.datasetId, qs.datasetId) : undefined,
    );
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.modelTrainingJobs).where(where);
    const col = sortBy === 'updatedAt' ? schema.modelTrainingJobs.updatedAt : schema.modelTrainingJobs.createdAt;
    const rows = await db
      .select()
      .from(schema.modelTrainingJobs)
      .where(where)
      .orderBy(order === 'asc' ? asc(col) : desc(col))
      .limit(limit)
      .offset(offset);
    return ok({ jobs: rows.map((r) => toJobResponse(r)), page: pageMeta(parsed, Number(total)) });
  }

  if (routeKey === 'POST /training-jobs') {
    const parsed = createTrainingJobSchema.safeParse(safeJson(event.body));
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const body = parsed.data;

    const [version] = await db
      .select({
        version: schema.datasetVersions,
        dataset: schema.datasets,
      })
      .from(schema.datasetVersions)
      .innerJoin(schema.datasets, eq(schema.datasets.id, schema.datasetVersions.datasetId))
      .where(and(eq(schema.datasetVersions.id, body.datasetVersionId), eq(schema.datasets.organizationId, orgId)));
    if (!version) return notFound(`Dataset version "${body.datasetVersionId}" not found`);
    if (version.version.status !== 'ready') {
      return conflict(`Dataset version ${version.version.version} is ${version.version.status}; train on a ready version`);
    }

    const active = await activeJobsForOrg(orgId);
    if (active.length > 0) return errorResponse(409, 'TRAINING_JOB_IN_FLIGHT', concurrencyMessage(active), { jobs: active.map((j) => j.id) });

    const compute = chooseCompute({
      target: body.target,
      instanceType: body.instanceType,
      spot: body.spot,
      maxMinutes: body.limits.maxMinutes,
    });
    if ('error' in compute) return badRequest(compute.error);

    const family = 'detection';
    const outputVersion = await resolveOutputVersion(BUCKET, orgId, family, body.output.name, body.output.version);
    if ('error' in outputVersion) {
      return errorResponse(400, outputVersion.code ?? 'MODEL_NAME_INVALID', outputVersion.error, { name: body.output.name });
    }

    const jobId = randomUUID();
    const spec = buildTrainJobSpec({
      jobId,
      recipe: body.recipe,
      output: { family, name: body.output.name, version: outputVersion.version, label: body.output.label ?? null },
      base: { kind: 'pretrained', ref: body.base.ref },
      mode: body.mode,
      hyperparameters: body.hyperparameters,
      maxMinutes: compute.maxMinutes,
      provenance: {
        orgId,
        datasetId: version.dataset.id,
        datasetVersion: version.version.version,
        datasetVersionId: version.version.id,
        requestedBy: auth.userId ?? null,
      },
    });

    const [row] = await db
      .insert(schema.modelTrainingJobs)
      .values({
        id: jobId,
        organizationId: orgId,
        datasetId: version.dataset.id,
        datasetVersionId: version.version.id,
        task: 'train',
        recipe: body.recipe,
        base: spec.base,
        spec,
        mode: body.mode,
        target: compute.target,
        compute,
        status: 'queued',
        progress: { phase: 'queued' },
        createdByUserId: auth.userId,
      })
      .returning();
    try {
      await enqueueModelJob({ kind: 'train', jobId: row.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await closeJob(row.id, 'failed', { error: `enqueue failed: ${message}` });
      return errorResponse(502, 'TRAINING_DISPATCH_FAILED', 'Failed to queue the training job', { jobId: row.id, message });
    }
    return created({
      job: toJobResponse(row, {
        recipeLicense: RECIPE_LICENSES[body.recipe] ?? null,
        estimate: { maxRuntimeSeconds: compute.maxRuntimeSeconds, instanceType: compute.instanceType, spot: compute.spot },
      }),
    });
  }

  if (!id) return badRequest('job id required');
  const job = await db.query.modelTrainingJobs.findFirst({
    where: and(eq(schema.modelTrainingJobs.id, id), eq(schema.modelTrainingJobs.organizationId, orgId)),
  });
  if (!job) return notFound(`Training job "${id}" not found`);

  switch (routeKey) {
    case 'GET /training-jobs/{id}': {
      const [progress, artifacts] = [await progressTail(BUCKET, job.id), await artifactIndex(BUCKET, job.id)];
      let outputModel = null;
      if (job.outputModelId) {
        const model = await db.query.orgModels.findFirst({ where: eq(schema.orgModels.id, job.outputModelId) });
        if (model) outputModel = { id: model.id, family: model.family, name: model.name, version: model.version, label: model.label };
      }
      return ok({
        job: toJobResponse(job, {
          recipeLicense: RECIPE_LICENSES[job.recipe] ?? null,
          spec: job.spec,
          progressTail: progress,
          artifactIndex: artifacts,
          outputModel,
          terminal: isTerminal(job.status),
        }),
      });
    }

    case 'POST /training-jobs/{id}/cancel': {
      if (isTerminal(job.status)) return conflict(`Job ${job.id} is already ${job.status}`);
      if (!job.externalRef) {
        // Never reached SageMaker: close it here, and the dispatcher's claim
        // (dispatched_at plus the status check) keeps a racing delivery out.
        await closeJob(job.id, 'cancelled', { error: 'cancelled before dispatch', progress: { phase: 'cancelled' } });
        const closed = await db.query.modelTrainingJobs.findFirst({ where: eq(schema.modelTrainingJobs.id, job.id) });
        return ok({ job: toJobResponse(closed ?? job), stopping: false });
      }
      try {
        await stopTrainingJob(job.externalRef);
      } catch (err) {
        const name = (err as { name?: string }).name;
        const message = err instanceof Error ? err.message : String(err);
        // Already terminal on SageMaker's side: the state change closes the row.
        if (name !== 'ValidationException') {
          return errorResponse(502, 'TRAINING_STOP_FAILED', `Failed to stop ${job.externalRef}`, { message });
        }
      }
      await db
        .update(schema.modelTrainingJobs)
        .set({ progress: { ...((job.progress ?? {}) as Record<string, unknown>), stopRequestedAt: new Date().toISOString() }, updatedAt: new Date() })
        .where(eq(schema.modelTrainingJobs.id, job.id));
      // The row is closed `cancelled` by the finalizer on SageMaker's Stopped
      // event, which is also where the billable seconds come from.
      return ok({ job: toJobResponse(job), stopping: true });
    }

    case 'GET /training-jobs/{id}/artifact-url': {
      const key = event.queryStringParameters?.key;
      if (!key) return badRequest('key query parameter required');
      const prefix = trainingPrefix(job.id);
      if (!isKeyUnder(prefix, key)) return badRequest(`key must lie under ${prefix}`);
      const url = await presignGet(BUCKET, key, { downloadName: key.slice(key.lastIndexOf('/') + 1) });
      return ok({ url, expiresInSeconds: 15 * 60 });
    }

    default:
      return methodNotAllowed(method, 'GET, POST');
  }
};

export const handler = apiHandler(restHandler);

export const TERMINAL_STATUSES = TERMINAL_TRAINING_STATUSES;

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { orgModelPrefix } from '../models/keys';
import { modelManifestSchema } from '../workflows/models/registry';
import {
  checkManifestIdentity,
  forgeLabelsSchema,
  forgeResultSchema,
  jobRowUpdateFromResult,
  labelsToAnnotationRows,
  publishCandidate,
  type ForgeResult,
} from '../models/forge-result';
import { jobArtifactsPrefix, jobModelTarKey, TERMINAL_TRAINING_STATUSES, type TrainingStatus } from '../models/training';
import { isSafeTarPath, listTarEntries, tarEntryBytes, type TarEntry } from '../models/tar';
import { datasetS3, mapBounded } from './dataset-store';
import { classIdByName, isTerminal } from './training-jobs';
import { refreshItemCount } from './dataset-import';

/**
 * Finalize (design §4d step 4). A SageMaker state change fires the handler;
 * this is everything it does afterwards, kept out of the handler so the pure
 * mapping in `src/models/forge-result.ts` is all that the smoke has to stand
 * in front of.
 *
 * Order matters on publish: `model.onnx` first, `manifest.json` second, the
 * `org_models` row last. A reader that sees a manifest sees a complete model,
 * and a row always points at two objects that exist. (`GET /models` lists
 * ROWS, so a prefix without a row is resolvable by the engine and invisible in
 * the picker; that is the failure this order avoids.)
 */

const ARTIFACT_CONCURRENCY = 8;
/** Uncompressed ceiling for one job's output; a yolov8 job is tens of megabytes. */
const MAX_TAR_BYTES = 1024 * 1024 * 1024;

export interface TerminalEvent {
  status: 'Completed' | 'Failed' | 'Stopped';
  failureReason?: string | null;
  /** SageMaker's SecondaryStatus at the terminal event (MaxWaitTimeExceeded, Stopped, ...). */
  secondaryStatus?: string | null;
  /** The last SecondaryStatusTransitions message, SageMaker's own words for why. */
  statusMessage?: string | null;
  billableSeconds?: number | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface ExtractedOutput {
  entries: TarEntry[];
  tar: Buffer;
  result: ForgeResult | null;
  resultError: string | null;
}

/**
 * Downloads `model.tar.gz`, expands it in memory and mirrors every file to
 * `training/<jobId>/artifacts/`, so the job detail page can presign any of
 * them without a second archive read.
 */
export async function extractJobOutput(
  bucket: string,
  jobId: string,
  externalRef: string,
  log: (m: string) => void,
): Promise<ExtractedOutput> {
  const key = jobModelTarKey(jobId, externalRef);
  const res = await datasetS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const gz = await bodyToBuffer(res.Body);
  const tar = gunzipSync(gz, { maxOutputLength: MAX_TAR_BYTES });
  const entries = listTarEntries(tar).filter((e) => e.type === 'file' && isSafeTarPath(e.name));
  log(`job ${jobId}: ${key} is ${gz.length} B gz / ${tar.length} B tar, ${entries.length} file(s)`);
  const prefix = jobArtifactsPrefix(jobId);
  await mapBounded(entries, ARTIFACT_CONCURRENCY, async (entry) => {
    await datasetS3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}${entry.name}`,
        Body: tarEntryBytes(tar, entry),
        ContentType: contentTypeFor(entry.name),
      }),
    );
  });
  const resultEntry = entries.find((e) => e.name === 'result.json');
  if (!resultEntry) return { entries, tar, result: null, resultError: 'the job output has no result.json' };
  const parsed = forgeResultSchema.safeParse(JSON.parse(tarEntryBytes(tar, resultEntry).toString('utf8')));
  if (!parsed.success) {
    return { entries, tar, result: null, resultError: `result.json is not result v1: ${parsed.error.issues[0]?.message}` };
  }
  return { entries, tar, result: parsed.data, resultError: null };
}

function contentTypeFor(name: string): string {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.jsonl')) return 'application/x-ndjson';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.onnx')) return 'application/octet-stream';
  if (name.endsWith('.log') || name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Publishes a succeeded train job: identity and sha256 checks, then
 * `model.onnx`, `manifest.json`, then the `org_models` row. The manifest is
 * written back BYTE FOR BYTE, not re-serialized: the engine's own schema
 * strips `provenance` on parse and a re-serialized file would lose the
 * lineage block the design keeps in the file (design §7, Q10).
 */
export async function publishTrainedModel(
  bucket: string,
  job: typeof schema.modelTrainingJobs.$inferSelect,
  out: ExtractedOutput,
  result: ForgeResult,
  log: (m: string) => void,
): Promise<{ ok: true; modelId: string; prefix: string } | { ok: false; error: string }> {
  const requested = ((job.spec ?? {}) as { output?: { family: string; name: string; version: number; label?: string | null } }).output;
  if (!requested) return { ok: false, error: 'the job spec has no output block' };
  const candidate = publishCandidate(result, requested);
  if (!candidate.ok) return { ok: false, error: candidate.error };
  const manifestEntry = out.entries.find((e) => e.name === candidate.value.manifestPath);
  const onnxEntry = out.entries.find((e) => e.name === candidate.value.onnxPath);
  if (!manifestEntry) return { ok: false, error: `the job output has no ${candidate.value.manifestPath}` };
  if (!onnxEntry) return { ok: false, error: `the job output has no ${candidate.value.onnxPath}` };
  const manifestBytes = tarEntryBytes(out.tar, manifestEntry);
  const onnxBytes = tarEntryBytes(out.tar, onnxEntry);
  const onnxSha256 = createHash('sha256').update(onnxBytes).digest('hex');

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
  } catch (err) {
    return { ok: false, error: `manifest.json is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const identity = checkManifestIdentity(manifestRaw as Record<string, unknown>, requested, onnxSha256, onnxBytes.length);
  if (!identity.ok) return { ok: false, error: identity.error };
  // The engine's own contract, so a model the engine cannot load never reaches
  // the registry root.
  const engineParse = modelManifestSchema.safeParse(manifestRaw);
  if (!engineParse.success) {
    return { ok: false, error: `manifest.json does not satisfy the engine's manifest v1: ${engineParse.error.issues[0]?.message}` };
  }

  const prefix = orgModelPrefix(job.organizationId, requested.family, requested.name, requested.version);
  await datasetS3().send(
    new PutObjectCommand({ Bucket: bucket, Key: `${prefix}model.onnx`, Body: onnxBytes, ContentType: 'application/octet-stream' }),
  );
  await datasetS3().send(
    new PutObjectCommand({ Bucket: bucket, Key: `${prefix}manifest.json`, Body: manifestBytes, ContentType: 'application/json' }),
  );
  const provenance = {
    jobId: job.id,
    datasetVersionId: job.datasetVersionId ?? null,
    datasetId: job.datasetId ?? null,
    recipe: job.recipe,
    base: job.base ?? null,
    metrics: result.metrics
      ? { mAP50: result.metrics.mAP50, mAP50_95: result.metrics.mAP50_95, precision: result.metrics.precision, recall: result.metrics.recall }
      : null,
    trainedAt: result.endedAt,
    epochsCompleted: result.epochsCompleted ?? null,
  };
  const [row] = await db
    .insert(schema.orgModels)
    .values({
      organizationId: job.organizationId,
      family: requested.family,
      name: requested.name,
      version: requested.version,
      label: requested.label ?? engineParse.data.label ?? null,
      manifest: manifestRaw,
      s3Prefix: prefix,
      status: 'ready',
      provenance,
      createdByUserId: job.createdByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.orgModels.organizationId, schema.orgModels.family, schema.orgModels.name, schema.orgModels.version],
      set: { manifest: manifestRaw, s3Prefix: prefix, status: 'ready', provenance, updatedAt: new Date() },
    })
    .returning();
  log(
    `job ${job.id} published ${requested.family}/${requested.name} v${requested.version} to ${prefix} (org model ${row.id}, model.onnx ${onnxBytes.length} B, sha256 verified)`,
  );
  return { ok: true, modelId: row.id, prefix };
}

/**
 * An `autolabel` job's labels file becomes `dataset_annotations` rows with
 * `source: model`. An item a human already labeled is never overwritten: the
 * mapping is applied only to items still `unlabeled` or `ai_labeled`, and
 * their previous model boxes are replaced, not added to.
 */
export async function applyAssistLabels(
  job: typeof schema.modelTrainingJobs.$inferSelect,
  out: ExtractedOutput,
  result: ForgeResult,
  log: (m: string) => void,
): Promise<{ itemsLabeled: number; boxes: number; unknownImages: number; unknownClasses: string[] }> {
  if (!job.datasetId) throw new Error('autolabel job has no dataset');
  const labelsName = result.artifacts.labels ?? result.labels?.file ?? 'labels.json';
  const entry = out.entries.find((e) => e.name === labelsName);
  if (!entry) throw new Error(`the job output has no ${labelsName}`);
  const labels = forgeLabelsSchema.parse(JSON.parse(tarEntryBytes(out.tar, entry).toString('utf8')));
  const names = await classIdByName(job.datasetId);
  const ids = labels.images.map((i) => i.id);
  const sizes = new Map<string, { width: number; height: number }>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db
      .select({ id: schema.datasetItems.id, width: schema.datasetItems.width, height: schema.datasetItems.height })
      .from(schema.datasetItems)
      .where(
        and(
          eq(schema.datasetItems.datasetId, job.datasetId),
          inArray(schema.datasetItems.id, chunk),
          // A human label placed while the job ran wins; those items are skipped.
          inArray(schema.datasetItems.status, ['unlabeled', 'ai_labeled']),
        ),
      );
    for (const r of rows) sizes.set(r.id, { width: r.width, height: r.height });
  }
  const sourceRef = `${labels.model.family}/${labels.model.name}@${labels.model.version}`;
  const mapping = labelsToAnnotationRows(labels, { classIdByName: names, itemSizeById: sizes, sourceRef });
  const now = new Date();
  // Sequential awaits: the Data API serializes statements inside a transaction.
  for (let i = 0; i < mapping.labeledItemIds.length; i += 200) {
    const chunk = mapping.labeledItemIds.slice(i, i + 200);
    const rows = mapping.rows.filter((r) => chunk.includes(r.itemId));
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.datasetAnnotations)
        .where(and(inArray(schema.datasetAnnotations.itemId, chunk), eq(schema.datasetAnnotations.source, 'model')));
      if (rows.length > 0) {
        await tx.insert(schema.datasetAnnotations).values(
          rows.map((r) => ({
            itemId: r.itemId,
            classId: r.classId,
            x1: r.x1,
            y1: r.y1,
            x2: r.x2,
            y2: r.y2,
            source: r.source,
            sourceRef: r.sourceRef,
            confidence: r.confidence,
          })),
        );
      }
      await tx
        .update(schema.datasetItems)
        .set({ status: 'ai_labeled', updatedAt: now })
        .where(and(inArray(schema.datasetItems.id, chunk), inArray(schema.datasetItems.status, ['unlabeled', 'ai_labeled'])));
    });
  }
  await refreshItemCount(job.datasetId);
  log(
    `job ${job.id} assist: ${mapping.labeledItemIds.length} item(s) -> ai_labeled with ${mapping.boxes} box(es) from ${sourceRef}` +
      (mapping.unknownClasses.length > 0 ? `; unknown class(es) ${mapping.unknownClasses.join(', ')}` : '') +
      (mapping.unknownImages.length > 0 ? `; ${mapping.unknownImages.length} image(s) no longer eligible` : ''),
  );
  return {
    itemsLabeled: mapping.labeledItemIds.length,
    boxes: mapping.boxes,
    unknownImages: mapping.unknownImages.length,
    unknownClasses: mapping.unknownClasses,
  };
}

/** Closes a row that will never produce a result (a stop, a SageMaker-side failure). */
export async function closeJob(
  jobId: string,
  status: TrainingStatus,
  fields: {
    error?: string | null;
    billableSeconds?: number | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
    metrics?: unknown;
    artifacts?: unknown;
    progress?: unknown;
    outputModelId?: string | null;
  } = {},
): Promise<void> {
  const patch: Partial<typeof schema.modelTrainingJobs.$inferInsert> = { status, updatedAt: new Date() };
  if (fields.error !== undefined) patch.error = fields.error === null ? null : fields.error.slice(0, 2000);
  if (fields.billableSeconds !== undefined && fields.billableSeconds !== null) patch.billableSeconds = fields.billableSeconds;
  if (fields.startedAt) patch.startedAt = fields.startedAt;
  patch.endedAt = fields.endedAt ?? new Date();
  if (fields.metrics !== undefined) patch.metrics = fields.metrics;
  if (fields.artifacts !== undefined) patch.artifacts = fields.artifacts;
  if (fields.progress !== undefined) patch.progress = fields.progress as Record<string, unknown>;
  if (fields.outputModelId !== undefined) patch.outputModelId = fields.outputModelId;
  await db.update(schema.modelTrainingJobs).set(patch).where(eq(schema.modelTrainingJobs.id, jobId));
}

/**
 * Atomic claim on the row: exactly one finalizer invocation proceeds per job.
 * SageMaker emits more than one state-change event at completion (the M4
 * browser pass saw two invocations 150 ms apart, both reading the row as
 * `running`, both applying the assist labels: every pre-label written twice).
 * The status check alone is a read-then-act; this is one conditional UPDATE,
 * so the loser sees zero rows and stops.
 */
export async function claimFinalize(jobId: string): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const rows = await db
    .update(schema.modelTrainingJobs)
    .set({
      progress: sql`coalesce(${schema.modelTrainingJobs.progress}, '{}'::jsonb) || jsonb_build_object('finalizeClaimedAt', ${claimedAt}::text)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.modelTrainingJobs.id, jobId),
        notInArray(schema.modelTrainingJobs.status, [...TERMINAL_TRAINING_STATUSES]),
        sql`(${schema.modelTrainingJobs.progress}->>'finalizeClaimedAt') is null`,
      ),
    )
    .returning({ id: schema.modelTrainingJobs.id });
  return rows.length > 0;
}

/**
 * The whole terminal path for one job, idempotent on the row's status and
 * serialized by `claimFinalize`: a redelivered or duplicated state change for
 * a job another invocation is closing (or has closed) does nothing.
 */
/**
 * A `Stopped` training job is `cancelled` only when this platform asked for
 * the stop (`POST /training-jobs/{id}/cancel` records `stopRequestedAt` before
 * calling StopTrainingJob). SageMaker also stops jobs on its own: a managed
 * spot job that never found capacity ends `Stopped / MaxWaitTimeExceeded`,
 * which the M5 pass saw closed as "cancelled: Stopped" after 31 minutes though
 * nobody cancelled it. Those close `failed`, with SageMaker's own reason.
 */
export function stoppedOutcome(
  progress: unknown,
  event: Pick<TerminalEvent, 'failureReason' | 'secondaryStatus' | 'statusMessage'>,
): { status: 'cancelled' | 'failed'; error: string } {
  const requested = typeof (progress as { stopRequestedAt?: unknown } | null)?.stopRequestedAt === 'string';
  if (requested) return { status: 'cancelled', error: 'Cancelled' };
  const secondary = event.secondaryStatus ?? 'Stopped';
  if (secondary === 'MaxWaitTimeExceeded') {
    return {
      status: 'failed',
      error: 'No spot instance became available within the wait time (SageMaker MaxWaitTimeExceeded). Retry later, or use the CPU target.',
    };
  }
  const why = event.statusMessage ?? event.failureReason;
  return { status: 'failed', error: `SageMaker stopped the job before it finished (${secondary}${why ? `: ${why}` : ''})` };
}

export async function finalizeTrainingJob(
  bucket: string,
  job: typeof schema.modelTrainingJobs.$inferSelect,
  event: TerminalEvent,
  log: (m: string) => void,
): Promise<void> {
  if (isTerminal(job.status)) {
    log(`job ${job.id} is already ${job.status}, skipping`);
    return;
  }
  if (!(await claimFinalize(job.id))) {
    log(`job ${job.id} is being finalized by another invocation, skipping`);
    return;
  }
  const externalRef = job.externalRef;
  if (!externalRef) {
    await closeJob(job.id, 'failed', { error: 'the job has no SageMaker job name', endedAt: event.endedAt ?? new Date() });
    return;
  }
  const common = {
    billableSeconds: event.billableSeconds ?? null,
    startedAt: event.startedAt ?? job.startedAt ?? null,
    endedAt: event.endedAt ?? new Date(),
  };

  // A stop never produced a model; a SageMaker-side failure may not have
  // produced an output tarball either, so neither read one before trying.
  let out: ExtractedOutput | null = null;
  try {
    out = await extractJobOutput(bucket, job.id, externalRef, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`job ${job.id}: no readable output (${message})`);
  }

  if (event.status === 'Stopped') {
    const outcome = stoppedOutcome(job.progress, event);
    await closeJob(job.id, outcome.status, {
      ...common,
      error: outcome.error,
      progress: { ...((job.progress ?? {}) as Record<string, unknown>), phase: outcome.status },
      artifacts: out ? { prefix: jobArtifactsPrefix(job.id), files: out.entries.length } : null,
    });
    log(`job ${job.id} ${outcome.status}: ${outcome.error}`);
    return;
  }

  const result = out?.result ?? null;
  if (!result) {
    await closeJob(job.id, 'failed', {
      ...common,
      error:
        event.failureReason ??
        out?.resultError ??
        'the training job ended without a result.json (SageMaker did not run the container to completion)',
      progress: { phase: 'failed' },
      artifacts: out ? { prefix: jobArtifactsPrefix(job.id), files: out.entries.length } : null,
    });
    log(`job ${job.id} failed: ${event.failureReason ?? out?.resultError ?? 'no result.json'}`);
    return;
  }

  const update = jobRowUpdateFromResult(result, {
    endedAt: common.endedAt,
    artifactPrefix: jobArtifactsPrefix(job.id),
    extra: { files: out?.entries.length ?? 0 },
  });

  if (result.status !== 'succeeded') {
    await closeJob(job.id, 'failed', { ...common, ...update, endedAt: common.endedAt });
    log(`job ${job.id} failed in ${result.error?.phase}: ${result.error?.message}`);
    return;
  }

  if (job.task === 'train') {
    const published = await publishTrainedModel(bucket, job, out as ExtractedOutput, result, log);
    if (!published.ok) {
      await closeJob(job.id, 'failed', {
        ...common,
        metrics: update.metrics,
        artifacts: update.artifacts,
        error: `publish: ${published.error}`,
        progress: { phase: 'publish' },
      });
      log(`job ${job.id} publish refused: ${published.error}`);
      return;
    }
    await closeJob(job.id, 'succeeded', {
      ...common,
      metrics: update.metrics,
      artifacts: { ...(update.artifacts as Record<string, unknown>), model: published.prefix },
      error: null,
      progress: update.progress,
      outputModelId: published.modelId,
    });
    log(`job ${job.id} succeeded, org model ${published.modelId}, billable ${common.billableSeconds ?? '?'} s`);
    return;
  }

  try {
    const applied = await applyAssistLabels(job, out as ExtractedOutput, result, log);
    await closeJob(job.id, 'succeeded', {
      ...common,
      metrics: { ...((update.metrics ?? {}) as Record<string, unknown>), applied },
      artifacts: update.artifacts,
      error: null,
      progress: update.progress,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await closeJob(job.id, 'failed', { ...common, metrics: update.metrics, artifacts: update.artifacts, error: `labels: ${message}`, progress: { phase: 'label' } });
    log(`job ${job.id} labels could not be applied: ${message}`);
  }
}

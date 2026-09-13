import { z } from 'zod';
import type { TrainingStatus } from './training';

/**
 * The forge's READ-side contracts, mirrored as zod (xorgate-model-forge
 * `4a500a9`, `contracts/result.schema.json`, `progress.schema.json`,
 * `labels.schema.json`): what the finalizer parses out of `model.tar.gz` and
 * what `GET /training-jobs/{id}` tails. Pure: no AWS, no DB.
 *
 * Every object is `passthrough()`. The forge may add fields in an additive
 * minor and this service must keep reading the document; it must never fail a
 * finished job because a field it does not use appeared.
 */

const splitCountsSchema = z.object({ train: z.number(), val: z.number(), test: z.number() });

export const forgePerClassMetricSchema = z
  .object({
    name: z.string(),
    mAP50: z.number(),
    mAP50_95: z.number().nullish(),
    precision: z.number(),
    recall: z.number(),
    instances: z.number(),
  })
  .passthrough();

export const forgeMetricsSchema = z
  .object({
    mAP50: z.number(),
    mAP50_95: z.number(),
    precision: z.number(),
    recall: z.number(),
    perClass: z.array(forgePerClassMetricSchema).default([]),
  })
  .passthrough();

export const forgeResultSchema = z
  .object({
    resultVersion: z.literal(1),
    jobId: z.string(),
    task: z.enum(['train', 'autolabel']),
    recipe: z.string(),
    status: z.enum(['succeeded', 'failed']),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number(),
    dataset: z
      .object({
        classes: z.array(z.string()),
        images: splitCountsSchema,
        instances: z.record(z.string(), z.number()).default({}),
      })
      .passthrough()
      .optional(),
    base: z.object({ kind: z.string(), ref: z.string().nullish(), path: z.string().nullish() }).passthrough().optional(),
    hyperparameters: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    epochsCompleted: z.number().optional(),
    metrics: forgeMetricsSchema.optional(),
    model: z.object({ family: z.string(), name: z.string(), version: z.number(), dir: z.string() }).passthrough().optional(),
    check: z.object({ ok: z.boolean(), lines: z.array(z.string()) }).passthrough().optional(),
    artifacts: z
      .object({
        trainLog: z.string().nullish(),
        weights: z.string().nullish(),
        eval: z
          .object({ metrics: z.string(), confusion: z.string(), samples: z.array(z.string()).default([]) })
          .passthrough()
          .nullish(),
        labels: z.string().nullish(),
      })
      .passthrough()
      .default({}),
    labels: z
      .object({
        file: z.string(),
        images: z.number(),
        boxes: z.number(),
        perClass: z.record(z.string(), z.number()).default({}),
        unmapped: z.record(z.string(), z.number()).default({}),
      })
      .passthrough()
      .optional(),
    provenance: z.record(z.string(), z.unknown()).default({}),
    error: z.object({ phase: z.string(), message: z.string() }).passthrough().nullish(),
  })
  .passthrough();

export type ForgeResult = z.infer<typeof forgeResultSchema>;

export const forgeLabelBoxSchema = z
  .object({
    cls: z.string(),
    modelCls: z.string(),
    confidence: z.number(),
    xyxy: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })
  .passthrough();

export const forgeLabelsSchema = z
  .object({
    labelsVersion: z.literal(1),
    jobId: z.string(),
    model: z.object({ family: z.string(), name: z.string(), version: z.number() }).passthrough(),
    minConfidence: z.number(),
    classMap: z.record(z.string(), z.string()).default({}),
    images: z.array(z.object({ id: z.string(), boxes: z.array(forgeLabelBoxSchema) }).passthrough()),
    summary: z
      .object({
        images: z.number(),
        boxes: z.number(),
        perClass: z.record(z.string(), z.number()).default({}),
        unmapped: z.record(z.string(), z.number()).default({}),
      })
      .passthrough(),
  })
  .passthrough();

export type ForgeLabels = z.infer<typeof forgeLabelsSchema>;

// --- progress ----------------------------------------------------------------------

export const forgeProgressSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('status'), at: z.string(), status: z.string(), phase: z.string() }).passthrough(),
  z
    .object({
      t: z.literal('epoch'),
      at: z.string(),
      epoch: z.number(),
      epochs: z.number(),
      loss: z.number().nullish(),
      mAP50: z.number().nullish(),
    })
    .passthrough(),
  z.object({ t: z.literal('log'), at: z.string(), line: z.string() }).passthrough(),
]);
export type ForgeProgressMessage = z.infer<typeof forgeProgressSchema>;

export interface ProgressSummary {
  /** The parsed tail, oldest first. */
  lines: ForgeProgressMessage[];
  phase: string | null;
  epoch: number | null;
  epochs: number | null;
  lastEpochMap50: number | null;
  lastLine: string | null;
  /** Lines that did not parse (a partial last line while the file is being synced). */
  skipped: number;
}

/**
 * `progress.jsonl` is synced while the job runs, so the last line is often a
 * partial write: unparseable lines are counted, never thrown on. `tail` keeps
 * the newest N.
 */
export function summarizeProgress(text: string, tail = 200): ProgressSummary {
  const raw = text.split('\n').filter((l) => l.trim().length > 0);
  const parsed: ForgeProgressMessage[] = [];
  let skipped = 0;
  for (const line of raw) {
    try {
      const msg = forgeProgressSchema.safeParse(JSON.parse(line));
      if (msg.success) parsed.push(msg.data);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const lines = parsed.slice(-tail);
  let phase: string | null = null;
  let epoch: number | null = null;
  let epochs: number | null = null;
  let lastEpochMap50: number | null = null;
  let lastLine: string | null = null;
  for (const m of parsed) {
    if (m.t === 'status') phase = m.phase;
    else if (m.t === 'epoch') {
      epoch = m.epoch;
      epochs = m.epochs;
      lastEpochMap50 = m.mAP50 ?? lastEpochMap50;
    } else if (m.t === 'log') lastLine = m.line;
  }
  return { lines, phase, epoch, epochs, lastEpochMap50, lastLine, skipped };
}

// --- finalize mapping ---------------------------------------------------------------

export interface TrainJobRequest {
  family: string;
  name: string;
  version: number;
}

export interface PublishCandidate {
  /** `model/<family>/<name>/<version>` inside the tar, as the result names it. */
  modelDir: string;
  manifestPath: string;
  onnxPath: string;
  family: string;
  name: string;
  version: number;
}

export type FinalizeCheck<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * What a succeeded `train` result promises, checked before anything is
 * published: the result carries a model block, the check passed, and the
 * identity is the one the job asked for. A model the platform did not ask for
 * must never land in the organization's registry root.
 */
export function publishCandidate(result: ForgeResult, requested: TrainJobRequest): FinalizeCheck<PublishCandidate> {
  if (result.status !== 'succeeded') return { ok: false, error: `result status is ${result.status}` };
  if (!result.model) return { ok: false, error: 'result.json has no model block' };
  const { family, name, version, dir } = result.model;
  if (family !== requested.family || name !== requested.name || version !== requested.version) {
    return {
      ok: false,
      error: `the job asked for ${requested.family}/${requested.name} v${requested.version} and the result carries ${family}/${name} v${version}`,
    };
  }
  if (!result.check?.ok) {
    return { ok: false, error: `the forge's own model check did not pass: ${result.check?.lines?.join(' | ') ?? 'no check block'}` };
  }
  const modelDir = dir.replace(/^\.?\//, '').replace(/\/$/, '');
  return {
    ok: true,
    value: {
      modelDir,
      manifestPath: `${modelDir}/manifest.json`,
      onnxPath: `${modelDir}/model.onnx`,
      family,
      name,
      version,
    },
  };
}

/**
 * The manifest is the engine's contract, so its identity is validated against
 * the path it will be published at AND the sha256 it records for `model.onnx`
 * against the bytes actually in the tar. A manifest that disagrees with its
 * own file is the one failure mode that would be invisible until a run fails
 * in the field.
 */
export function checkManifestIdentity(
  manifest: { family?: unknown; name?: unknown; version?: unknown; files?: unknown },
  requested: TrainJobRequest,
  onnxSha256: string,
  onnxBytes: number,
): FinalizeCheck<true> {
  if (manifest.family !== requested.family || manifest.name !== requested.name || manifest.version !== requested.version) {
    return {
      ok: false,
      error: `manifest.json says ${String(manifest.family)}/${String(manifest.name)} v${String(manifest.version)}, the job asked for ${requested.family}/${requested.name} v${requested.version}`,
    };
  }
  const files = (manifest.files ?? {}) as Record<string, { sha256?: unknown; sizeBytes?: unknown }>;
  const entry = files['model.onnx'];
  if (!entry || typeof entry.sha256 !== 'string') {
    return { ok: false, error: 'manifest.json has no files["model.onnx"].sha256' };
  }
  if (entry.sha256 !== onnxSha256) {
    return { ok: false, error: `model.onnx sha256 ${onnxSha256} does not match manifest.json (${entry.sha256})` };
  }
  if (typeof entry.sizeBytes === 'number' && entry.sizeBytes !== onnxBytes) {
    return { ok: false, error: `model.onnx is ${onnxBytes} bytes, manifest.json says ${entry.sizeBytes}` };
  }
  return { ok: true, value: true };
}

export interface JobRowUpdate {
  status: TrainingStatus;
  metrics: unknown;
  artifacts: unknown;
  error: string | null;
  endedAt: Date;
  progress: Record<string, unknown>;
}

/** Result v1 -> the columns of `model_training_jobs`, for both tasks. */
export function jobRowUpdateFromResult(
  result: ForgeResult,
  opts: { endedAt: Date; artifactPrefix: string; extra?: Record<string, unknown> },
): JobRowUpdate {
  const succeeded = result.status === 'succeeded';
  return {
    status: succeeded ? 'succeeded' : 'failed',
    metrics: result.metrics
      ? {
          mAP50: result.metrics.mAP50,
          mAP50_95: result.metrics.mAP50_95,
          precision: result.metrics.precision,
          recall: result.metrics.recall,
          perClass: result.metrics.perClass,
          epochsCompleted: result.epochsCompleted ?? null,
          hyperparameters: result.hyperparameters ?? null,
          dataset: result.dataset ?? null,
        }
      : result.labels
        ? { labels: result.labels, dataset: result.dataset ?? null }
        : null,
    artifacts: {
      prefix: artifactPrefixOf(opts.artifactPrefix),
      trainLog: result.artifacts.trainLog ?? null,
      weights: result.artifacts.weights ?? null,
      eval: result.artifacts.eval ?? null,
      labels: result.artifacts.labels ?? null,
      check: result.check ?? null,
      durationMs: result.durationMs,
      ...(opts.extra ?? {}),
    },
    error: succeeded ? null : `${result.error?.phase ?? 'unknown'}: ${result.error?.message ?? 'the job failed without a message'}`,
    endedAt: opts.endedAt,
    progress: { phase: succeeded ? 'done' : (result.error?.phase ?? 'done'), epochsCompleted: result.epochsCompleted ?? null },
  };
}

function artifactPrefixOf(prefix: string): string {
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

// --- labels -> annotation rows -------------------------------------------------------

export interface AnnotationRowInput {
  itemId: string;
  classId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  source: 'model';
  sourceRef: string;
  confidence: number;
}

export interface LabelsMapping {
  rows: AnnotationRowInput[];
  /** Item ids that got at least one box (they flip to `ai_labeled`). */
  labeledItemIds: string[];
  /** Item ids the labels file named that the dataset does not (or no longer) holds. */
  unknownImages: string[];
  /** Class names the labels file used that the dataset does not carry. */
  unknownClasses: string[];
  boxes: number;
}

/**
 * The labels file (image id = dataset item id, absolute xyxy, dataset class
 * NAMES after `classMap`) becomes `dataset_annotations` rows. Boxes are
 * clamped into the image; a box naming an unknown class or an unknown image is
 * counted and dropped rather than failing the job, because the dataset may
 * have been edited while the job ran.
 */
export function labelsToAnnotationRows(
  labels: ForgeLabels,
  ctx: {
    classIdByName: ReadonlyMap<string, string>;
    itemSizeById: ReadonlyMap<string, { width: number; height: number }>;
    sourceRef: string;
  },
): LabelsMapping {
  const rows: AnnotationRowInput[] = [];
  const labeledItemIds: string[] = [];
  const unknownImages: string[] = [];
  const unknownClasses = new Set<string>();
  for (const image of labels.images) {
    const size = ctx.itemSizeById.get(image.id);
    if (!size) {
      if (image.boxes.length > 0) unknownImages.push(image.id);
      continue;
    }
    let added = 0;
    for (const box of image.boxes) {
      const classId = ctx.classIdByName.get(box.cls);
      if (!classId) {
        unknownClasses.add(box.cls);
        continue;
      }
      const x1 = clamp(Math.min(box.xyxy[0], box.xyxy[2]), 0, size.width);
      const y1 = clamp(Math.min(box.xyxy[1], box.xyxy[3]), 0, size.height);
      const x2 = clamp(Math.max(box.xyxy[0], box.xyxy[2]), 0, size.width);
      const y2 = clamp(Math.max(box.xyxy[1], box.xyxy[3]), 0, size.height);
      if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
      rows.push({
        itemId: image.id,
        classId,
        x1,
        y1,
        x2,
        y2,
        source: 'model',
        sourceRef: ctx.sourceRef,
        confidence: box.confidence,
      });
      added += 1;
    }
    if (added > 0) labeledItemIds.push(image.id);
  }
  return { rows, labeledItemIds, unknownImages, unknownClasses: [...unknownClasses].sort(), boxes: rows.length };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

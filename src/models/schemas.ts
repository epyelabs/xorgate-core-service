import { z } from 'zod';
import { CLASS_NAME_MAX, DATASET_NAME_MAX, MODEL_NAME_MAX } from './names';
import { MAX_CLASSES } from './classes';
import { IMAGE_CONTENT_TYPES, MAX_IMPORT_FRAMES } from './keys';
import { DEFAULT_MAX_MINUTES, MAX_MAX_MINUTES, RECIPES, TRAINING_MODES, TRAINING_TARGETS } from './training';

/**
 * Request bodies of the Models API (design §4c). Server-side contract; the
 * web app mirrors these in M4. Everything here is pure zod.
 */

const classInputSchema = z.object({
  id: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(CLASS_NAME_MAX),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb')
    .optional(),
});

export const createDatasetSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(DATASET_NAME_MAX, 'Name is too long'),
  description: z.string().max(280, 'Description is too long').optional(),
  classes: z.array(z.string().min(1).max(CLASS_NAME_MAX)).min(1).max(MAX_CLASSES),
});

export const updateDatasetSchema = z.object({
  name: z.string().trim().min(1).max(DATASET_NAME_MAX).optional(),
  description: z.string().max(280).nullable().optional(),
  /** Full replacement list; entries with a known id keep it (rename, recolor, reorder). */
  classes: z.array(classInputSchema).min(1).max(MAX_CLASSES).optional(),
});

export const ITEM_STATUSES = ['unlabeled', 'ai_labeled', 'labeled', 'excluded'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_SOURCE_KINDS = ['upload', 'recording', 'run_capture'] as const;

export const createUploadsSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(200),
        contentType: z.enum(IMAGE_CONTENT_TYPES),
      }),
    )
    .min(1)
    .max(50),
});

export const registerItemsSchema = z.object({
  /** Keys handed out by the uploads endpoint, at most 50 per call. */
  keys: z.array(z.string().min(1).max(300)).min(1).max(50),
  /** Optional split group for every registered item (a session or a scene tag). */
  groupKey: z.string().min(1).max(120).optional(),
});

export const annotationInputSchema = z.object({
  classId: z.string().min(1).max(32),
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
  source: z.enum(['human', 'model', 'import']).optional(),
  sourceRef: z.string().max(200).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const putAnnotationsSchema = z.object({
  annotations: z.array(annotationInputSchema).max(500),
  /**
   * The item's status after the write. Default: `labeled` (a human confirmed
   * the set, empty or not); `unlabeled` clears a mistaken save.
   */
  status: z.enum(['labeled', 'unlabeled', 'ai_labeled']).optional(),
});

export const createImportSchema = z.object({
  kind: z.literal('recording'),
  sessionId: z.string().uuid(),
  /** One of the two sampling rates; default every 2 s. */
  everySeconds: z.number().positive().max(3600).optional(),
  fps: z.number().positive().max(15).optional(),
  maxFrames: z.number().int().positive().max(MAX_IMPORT_FRAMES).optional(),
  /** ISO-8601 bounds inside the session (optional). */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const createVersionSchema = z.object({
  message: z.string().max(280).optional(),
  split: z
    .object({
      train: z.number().min(0).max(1),
      val: z.number().min(0).max(1),
      test: z.number().min(0).max(1).default(0),
    })
    .default({ train: 0.8, val: 0.2, test: 0 }),
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(0),
  keepPrevious: z.boolean().default(false),
  /** Include `ai_labeled` items (unreviewed pre-labels) next to human-labeled ones. Default false. */
  includeAiLabeled: z.boolean().default(false),
});

export const patchModelSchema = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['ready', 'archived']).optional(),
});

// --- training and assist (M3, design §4c) ------------------------------------------

const hyperparametersSchema = z.object({
  epochs: z.number().int().min(1).max(1000).optional(),
  imgsz: z.number().int().min(32).max(1920).optional(),
  batch: z.union([z.literal('auto'), z.number().int().min(1).max(256)]).optional(),
  patience: z.number().int().min(0).max(1000).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});

export const createTrainingJobSchema = z.object({
  datasetVersionId: z.string().uuid(),
  recipe: z.enum(RECIPES).default('yolov8'),
  /** Phase 1 trains from a recipe base only; `weights` (train-from-previous) is Phase 2. */
  base: z
    .object({ kind: z.literal('pretrained').default('pretrained'), ref: z.string().min(1).max(64) })
    .default({ kind: 'pretrained', ref: 'yolov8n' }),
  output: z.object({
    name: z.string().min(1).max(MODEL_NAME_MAX),
    label: z.string().trim().max(120).optional(),
    /** Omitted: the next free version of that name in the organization. */
    version: z.number().int().min(1).max(10_000).optional(),
  }),
  mode: z.enum(TRAINING_MODES).default('fast'),
  hyperparameters: hyperparametersSchema.optional(),
  target: z.enum(TRAINING_TARGETS).default('cpu'),
  instanceType: z.string().min(1).max(40).optional(),
  spot: z.boolean().optional(),
  limits: z.object({ maxMinutes: z.number().int().min(1).max(MAX_MAX_MINUTES).default(DEFAULT_MAX_MINUTES) }).default({
    maxMinutes: DEFAULT_MAX_MINUTES,
  }),
});

export const createAssistSchema = z.object({
  /** A registry name, resolved org-first then platform (`yolov8n`, `my-model@2`). */
  model: z.string().min(1).max(MODEL_NAME_MAX + 8),
  family: z.string().min(1).max(40).default('detection'),
  minConfidence: z.number().min(0).max(1).default(0.4),
  /** model class name -> dataset class name; unmapped model classes are counted, not written. */
  classMap: z.record(z.string().min(1).max(CLASS_NAME_MAX), z.string().min(1).max(CLASS_NAME_MAX)).optional(),
  /** Which items to label. `unlabeled` (default) never touches a human-labeled item. */
  items: z.enum(['unlabeled', 'all']).default('unlabeled'),
  maxItems: z.number().int().min(1).max(500).optional(),
  target: z.enum(TRAINING_TARGETS).default('cpu'),
  instanceType: z.string().min(1).max(40).optional(),
  limits: z.object({ maxMinutes: z.number().int().min(1).max(MAX_MAX_MINUTES).default(30) }).default({ maxMinutes: 30 }),
});

/** What `ModelJobQueue` carries. */
export const modelJobMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('import'), importId: z.string().uuid(), cursor: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('version_build'), versionId: z.string().uuid() }),
  z.object({ kind: z.literal('train'), jobId: z.string().uuid() }),
  z.object({ kind: z.literal('autolabel'), jobId: z.string().uuid() }),
]);
export type ModelJobMessage = z.infer<typeof modelJobMessageSchema>;

export const MODEL_NAME_MAX_LENGTH = MODEL_NAME_MAX;

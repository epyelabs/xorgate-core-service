import { z } from 'zod';
import { CLASS_NAME_MAX, DATASET_NAME_MAX, MODEL_NAME_MAX } from './names';
import { MAX_CLASSES } from './classes';
import { IMAGE_CONTENT_TYPES, MAX_IMPORT_FRAMES } from './keys';

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

/** What `ModelJobQueue` carries. M3 adds `train | autolabel`. */
export const modelJobMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('import'), importId: z.string().uuid(), cursor: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('version_build'), versionId: z.string().uuid() }),
]);
export type ModelJobMessage = z.infer<typeof modelJobMessageSchema>;

export const MODEL_NAME_MAX_LENGTH = MODEL_NAME_MAX;

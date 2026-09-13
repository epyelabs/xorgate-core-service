import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { parseStoredClasses } from '../models/classes';
import { modelNameError } from '../models/names';
import { MODEL_REGISTRY_PREFIX, modelRootsFor } from '../workflows/models/registry';
import { resolveModelIn } from '../workflows/models/store';
import {
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_SPOT,
  instanceTypeError,
  MAX_RUNNING_JOBS_PER_ORG,
  maxMinutesError,
  maxRuntimeSeconds,
  TERMINAL_TRAINING_STATUSES,
  type TrainingTarget,
} from '../models/training';
import { datasetS3 } from './dataset-store';

/**
 * Training and assist job rows: the impure half that the handlers share
 * (xorgate-models M3). Guardrails first (Q6: one running job per
 * organization, the minute cap, the instance allow-list, no shadowing of a
 * platform model name), then the row, then the queue message. The pure
 * decisions live in `src/models/training.ts`.
 */

export type JobRow = typeof schema.modelTrainingJobs.$inferSelect;

export const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running'] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_TRAINING_STATUSES as readonly string[]).includes(status);
}

/** The organization's jobs that have not finished; the concurrency guardrail reads this. */
export async function activeJobsForOrg(orgId: string): Promise<JobRow[]> {
  return db
    .select()
    .from(schema.modelTrainingJobs)
    .where(
      and(
        eq(schema.modelTrainingJobs.organizationId, orgId),
        inArray(schema.modelTrainingJobs.status, [...ACTIVE_JOB_STATUSES]),
      ),
    )
    .orderBy(desc(schema.modelTrainingJobs.createdAt));
}

export interface ComputeChoice {
  target: TrainingTarget;
  instanceType: string;
  spot: boolean;
  maxMinutes: number;
  maxRuntimeSeconds: number;
  volumeSizeGb: number;
}

/** Resolves and validates the compute block, or returns the refusal message. */
export function chooseCompute(input: {
  target: TrainingTarget;
  instanceType?: string;
  spot?: boolean;
  maxMinutes: number;
  volumeSizeGb?: number;
}): ComputeChoice | { error: string } {
  const instanceType = input.instanceType ?? DEFAULT_INSTANCE_TYPE[input.target];
  const instanceError = instanceTypeError(input.target, instanceType);
  if (instanceError) return { error: instanceError };
  const minutesError = maxMinutesError(input.maxMinutes);
  if (minutesError) return { error: minutesError };
  const spot = input.spot ?? DEFAULT_SPOT[input.target];
  return {
    target: input.target,
    instanceType,
    spot,
    maxMinutes: input.maxMinutes,
    maxRuntimeSeconds: maxRuntimeSeconds(input.maxMinutes),
    volumeSizeGb: input.volumeSizeGb ?? 30,
  };
}

/**
 * The output identity of a train job: the name rule, Q4's no-shadowing rule
 * (a name that resolves in the PLATFORM root is taken for everyone), and the
 * next free version of that name in the organization. Returns the refusal
 * message instead of a version when the name cannot be used.
 */
export async function resolveOutputVersion(
  bucket: string,
  orgId: string,
  family: string,
  name: string,
  requestedVersion?: number,
): Promise<{ version: number } | { error: string; code?: string }> {
  const nameError = modelNameError(name);
  if (nameError) return { error: nameError };
  try {
    const platform = await resolveModelIn(datasetS3(), bucket, family, name, undefined, [MODEL_REGISTRY_PREFIX]);
    return {
      error: `"${name}" is the name of a platform model (${family}/${platform.manifest.name} v${platform.manifest.version}); organization models may not shadow platform names. Pick another name.`,
      code: 'MODEL_NAME_TAKEN',
    };
  } catch {
    // Not in the platform root: the name is free for this organization.
  }
  const [row] = await db
    .select({ v: sql<number | null>`max(${schema.orgModels.version})` })
    .from(schema.orgModels)
    .where(
      and(
        eq(schema.orgModels.organizationId, orgId),
        eq(schema.orgModels.family, family),
        eq(schema.orgModels.name, name),
      ),
    );
  const highest = row?.v === null || row?.v === undefined ? 0 : Number(row.v);
  if (requestedVersion === undefined) return { version: highest + 1 };
  if (requestedVersion <= highest) {
    return { error: `${family}/${name} v${requestedVersion} already exists in this organization (latest is v${highest})`, code: 'MODEL_VERSION_TAKEN' };
  }
  return { version: requestedVersion };
}

/** `yolov8n` or `yolov8n@2` -> the pair the registry resolves. */
export function parseModelRef(ref: string): { name: string; version?: number } {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return { name: ref };
  const version = Number(ref.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) return { name: ref };
  return { name: ref.slice(0, at), version };
}

/**
 * Resolves an assist model through the organization's own chain
 * (`org-models/<orgId>/` then `models/`) and reports which ROOT it came from:
 * that root becomes the job's `models` channel, so the container sees exactly
 * the registry the engine would.
 */
export async function resolveAssistModel(
  bucket: string,
  orgId: string,
  family: string,
  ref: string,
): Promise<{ root: string; name: string; version: number; classNames: string[] } | { error: string }> {
  const { name, version } = parseModelRef(ref);
  try {
    const resolved = await resolveModelIn(datasetS3(), bucket, family, name, version, modelRootsFor(orgId));
    return {
      root: resolved.root,
      name: resolved.manifest.name,
      version: resolved.manifest.version,
      classNames: resolved.manifest.classNames ?? [],
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function toJobResponse(row: JobRow, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    datasetId: row.datasetId ?? null,
    datasetVersionId: row.datasetVersionId ?? null,
    task: row.task,
    recipe: row.recipe,
    base: row.base ?? null,
    mode: row.mode ?? null,
    target: row.target,
    compute: row.compute,
    status: row.status,
    externalRef: row.externalRef ?? null,
    progress: row.progress,
    metrics: row.metrics ?? null,
    artifacts: row.artifacts ?? null,
    error: row.error ?? null,
    outputModelId: row.outputModelId ?? null,
    billableSeconds: row.billableSeconds ?? null,
    output: (row.spec as { output?: unknown } | null)?.output ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...extra,
  };
}

/** The dataset's class list as a name -> class id map (the labels file names classes). */
export async function classIdByName(datasetId: string): Promise<Map<string, string>> {
  const dataset = await db.query.datasets.findFirst({ where: eq(schema.datasets.id, datasetId) });
  if (!dataset) return new Map();
  return new Map(parseStoredClasses(dataset.classes).map((c) => [c.name, c.id]));
}

/** The refusal a second concurrent job gets (Q6: one running job per organization). */
export function concurrencyMessage(active: JobRow[]): string {
  const one = active[0];
  return `This organization already has ${active.length} job(s) in flight (${one.task} ${one.id}, ${one.status}); at most ${MAX_RUNNING_JOBS_PER_ORG} runs at a time. Wait for it or cancel it.`;
}

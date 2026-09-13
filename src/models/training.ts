/**
 * Training and assist jobs: the pure half (xorgate-models M3, design §4d).
 * No AWS SDK, no drizzle, no environment. Three things live here:
 *
 *   1. the guardrails (Q6): one running job per organization, the minute cap,
 *      the instance allow-list;
 *   2. the forge job spec v1 builder (a row plus a request body becomes the
 *      document written to `training/<jobId>/job/job.json`);
 *   3. the `CreateTrainingJob` request builder (channels, output, checkpoints,
 *      stopping condition, spot, network isolation, tags).
 *
 * The job spec shape is the forge's frozen contract
 * (`contracts/job.schema.json` at xorgate-model-forge `4a500a9`); nothing here
 * may add a field the schema does not carry.
 */

import { datasetVersionPrefix, orgModelsRoot, PLATFORM_MODELS_PREFIX, trainingPrefix } from './keys';

// --- targets, instances, caps ------------------------------------------------------

export const TRAINING_TASKS = ['train', 'autolabel'] as const;
export type TrainingTask = (typeof TRAINING_TASKS)[number];

export const TRAINING_TARGETS = ['cpu', 'gpu'] as const;
export type TrainingTarget = (typeof TRAINING_TARGETS)[number];

export const TRAINING_STATUSES = ['queued', 'dispatched', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];
export const TERMINAL_TRAINING_STATUSES: readonly TrainingStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * The instance allow-list (Q6). Anything outside it is refused before a job
 * exists: SageMaker bills per second and a typo in an instance type is the
 * expensive kind of typo. `gpu` types need a Service Quotas grant per account;
 * `cpu` needs none, which is why it is the target every proof runs on.
 */
export const TARGET_INSTANCE_TYPES: Record<TrainingTarget, readonly string[]> = {
  cpu: ['ml.m5.xlarge', 'ml.m5.2xlarge'],
  gpu: ['ml.g4dn.xlarge', 'ml.g6.xlarge'],
};
export const DEFAULT_INSTANCE_TYPE: Record<TrainingTarget, string> = {
  cpu: 'ml.m5.xlarge',
  gpu: 'ml.g4dn.xlarge',
};
/** Spot is the default on GPU (design §4d) and is not offered on CPU: an `ml.m5.xlarge` run is cents. */
export const DEFAULT_SPOT: Record<TrainingTarget, boolean> = { cpu: false, gpu: true };

export const DEFAULT_MAX_MINUTES = 60;
export const MAX_MAX_MINUTES = 240;
export const MAX_RUNNING_JOBS_PER_ORG = 1;
export const DEFAULT_VOLUME_SIZE_GB = 30;
export const RECIPES = ['yolov8'] as const;
export const RECIPE_LICENSES: Record<string, string> = { yolov8: 'AGPL-3.0' };
export const TRAINING_MODES = ['fast', 'accurate'] as const;

/**
 * SageMaker's own startup (image pull of a 2.76 GB image, channel download)
 * is not the recipe's budget, so it is added on top of `maxMinutes` before
 * `MaxRuntimeInSeconds`. It is capped at the job's own budget so a deliberately
 * tiny budget cannot quietly become a long-running job: `maxMinutes: 1` asks
 * for a two-minute ceiling, and SageMaker ends the job at it.
 */
export const STARTUP_ALLOWANCE_SECONDS = 600;

export function startupAllowanceSeconds(maxMinutes: number): number {
  return Math.min(STARTUP_ALLOWANCE_SECONDS, maxMinutes * 60);
}

export function maxRuntimeSeconds(maxMinutes: number): number {
  return maxMinutes * 60 + startupAllowanceSeconds(maxMinutes);
}

/** `null` when the pair is allowed, otherwise the refusal. */
export function instanceTypeError(target: TrainingTarget, instanceType: string): string | null {
  const allowed = TARGET_INSTANCE_TYPES[target];
  if (!allowed) return `Unknown target "${target}"`;
  if (!allowed.includes(instanceType)) {
    return `Instance type "${instanceType}" is not allowed for the ${target} target (allowed: ${allowed.join(', ')})`;
  }
  return null;
}

export function maxMinutesError(maxMinutes: number): string | null {
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1) return 'maxMinutes must be a positive integer';
  if (maxMinutes > MAX_MAX_MINUTES) return `maxMinutes must be at most ${MAX_MAX_MINUTES}`;
  return null;
}

// --- job naming --------------------------------------------------------------------

/**
 * `xorgate-forge-<stage>-<jobId>`: the EventBridge rule filters on this
 * prefix, and the stage segment keeps two stages in one account apart.
 * SageMaker allows 63 characters; the longest form is 18 + 36 = 54.
 */
export function forgeJobNamePrefix(stage: string): string {
  return `xorgate-forge-${stage}-`;
}
export function sagemakerJobName(stage: string, jobId: string): string {
  return `${forgeJobNamePrefix(stage)}${jobId}`;
}
/** The job id out of a SageMaker training-job name, or null when the name is another stage's or another tool's. */
export function jobIdFromSagemakerName(stage: string, name: string): string | null {
  const prefix = forgeJobNamePrefix(stage);
  if (!name.startsWith(prefix)) return null;
  const id = name.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}

// --- S3 layout of a job ------------------------------------------------------------

/**
 * `training/<jobId>/job/` holds nothing but `job.json`, and that directory is
 * what the `job` channel points at: a channel is an S3 PREFIX, so the spec
 * needs a prefix of its own or the channel would sweep in `output/` and
 * `checkpoints/` as well (design §4a names `training/<jobId>/job.json`; the
 * extra segment is the deviation that makes the channel deterministic).
 */
export function jobSpecPrefix(jobId: string): string {
  return `${trainingPrefix(jobId)}job/`;
}
export function jobSpecKey(jobId: string): string {
  return `${jobSpecPrefix(jobId)}job.json`;
}
export function jobOutputPrefix(jobId: string): string {
  return `${trainingPrefix(jobId)}output/`;
}
export function jobCheckpointsPrefix(jobId: string): string {
  return `${trainingPrefix(jobId)}checkpoints/`;
}
export function jobProgressKey(jobId: string): string {
  return `${jobCheckpointsPrefix(jobId)}progress.jsonl`;
}
export function jobArtifactsPrefix(jobId: string): string {
  return `${trainingPrefix(jobId)}artifacts/`;
}
/** What SageMaker writes when the container exits: the tar of `/opt/ml/model`. */
export function jobModelTarKey(jobId: string, sagemakerJobName_: string): string {
  return `${jobOutputPrefix(jobId)}${sagemakerJobName_}/output/model.tar.gz`;
}

// --- the forge job spec v1 ---------------------------------------------------------

export interface JobSpecProvenance {
  orgId: string;
  datasetId: string;
  datasetVersion?: number;
  datasetVersionId?: string;
  requestedBy?: string | null;
}

export interface TrainJobSpec {
  specVersion: 1;
  jobId: string;
  task: 'train';
  recipe: string;
  output: { family: string; name: string; version: number; label?: string | null };
  base: { kind: 'pretrained' | 'weights'; ref?: string | null; path?: string | null };
  mode: 'fast' | 'accurate';
  hyperparameters?: Record<string, number | string>;
  limits: { maxMinutes: number };
  provenance: Record<string, unknown>;
}

export interface AutolabelJobSpec {
  specVersion: 1;
  jobId: string;
  task: 'autolabel';
  recipe: string;
  model: { family: string; name: string };
  minConfidence: number;
  classMap?: Record<string, string>;
  images: 'all' | string[];
  limits: { maxMinutes: number };
  provenance: Record<string, unknown>;
}

export type ForgeJobSpec = TrainJobSpec | AutolabelJobSpec;

export interface BuildTrainSpecInput {
  jobId: string;
  recipe: string;
  output: { family: string; name: string; version: number; label?: string | null };
  base: { kind: 'pretrained' | 'weights'; ref?: string | null; path?: string | null };
  mode: 'fast' | 'accurate';
  hyperparameters?: { epochs?: number; imgsz?: number; batch?: number | 'auto'; patience?: number; seed?: number };
  maxMinutes: number;
  provenance: JobSpecProvenance;
}

function cleanProvenance(p: JobSpecProvenance): Record<string, unknown> {
  const out: Record<string, unknown> = { orgId: p.orgId, datasetId: p.datasetId };
  if (p.datasetVersion !== undefined) out.datasetVersion = p.datasetVersion;
  if (p.datasetVersionId !== undefined) out.datasetVersionId = p.datasetVersionId;
  if (p.requestedBy) out.requestedBy = p.requestedBy;
  return out;
}

export function buildTrainJobSpec(input: BuildTrainSpecInput): TrainJobSpec {
  const hp: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(input.hyperparameters ?? {})) {
    if (v !== undefined && v !== null) hp[k] = v as number | string;
  }
  return {
    specVersion: 1,
    jobId: input.jobId,
    task: 'train',
    recipe: input.recipe,
    output: {
      family: input.output.family,
      name: input.output.name,
      version: input.output.version,
      label: input.output.label ?? null,
    },
    base: { kind: input.base.kind, ref: input.base.ref ?? null, path: input.base.path ?? null },
    mode: input.mode,
    ...(Object.keys(hp).length > 0 ? { hyperparameters: hp } : {}),
    limits: { maxMinutes: input.maxMinutes },
    provenance: cleanProvenance(input.provenance),
  };
}

export interface BuildAutolabelSpecInput {
  jobId: string;
  recipe: string;
  model: { family: string; name: string };
  minConfidence: number;
  classMap?: Record<string, string>;
  images?: 'all' | string[];
  maxMinutes: number;
  provenance: JobSpecProvenance;
}

export function buildAutolabelJobSpec(input: BuildAutolabelSpecInput): AutolabelJobSpec {
  return {
    specVersion: 1,
    jobId: input.jobId,
    task: 'autolabel',
    recipe: input.recipe,
    model: { family: input.model.family, name: input.model.name },
    minConfidence: input.minConfidence,
    ...(input.classMap && Object.keys(input.classMap).length > 0 ? { classMap: input.classMap } : {}),
    images: input.images ?? 'all',
    limits: { maxMinutes: input.maxMinutes },
    provenance: cleanProvenance(input.provenance),
  };
}

// --- the CreateTrainingJob request -------------------------------------------------

/**
 * The subset of `CreateTrainingJob` this feature sends. Declared here rather
 * than imported from `@aws-sdk/client-sagemaker` so the module stays pure and
 * the smoke can assert the exact document without an SDK in the process.
 */
export interface CreateTrainingJobRequest {
  TrainingJobName: string;
  RoleArn: string;
  AlgorithmSpecification: {
    TrainingImage: string;
    TrainingInputMode: 'File';
    ContainerEntrypoint: string[];
    ContainerArguments: string[];
  };
  InputDataConfig: Array<{
    ChannelName: string;
    DataSource: { S3DataSource: { S3DataType: 'S3Prefix'; S3Uri: string; S3DataDistributionType: 'FullyReplicated' } };
    InputMode: 'File';
  }>;
  OutputDataConfig: { S3OutputPath: string };
  ResourceConfig: { InstanceType: string; InstanceCount: 1; VolumeSizeInGB: number };
  StoppingCondition: { MaxRuntimeInSeconds: number; MaxWaitTimeInSeconds?: number };
  CheckpointConfig: { S3Uri: string; LocalPath: string };
  EnableManagedSpotTraining: boolean;
  EnableNetworkIsolation: boolean;
  Environment: Record<string, string>;
  Tags: Array<{ Key: string; Value: string }>;
}

export interface BuildSagemakerRequestInput {
  stage: string;
  jobId: string;
  orgId: string;
  bucket: string;
  imageUri: string;
  roleArn: string;
  target: TrainingTarget;
  instanceType: string;
  spot: boolean;
  maxMinutes: number;
  volumeSizeGb?: number;
  /** The `dataset` channel: a ready version's prefix IS a forge dataset v1. */
  datasetPrefix: string;
  /**
   * The optional `models` channel: a registry ROOT (`org-models/<orgId>/` or
   * `models/`), mounted at `/opt/ml/input/data/models`, which the forge's
   * SageMaker host reads as `<root>/<family>/<name>/<version>/`.
   */
  modelsRoot?: string | null;
  environment?: Record<string, string>;
}

/** `/opt/ml` paths the forge's SageMakerHost maps (hosts/sagemaker.py). */
export const CONTAINER_JOB_SPEC_PATH = '/opt/ml/input/data/job/job.json';
export const CONTAINER_CHECKPOINTS_PATH = '/opt/ml/checkpoints';

export function buildCreateTrainingJobRequest(input: BuildSagemakerRequestInput): CreateTrainingJobRequest {
  const instanceError = instanceTypeError(input.target, input.instanceType);
  if (instanceError) throw new Error(instanceError);
  const minutesError = maxMinutesError(input.maxMinutes);
  if (minutesError) throw new Error(minutesError);
  const runtime = maxRuntimeSeconds(input.maxMinutes);
  const s3 = (key: string) => `s3://${input.bucket}/${key}`;
  const channels: CreateTrainingJobRequest['InputDataConfig'] = [
    channel('dataset', s3(input.datasetPrefix)),
    channel('job', s3(jobSpecPrefix(input.jobId))),
  ];
  if (input.modelsRoot) channels.push(channel('models', s3(input.modelsRoot)));
  return {
    TrainingJobName: sagemakerJobName(input.stage, input.jobId),
    RoleArn: input.roleArn,
    AlgorithmSpecification: {
      TrainingImage: input.imageUri,
      TrainingInputMode: 'File',
      // The image's own ENTRYPOINT/CMD point at /opt/ml/input/config/job.json,
      // which is SageMaker's own config directory and not writable by us; the
      // spec rides in a channel instead, so the command is overridden here.
      ContainerEntrypoint: ['xmf'],
      ContainerArguments: ['run', CONTAINER_JOB_SPEC_PATH, '--host', 'sagemaker'],
    },
    InputDataConfig: channels,
    OutputDataConfig: { S3OutputPath: s3(jobOutputPrefix(input.jobId)) },
    ResourceConfig: {
      InstanceType: input.instanceType,
      InstanceCount: 1,
      VolumeSizeInGB: input.volumeSizeGb ?? DEFAULT_VOLUME_SIZE_GB,
    },
    StoppingCondition: {
      MaxRuntimeInSeconds: runtime,
      // Spot: the wait budget must be at least the runtime budget; the job
      // waits for capacity inside it.
      ...(input.spot ? { MaxWaitTimeInSeconds: runtime } : {}),
    },
    CheckpointConfig: { S3Uri: s3(jobCheckpointsPrefix(input.jobId)), LocalPath: CONTAINER_CHECKPOINTS_PATH },
    EnableManagedSpotTraining: input.spot,
    // Every weight the recipe needs is baked into the image and every input
    // arrives through a channel, so the container needs no network at all.
    EnableNetworkIsolation: true,
    Environment: { XORGATE_STAGE: input.stage, XORGATE_JOB_ID: input.jobId, ...(input.environment ?? {}) },
    Tags: [
      { Key: 'xorgate:stage', Value: input.stage },
      { Key: 'xorgate:orgId', Value: input.orgId },
      { Key: 'xorgate:jobId', Value: input.jobId },
    ],
  };
}

function channel(name: string, s3Uri: string): CreateTrainingJobRequest['InputDataConfig'][number] {
  return {
    ChannelName: name,
    DataSource: { S3DataSource: { S3DataType: 'S3Prefix', S3Uri: s3Uri, S3DataDistributionType: 'FullyReplicated' } },
    InputMode: 'File',
  };
}

/** The registry root a resolved model came from, as a `models` channel prefix. */
export function modelsChannelRoot(orgId: string, root: string): string {
  return root === PLATFORM_MODELS_PREFIX ? PLATFORM_MODELS_PREFIX : orgModelsRoot(orgId);
}

/** `datasets/<id>/versions/<n>/`, the `dataset` channel for a train job. */
export function datasetChannelPrefix(datasetId: string, version: number): string {
  return datasetVersionPrefix(datasetId, version);
}

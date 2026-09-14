import type { EventBridgeEvent } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { DescribeTrainingJobCommand, SageMakerClient } from '@aws-sdk/client-sagemaker';
import { db, schema } from '../db/index';
import { jobIdFromSagemakerName } from '../models/training';
import { finalizeTrainingJob, type TerminalEvent } from '../services/training-finalize';
import { isTerminal } from '../services/training-jobs';

/**
 * Training-job finalizer (xorgate-models design §4d step 4). Fired by the
 * EventBridge rule on `aws.sagemaker` "SageMaker Training Job State Change",
 * filtered to `xorgate-forge-<stage>-*`, so no other tool's training jobs and
 * no other stage's reach this function.
 *
 *   InProgress                -> the row's `progress.phase` follows the
 *                                SecondaryStatus (EventBridge delivers every
 *                                transition, about fifteen events per job);
 *                                the row flips to `running` once the container
 *                                side starts (Downloading, Training, ...), not
 *                                while SageMaker is still looking for an
 *                                instance (Starting, Pending, ...). The M5 pass
 *                                watched a spot job read "running, started
 *                                10:47" for 31 minutes with no instance at all.
 *   Completed | Failed        -> extract model.tar.gz, read result.json,
 *                                publish or record the failure, close the row
 *   Stopped                   -> `cancelled` when this platform asked for the
 *                                stop (POST /cancel), `failed` with the
 *                                SecondaryStatus otherwise (MaxWaitTimeExceeded
 *                                on a spot job that never got capacity)
 *
 * Idempotent on the row's status: a redelivered terminal event for a closed
 * job does nothing. `DescribeTrainingJob` is called on every terminal event
 * because `BillableTimeInSeconds` is the number the cost story rests on and
 * the event does not always carry it.
 */

/** SecondaryStatus values before any container exists (nothing is billed yet). */
const PRE_INSTANCE_STATUSES = new Set(['Starting', 'Pending', 'LaunchingMLInstances', 'PreparingTrainingStack', 'DownloadingTrainingImage']);

const sagemaker = new SageMakerClient({});

interface StateChangeDetail {
  TrainingJobName?: string;
  TrainingJobStatus?: string;
  SecondaryStatus?: string;
  FailureReason?: string;
  BillableTimeInSeconds?: number;
  TrainingStartTime?: number | string;
  TrainingEndTime?: number | string;
}

function asDate(value: number | string | undefined | null): Date | null {
  if (value === undefined || value === null) return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const handler = async (
  event: EventBridgeEvent<'SageMaker Training Job State Change', StateChangeDetail>,
): Promise<void> => {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) throw new Error('model-job-finalize: BUCKET_NAME is not configured');
  const stage = process.env.STAGE ?? 'dev';
  const log = (m: string) => console.log(`model-job-finalize: ${m}`);

  const name = event.detail?.TrainingJobName;
  const status = event.detail?.TrainingJobStatus;
  if (!name || !status) {
    console.warn('model-job-finalize: event missing TrainingJobName/TrainingJobStatus', { id: event.id });
    return;
  }
  const jobId = jobIdFromSagemakerName(stage, name);
  if (!jobId) {
    log(`${name} is not a ${stage} forge job, ignoring`);
    return;
  }
  const job = await db.query.modelTrainingJobs.findFirst({ where: eq(schema.modelTrainingJobs.id, jobId) });
  if (!job) {
    console.warn('model-job-finalize: no row for training job', { name, jobId });
    return;
  }

  if (status === 'InProgress') {
    if (isTerminal(job.status)) return;
    const secondary = event.detail.SecondaryStatus ?? 'Starting';
    const phase = secondary.toLowerCase();
    const progress = { ...((job.progress ?? {}) as Record<string, unknown>) };
    const containerSide = !PRE_INSTANCE_STATUSES.has(secondary);
    const flip = containerSide && (job.status === 'dispatched' || job.status === 'queued');
    if (!flip && progress.phase === phase) return;
    progress.phase = phase;
    await db
      .update(schema.modelTrainingJobs)
      .set({
        ...(flip ? { status: 'running', startedAt: asDate(event.detail.TrainingStartTime) ?? job.startedAt ?? new Date() } : {}),
        progress,
        updatedAt: new Date(),
      })
      .where(eq(schema.modelTrainingJobs.id, job.id));
    log(`job ${job.id} ${flip ? 'running' : job.status} (${secondary})`);
    return;
  }

  if (status !== 'Completed' && status !== 'Failed' && status !== 'Stopped') {
    log(`job ${job.id}: ignoring state ${status}`);
    return;
  }
  if (isTerminal(job.status)) {
    log(`job ${job.id} is already ${job.status}, skipping`);
    return;
  }

  // The authoritative numbers (billable seconds, the failure reason, the real
  // start and end) come from the API, not from the event body.
  let described: Awaited<ReturnType<typeof describe>> | null = null;
  try {
    described = await describe(name);
  } catch (err) {
    console.warn('model-job-finalize: DescribeTrainingJob failed, using the event body', { name, err });
  }
  const terminal: TerminalEvent = {
    status,
    failureReason: described?.FailureReason ?? event.detail.FailureReason ?? null,
    secondaryStatus: described?.SecondaryStatus ?? event.detail.SecondaryStatus ?? null,
    statusMessage: described?.StatusMessage ?? null,
    billableSeconds: described?.BillableTimeInSeconds ?? event.detail.BillableTimeInSeconds ?? null,
    startedAt: described?.TrainingStartTime ?? asDate(event.detail.TrainingStartTime),
    endedAt: described?.TrainingEndTime ?? asDate(event.detail.TrainingEndTime) ?? new Date(),
  };
  await finalizeTrainingJob(bucket, job, terminal, log);
};

async function describe(name: string) {
  const res = await sagemaker.send(new DescribeTrainingJobCommand({ TrainingJobName: name }));
  const transitions = res.SecondaryStatusTransitions ?? [];
  return {
    FailureReason: res.FailureReason ?? null,
    SecondaryStatus: res.SecondaryStatus ?? null,
    StatusMessage: transitions.length > 0 ? (transitions[transitions.length - 1].StatusMessage ?? null) : null,
    BillableTimeInSeconds: res.BillableTimeInSeconds ?? null,
    TrainingStartTime: res.TrainingStartTime ?? null,
    TrainingEndTime: res.TrainingEndTime ?? null,
  };
}

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { ModelJobMessage } from '../models/schemas';

/**
 * The one async plane of the Models feature (design §4d): `ModelJobQueue`
 * (SQS + DLQ, maxReceiveCount 3) carries `{ kind, ...ids }` and
 * `handlers/model-job-dispatch.ts` consumes it. M2 kinds: `import` and
 * `version_build`; M3 adds `train` and `autolabel`. The row that owns the job
 * is the authority; the message only names it.
 */

const sqs = new SQSClient({});
const QUEUE_URL = process.env.MODEL_JOB_QUEUE_URL;

export async function enqueueModelJob(message: ModelJobMessage): Promise<void> {
  if (!QUEUE_URL) throw new Error('MODEL_JOB_QUEUE_URL is not configured');
  await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) }));
}

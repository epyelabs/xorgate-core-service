import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { modelJobMessageSchema } from '../models/schemas';
import { runRecordingImport } from '../services/dataset-import';
import { buildDatasetVersion } from '../services/dataset-version-build';
import { dispatchTrainingJob } from '../services/training-dispatch';
import { runDevicePurge } from '../services/device-purge';

/**
 * `ModelJobQueue` consumer (xorgate-models design §4d). SQS event source,
 * batchSize 1, reportBatchItemFailures. The message names the row that owns
 * the job (`{ kind: 'import', importId, cursor? }` or
 * `{ kind: 'version_build', versionId }`); the job re-reads the row and claims
 * it atomically (`dispatched_at IS NULL`), so a redelivery is a no-op.
 * `train` and `autolabel` write the job spec to S3 and call
 * `CreateTrainingJob`; the EventBridge finalizer closes those rows.
 *
 * The import needs the ffmpeg layer (FFMPEG_PATH) and the function's full
 * 15-minute budget; it chunks across invocations through the queue when a
 * session is longer than one invocation can walk.
 *
 * `device_purge` (plans/device-wf-data-delete) is not a Models job at all; it
 * rides here for the same budget and the same cursor discipline, claiming its
 * `device_purges` row through a lease and re-enqueueing itself when time runs
 * low. `ApproximateReceiveCount` tells it when SQS is about to give up, so it
 * can mark the row failed instead of leaving a purge that spins forever.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) throw new Error('model-job-dispatch: BUCKET_NAME is not configured');
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const log = (m: string) => console.log(`model-job-dispatch: ${m}`);
  for (const record of event.Records) {
    let parsed;
    try {
      parsed = modelJobMessageSchema.safeParse(JSON.parse(record.body));
    } catch {
      parsed = { success: false as const, error: null };
    }
    if (!parsed.success) {
      console.error('model-job-dispatch: unparseable message, dropping', { body: record.body });
      continue; // unprocessable: ack so it never loops into the DLQ
    }
    const message = parsed.data;
    try {
      switch (message.kind) {
        case 'import':
          await runRecordingImport({
            bucket,
            importId: message.importId,
            cursor: message.cursor,
            remainingMs: () => context.getRemainingTimeInMillis(),
            log,
          });
          break;
        case 'version_build':
          await buildDatasetVersion(bucket, message.versionId, log);
          break;
        case 'train':
        case 'autolabel':
          await dispatchTrainingJob(bucket, message.jobId, log);
          break;
        case 'device_purge':
          await runDevicePurge({
            bucket,
            purgeId: message.purgeId,
            remainingMs: () => context.getRemainingTimeInMillis(),
            receiveCount: Number(record.attributes?.ApproximateReceiveCount ?? '1'),
            log,
          });
          break;
      }
    } catch (err) {
      console.error('model-job-dispatch: record failed, will retry', { messageId: record.messageId, err });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { deliverOnce, type DeliveryMessage } from '../services/webhooks/deliver';

/**
 * WebhookDeliveryQueue consumer (batchSize 1, reportBatchItemFailures, 30 s
 * timeout): one signed POST per message (services/webhooks/deliver.ts
 * deliverOnce). The endpoint's answer, whatever it is, is a SUCCESS for SQS:
 * retries are scheduled by the delivery row (a delayed message up to 15 min,
 * the tick beyond). Only a database error fails the message.
 *
 * Runbook, WebhookDeliveryDlqDepthAlarm (drilled on dev in Phase 5, see
 * plans/xorgate-webhooks PROGRESS.md):
 * 1. A message lands in WebhookDeliveryDlq after 3 failed receives, i.e. the
 *    same database error three times, 60 s apart. Find it in this function's
 *    log: `webhook-deliver: failed { deliveryId, attempt, err }`.
 * 2. Fix the cause (Aurora, a migration, a bad deploy).
 * 3. Nothing is lost: the delivery row is still `pending`, and the minute
 *    tick re-enqueues it once its 300 s lease passes (to hurry it, run the
 *    sweeper with `{"job":"webhooks-requeue"}`). The DLQ copy is then stale.
 * 4. Empty the DLQ: `aws sqs start-message-move-task --source-arn <DLQ arn>
 *    --destination-arn <WebhookDeliveryQueue arn>` (redrive; a stale message
 *    is skipped as `already delivered` / `stale message`, so this is safe) or
 *    purge it. The alarm clears when the DLQ is empty.
 * WebhookFanoutDlqDepthAlarm is different: the outbox row was stamped
 * `dispatched_at` when it was enqueued, so the tick will NOT pick it up again.
 * After the fix, REDRIVE the fan-out DLQ (do not purge it); fan-out is
 * idempotent per (event, endpoint), so a repeat creates nothing twice.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let msg: DeliveryMessage;
    try {
      const parsed = JSON.parse(record.body) as Partial<DeliveryMessage>;
      if (typeof parsed.deliveryId !== 'string' || typeof parsed.attempt !== 'number') throw new Error('bad shape');
      msg = { deliveryId: parsed.deliveryId, attempt: parsed.attempt };
    } catch {
      console.error('webhook-deliver: malformed message dropped', { messageId: record.messageId });
      continue;
    }
    try {
      const res = await deliverOnce(msg);
      if (res.status === 'skipped') console.log('webhook-deliver: skipped', { ...msg, reason: res.reason });
    } catch (err) {
      console.error('webhook-deliver: failed', { ...msg, err });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

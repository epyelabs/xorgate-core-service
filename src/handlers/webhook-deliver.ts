import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { deliverOnce, type DeliveryMessage } from '../services/webhooks/deliver';

/**
 * WebhookDeliveryQueue consumer (batchSize 1, reportBatchItemFailures, 30 s
 * timeout): one signed POST per message (services/webhooks/deliver.ts
 * deliverOnce). The endpoint's answer, whatever it is, is a SUCCESS for SQS:
 * retries are scheduled by the delivery row (a delayed message up to 15 min,
 * the tick beyond). Only a database error fails the message.
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

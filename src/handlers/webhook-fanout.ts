import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { fanOutEvent } from '../services/webhooks/deliver';

/**
 * WebhookFanoutQueue consumer (batchSize 1, reportBatchItemFailures): one
 * outbox row -> one `webhook_deliveries` row per resolved endpoint, each
 * enqueued on WebhookDeliveryQueue. Idempotent (services/webhooks/deliver.ts
 * fanOutEvent), so SQS redelivery and the tick's re-enqueue are harmless. Zero
 * endpoints is a success (logged `unrouted`). A database error fails the
 * message; after three receives it lands in WebhookFanoutDlq (alarmed).
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let eventId: string | undefined;
    try {
      eventId = (JSON.parse(record.body) as { eventId?: string }).eventId;
    } catch {
      console.error('webhook-fanout: unparseable message dropped', { messageId: record.messageId });
      continue;
    }
    if (!eventId) {
      console.error('webhook-fanout: message without eventId dropped', { messageId: record.messageId });
      continue;
    }
    try {
      const res = await fanOutEvent(eventId);
      console.log('webhook-fanout', res);
    } catch (err) {
      console.error('webhook-fanout: failed', { eventId, err });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

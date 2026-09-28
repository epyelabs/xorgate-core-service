import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/index';
import { uuidv7 } from '../../utils/uuidv7';
import type { WebhookEventType } from './catalog';

/**
 * The outbox half of webhook delivery (README D3/D4).
 *
 * Emitters (Phases 2 and 3) call `emitWebhookEvent` with THEIR OWN `tx` (or
 * `db`) in the same statement sequence as the state change, then call
 * `dispatchWebhookEvents` with the returned ids AFTER the transaction commits.
 * The dispatch is best-effort: a Lambda that dies between the two leaves the
 * row with `dispatched_at IS NULL` and the minute tick re-enqueues it
 * (offline-sweeper). That split is what makes delivery at-least-once.
 *
 * The rollout switch (README Q15): with the `webhooks` stack flag off
 * (`WEBHOOKS_DISPATCH` != 'on'), rows are still written, so the log and a
 * later flip have them, but nothing is enqueued and the tick does not
 * re-enqueue. Read in `webhooksDispatchEnabled` only.
 */

/** Anything with drizzle's query-builder surface: `db` or a transaction's `tx`. */
export type WebhookDb = Pick<typeof db, 'insert' | 'select' | 'selectDistinct' | 'update' | 'delete' | 'execute'>;

export interface EmitWebhookEventArgs {
  organizationId: string;
  /** Null only for org-wide events (ping); every device/workflow event has one. */
  workspaceId: string | null;
  type: WebhookEventType;
  /** Unique per logical occurrence; a second emit with the same key is a no-op. */
  dedupeKey: string;
  /** The envelope's `data`; no presigned URLs (README §4). */
  data: Record<string, unknown>;
  /** Node-routed events and ping: the one endpoint. Omit to route via webhook_routes. */
  endpointId?: string | null;
}

/**
 * Insert the outbox row. Returns the new event id, or null when `dedupeKey`
 * already exists (the event was emitted before: an SQS redelivery, a retried
 * Lambda, a second close pass). Throws on any other database error so the
 * caller's transaction rolls back with its state change.
 */
export async function emitWebhookEvent(dbx: WebhookDb, args: EmitWebhookEventArgs): Promise<string | null> {
  const id = uuidv7();
  const rows = await dbx
    .insert(schema.webhookEvents)
    .values({
      id,
      organizationId: args.organizationId,
      workspaceId: args.workspaceId,
      type: args.type,
      endpointId: args.endpointId ?? null,
      dedupeKey: args.dedupeKey,
      data: args.data,
    })
    .onConflictDoNothing({ target: schema.webhookEvents.dedupeKey })
    .returning({ id: schema.webhookEvents.id });
  return rows[0]?.id ?? null;
}

/** True when this deployment enqueues deliveries (the `webhooks` stack flag). */
export function webhooksDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEBHOOKS_DISPATCH === 'on' && !!env.WEBHOOK_FANOUT_QUEUE_URL;
}

let sqsClient: SQSClient | null = null;
export function webhookSqs(): SQSClient {
  return (sqsClient ??= new SQSClient({}));
}

export interface DispatchResult {
  /** Ids now on the fan-out queue (and stamped `dispatched_at`). */
  sent: string[];
  /** Ids whose SendMessage failed; the tick retries them. */
  failed: string[];
  /** True when the `webhooks` flag is off and nothing was attempted. */
  disabled: boolean;
}

/**
 * Best-effort: SendMessage `{ eventId }` per id to the fan-out queue, then
 * stamp `dispatched_at`. Sequential awaits (the Data API forbids concurrent
 * statements on one handle). Never throws; call it after commit. Nulls in
 * `ids` (deduped emits) are skipped, so an emitter can pass its results as is.
 */
export async function dispatchWebhookEvents(
  ids: ReadonlyArray<string | null | undefined>,
  opts: { db?: WebhookDb; sqs?: Pick<SQSClient, 'send'>; env?: NodeJS.ProcessEnv } = {},
): Promise<DispatchResult> {
  const env = opts.env ?? process.env;
  const result: DispatchResult = { sent: [], failed: [], disabled: false };
  const todo = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (todo.length === 0) return result;
  if (!webhooksDispatchEnabled(env)) {
    result.disabled = true;
    return result;
  }
  const dbx = opts.db ?? db;
  const sqs = opts.sqs ?? webhookSqs();
  for (const eventId of todo) {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: env.WEBHOOK_FANOUT_QUEUE_URL,
          MessageBody: JSON.stringify({ eventId }),
        }),
      );
    } catch (err) {
      console.error('webhooks: fan-out enqueue failed; the tick will retry', { eventId, err });
      result.failed.push(eventId);
      continue;
    }
    try {
      await dbx
        .update(schema.webhookEvents)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(schema.webhookEvents.id, eventId), isNull(schema.webhookEvents.dispatchedAt)));
    } catch (err) {
      // Enqueued but not stamped: the tick may enqueue it again after 60 s,
      // which fan-out absorbs (one delivery row per event and endpoint).
      console.error('webhooks: dispatched_at stamp failed', { eventId, err });
    }
    result.sent.push(eventId);
  }
  return result;
}

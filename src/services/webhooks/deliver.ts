import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index';
import { tsParam } from '../../utils/sql';
import { PING_TYPE, WEBHOOK_API_VERSION } from './catalog';
import { dispatchWebhookEvents, webhookSqs, webhooksDispatchEnabled, type WebhookDb } from './emit';
import { resolveEndpoints } from './routing';
import { signingSecrets } from './secrets';
import { webhookHeaders, type WebhookEnvelope } from './signing';

/**
 * Fan-out, delivery and the tick's safety net (README D4).
 *
 * Attempt bookkeeping, which is what keeps a POST from happening twice:
 *
 * - A delivery-queue message is `{ deliveryId, attempt }`, meaning "make
 *   attempt `attempt + 1` if the row still has `attempt` attempts". The deliver
 *   Lambda CLAIMS by `UPDATE … SET attempt = attempt + 1 WHERE attempt = $n
 *   AND status = 'pending'`; a duplicate or stale message matches nothing.
 * - `next_attempt_at` is the due time of the next attempt, or a LEASE while
 *   one is queued or in flight. The tick re-enqueues pending rows whose value
 *   has passed (a lost message, a crashed Lambda, a retry longer than SQS's
 *   15-minute delay cap) and pushes the value out by the lease as it does, so
 *   two ticks do not enqueue the same row twice.
 */

/** Seconds after a failed attempt n (1-based) before attempt n+1; 8 attempts, ~44 h. */
export const BACKOFF_SECONDS = [0, 60, 300, 1800, 7200, 21600, 43200, 86400] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
/** SQS DelaySeconds cap; longer retries wait for the tick. */
export const MAX_QUEUE_DELAY_SECONDS = 900;
export const HTTP_TIMEOUT_MS = 10_000;
export const RESPONSE_EXCERPT_BYTES = 1024;
/** How long a queued or in-flight attempt holds the row before the tick may re-enqueue it. */
export const LEASE_SECONDS = 300;

export type AttemptOutcome =
  | { status: 'delivered' }
  | { status: 'failed'; disableEndpoint?: 'gone' }
  | { status: 'exhausted' }
  | { status: 'retry'; delaySeconds: number };

/**
 * What happens after an attempt. `attemptsMade` counts the one just made.
 * 2xx delivered; 410 fails and disables the endpoint; a ping is never retried;
 * anything else (other 4xx/5xx, 3xx since redirects are not followed, a
 * timeout or network error) retries on the backoff table until the 8th.
 */
export function nextStep(attemptsMade: number, httpStatus: number | null, eventType: string): AttemptOutcome {
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) return { status: 'delivered' };
  if (httpStatus === 410) return { status: 'failed', disableEndpoint: 'gone' };
  if (eventType === PING_TYPE) return { status: 'failed' };
  if (attemptsMade >= MAX_ATTEMPTS) return { status: 'exhausted' };
  return { status: 'retry', delaySeconds: BACKOFF_SECONDS[attemptsMade] };
}

// ---------------------------------------------------------------------------
// Queueing

export interface DeliveryMessage {
  deliveryId: string;
  /** Attempts the row had when this message was sent. */
  attempt: number;
}

/** Best-effort enqueue; false when the flag is off or SendMessage failed (the tick recovers). */
export async function enqueueDelivery(
  msg: DeliveryMessage,
  delaySeconds = 0,
  opts: { sqs?: Pick<SQSClient, 'send'>; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!webhooksDispatchEnabled(env) || !env.WEBHOOK_DELIVERY_QUEUE_URL) return false;
  try {
    await (opts.sqs ?? webhookSqs()).send(
      new SendMessageCommand({
        QueueUrl: env.WEBHOOK_DELIVERY_QUEUE_URL,
        MessageBody: JSON.stringify(msg),
        ...(delaySeconds > 0 ? { DelaySeconds: Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS) } : {}),
      }),
    );
    return true;
  } catch (err) {
    console.error('webhooks: delivery enqueue failed; the tick will retry', { ...msg, err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fan-out

export interface FanOutResult {
  eventId: string;
  found: boolean;
  endpoints: number;
  /** Delivery rows this call created (0 on a repeat fan-out of the same event). */
  created: number;
}

/**
 * One outbox row -> one delivery row per resolved endpoint, each enqueued.
 * Idempotent: the partial unique index (event_id, endpoint_id) WHERE
 * redelivery_of IS NULL makes a second fan-out of the same event create
 * nothing, so an SQS redelivery or a tick re-enqueue never double-delivers.
 */
export async function fanOutEvent(eventId: string, dbx: WebhookDb = db): Promise<FanOutResult> {
  const [event] = await dbx
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.id, eventId));
  if (!event) return { eventId, found: false, endpoints: 0, created: 0 };

  const endpointIds = await resolveEndpoints(dbx, event);
  let created = 0;
  for (const endpointId of endpointIds) {
    const res = await dbx.execute<{ id: string }>(sql`
      insert into webhook_deliveries (event_id, endpoint_id, status, attempt, next_attempt_at)
      values (${eventId}::uuid, ${endpointId}::uuid, 'pending', 0, now() + make_interval(secs => ${sql.raw(String(LEASE_SECONDS))}))
      on conflict (event_id, endpoint_id) where redelivery_of is null do nothing
      returning id
    `);
    const deliveryId = res.rows[0]?.id;
    if (!deliveryId) continue;
    created += 1;
    await enqueueDelivery({ deliveryId, attempt: 0 });
  }
  if (!event.dispatchedAt) {
    await dbx
      .update(schema.webhookEvents)
      .set({ dispatchedAt: new Date() })
      .where(and(eq(schema.webhookEvents.id, eventId), isNull(schema.webhookEvents.dispatchedAt)));
  }
  if (endpointIds.length === 0) {
    console.log('webhooks: unrouted event', { eventId, type: event.type });
  }
  return { eventId, found: true, endpoints: endpointIds.length, created };
}

// ---------------------------------------------------------------------------
// Delivery

export function envelopeOf(event: schema.WebhookEvent): WebhookEnvelope {
  return {
    id: event.id,
    type: event.type,
    apiVersion: WEBHOOK_API_VERSION,
    createdAt: new Date(event.createdAt).toISOString(),
    organizationId: event.organizationId,
    workspaceId: event.workspaceId ?? null,
    data: event.data,
  };
}

/** Read at most `limit` bytes of a response body as text, then drop the rest. */
async function readExcerpt(res: Response, limit = RESPONSE_EXCERPT_BYTES): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size === 0) return null;
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, limit).toString('utf8');
}

export interface DeliverDeps {
  db?: WebhookDb;
  fetch?: typeof fetch;
  now?: () => number;
  secrets?: typeof signingSecrets;
}

export type DeliverResult =
  | { status: 'skipped'; reason: string }
  | { status: AttemptOutcome['status']; attempt: number; httpStatus: number | null; ms: number };

/** One attempt of one delivery. Throws only on database errors (SQS then retries the message). */
export async function deliverOnce(msg: DeliveryMessage, deps: DeliverDeps = {}): Promise<DeliverResult> {
  const dbx = deps.db ?? db;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const d = schema.webhookDeliveries;

  const [delivery] = await dbx.select().from(d).where(eq(d.id, msg.deliveryId));
  if (!delivery) return { status: 'skipped', reason: 'no such delivery' };
  if (delivery.status !== 'pending') return { status: 'skipped', reason: `already ${delivery.status}` };
  if (delivery.attempt !== msg.attempt) return { status: 'skipped', reason: 'stale message' };

  const [event] = await dbx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, delivery.eventId));
  const [endpoint] = await dbx
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, delivery.endpointId));
  if (!event || !endpoint) return { status: 'skipped', reason: 'event or endpoint gone' };
  if (!endpoint.enabled) {
    await dbx
      .update(d)
      .set({ status: 'failed', error: 'endpoint disabled', nextAttemptAt: null, updatedAt: new Date(now()) })
      .where(and(eq(d.id, delivery.id), eq(d.status, 'pending')));
    return { status: 'skipped', reason: 'endpoint disabled' };
  }

  // Claim attempt n+1; the lease covers a crash mid-POST (the tick re-enqueues).
  const claimed = await dbx
    .update(d)
    .set({
      attempt: sql`${d.attempt} + 1`,
      nextAttemptAt: sql`now() + make_interval(secs => ${sql.raw(String(LEASE_SECONDS))})`,
      updatedAt: new Date(now()),
    })
    .where(and(eq(d.id, delivery.id), eq(d.status, 'pending'), eq(d.attempt, msg.attempt)))
    .returning({ attempt: d.attempt });
  if (claimed.length === 0) return { status: 'skipped', reason: 'claimed elsewhere' };
  const attempt = claimed[0].attempt;

  const envelope = envelopeOf(event);
  const body = JSON.stringify(envelope);
  const started = now();
  let httpStatus: number | null = null;
  let excerpt: string | null = null;
  let error: string | null = null;
  try {
    const secrets = await (deps.secrets ?? signingSecrets)(
      endpoint.organizationId,
      endpoint.id,
      endpoint.secretVersion,
      started,
    );
    const res = await doFetch(endpoint.url, {
      method: 'POST',
      headers: webhookHeaders({
        id: envelope.id,
        timestamp: Math.floor(started / 1000),
        body,
        type: envelope.type,
        deliveryId: delivery.id,
        secrets,
      }),
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    httpStatus = res.status;
    excerpt = await readExcerpt(res).catch(() => null);
    if (httpStatus >= 300 && httpStatus < 400) error = 'redirect not followed';
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    error =
      e.name === 'TimeoutError'
        ? `timed out after ${HTTP_TIMEOUT_MS} ms`
        : (e.cause?.code ?? e.message ?? String(err)).slice(0, 500);
  }
  const ms = now() - started;
  const outcome = nextStep(attempt, httpStatus, event.type);
  const at = new Date(now());

  await dbx
    .update(d)
    .set({
      status: outcome.status === 'retry' ? 'pending' : outcome.status,
      responseStatus: httpStatus,
      responseMs: ms,
      responseExcerpt: excerpt,
      error,
      deliveredAt: outcome.status === 'delivered' ? at : null,
      nextAttemptAt:
        outcome.status === 'retry' ? sql`now() + make_interval(secs => ${sql.raw(String(outcome.delaySeconds))})` : null,
      updatedAt: at,
    })
    .where(eq(d.id, delivery.id));

  const ep = schema.webhookEndpoints;
  if (outcome.status === 'delivered') {
    await dbx
      .update(ep)
      .set({ lastDeliveryAt: at, lastSuccessAt: at, consecutiveFailures: 0, updatedAt: at })
      .where(eq(ep.id, endpoint.id));
  } else if (outcome.status === 'exhausted') {
    await dbx
      .update(ep)
      .set({ lastDeliveryAt: at, consecutiveFailures: sql`${ep.consecutiveFailures} + 1`, updatedAt: at })
      .where(eq(ep.id, endpoint.id));
  } else if (outcome.status === 'failed' && outcome.disableEndpoint) {
    await dbx
      .update(ep)
      .set({ lastDeliveryAt: at, enabled: false, disabledAt: at, disabledReason: outcome.disableEndpoint, updatedAt: at })
      .where(eq(ep.id, endpoint.id));
  } else {
    await dbx.update(ep).set({ lastDeliveryAt: at }).where(eq(ep.id, endpoint.id));
  }

  if (outcome.status === 'retry' && outcome.delaySeconds <= MAX_QUEUE_DELAY_SECONDS) {
    await enqueueDelivery({ deliveryId: delivery.id, attempt }, outcome.delaySeconds);
  }
  console.log('webhooks: delivery attempt', {
    deliveryId: delivery.id,
    eventId: event.id,
    endpointId: endpoint.id,
    type: event.type,
    attempt,
    httpStatus,
    ms,
    outcome: outcome.status,
    ...(outcome.status === 'retry' ? { retryInSeconds: outcome.delaySeconds } : {}),
    ...(error ? { error } : {}),
  });
  return { status: outcome.status, attempt, httpStatus, ms };
}

// ---------------------------------------------------------------------------
// The minute tick (offline-sweeper): outbox safety net and retention

export const OUTBOX_GRACE_SECONDS = 60;
export const TICK_BATCH = 100;
export const RETENTION_DAYS = 30;

/** Outbox rows nobody enqueued (a crash between commit and SendMessage) -> dispatch. */
export async function redispatchStaleEvents(dbx: WebhookDb = db): Promise<{ found: number; sent: number }> {
  if (!webhooksDispatchEnabled()) return { found: 0, sent: 0 };
  const e = schema.webhookEvents;
  const rows = await dbx
    .select({ id: e.id })
    .from(e)
    .where(and(isNull(e.dispatchedAt), sql`${e.createdAt} < now() - make_interval(secs => ${sql.raw(String(OUTBOX_GRACE_SECONDS))})`))
    .orderBy(asc(e.createdAt))
    .limit(TICK_BATCH);
  if (rows.length === 0) return { found: 0, sent: 0 };
  const res = await dispatchWebhookEvents(
    rows.map((r) => r.id),
    { db: dbx },
  );
  return { found: rows.length, sent: res.sent.length };
}

/** Pending deliveries whose due time or lease has passed -> re-lease and enqueue. */
export async function requeueDueDeliveries(dbx: WebhookDb = db): Promise<{ requeued: number }> {
  if (!webhooksDispatchEnabled()) return { requeued: 0 };
  const res = await dbx.execute<{ id: string; attempt: number }>(sql`
    update webhook_deliveries
    set next_attempt_at = now() + make_interval(secs => ${sql.raw(String(LEASE_SECONDS))}), updated_at = now()
    where id in (
      select id from webhook_deliveries
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at
      limit ${sql.raw(String(TICK_BATCH))}
    )
    returning id, attempt
  `);
  let requeued = 0;
  for (const row of res.rows) {
    if (await enqueueDelivery({ deliveryId: row.id, attempt: Number(row.attempt) })) requeued += 1;
  }
  return { requeued };
}

/** Delete deliveries, then events, older than the retention window. */
export async function expireWebhookHistory(dbx: WebhookDb = db): Promise<{ deliveries: number; events: number }> {
  const cutoff = tsParam(new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString());
  const deliveries = await dbx
    .delete(schema.webhookDeliveries)
    .where(sql`${schema.webhookDeliveries.createdAt} < ${cutoff}`)
    .returning({ id: schema.webhookDeliveries.id });
  const events = await dbx
    .delete(schema.webhookEvents)
    .where(sql`${schema.webhookEvents.createdAt} < ${cutoff}`)
    .returning({ id: schema.webhookEvents.id });
  return { deliveries: deliveries.length, events: events.length };
}

import { createHmac, randomBytes } from 'node:crypto';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com/, README D5).
 *
 *   webhook-id         the event id (the outbox row's uuidv7)
 *   webhook-timestamp  unix seconds at send time
 *   webhook-signature  "v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>",
 *                      one per valid secret, space-separated (two during the
 *                      24 h rotation window)
 *
 * A secret is `whsec_` + STANDARD base64 of 32 random bytes; the HMAC key is
 * the decoded bytes. Standard base64, not base64url: off-the-shelf verifiers
 * (the `standardwebhooks` npm package among them) decode it that way and reject
 * `-`/`_`.
 *
 * This must stay byte-for-byte identical to the engine's local sink
 * (`@xorgate/workflow-engine/local` signWebhookPayload, 0.5.0) so one receiver
 * verifies both; test/webhooks-signing.test.ts pins the shared vector.
 */

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_USER_AGENT = 'xorgate-webhooks/1';

/** A new signing secret. Shown to the caller once; stored only in Secrets Manager. */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString('base64');
}

/** The HMAC key of a `whsec_` secret. Throws without quoting the value. */
export function webhookSecretKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new Error(`webhook secret must be ${WEBHOOK_SECRET_PREFIX}<base64>`);
  }
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (key.length < 16) throw new Error('webhook secret key is shorter than 16 bytes');
  return key;
}

/** The `webhook-signature` header value for one or more secrets (current first). */
export function signWebhookPayload(args: {
  id: string;
  timestamp: number;
  body: string;
  secrets: readonly string[];
}): string {
  const content = `${args.id}.${args.timestamp}.${args.body}`;
  return args.secrets
    .map((s) => `v1,${createHmac('sha256', webhookSecretKey(s)).update(content).digest('base64')}`)
    .join(' ');
}

/** Every header a delivery carries. */
export function webhookHeaders(args: {
  id: string;
  timestamp: number;
  body: string;
  type: string;
  deliveryId: string;
  secrets: readonly string[];
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': WEBHOOK_USER_AGENT,
    'webhook-id': args.id,
    'webhook-timestamp': String(args.timestamp),
    'webhook-signature': signWebhookPayload(args),
    'x-xorgate-event': args.type,
    'x-xorgate-delivery': args.deliveryId,
  };
}

/** The JSON envelope every delivery POSTs (README §4). */
export interface WebhookEnvelope {
  id: string;
  type: string;
  apiVersion: string;
  createdAt: string;
  organizationId: string;
  workspaceId: string | null;
  data: Record<string, unknown>;
}

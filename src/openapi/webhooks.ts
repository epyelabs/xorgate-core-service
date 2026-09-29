import {
  DEVICE_ROUTABLE_TYPES,
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_EVENT_TYPES,
} from '../services/webhooks/catalog';

/**
 * Webhooks (plans/xorgate-webhooks, Phase 1): the endpoint registry, its
 * delivery log, the event catalog, a device's routes, and (as `x-webhooks`)
 * the payload of every event type. Hand-written against handlers/webhooks.ts
 * and handlers/device-webhooks.ts.
 *
 * The document is OpenAPI 3.0.3, which has no `webhooks` section (3.1 added
 * it), so the per-event payloads live under the `x-webhooks` extension, the
 * shape Redoc renders for 3.0. Phase 4 teaches the docs site to read it.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const r = (name: string) => ({ $ref: `#/components/responses/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });

const endpointIdParams = [
  { $ref: '#/components/parameters/IdPath' },
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];
const deliveryIdParam = {
  name: 'deliveryId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'A delivery of this endpoint.',
};

const readErrors = {
  '401': r('Unauthorized'),
  '403': r('Forbidden'),
  '404': r('NotFound'),
};
const writeErrors = { '400': r('BadRequest'), ...readErrors };

const webhookEnvelopeWrap = (props: Record<string, unknown>) => ({
  type: 'object',
  required: Object.keys(props),
  properties: props,
});

export const webhooksPaths = {
  '/webhooks': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listWebhooks',
      summary: 'List webhook endpoints',
      description:
        'The organization\'s endpoint registry, paginated with the shared list dialect, newest ' +
        'first by default. Any role may read. A workspace-scoped session token is refused ' +
        '(`403 WORKSPACE_SCOPED`): endpoints are organization resources.',
      tags: ['Webhooks'],
      parameters: [
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['createdAt', 'name'], default: 'createdAt' },
        },
      ],
      responses: {
        '200': {
          description: 'Endpoints. The signing secret is never included.',
          content: json(
            webhookEnvelopeWrap({
              webhooks: { type: 'array', items: ref('WebhookEndpoint') },
              page: ref('PageMeta'),
            }),
          ),
        },
        '401': r('Unauthorized'),
        '403': r('Forbidden'),
      },
    },
    post: {
      operationId: 'createWebhook',
      summary: 'Register a webhook endpoint (owner/admin only)',
      description:
        'Creates an endpoint and its signing secret, returned exactly once as `secret` ' +
        '(`whsec_` + base64 of 32 random bytes, the Standard Webhooks format). Deliveries carry ' +
        '`webhook-id`, `webhook-timestamp` and `webhook-signature` headers; verify them with any ' +
        'Standard Webhooks library.\n\n' +
        '`name` is the handle a workflow template\'s `output.event` node references in its ' +
        '`webhook` field; it is unique within the organization. `url` must be `https://`, ' +
        'carry no credentials, and not be `localhost` or a literal private, loopback or ' +
        'link-local address. Redirects are never followed.\n\n' +
        'An endpoint receives nothing until something routes to it: a device route ' +
        '(`PUT /devices/{id}/webhooks`) or a workflow node naming it. `POST /webhooks/{id}/test` ' +
        'sends a `ping`.',
      tags: ['Webhooks'],
      requestBody: {
        required: true,
        content: json({
          type: 'object',
          required: ['name', 'url'],
          properties: {
            name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', example: 'dispatch' },
            url: { type: 'string', format: 'uri', example: 'https://example.com/hooks/xorgate' },
            description: { type: 'string', nullable: true, maxLength: 500 },
          },
        }),
      },
      responses: {
        '201': {
          description: 'Created. Save `secret`: it is not retrievable later, only rotatable.',
          content: json(
            webhookEnvelopeWrap({
              webhook: ref('WebhookEndpoint'),
              secret: { type: 'string', example: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' },
            }),
          ),
        },
        '400': r('BadRequest'),
        '401': r('Unauthorized'),
        '403': r('Forbidden'),
        '409': r('Conflict'),
      },
    },
  },
  '/webhooks/{id}': {
    parameters: endpointIdParams,
    get: {
      operationId: 'getWebhook',
      summary: 'Get a webhook endpoint',
      description: 'The endpoint plus `deliveryStats`: delivery counts by status over the last 24 hours.',
      tags: ['Webhooks'],
      responses: {
        '200': {
          description: 'The endpoint.',
          content: json(
            webhookEnvelopeWrap({
              webhook: {
                allOf: [
                  ref('WebhookEndpoint'),
                  {
                    type: 'object',
                    properties: {
                      deliveryStats: {
                        type: 'object',
                        properties: {
                          windowHours: { type: 'integer', example: 24 },
                          pending: { type: 'integer' },
                          delivered: { type: 'integer' },
                          failed: { type: 'integer' },
                          exhausted: { type: 'integer' },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          ),
        },
        ...readErrors,
      },
    },
    patch: {
      operationId: 'updateWebhook',
      summary: 'Update a webhook endpoint (owner/admin only)',
      description:
        'Any of `name`, `url`, `description`, `enabled`. Disabling records `disabledAt` and ' +
        '`disabledReason: "manual"`; re-enabling clears them and resets `consecutiveFailures`. ' +
        'An endpoint that answered `410 Gone` is disabled automatically (`disabledReason: "gone"`), and so is ' +
        'one with 5 exhausted deliveries in a row whose oldest exhaustion is at least 24 h old ' +
        '(`disabledReason: "failing"`; the org owners are emailed).',
      tags: ['Webhooks'],
      requestBody: {
        required: true,
        content: json({
          type: 'object',
          properties: {
            name: { type: 'string' },
            url: { type: 'string', format: 'uri' },
            description: { type: 'string', nullable: true },
            enabled: { type: 'boolean' },
          },
        }),
      },
      responses: {
        '200': { description: 'Updated.', content: json(webhookEnvelopeWrap({ webhook: ref('WebhookEndpoint') })) },
        ...writeErrors,
        '409': r('Conflict'),
      },
    },
    delete: {
      operationId: 'deleteWebhook',
      summary: 'Delete a webhook endpoint (owner/admin only)',
      description:
        'Deletes the endpoint, its device routes, its delivery log and its signing secret. Past ' +
        'events stay in the organization\'s event history.',
      tags: ['Webhooks'],
      responses: { '204': r('NoContent'), ...readErrors },
    },
  },
  '/webhooks/{id}/test': {
    parameters: endpointIdParams,
    post: {
      operationId: 'testWebhook',
      summary: 'Send a ping (owner/admin only)',
      description:
        'Emits a `ping` event to this endpoint only. One attempt, never retried; the result ' +
        'appears in `GET /webhooks/{id}/deliveries` within seconds. `dispatched: false` means ' +
        'the event was recorded but webhook delivery is switched off for this deployment.',
      tags: ['Webhooks'],
      responses: {
        '202': {
          description: 'Queued.',
          content: json(
            webhookEnvelopeWrap({
              eventId: { type: 'string', format: 'uuid' },
              dispatched: { type: 'boolean' },
            }),
          ),
        },
        ...readErrors,
        '409': r('Conflict'),
      },
    },
  },
  '/webhooks/{id}/rotate-secret': {
    parameters: endpointIdParams,
    post: {
      operationId: 'rotateWebhookSecret',
      summary: 'Rotate the signing secret (owner/admin only)',
      description:
        'Returns a new `secret` exactly once. For 24 hours deliveries carry TWO `v1,` signatures ' +
        '(new and previous), which Standard Webhooks verifiers accept, so the receiver can switch ' +
        'at its own pace.',
      tags: ['Webhooks'],
      responses: {
        '200': {
          description: 'Rotated.',
          content: json(
            webhookEnvelopeWrap({
              webhook: ref('WebhookEndpoint'),
              secret: { type: 'string' },
              previousSecretValidForHours: { type: 'integer', example: 24 },
            }),
          ),
        },
        ...readErrors,
      },
    },
  },
  '/webhooks/{id}/deliveries': {
    parameters: endpointIdParams,
    get: {
      operationId: 'listWebhookDeliveries',
      summary: 'List deliveries to an endpoint',
      description:
        'The delivery log, newest first by default, paginated with the shared list dialect. Kept ' +
        'for 30 days. `status`: `pending` (queued or waiting to retry), `delivered` (2xx), ' +
        '`failed` (a ping that failed, a 410, or a disabled endpoint), `exhausted` (8 attempts ' +
        'over about 44 hours, all failed).',
      tags: ['Webhooks'],
      parameters: [
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['pending', 'delivered', 'failed', 'exhausted'] },
        },
      ],
      responses: {
        '200': {
          description: 'Deliveries.',
          content: json(
            webhookEnvelopeWrap({
              deliveries: { type: 'array', items: ref('WebhookDelivery') },
              page: ref('PageMeta'),
            }),
          ),
        },
        ...writeErrors,
      },
    },
  },
  '/webhooks/{id}/deliveries/{deliveryId}': {
    parameters: [...endpointIdParams, deliveryIdParam],
    get: {
      operationId: 'getWebhookDelivery',
      summary: 'Get one delivery',
      description: 'The delivery with the first 1 KB of the response body and the event envelope that was sent.',
      tags: ['Webhooks'],
      responses: {
        '200': {
          description: 'The delivery.',
          content: json(
            webhookEnvelopeWrap({
              delivery: {
                allOf: [
                  ref('WebhookDelivery'),
                  {
                    type: 'object',
                    properties: {
                      responseExcerpt: { type: 'string', nullable: true },
                      event: { allOf: [ref('WebhookEventEnvelope')], nullable: true },
                    },
                  },
                ],
              },
            }),
          ),
        },
        ...readErrors,
      },
    },
  },
  '/webhooks/{id}/deliveries/{deliveryId}/redeliver': {
    parameters: [...endpointIdParams, deliveryIdParam],
    post: {
      operationId: 'redeliverWebhook',
      summary: 'Redeliver an event (owner/admin only)',
      description:
        'Queues a NEW delivery of the same event (same `webhook-id`, so a receiver that dedupes ' +
        'on it will treat it as a repeat) with a fresh retry schedule. `redeliveryOf` points at ' +
        'the original.',
      tags: ['Webhooks'],
      responses: {
        '202': {
          description: 'Queued.',
          content: json(webhookEnvelopeWrap({ delivery: ref('WebhookDelivery'), enqueued: { type: 'boolean' } })),
        },
        ...readErrors,
        '409': r('Conflict'),
      },
    },
  },
  '/webhook-event-types': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'listWebhookEventTypes',
      summary: 'List webhook event types',
      description:
        'Every event type with how it is routed and a sample `data`. `device` types are routed ' +
        'per device (`PUT /devices/{id}/webhooks`); `workflow.event` by the emitting node\'s ' +
        '`webhook` field; `ping` by `POST /webhooks/{id}/test`.',
      tags: ['Webhooks'],
      responses: {
        '200': {
          description: 'The catalog.',
          content: json(
            webhookEnvelopeWrap({
              apiVersion: { type: 'string', example: WEBHOOK_API_VERSION },
              eventTypes: { type: 'array', items: ref('WebhookEventTypeInfo') },
            }),
          ),
        },
        '401': r('Unauthorized'),
        '403': r('Forbidden'),
      },
    },
  },
};

export const deviceWebhooksPaths = {
  '/devices/{id}/webhooks': {
    parameters: endpointIdParams,
    get: {
      operationId: 'getDeviceWebhooks',
      summary: "Get a device's webhook routes",
      description:
        'Which endpoints receive which of this device\'s presence and session events. ' +
        'owner/admin/member. A workspace-scoped session token may read its own workspace\'s devices.',
      tags: ['Webhooks'],
      responses: {
        '200': {
          description: 'The routes.',
          content: json(webhookEnvelopeWrap({ routes: { type: 'array', items: ref('DeviceWebhookRoute') } })),
        },
        ...readErrors,
      },
    },
    put: {
      operationId: 'setDeviceWebhooks',
      summary: "Replace a device's webhook routes (owner/admin only)",
      description:
        'The body is the complete set; `{"routes": []}` removes every route. Each endpoint may ' +
        'appear once, with a non-empty subset of the device event types. Endpoints must belong ' +
        'to the organization. Adding a route applies to events from then on (no backfill). A ' +
        'workspace-scoped session token may manage its own workspace\'s devices, which is how an ' +
        'integration wires a device at pairing time.',
      tags: ['Webhooks'],
      requestBody: {
        required: true,
        content: json({
          type: 'object',
          required: ['routes'],
          properties: {
            routes: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['endpointId', 'eventTypes'],
                properties: {
                  endpointId: { type: 'string', format: 'uuid' },
                  eventTypes: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string', enum: [...DEVICE_ROUTABLE_TYPES] },
                  },
                },
              },
            },
          },
        }),
      },
      responses: {
        '200': {
          description: 'The new set.',
          content: json(webhookEnvelopeWrap({ routes: { type: 'array', items: ref('DeviceWebhookRoute') } })),
        },
        ...writeErrors,
      },
    },
  },
};

export const webhookSchemas: Record<string, unknown> = {
  WebhookEndpoint: {
    type: 'object',
    required: ['id', 'organizationId', 'name', 'url', 'enabled', 'secretVersion', 'createdAt'],
    description: 'A registered receiver. The signing secret is never part of it.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      organizationId: { type: 'string', format: 'uuid' },
      name: { type: 'string', example: 'dispatch' },
      url: { type: 'string', format: 'uri' },
      description: { type: 'string', nullable: true },
      secretVersion: { type: 'integer', description: 'Bumped by each rotation.' },
      enabled: { type: 'boolean' },
      disabledAt: { type: 'string', format: 'date-time', nullable: true },
      disabledReason: {
        type: 'string',
        nullable: true,
        example: 'manual',
        description: '`manual` (PATCH), `gone` (the endpoint answered 410) or `failing` (auto-disabled after repeated exhausted deliveries).',
      },
      consecutiveFailures: { type: 'integer', description: 'Exhausted deliveries in a row.' },
      lastDeliveryAt: { type: 'string', format: 'date-time', nullable: true },
      lastSuccessAt: { type: 'string', format: 'date-time', nullable: true },
      createdBy: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WebhookDelivery: {
    type: 'object',
    required: ['id', 'eventId', 'endpointId', 'status', 'attempt', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Also sent as `x-xorgate-delivery`.' },
      eventId: { type: 'string', format: 'uuid', description: 'The envelope `id` and `webhook-id`.' },
      eventType: { type: 'string', enum: [...WEBHOOK_EVENT_TYPES] },
      endpointId: { type: 'string', format: 'uuid' },
      redeliveryOf: { type: 'string', format: 'uuid', nullable: true },
      status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'exhausted'] },
      attempt: { type: 'integer', description: 'Attempts made so far (at most 8).' },
      nextAttemptAt: { type: 'string', format: 'date-time', nullable: true },
      responseStatus: { type: 'integer', nullable: true },
      responseMs: { type: 'integer', nullable: true },
      error: { type: 'string', nullable: true, description: 'Timeout, network error or "redirect not followed".' },
      deliveredAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WebhookEventEnvelope: {
    type: 'object',
    required: ['id', 'type', 'apiVersion', 'createdAt', 'organizationId', 'workspaceId', 'data'],
    description:
      'The JSON body of every delivery. Dedupe on `id` (also the `webhook-id` header): delivery ' +
      'is at-least-once. `createdAt` is when xorgate detected the event (server clock).',
    properties: {
      id: { type: 'string', format: 'uuid' },
      type: { type: 'string', enum: [...WEBHOOK_EVENT_TYPES] },
      apiVersion: { type: 'string', example: WEBHOOK_API_VERSION },
      createdAt: { type: 'string', format: 'date-time' },
      organizationId: { type: 'string', format: 'uuid' },
      workspaceId: { type: 'string', format: 'uuid', nullable: true },
      data: { type: 'object', additionalProperties: true },
    },
  },
  WebhookEventTypeInfo: {
    type: 'object',
    required: ['type', 'routing', 'description', 'sample'],
    properties: {
      type: { type: 'string', enum: [...WEBHOOK_EVENT_TYPES] },
      routing: { type: 'string', enum: ['device', 'node', 'endpoint'] },
      description: { type: 'string' },
      sample: { type: 'object', additionalProperties: true },
    },
  },
  DeviceWebhookRoute: {
    type: 'object',
    required: ['endpointId', 'endpointName', 'eventTypes'],
    properties: {
      endpointId: { type: 'string', format: 'uuid' },
      endpointName: { type: 'string' },
      eventTypes: { type: 'array', items: { type: 'string', enum: [...DEVICE_ROUTABLE_TYPES] } },
    },
  },
};

/**
 * `x-webhooks`: one POST per event type, the request body being the envelope
 * with that type's sample `data`. What a receiver implements.
 */
export function webhookEventsSection(): Record<string, unknown> {
  return Object.fromEntries(
    WEBHOOK_EVENT_CATALOG.map((info) => [
      info.type,
      {
        post: {
          operationId: `webhook_${info.type.replace(/[^a-z0-9]/gi, '_')}`,
          summary: info.type,
          description:
            `${info.description}\n\nHeaders: \`webhook-id\` (the envelope id), \`webhook-timestamp\` ` +
            '(unix seconds), `webhook-signature` (`v1,<base64 HMAC-SHA256>`, space-separated when ' +
            'two secrets are valid), `x-xorgate-event`, `x-xorgate-delivery`. Answer 2xx within ' +
            '10 seconds; anything else is retried (a `ping` is not), and `410` disables the endpoint.',
          tags: ['Webhooks'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookEventEnvelope' },
                example: {
                  id: '0192f0a4-5555-7000-8000-000000000006',
                  type: info.type,
                  apiVersion: WEBHOOK_API_VERSION,
                  createdAt: '2026-09-27T14:03:11.412Z',
                  organizationId: '0192f0a4-6666-7000-8000-000000000007',
                  workspaceId: info.type === 'ping' ? null : '0192f0a4-7777-7000-8000-000000000008',
                  data: info.sample,
                },
              },
            },
          },
          responses: { '2XX': { description: 'Received. Any 2xx counts as delivered.' } },
        },
      },
    ]),
  );
}

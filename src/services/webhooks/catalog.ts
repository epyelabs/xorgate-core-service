/**
 * The v1 webhook event catalog (plans/xorgate-webhooks README §4).
 *
 * Two routing kinds (README D1):
 * - DEVICE-ROUTABLE: presence and session events, routed per device through
 *   `webhook_routes` (the device Settings -> Webhooks sub-tab, or
 *   `PUT /devices/{id}/webhooks`).
 * - NODE-ROUTED: `workflow.event`, routed by the emitting output.event node's
 *   `webhook` name, resolved to an endpoint at finalize.
 * Plus `ping`, which goes to the one endpoint it was sent to.
 *
 * `workflow_run.completed` is parked (README Q11). One sample `data` per type
 * backs `GET /webhook-event-types` and the Phase 4 docs.
 */

/** The envelope's `apiVersion`; `data` shapes are versioned through it. */
export const WEBHOOK_API_VERSION = '2026-09-27';

export const DEVICE_ROUTABLE_TYPES = [
  'device.online',
  'device.offline',
  'media_session.started',
  'media_session.ended',
  'telemetry_session.started',
  'telemetry_session.ended',
  'telemetry_session.completed',
] as const;
export type DeviceRoutableType = (typeof DEVICE_ROUTABLE_TYPES)[number];

export const NODE_ROUTED_TYPES = ['workflow.event'] as const;
export type NodeRoutedType = (typeof NODE_ROUTED_TYPES)[number];

export const PING_TYPE = 'ping' as const;

export type WebhookEventType = DeviceRoutableType | NodeRoutedType | typeof PING_TYPE;

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  ...DEVICE_ROUTABLE_TYPES,
  ...NODE_ROUTED_TYPES,
  PING_TYPE,
];

export function isDeviceRoutableType(t: unknown): t is DeviceRoutableType {
  return typeof t === 'string' && (DEVICE_ROUTABLE_TYPES as readonly string[]).includes(t);
}

export function isWebhookEventType(t: unknown): t is WebhookEventType {
  return typeof t === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(t);
}

export interface WebhookEventTypeInfo {
  type: WebhookEventType;
  routing: 'device' | 'node' | 'endpoint';
  description: string;
  sample: Record<string, unknown>;
}

const DEVICE = '0192f0a4-0000-7000-8000-000000000001';
const SESSION = '0192f0a4-1111-7000-8000-000000000002';

const deviceSample = (extra: Record<string, unknown>): Record<string, unknown> => ({
  deviceId: DEVICE,
  serial: '10954137370d4c73988b65d994e76a19',
  name: 'Truck 01',
  lastSeenAt: '2026-09-27T14:03:10.100Z',
  ...extra,
});

const endedSample = {
  sessionId: SESSION,
  deviceId: DEVICE,
  startedAt: '2026-09-27T13:10:00.000Z',
  endedAt: '2026-09-27T13:52:00.000Z',
  lastSegmentAt: '2026-09-27T13:52:31.000Z',
  segmentCount: 42,
  reopened: false,
};

export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventTypeInfo[] = [
  {
    type: 'device.online',
    routing: 'device',
    description: 'The device came online (connect message or first telemetry after being offline).',
    sample: deviceSample({ status: 'online', previousStatus: 'offline', source: 'connect' }),
  },
  {
    type: 'device.offline',
    routing: 'device',
    description:
      'The device went offline: graceful disconnect, MQTT last-will, or the stale-telemetry sweeper.',
    sample: deviceSample({ status: 'offline', previousStatus: 'online', source: 'lwt' }),
  },
  {
    type: 'media_session.started',
    routing: 'device',
    description:
      'The first segment of a new media session was ingested ("first data arrived", not "recording began").',
    sample: {
      sessionId: SESSION,
      deviceId: DEVICE,
      streamKey: 'cam0',
      startedAt: '2026-09-27T13:10:00.000Z',
      timeSource: 'gps',
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
      firstSeq: 0,
    },
  },
  {
    type: 'media_session.ended',
    routing: 'device',
    description:
      'No segment arrived for the close window (10 min). A straggler segment reopens the session and it ends again later.',
    sample: { ...endedSample, streamKey: 'cam0', totalBytes: 251658240, totalDurationMs: 2520000 },
  },
  {
    type: 'telemetry_session.started',
    routing: 'device',
    description: 'The first segment of a new telemetry session was ingested.',
    sample: {
      sessionId: SESSION,
      deviceId: DEVICE,
      startedAt: '2026-09-27T13:10:00.000Z',
      rateHz: 1,
      timeSource: 'gps',
    },
  },
  {
    type: 'telemetry_session.ended',
    routing: 'device',
    description: 'The telemetry session closed; its overview and insights may not be built yet.',
    sample: { ...endedSample, sampleCount: 2520, byteCount: 409600 },
  },
  {
    type: 'telemetry_session.completed',
    routing: 'device',
    description:
      'The closed telemetry session has its overview artifact and insights. The event most consumers want.',
    sample: {
      ...endedSample,
      sampleCount: 2520,
      byteCount: 409600,
      distanceM: 38210,
      durationMs: 2520000,
      maxSpeedKph: 104.2,
      insights: {},
      overview: { apiPath: `/v1/devices/${DEVICE}/telemetry/sessions/${SESSION}` },
    },
  },
  {
    type: 'workflow.event',
    routing: 'node',
    description:
      "An output.event node whose `webhook` names this endpoint fired, in a production run. Delivered once the run ends. `payload` is producer-defined and not a stable shape.",
    sample: {
      eventId: '0192f0a4-2222-7000-8000-000000000003',
      nodeId: 'n4',
      kind: 'harsh_brake',
      occurredAt: '2026-09-27T13:31:12.000Z',
      confidence: 1,
      payloadSummary: 'harsh_brake · observed 0.62',
      payload: { signal: 'accel.x', observed: 0.62, operator: 'gt', threshold: 0.5 },
      run: {
        id: '0192f0a4-3333-7000-8000-000000000004',
        templateId: '0192f0a4-4444-7000-8000-000000000005',
        templateVersion: 3,
        trigger: 'event',
        triggerContext: null,
        deviceId: DEVICE,
      },
    },
  },
  {
    type: 'ping',
    routing: 'endpoint',
    description: 'Sent by POST /webhooks/{id}/test. One attempt, never retried.',
    sample: { message: 'Test ping from xorgate' },
  },
];

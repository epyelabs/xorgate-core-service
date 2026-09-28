import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { Webhook } from 'standardwebhooks';

// The service modules import the real db (Data API client); these tests hand
// them a pg-proxy drizzle instead, so the module only needs to load.
vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  return { db: {}, schema };
});

import * as schema from '../src/db/schema';
import {
  generateWebhookSecret,
  signWebhookPayload,
  webhookHeaders,
  webhookSecretKey,
} from '../src/services/webhooks/signing';
import { endpointUrlProblem } from '../src/services/webhooks/url-policy';
import { BACKOFF_SECONDS, MAX_ATTEMPTS, nextStep } from '../src/services/webhooks/deliver';
import { dispatchWebhookEvents, emitWebhookEvent, type WebhookDb } from '../src/services/webhooks/emit';
import { resolveEndpoints } from '../src/services/webhooks/routing';
import { activeSecrets } from '../src/services/webhooks/secrets';
import { DEVICE_ROUTABLE_TYPES, WEBHOOK_EVENT_CATALOG, WEBHOOK_EVENT_TYPES } from '../src/services/webhooks/catalog';
import { uuidv7 } from '../src/utils/uuidv7';

/** A drizzle db over a fake driver: records each statement, answers from a queue. */
function proxyDb(answers: unknown[][][] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const dbx = drizzle(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: (answers.shift() ?? []) as unknown[] };
  }, { schema });
  return { db: dbx as unknown as WebhookDb, calls };
}

describe('webhook signing (Standard Webhooks)', () => {
  // The SAME vector the engine pins (engines/xorgate-workflow-engine
  // scripts/smoke.mjs §2c), computed independently with standardwebhooks@1
  // Webhook#sign. Engine 0.5.0's local sink and core's signing.ts must agree.
  const V = {
    secret: 'whsec_eG9yZ2F0ZS13ZWJob29rcy1zaGFyZWQtdmVjdG9yLTMyYg==',
    id: '01928f3e-5c2a-7b4d-8e9f-0a1b2c3d4e5f',
    ts: 1790000000,
    body: '{"id":"01928f3e-5c2a-7b4d-8e9f-0a1b2c3d4e5f","type":"ping","apiVersion":"2026-09-27","data":{"message":"hello"}}',
    sig: 'v1,eunRXoEGTAdBvdruPkA9OUvMYGdgpA+cG8cpxQnFfVM=',
  };

  it('matches the vector shared with the engine', () => {
    expect(signWebhookPayload({ id: V.id, timestamp: V.ts, body: V.body, secrets: [V.secret] })).toBe(V.sig);
    expect(new Webhook(V.secret).sign(V.id, new Date(V.ts * 1000), V.body)).toBe(V.sig);
  });

  it('produces headers the standardwebhooks verifier accepts', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const id = uuidv7();
    const body = JSON.stringify({ id, type: 'ping', data: { message: 'hi' } });
    const headers = webhookHeaders({
      id,
      timestamp: Math.floor(Date.now() / 1000),
      body,
      type: 'ping',
      deliveryId: 'd-1',
      secrets: [secret],
    });
    expect(headers['x-xorgate-event']).toBe('ping');
    expect(headers['x-xorgate-delivery']).toBe('d-1');
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
    expect(() => new Webhook(generateWebhookSecret()).verify(body, headers)).toThrow();
  });

  it('signs with both secrets during a rotation, and either verifies', () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const now = Date.parse('2026-09-28T12:00:00Z');
    const active = activeSecrets(
      { current: newSecret, previous: oldSecret, previousExpiresAt: '2026-09-29T11:00:00Z' },
      now,
    );
    expect(active).toEqual([newSecret, oldSecret]);
    const body = '{"x":1}';
    const headers = webhookHeaders({ id: 'evt', timestamp: Math.floor(Date.now() / 1000), body, type: 'ping', deliveryId: 'd', secrets: active });
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(() => new Webhook(oldSecret).verify(body, headers)).not.toThrow();
    expect(() => new Webhook(newSecret).verify(body, headers)).not.toThrow();
    // After the window only the current one signs.
    expect(activeSecrets({ current: newSecret, previous: oldSecret, previousExpiresAt: '2026-09-28T11:00:00Z' }, now)).toEqual([newSecret]);
  });

  it('refuses a secret that is not whsec_<base64> without quoting it', () => {
    expect(() => webhookSecretKey('plain-LEAKME')).toThrow(/whsec_/);
    try {
      webhookSecretKey('plain-LEAKME');
    } catch (e) {
      expect(String(e)).not.toContain('LEAKME');
    }
  });
});

describe('endpoint URL policy', () => {
  it.each([
    ['https://example.com/hooks', null],
    ['https://hooks.example.com:8443/x?y=1', null],
    ['https://8.8.8.8/x', null],
    ['http://example.com/hooks', 'url must use https://'],
    ['https://10.0.0.5/', 'private'],
    ['https://172.16.3.4/', 'private'],
    ['https://192.168.1.1/', 'private'],
    ['https://127.0.0.1/', 'private'],
    ['https://169.254.169.254/latest/meta-data', 'private'],
    ['https://100.64.0.1/', 'private'],
    ['https://0.0.0.0/', 'private'],
    ['https://[::1]/', 'private'],
    ['https://[fd00::1]/', 'private'],
    ['https://[fe80::1]/', 'private'],
    ['https://[::ffff:10.0.0.1]/', 'private'],
    ['https://localhost/', 'localhost'],
    ['https://api.localhost/', 'localhost'],
    ['https://user:pass@example.com/', 'credentials'],
    ['ftp://example.com/', 'https'],
    ['not a url', 'not a valid URL'],
    ['', 'required'],
  ])('%s', (url, expected) => {
    const problem = endpointUrlProblem(url);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toContain(expected);
  });
});

describe('retry schedule', () => {
  it('is 8 attempts at 0, 1m, 5m, 30m, 2h, 6h, 12h, 24h', () => {
    expect(BACKOFF_SECONDS).toEqual([0, 60, 300, 1800, 7200, 21600, 43200, 86400]);
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it('delivers on 2xx, retries on the table, exhausts after the 8th', () => {
    expect(nextStep(1, 204, 'device.online')).toEqual({ status: 'delivered' });
    expect(nextStep(3, 200, 'device.online')).toEqual({ status: 'delivered' });
    expect(nextStep(1, 500, 'device.online')).toEqual({ status: 'retry', delaySeconds: 60 });
    expect(nextStep(2, null, 'device.online')).toEqual({ status: 'retry', delaySeconds: 300 });
    expect(nextStep(4, 404, 'workflow.event')).toEqual({ status: 'retry', delaySeconds: 7200 });
    expect(nextStep(7, 302, 'device.online')).toEqual({ status: 'retry', delaySeconds: 86400 });
    expect(nextStep(8, 500, 'device.online')).toEqual({ status: 'exhausted' });
  });

  it('fails a 410 and disables the endpoint; never retries a ping', () => {
    expect(nextStep(1, 410, 'device.online')).toEqual({ status: 'failed', disableEndpoint: 'gone' });
    expect(nextStep(1, 500, 'ping')).toEqual({ status: 'failed' });
    expect(nextStep(1, null, 'ping')).toEqual({ status: 'failed' });
    expect(nextStep(1, 204, 'ping')).toEqual({ status: 'delivered' });
  });
});

describe('emitWebhookEvent', () => {
  const args = {
    organizationId: '0192f0a4-6666-7000-8000-000000000007',
    workspaceId: null,
    type: 'ping' as const,
    dedupeKey: 'ping:e:1',
    data: { message: 'hi' },
  };

  it('inserts with ON CONFLICT (dedupe_key) DO NOTHING and returns the uuidv7 id', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    // The fake echoes the id it was given back as the RETURNING row.
    const echo = drizzle(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [[params[0]]] };
    }, { schema }) as unknown as WebhookDb;
    const id = await emitWebhookEvent(echo, args);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls[0].sql).toMatch(/insert into "webhook_events"/);
    expect(calls[0].sql).toMatch(/on conflict \("dedupe_key"\) do nothing/);
    expect(calls[0].sql).toMatch(/returning "id"/);
    expect(calls[0].params).toContain('ping:e:1');
  });

  it('returns null when the dedupe key already exists (no row returned)', async () => {
    const { db } = proxyDb([[]]);
    expect(await emitWebhookEvent(db, args)).toBeNull();
  });
});

describe('dispatchWebhookEvents', () => {
  it('is a no-op with the webhooks flag off, and skips nulls', async () => {
    const send = vi.fn();
    const res = await dispatchWebhookEvents(['a', null], {
      sqs: { send } as never,
      env: { WEBHOOKS_DISPATCH: 'off', WEBHOOK_FANOUT_QUEUE_URL: 'https://sqs/q' },
    });
    expect(res).toEqual({ sent: [], failed: [], disabled: true });
    expect(send).not.toHaveBeenCalled();
    expect(await dispatchWebhookEvents([null, undefined], { env: {} })).toEqual({ sent: [], failed: [], disabled: false });
  });

  it('enqueues {eventId} and stamps dispatched_at when on; a failed send is reported, not thrown', async () => {
    const { db, calls } = proxyDb();
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom'));
    const res = await dispatchWebhookEvents(['e1', 'e2'], {
      db,
      sqs: { send } as never,
      env: { WEBHOOKS_DISPATCH: 'on', WEBHOOK_FANOUT_QUEUE_URL: 'https://sqs/q' },
    });
    expect(res).toEqual({ sent: ['e1'], failed: ['e2'], disabled: false });
    expect(JSON.parse(send.mock.calls[0][0].input.MessageBody)).toEqual({ eventId: 'e1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/update "webhook_events" set "dispatched_at"/);
    expect(calls[0].sql).toMatch(/"dispatched_at" is null/);
  });
});

describe('resolveEndpoints', () => {
  const org = '0192f0a4-6666-7000-8000-000000000007';

  it('node-routed / ping: the one endpoint, only if enabled and in the org', async () => {
    const { db, calls } = proxyDb([[['ep-1']]]);
    const ids = await resolveEndpoints(db, { type: 'workflow.event', organizationId: org, endpointId: 'ep-1', data: {} });
    expect(ids).toEqual(['ep-1']);
    expect(calls[0].sql).toMatch(/from "webhook_endpoints"/);
    expect(calls[0].sql).toMatch(/"enabled" = \$\d/);
    expect(calls[0].params).toEqual(expect.arrayContaining(['ep-1', org, true]));
  });

  it('device-routed: webhook_routes for data.deviceId containing the type, joined to enabled endpoints', async () => {
    const { db, calls } = proxyDb([[['ep-1'], ['ep-2']]]);
    const ids = await resolveEndpoints(db, {
      type: 'device.offline',
      organizationId: org,
      endpointId: null,
      data: { deviceId: 'dev-1' },
    });
    expect(ids).toEqual(['ep-1', 'ep-2']);
    expect(calls[0].sql).toMatch(/select distinct/);
    expect(calls[0].sql).toMatch(/inner join "webhook_endpoints"/);
    expect(calls[0].sql).toMatch(/"event_types" @> ARRAY\[\$\d+\]::text\[\]/);
    expect(calls[0].params).toEqual(expect.arrayContaining(['dev-1', org, true, 'device.offline']));
  });

  it('an event with neither an endpoint nor a deviceId is unrouted without a query', async () => {
    const { db, calls } = proxyDb();
    expect(await resolveEndpoints(db, { type: 'device.online', organizationId: org, endpointId: null, data: {} })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('event catalog', () => {
  it('has one entry with a sample per type, seven device-routable', () => {
    expect(WEBHOOK_EVENT_CATALOG.map((c) => c.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(DEVICE_ROUTABLE_TYPES).toHaveLength(7);
    expect(WEBHOOK_EVENT_TYPES).not.toContain('workflow_run.completed');
    for (const c of WEBHOOK_EVENT_CATALOG) expect(Object.keys(c.sample).length).toBeGreaterThan(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Same shape as test/webhooks.test.ts: the service modules get a pg-proxy
// drizzle instead of the Data API client.
vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  return { db: {}, schema };
});

import {
  AUTO_DISABLE_AFTER,
  AUTO_DISABLE_MIN_SPAN_SECONDS,
  AUTO_DISABLE_REASON,
  DELIVERY_LOG_MSG,
  autoDisableIfFailing,
  deliveryLogLine,
  shouldAutoDisable,
} from '../src/services/webhooks/deliver';
import type { WebhookDb } from '../src/services/webhooks/emit';
import { webhookEndpointDisabledEmail } from '../src/email/templates';

/** A db whose execute() renders the statement and answers `{ rows }` like the Data API driver. */
function executeDb(answers: unknown[][] = []) {
  const dialect = new PgDialect();
  const calls: { sql: string; params: unknown[] }[] = [];
  const dbx = {
    execute: async (q: SQL) => {
      calls.push(dialect.sqlToQuery(q));
      return { rows: answers.shift() ?? [] };
    },
  };
  return { db: dbx as unknown as WebhookDb, calls };
}

const HOUR = 60 * 60 * 1000;

describe('auto-disable threshold', () => {
  const now = new Date('2026-09-29T12:00:00Z');

  it('is 5 exhausted deliveries in a row, the oldest exhausted at least 24 h ago, reason failing', () => {
    expect(AUTO_DISABLE_AFTER).toBe(5);
    expect(AUTO_DISABLE_MIN_SPAN_SECONDS).toBe(86_400);
    expect(AUTO_DISABLE_REASON).toBe('failing');
  });

  it('needs both the count and the span', () => {
    const dayAgo = new Date(now.getTime() - 24 * HOUR);
    expect(shouldAutoDisable(5, dayAgo, now)).toBe(true);
    expect(shouldAutoDisable(9, new Date(now.getTime() - 72 * HOUR), now)).toBe(true);
    // 4 in a row is not enough however old
    expect(shouldAutoDisable(4, new Date(now.getTime() - 72 * HOUR), now)).toBe(false);
    // 5 that all exhausted inside the last day (one outage's burst) is not enough
    expect(shouldAutoDisable(5, new Date(now.getTime() - 24 * HOUR + 1000), now)).toBe(false);
    expect(shouldAutoDisable(50, new Date(now.getTime() - HOUR), now)).toBe(false);
    expect(shouldAutoDisable(5, null, now)).toBe(false);
  });
});

describe('autoDisableIfFailing', () => {
  it('is one conditional UPDATE: enabled, count >= 5, oldest of the last 5 exhaustions >= 24 h', async () => {
    const { db, calls } = executeDb([[]]);
    const notify = vi.fn();
    expect(await autoDisableIfFailing('ep-1', { db, notify })).toBeNull();
    expect(calls).toHaveLength(1);
    const q = calls[0].sql.replace(/\s+/g, ' ');
    expect(q).toMatch(/update webhook_endpoints e set enabled = false, disabled_at = now\(\), disabled_reason = \$1/);
    expect(q).toMatch(/and e\.enabled and e\.consecutive_failures >= 5/);
    expect(q).toMatch(/d\.status = 'exhausted' order by d\.updated_at desc limit 5/);
    expect(q).toMatch(/<= now\(\) - make_interval\(secs => 86400\)/);
    expect(calls[0].params).toEqual(['failing', 'ep-1']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies once when the claim returns the endpoint', async () => {
    const row = { id: 'ep-1', name: 'dispatch', url: 'https://h.example/x', organization_id: 'org-1', consecutive_failures: '5' };
    const { db } = executeDb([[row]]);
    const notify = vi.fn().mockResolvedValue({ sent: 1, owners: 1 });
    const res = await autoDisableIfFailing('ep-1', { db, notify });
    expect(res).toEqual({ id: 'ep-1', name: 'dispatch', url: 'https://h.example/x', organizationId: 'org-1', consecutiveFailures: 5 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toEqual(res);
  });

  it('a failed notification does not undo or throw', async () => {
    const row = { id: 'ep-1', name: 'd', url: 'https://h.example/', organization_id: 'o', consecutive_failures: 6 };
    const { db } = executeDb([[row]]);
    const notify = vi.fn().mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(autoDisableIfFailing('ep-1', { db, notify })).resolves.toMatchObject({ id: 'ep-1' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('endpoint disabled email', () => {
  it('names the endpoint in the subject and links the endpoint page; escapes user input', () => {
    const mail = webhookEndpointDisabledEmail(
      { appUrl: 'https://console.xorgate.io', stage: 'prod' },
      {
        email: 'o@example.com',
        name: 'Ada Lovelace',
        organizationName: 'Acme <Fleet>',
        endpointName: 'dispatch',
        endpointUrl: 'https://hooks.example.com/x',
        endpointPath: '/webhooks/ep-1',
        consecutiveFailures: 5,
      },
    );
    expect(mail.subject).toBe('Webhook endpoint dispatch disabled');
    expect(mail.html).toContain('href="https://console.xorgate.io/webhooks/ep-1"');
    expect(mail.html).toContain('Acme &lt;Fleet&gt;');
    expect(mail.html).not.toContain('Acme <Fleet>');
    expect(mail.text).toContain('https://console.xorgate.io/webhooks/ep-1');
    expect(mail.text).toContain('5 deliveries in a row');
  });
});

describe('delivery log line', () => {
  it('is one object with the fields the metric filters read', () => {
    const base = {
      deliveryId: 'd1', eventId: 'e1', organizationId: 'o1', endpointId: 'ep1', type: 'device.online',
      attempt: 2, httpStatus: 500, ms: 123,
    };
    expect(deliveryLogLine({ ...base, outcome: { status: 'retry', delaySeconds: 300 }, error: null })).toEqual({
      msg: DELIVERY_LOG_MSG, ...base, outcome: 'retry', retryInSeconds: 300,
    });
    expect(deliveryLogLine({ ...base, httpStatus: null, outcome: { status: 'exhausted' }, error: 'timed out' })).toEqual({
      msg: 'webhooks', ...base, httpStatus: null, outcome: 'exhausted', error: 'timed out',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  edgesFrom,
  LWT_MIN_AGE_MS,
  offlineClaimSql,
  offlineSourceFor,
  onlineClaimSql,
  presenceDedupeKey,
  presenceEventData,
} from '../src/services/device-presence';

/**
 * xorgate-webhooks Phase 2: device presence edges. The claim SQL itself is
 * proven against dev Aurora (plans/xorgate-webhooks/p2-verification); these
 * pin the parts that decide WHICH rows become events.
 */

const dialect = new PgDialect();
const text = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const row = (over: Record<string, unknown> = {}) => ({
  id: DEVICE,
  workspace_id: 'ws-1',
  organization_id: 'org-1',
  serial: 'SER',
  name: 'Truck 01',
  status: 'online',
  previous_status: 'offline',
  status_changed_at: '2026-09-28T20:00:00.123Z',
  last_seen_at: '2026-09-28T20:00:00.123Z',
  ...over,
});

describe('device presence: which claim rows are edges', () => {
  it('offline -> online and provisioned -> online are edges', () => {
    const edges = edgesFrom([row(), row({ previous_status: 'provisioned' })], 'telemetry');
    expect(edges.map((e) => [e.previousStatus, e.status, e.source])).toEqual([
      ['offline', 'online', 'telemetry'],
      ['provisioned', 'online', 'telemetry'],
    ]);
  });

  it('a plain heartbeat bump (online -> online) is not an edge', () => {
    expect(edgesFrom([row({ previous_status: 'online' })], 'connect')).toEqual([]);
  });

  it('a decommissioned row that only got the bump is not an edge', () => {
    expect(
      edgesFrom([row({ status: 'decommissioned', previous_status: 'decommissioned' })], 'connect'),
    ).toEqual([]);
  });

  it('online -> offline is an edge with the given source', () => {
    const [edge] = edgesFrom([row({ status: 'offline', previous_status: 'online' })], 'sweeper');
    expect(edge).toMatchObject({ status: 'offline', previousStatus: 'online', source: 'sweeper' });
  });

  it('no rows (the steady-state 1 Hz frame) and an undefined result are empty', () => {
    expect(edgesFrom([], 'telemetry')).toEqual([]);
    expect(edgesFrom(undefined, 'telemetry')).toEqual([]);
  });
});

describe('device presence: event identity and payload', () => {
  it('dedupe key follows the P1 convention and differs per transition', () => {
    const [a] = edgesFrom([row()], 'connect');
    const [b] = edgesFrom([row({ status_changed_at: '2026-09-28T20:00:05.001Z' })], 'connect');
    expect(presenceDedupeKey(a!)).toBe(`device:${DEVICE}:online:2026-09-28T20:00:00.123Z`);
    expect(presenceDedupeKey(a!)).not.toBe(presenceDedupeKey(b!));
  });

  it('data carries README §4 fields and nothing else', () => {
    const [edge] = edgesFrom([row({ status: 'offline', previous_status: 'online' })], 'lwt');
    expect(presenceEventData(edge!)).toEqual({
      deviceId: DEVICE,
      serial: 'SER',
      name: 'Truck 01',
      status: 'offline',
      previousStatus: 'online',
      lastSeenAt: '2026-09-28T20:00:00.123Z',
      source: 'lwt',
    });
  });
});

describe('device presence: status-topic offline source', () => {
  const now = Date.parse('2026-09-28T20:00:00Z');
  it('a graceful stop stamps ts at shutdown', () => {
    expect(offlineSourceFor(now - 500, now)).toBe('graceful');
  });
  it('the Last-Will carries the connect time, always older than the keepalive', () => {
    expect(offlineSourceFor(now - 90_000, now)).toBe('lwt');
    expect(offlineSourceFor(now - LWT_MIN_AGE_MS - 1, now)).toBe('lwt');
  });
  it('no ts at all reads as graceful', () => {
    expect(offlineSourceFor(undefined, now)).toBe('graceful');
  });
});

describe('device presence: claim SQL shape', () => {
  it('the telemetry claim is ONE statement: throttled bump OR a not-online row, locked', () => {
    const q = text(onlineClaimSql(DEVICE, { throttle: true }));
    expect(q).toContain("interval '15 seconds'");
    expect(q).toContain("status IN ('offline', 'provisioned')");
    expect(q).toContain('FOR UPDATE');
    expect(q).toContain('p.prev AS previous_status');
    expect(q).toContain("CASE WHEN p.prev = 'decommissioned' THEN p.prev ELSE 'online' END");
  });

  it('the connect claim always bumps', () => {
    const q = text(onlineClaimSql(DEVICE, { throttle: false }));
    expect(q).not.toContain("interval '15 seconds'");
    expect(q).toContain('AND true');
  });

  it('offline claims only touch online rows and stamp status_changed_at', () => {
    for (const q of [text(offlineClaimSql({ deviceId: DEVICE })), text(offlineClaimSql({ staleSecs: 60 }))]) {
      expect(q).toContain("status = 'offline', status_changed_at = now()");
      expect(q).toContain("AND status = 'online'");
    }
    expect(text(offlineClaimSql({ staleSecs: 60 }))).toContain('make_interval(secs => 60)');
  });
});

import { describe, expect, it } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  emitTelemetrySessionCompleted,
  mediaCloseSql,
  mediaEndedEvents,
  mediaEndedKey,
  mediaStartedData,
  mediaStartedKey,
  overviewApiPath,
  telemetryCloseSql,
  telemetryCompletedData,
  telemetryCompletedKey,
  telemetryEndedEvents,
  telemetryEndedKey,
  telemetryStartedKey,
  type MediaClosedRow,
  type TelemetryClosedRow,
  type TelemetryCompletedInput,
} from '../src/services/webhooks/sessions';
import { indexSegment } from '../src/services/telemetry-sessions';

/**
 * xorgate-webhooks Phase 3: session lifecycle events. The close SQL is proven
 * against prod Aurora in the drill (plans/xorgate-webhooks/p3-verification);
 * these pin identity (dedupe keys), the reopen flag, the payloads, and the
 * created-vs-existing detection that decides `started`.
 */

const dialect = new PgDialect();
const text = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');

const DEVICE = '58b51737-196e-4c29-a6f6-36f6793a5126';
const SESSION = '01a0cee6-0ca3-750b-bb29-9a8c41363905';

/** A drizzle-shaped recorder: every builder call chains, awaiting yields `result(table)`. */
function fakeDb(result: (op: string, table: string) => unknown) {
  const calls: { op: string; table: string }[] = [];
  const chain = (value: unknown): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) =>
        prop === 'then'
          ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej)
          : () => chain(value),
    });
  const op =
    (name: string) =>
    (table?: Table): unknown => {
      const t = table ? getTableName(table) : '';
      calls.push({ op: name, table: t });
      return name === 'select' ? { from: (from: Table) => { calls[calls.length - 1]!.table = getTableName(from); return chain(result(name, getTableName(from))); } } : chain(result(name, t));
    };
  return { calls, db: { insert: op('insert'), update: op('update'), select: op('select'), delete: op('delete'), selectDistinct: op('select'), execute: op('execute') } };
}

describe('session webhooks: dedupe keys (P1 conventions)', () => {
  it('started is once per session; ended/completed carry the claim timestamp', () => {
    expect(mediaStartedKey(SESSION)).toBe(`media_session:${SESSION}:started`);
    expect(telemetryStartedKey(SESSION)).toBe(`telemetry_session:${SESSION}:started`);
    expect(mediaEndedKey(SESSION, '2026-09-29T01:00:00.123Z')).toBe(
      `media_session:${SESSION}:ended:2026-09-29T01:00:00.123Z`,
    );
    expect(telemetryEndedKey(SESSION, '2026-09-29T01:00:00.123Z')).toBe(
      `telemetry_session:${SESSION}:ended:2026-09-29T01:00:00.123Z`,
    );
    expect(telemetryCompletedKey(SESSION, '2026-09-29T01:11:00.000Z')).toBe(
      `telemetry_session:${SESSION}:completed:2026-09-29T01:11:00.000Z`,
    );
  });

  it('a reopen (later last_segment_at) is a NEW ended event, not a dedupe', () => {
    expect(mediaEndedKey(SESSION, '2026-09-29T01:00:00.123Z')).not.toBe(
      mediaEndedKey(SESSION, '2026-09-29T01:20:00.456Z'),
    );
  });
});

const mediaRow = (over: Partial<MediaClosedRow> = {}): MediaClosedRow => ({
  id: SESSION,
  device_id: DEVICE,
  stream_key: 'cam0',
  started_at: '2026-09-29T00:50:00.000Z',
  ended_at: '2026-09-29T00:53:00.000Z',
  last_segment_at: '2026-09-29T00:53:04.321Z',
  reopened: false,
  segment_count: 3,
  total_bytes: '12582912',
  total_duration_ms: '180000',
  workspace_id: 'ws-1',
  organization_id: 'org-1',
  ...over,
});

describe('session webhooks: media ended', () => {
  it('the close is one statement: stamps ended_fired_at, reads the previous one, skips locked rows', () => {
    const q = text(mediaCloseSql(600));
    expect(q).toContain('UPDATE media_sessions m SET status = \'closed\', ended_fired_at = now()');
    expect(q).toContain('ended_fired_at AS prev_fired');
    expect(q).toContain('FOR UPDATE SKIP LOCKED');
    expect(q).toContain("WHERE m.id = c.id AND m.status = 'open'");
    expect(q).toContain('(c.prev_fired IS NOT NULL) AS reopened');
    expect(q).toContain('make_interval(secs => 600)');
    expect(q).not.toContain('device_id = $');
  });

  it('close-on-read scopes the close to one device', () => {
    const q = dialect.sqlToQuery(mediaCloseSql(600, DEVICE));
    expect(q.sql).toContain('AND device_id = $1::uuid');
    expect(q.params).toEqual([DEVICE]);
  });

  it('one event per closed row, README §4 data, numbers from bigint strings', () => {
    const [ev] = mediaEndedEvents([mediaRow()]);
    expect(ev).toEqual({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      type: 'media_session.ended',
      dedupeKey: `media_session:${SESSION}:ended:2026-09-29T00:53:04.321Z`,
      data: {
        sessionId: SESSION,
        deviceId: DEVICE,
        streamKey: 'cam0',
        startedAt: '2026-09-29T00:50:00.000Z',
        endedAt: '2026-09-29T00:53:00.000Z',
        lastSegmentAt: '2026-09-29T00:53:04.321Z',
        segmentCount: 3,
        totalBytes: 12582912,
        totalDurationMs: 180000,
        reopened: false,
      },
    });
  });

  it('reopened follows the previous ended_fired_at', () => {
    const [ev] = mediaEndedEvents([mediaRow({ reopened: true, last_segment_at: '2026-09-29T01:20:00.000Z' })]);
    expect(ev!.data.reopened).toBe(true);
  });

  it('a device with no workspace is not emitted (cannot be routed)', () => {
    expect(mediaEndedEvents([mediaRow({ organization_id: null, workspace_id: null })])).toEqual([]);
  });
});

describe('session webhooks: telemetry ended', () => {
  const row = (over: Partial<TelemetryClosedRow> = {}): TelemetryClosedRow => ({
    id: SESSION,
    device_id: DEVICE,
    started_at: '2026-09-29T00:50:00.000Z',
    ended_at: '2026-09-29T00:53:00.000Z',
    last_segment_at: '2026-09-29T00:53:04.321Z',
    reopened: false,
    segment_count: 3,
    sample_count: '181',
    byte_count: '40960',
    workspace_id: 'ws-1',
    organization_id: 'org-1',
    ...over,
  });

  it('"ended before" = completed_fired_at is set; no column of its own', () => {
    const q = text(telemetryCloseSql(600));
    expect(q).toContain('(t.completed_fired_at IS NOT NULL) AS reopened');
    expect(q).toContain('FOR UPDATE SKIP LOCKED');
    expect(q).toContain("WHERE t.id = c.id AND t.status = 'open'");
    expect(q).not.toContain('ended_fired_at');
  });

  it('data carries the stored counters and the reopen flag', () => {
    const [ev] = telemetryEndedEvents([row({ reopened: true })]);
    expect(ev!.type).toBe('telemetry_session.ended');
    expect(ev!.dedupeKey).toBe(`telemetry_session:${SESSION}:ended:2026-09-29T00:53:04.321Z`);
    expect(ev!.data).toEqual({
      sessionId: SESSION,
      deviceId: DEVICE,
      startedAt: '2026-09-29T00:50:00.000Z',
      endedAt: '2026-09-29T00:53:00.000Z',
      lastSegmentAt: '2026-09-29T00:53:04.321Z',
      segmentCount: 3,
      sampleCount: 181,
      byteCount: 40960,
      reopened: true,
    });
  });
});

const completed = (over: Partial<TelemetryCompletedInput> = {}): TelemetryCompletedInput => ({
  id: SESSION,
  deviceId: DEVICE,
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  startedAtIso: '2026-09-29T00:50:00.000Z',
  endedAtIso: '2026-09-29T00:53:00.000Z',
  lastSegmentAtIso: '2026-09-29T00:53:04.321Z',
  segmentCount: 3,
  sampleCount: '181',
  byteCount: '40960',
  insights: { distance: { meters: 57, unit: 'm' } },
  distanceM: 57,
  durationMs: '180000',
  maxSpeedKph: 12.5,
  previousCompletedFiredAt: null,
  ...over,
});

describe('session webhooks: telemetry completed', () => {
  it('data = the ended fields + insights, promoted columns and an API path (no presigned URL)', () => {
    const data = telemetryCompletedData(completed());
    expect(data).toMatchObject({
      sessionId: SESSION,
      deviceId: DEVICE,
      lastSegmentAt: '2026-09-29T00:53:04.321Z',
      segmentCount: 3,
      sampleCount: 181,
      byteCount: 40960,
      reopened: false,
      insights: { distance: { meters: 57, unit: 'm' } },
      distanceM: 57,
      durationMs: 180000,
      maxSpeedKph: 12.5,
    });
    const apiPath = (data.overview as { apiPath: string }).apiPath;
    expect(apiPath).toBe(
      `/v1/devices/${DEVICE}/replay-manifest?from=2026-09-29T00%3A50%3A00.000Z&to=2026-09-29T00%3A53%3A00.000Z`,
    );
    expect(JSON.stringify(data)).not.toMatch(/X-Amz-|https:/);
  });

  it('reopened = a completed fired before this claim', () => {
    expect(telemetryCompletedData(completed({ previousCompletedFiredAt: '2026-09-29T01:04:00.000Z' })).reopened).toBe(true);
  });

  it('a one-sample session still gets a valid (from < to) manifest window', () => {
    expect(overviewApiPath(DEVICE, '2026-09-29T00:50:00.000Z', '2026-09-29T00:50:00.000Z')).toContain(
      'to=2026-09-29T00%3A50%3A01.000Z',
    );
  });

  it('emits only when this close emitted its ended (the backfill and pre-P3 closes stay silent)', async () => {
    const none = fakeDb(() => []);
    expect(await emitTelemetrySessionCompleted(none.db as never, completed(), '2026-09-29T01:04:00.000Z')).toBeNull();
    expect(none.calls).toEqual([{ op: 'select', table: 'webhook_events' }]);

    const withEnded = fakeDb((op) => (op === 'select' ? [{ id: 'ended-1' }] : [{ id: 'completed-1' }]));
    expect(await emitTelemetrySessionCompleted(withEnded.db as never, completed(), '2026-09-29T01:04:00.000Z')).toBe(
      'completed-1',
    );
    expect(withEnded.calls.map((c) => `${c.op}:${c.table}`)).toEqual(['select:webhook_events', 'insert:webhook_events']);
  });
});

describe('session webhooks: started detection (indexSegment)', () => {
  const input = {
    s3Key: `telemetry/v1/${DEVICE}/${SESSION}/1790000000000-0.jsonl.gz`,
    deviceId: DEVICE,
    sessionId: SESSION,
    seq: 0,
    header: { rateHz: 1, timeSource: 'ntp', startedAt: null, bootId: null },
    firstTs: Date.now() - 60_000,
    lastTs: Date.now(),
    samples: 60,
    bytes: 4096,
    keyStartTsMs: Date.now() - 60_000,
  };

  it('created = the session INSERT returned a row', async () => {
    const f = fakeDb((op, table) =>
      op === 'insert' && table === 'telemetry_sessions' ? [{ id: SESSION }] : op === 'insert' ? [{ s3Key: input.s3Key }] : undefined,
    );
    const r = await indexSegment(f.db as never, input);
    expect(r).toMatchObject({ indexed: true, created: true });
    expect(r.startedAt.getTime()).toBe(input.firstTs);
    // It never touches the outbox itself: the caller decides.
    expect(f.calls.some((c) => c.table === 'webhook_events')).toBe(false);
  });

  it('an existing session (ON CONFLICT DO NOTHING returned nothing) is not created', async () => {
    const f = fakeDb((op, table) =>
      op === 'insert' && table === 'telemetry_sessions' ? [] : op === 'insert' ? [{ s3Key: input.s3Key }] : undefined,
    );
    expect(await indexSegment(f.db as never, input)).toMatchObject({ indexed: true, created: false });
  });

  it('an already-indexed segment reports indexed=false', async () => {
    const f = fakeDb(() => []);
    expect(await indexSegment(f.db as never, input)).toMatchObject({ indexed: false, created: false });
  });
});

describe('session webhooks: media started payload', () => {
  it('carries the row values and the creating seq (not necessarily 0)', () => {
    expect(
      mediaStartedData({
        sessionId: SESSION,
        deviceId: DEVICE,
        streamKey: 'cam1',
        startedAt: new Date('2026-09-29T00:50:00.000Z'),
        timeSource: 'ntp',
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 30,
        firstSeq: 2,
      }),
    ).toEqual({
      sessionId: SESSION,
      deviceId: DEVICE,
      streamKey: 'cam1',
      startedAt: '2026-09-29T00:50:00.000Z',
      timeSource: 'ntp',
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
      firstSeq: 2,
    });
  });
});

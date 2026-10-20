import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * plans/clock-step-correction P1: the media ingest handler's wiring around
 * services/media-clock-step.ts. No database and no S3: `db` records every
 * builder call (insert values, update sets, raw executes), S3 serves a canned
 * sidecar. Pins: the inflated segment is INSERTED corrected, the step's two
 * statements run after the segment insert and roll-forward, the started
 * webhook and segment_uploaded trigger see corrected values, and a D10
 * straggler on a corrected session is inserted shifted.
 */

const DEVICE = '58b51737-196e-4c29-a6f6-36f6793a5126';
const SESSION = '01a14919-c536-7056-8107-2c3dbd738f8f';
const BUCKET = 'xorgate-test-bucket';
const SEQ1_RAW = Date.parse('2026-10-17T09:04:10.471Z');
const STEP = 4_012_833 - 60_000;

const state = {
  sessionCreated: true,
  sidecar: {} as Record<string, unknown>,
  sessionClock: null as null | { clockCorrectionMs: number | null; clockStaleBefore: Date | null },
  calls: [] as { op: string; table?: string; args?: unknown }[],
};

const dialect = new PgDialect();

/** A thenable builder that records every chained method call. */
function chain(op: string, table: string | undefined, value: unknown): unknown {
  return new Proxy(() => undefined, {
    get: (_t, prop) =>
      prop === 'then'
        ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej)
        : (...args: unknown[]) => {
            state.calls.push({ op: `${op}.${String(prop)}`, table, args: args[0] });
            return chain(op, table, value);
          },
  });
}

const fakeDb = {
  insert: (t: Table) => {
    const table = getTableName(t);
    state.calls.push({ op: 'insert', table });
    const ret = table === 'media_sessions' ? (state.sessionCreated ? [{ id: SESSION }] : []) : [{ id: 'row-new' }];
    return chain('insert', table, ret);
  },
  update: (t: Table) => {
    const table = getTableName(t);
    state.calls.push({ op: 'update', table });
    return chain('update', table, undefined);
  },
  execute: async (q: SQL) => {
    state.calls.push({ op: 'execute', args: dialect.sqlToQuery(q) });
    return { rows: [] };
  },
  select: () => ({
    from: (t: Table) => chain('select', getTableName(t), state.sessionClock ? [state.sessionClock] : []),
  }),
};

vi.mock('../src/db/index', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  return {
    schema: realSchema,
    db: {
      ...fakeDb,
      transaction: async <T>(fn: (tx: typeof fakeDb) => Promise<T>) => fn(fakeDb),
      query: {
        mediaSegments: { findFirst: async () => undefined },
        devices: { findFirst: async () => ({ id: DEVICE, recordingConfig: { video: { segmentSeconds: 60 } } }) },
      },
    },
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  class GetObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class S3Client {
    async send() {
      return { Body: { transformToString: async () => JSON.stringify(state.sidecar) } };
    }
  }
  return { S3Client, GetObjectCommand };
});

const emitMediaSessionStarted = vi.fn(async () => 'evt-1');
vi.mock('../src/services/webhooks/sessions', () => ({ emitMediaSessionStarted }));
vi.mock('../src/services/webhooks/emit', () => ({ dispatchWebhookEvents: vi.fn(async () => ({})) }));
const evaluateSegmentUploadedTriggers = vi.fn();
vi.mock('../src/services/workflow-triggers', () => ({ evaluateSegmentUploadedTriggers }));

const { handler } = await import('../src/handlers/media-segment-ingest');

const keyFor = (seq: number) => `media-sessions/v1/${DEVICE}/cam0/${SESSION}/${String(seq).padStart(5, '0')}.mp4`;
const event = (seq: number) =>
  ({ id: 'e1', detail: { bucket: { name: BUCKET }, object: { key: keyFor(seq), size: 100 } } }) as never;

function sidecar(seq: number, startTs: number, durationMs: number, extra: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE,
    streamKey: 'cam0',
    sessionId: SESSION,
    seq,
    startTs,
    durationMs,
    sizeBytes: 1024,
    timeSource: 'rtc',
    anchor: 'fstat',
    finalized: true,
    ...extra,
  };
}

const valuesOf = (table: string) =>
  state.calls.find((c) => c.op === 'insert.values' && c.table === table)?.args as Record<string, unknown>;

beforeEach(() => {
  state.calls = [];
  state.sessionCreated = false;
  state.sessionClock = null;
  emitMediaSessionStarted.mockClear();
  evaluateSegmentUploadedTriggers.mockClear();
});

describe('media-segment-ingest clock-step wiring', () => {
  it('a normal segment is stored raw and runs no step statements', async () => {
    state.sidecar = sidecar(2, Date.now() - 60_000, 59_990, { anchor: 'computed' });
    await handler(event(2));
    const seg = valuesOf('media_segments');
    expect(seg.durationMs).toBe(59_990);
    expect((seg.meta as Record<string, unknown>).clockStep).toBeUndefined();
    expect(state.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
  });

  it('finalized inflated (Tacloban 04 seq 1): inserted shifted + clamped, then shift + session statements, in order', async () => {
    state.sidecar = sidecar(1, SEQ1_RAW, 4_012_833);
    await handler(event(1));
    const seg = valuesOf('media_segments');
    expect((seg.startTs as Date).toISOString()).toBe('2026-10-17T10:10:03.304Z');
    expect(seg.durationMs).toBe(60_000);
    expect((seg.meta as Record<string, unknown>).clockStep).toEqual({
      stepMs: STEP,
      rawStartTs: '2026-10-17T09:04:10.471Z',
      rawDurationMs: 4_012_833,
    });
    expect((seg.meta as Record<string, unknown>).anchor).toBe('fstat');

    const ops = state.calls.map((c) => c.op).filter((op) => ['insert', 'update', 'execute', 'select.for'].includes(op));
    // session insert → row-locked read → segment insert → roll-forward → shift → session recompute
    expect(ops).toEqual(['insert', 'select.for', 'insert', 'update', 'execute', 'execute']);
    const [shift, session] = state.calls.filter((c) => c.op === 'execute').map((c) => c.args as { sql: string; params: unknown[] });
    expect(shift.sql).toMatch(/^update media_segments/);
    expect(shift.params).toContain('row-new');
    expect(session.sql).toMatch(/^update media_sessions/);

    expect(evaluateSegmentUploadedTriggers).toHaveBeenCalledWith(
      expect.objectContaining({ startTs: new Date('2026-10-17T10:10:03.304Z'), durationMs: 60_000 }),
    );
  });

  it('a session created by the inflated segment starts at the corrected time, also in media_session.started', async () => {
    state.sessionCreated = true;
    state.sidecar = sidecar(1, SEQ1_RAW, 4_012_833);
    await handler(event(1));
    const sess = valuesOf('media_sessions');
    expect((sess.startedAt as Date).toISOString()).toBe('2026-10-17T10:10:03.304Z');
    expect((sess.endedAt as Date).toISOString()).toBe('2026-10-17T10:11:03.304Z');
    // A new session has no correction to read: no row-locked select.
    expect(state.calls.some((c) => c.op === 'select.for')).toBe(false);
    expect(emitMediaSessionStarted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startedAt: new Date('2026-10-17T10:10:03.304Z') }),
    );
  });

  it('crash-cut inflated (D5): clamped only, no step statements', async () => {
    state.sidecar = sidecar(1, SEQ1_RAW, 4_012_833, { finalized: false });
    await handler(event(1));
    const seg = valuesOf('media_segments');
    expect((seg.startTs as Date).getTime()).toBe(SEQ1_RAW);
    expect(seg.durationMs).toBe(60_000);
    expect((seg.meta as Record<string, unknown>).clockStep).toEqual({ clampedOnly: true, rawDurationMs: 4_012_833 });
    expect(state.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
  });

  it('D10 straggler: seq 0 arriving after the step is inserted shifted by the session correction', async () => {
    state.sessionClock = { clockCorrectionMs: STEP, clockStaleBefore: new Date(SEQ1_RAW + 60_000) };
    state.sidecar = sidecar(0, Date.parse('2026-10-17T09:03:10.471Z'), 60_000, { anchor: 'boundary' });
    await handler(event(0));
    const seg = valuesOf('media_segments');
    expect((seg.startTs as Date).toISOString()).toBe('2026-10-17T10:09:03.304Z');
    expect(seg.durationMs).toBe(60_000);
    expect((seg.meta as Record<string, unknown>).clockStep).toEqual({
      stepMs: STEP,
      shifted: true,
      rawStartTs: '2026-10-17T09:03:10.471Z',
    });
    expect(state.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
  });
});

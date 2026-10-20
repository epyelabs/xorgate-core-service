import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Clock-step correction P2 (plans/clock-step-correction §4.3): the shared
 * telemetry routine (services/telemetry-clock-step.ts) and the ingest handler
 * on the prod fixture (test/fixtures/clock-step-telemetry, see
 * telemetry-batch.test.ts). No database and no S3: S3 is an in-memory object
 * store honouring Metadata / ContentEncoding, `db` records every UPDATE (its
 * SQL rendered with the real dialect) and every readings INSERT.
 */

const dialect = new PgDialect();
const DEVICE = 'c10c57e9-0000-4000-8000-00000000d002';
const SESSION = '01a14954-0000-7000-8000-00000000c002';
const BUCKET = 'xorgate-test-bucket';
const KEY0 = `telemetry/v1/${DEVICE}/${SESSION}/1792231625531-00000.jsonl.gz`;
const KEY1 = `telemetry/v1/${DEVICE}/${SESSION}/1792231686490-00001.jsonl.gz`;
const STEP_MS = 226_669_005;
const FIXTURES = join(__dirname, 'fixtures', 'clock-step-telemetry');
const SEQ0_GZ = readFileSync(join(FIXTURES, '1792231625531-00000.jsonl.gz'));
const SEQ1_GZ = readFileSync(join(FIXTURES, '1792231686490-00001.jsonl.gz'));
const SEQ0 = gunzipSync(SEQ0_GZ).toString('utf8');
const SEQ1 = gunzipSync(SEQ1_GZ).toString('utf8');

// ---- in-memory S3 -----------------------------------------------------------
interface StoredObject {
  body: Buffer;
  metadata?: Record<string, string>;
  contentEncoding?: string;
  contentType?: string;
}
const store = new Map<string, StoredObject>();
const puts: { key: string; metadata?: Record<string, string>; contentEncoding?: string }[] = [];
const copies: string[] = [];

vi.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetObjectCommand extends Cmd {}
  class HeadObjectCommand extends Cmd {}
  class CopyObjectCommand extends Cmd {}
  class PutObjectCommand extends Cmd {}
  class DeleteObjectsCommand extends Cmd {}
  const notFound = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  class S3Client {
    async send(cmd: Cmd) {
      const key = String(cmd.input.Key);
      const obj = store.get(key);
      if (cmd instanceof GetObjectCommand) {
        if (!obj) throw notFound();
        return {
          ContentLength: obj.body.length,
          Metadata: obj.metadata ?? {},
          ContentEncoding: obj.contentEncoding,
          Body: { transformToByteArray: async () => new Uint8Array(obj.body) },
        };
      }
      if (cmd instanceof HeadObjectCommand) {
        if (!obj) throw notFound();
        return { ContentEncoding: obj.contentEncoding, ContentType: obj.contentType, Metadata: obj.metadata ?? {} };
      }
      if (cmd instanceof CopyObjectCommand) {
        if (!obj) throw notFound();
        copies.push(key);
        // MetadataDirective REPLACE without Metadata: user metadata is dropped.
        store.set(key, { body: obj.body, contentEncoding: String(cmd.input.ContentEncoding), contentType: String(cmd.input.ContentType) });
        return {};
      }
      if (cmd instanceof PutObjectCommand) {
        const body = cmd.input.Body as Buffer;
        const metadata = cmd.input.Metadata as Record<string, string> | undefined;
        puts.push({ key, metadata, contentEncoding: cmd.input.ContentEncoding as string });
        store.set(key, {
          body: Buffer.from(body),
          metadata,
          contentEncoding: cmd.input.ContentEncoding as string,
          contentType: cmd.input.ContentType as string,
        });
        return {};
      }
      return {};
    }
  }
  return { S3Client, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, PutObjectCommand, DeleteObjectsCommand };
});

// ---- recording db -----------------------------------------------------------
const render = (v: unknown): string => {
  if (v && typeof v === 'object' && 'queryChunks' in (v as object)) {
    const q = dialect.sqlToQuery(v as SQL);
    return `${q.sql} ${JSON.stringify(q.params)}`;
  }
  return JSON.stringify(v);
};

interface UpdateCall {
  table: string;
  set: Record<string, string>;
  where: string;
}
const state = {
  ingestLogged: false,
  session: null as null | { clockCorrectionMs: number | null; clockStaleBefore: Date | null },
  earlierRows: [] as { s3Key: string; bytes: number }[],
  updates: [] as UpdateCall[],
  readings: [] as { ts: Date; metric: string }[],
  inserts: [] as string[],
};

function chain(value: unknown): unknown {
  return new Proxy(() => undefined, {
    get: (_t, prop) =>
      prop === 'then'
        ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej)
        : () => chain(value),
  });
}

const fakeDb = {
  insert: (table: Table) => {
    const name = getTableName(table);
    state.inserts.push(name);
    return {
      values: (v: unknown) => {
        if (name === 'telemetry_readings') state.readings.push(...(v as { ts: Date; metric: string }[]));
        const ret = name === 'telemetry_readings' ? undefined : [{ id: SESSION, s3Key: 'k' }];
        return chain(ret);
      },
    };
  },
  update: (table: Table) => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        const call: UpdateCall = {
          table: getTableName(table),
          set: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, render(v)])),
          where: render(where),
        };
        state.updates.push(call);
        // readings: report one moved row per ts param, like numberOfRecordsUpdated.
        const n = call.table === 'telemetry_readings' ? (call.where.match(/::timestamptz/g) ?? []).length : 1;
        return chain({ numberOfRecordsUpdated: n });
      },
    }),
  }),
  execute: () => chain({ rows: [] }),
  select: () => ({
    from: (table: Table) => {
      const name = getTableName(table);
      if (name === 'telemetry_sessions') return chain(state.session ? [state.session] : []);
      if (name === 'telemetry_segments') return chain(state.earlierRows);
      return chain([]);
    },
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
        devices: { findFirst: async () => ({ id: DEVICE }) },
        telemetryIngestLog: { findFirst: async () => (state.ingestLogged ? { s3Key: 'k' } : undefined) },
      },
    },
  };
});
vi.mock('../src/services/webhooks/emit', () => ({
  emitWebhookEvent: vi.fn(async () => 'evt-1'),
  emitWebhookEvents: vi.fn(async () => []),
  dispatchWebhookEvents: vi.fn(async () => ({ sent: [], failed: [], disabled: true })),
}));
vi.mock('../src/services/workflow-triggers', () => ({
  evaluateSegmentUploadedTriggers: vi.fn(),
  evaluateSessionCompletedTriggers: vi.fn(),
  evaluateTelemetrySessionCompletedTriggers: vi.fn(),
}));

process.env.BUCKET_NAME = BUCKET;
process.env.TELEMETRY_BATCH_MAX_AGE_DAYS = '100000'; // the fixture is from 2026-10; keep its rows insertable whenever this runs
const clockStep = await import('../src/services/telemetry-clock-step');
const { parseSegment } = await import('../src/services/telemetry-batch');
const { recordingConfig } = await import('../src/config/recording');
const { handler } = await import('../src/handlers/telemetry-batch-ingest');

const event = (key: string, size = 100) =>
  ({ id: 'e1', detail: { bucket: { name: BUCKET }, object: { key, size } } }) as never;
const textOf = (key: string): string => gunzipSync(store.get(key)!.body).toString('utf8');
const metaOf = (key: string) => clockStep.readClockStepMeta(store.get(key)?.metadata);
const updatesOn = (table: string) => state.updates.filter((u) => u.table === table);
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  store.clear();
  puts.length = 0;
  copies.length = 0;
  Object.assign(state, { ingestLogged: false, session: null, earlierRows: [], updates: [], readings: [], inserts: [] });
  (recordingConfig as { clockStepCorrection: boolean }).clockStepCorrection = true;
});

// ---- pure parts -------------------------------------------------------------
describe('telemetry-clock-step pure helpers', () => {
  it('chunk splits the stale ts list for the IN (...) statements (200 per statement)', () => {
    expect(clockStep.READINGS_TS_CHUNK).toBe(200);
    const ts = Array.from({ length: 450 }, (_, i) => i);
    const parts = clockStep.chunk(ts);
    expect(parts.map((p) => p.length)).toEqual([200, 200, 50]);
    expect(parts.flat()).toEqual(ts);
    expect(clockStep.chunk([])).toEqual([]);
    expect(clockStep.chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(() => clockStep.chunk([1], 0)).toThrow();
  });

  it('planWholeFileShift: a fresh shift rewrites every sample and records itself', () => {
    const plan = clockStep.planWholeFileShift(SEQ0, null, STEP_MS, 'seq:1');
    expect(plan.alreadyApplied).toBe(false);
    expect(plan.staleTs).toHaveLength(60);
    expect(plan.staleTs[0]).toBe(1792231625531);
    expect(plan.firstTs).toBe(1792231625531 + STEP_MS);
    expect(plan.meta).toEqual({ v: 1, applied: [{ by: 'seq:1', ms: STEP_MS }] });
    expect(plan.text.split('\n')[0]).toBe(SEQ0.split('\n')[0]);
  });

  it('planWholeFileShift: an already-applied shift writes nothing and reports what the readings still hold', () => {
    const first = clockStep.planWholeFileShift(SEQ0, null, STEP_MS, 'seq:1');
    const again = clockStep.planWholeFileShift(first.text, first.meta, STEP_MS, 'seq:1');
    expect(again.alreadyApplied).toBe(true);
    expect(again.text).toBe(first.text);
    expect(again.staleTs).toEqual(first.staleTs); // current − shift = the raw stamps
    expect(again.firstTs).toBe(first.firstTs);
    // A different step file's shift composes on top (D11).
    const second = clockStep.planWholeFileShift(first.text, first.meta, 15_000, 'seq:7');
    expect(second.alreadyApplied).toBe(false);
    expect(second.staleTs[0]).toBe(1792231625531 + STEP_MS);
    expect(second.meta.applied).toEqual([
      { by: 'seq:1', ms: STEP_MS },
      { by: 'seq:7', ms: 15_000 },
    ]);
  });

  it('reads back its own metadata and ignores anything else', () => {
    const meta = { v: 1 as const, own: { steps: [{ atIndex: 1, jumpMs: STEP_MS }], shiftMs: STEP_MS, rawFirstTs: 1, staleBefore: 2 } };
    expect(clockStep.readClockStepMeta(clockStep.encodeClockStepMeta(meta))).toEqual(meta);
    expect(clockStep.readClockStepMeta(undefined)).toBeNull();
    expect(clockStep.readClockStepMeta({})).toBeNull();
    expect(clockStep.readClockStepMeta({ 'xg-clock-step': 'not json' })).toBeNull();
    expect(clockStep.readClockStepMeta({ 'xg-clock-step': '{"v":2}' })).toBeNull();
    // ASCII-only, small: S3 user metadata travels in headers (2 KB cap).
    const encoded = clockStep.encodeClockStepMeta(meta)['xg-clock-step'];
    expect(/^[\x20-\x7e]+$/.test(encoded)).toBe(true);
    expect(encoded.length).toBeLessThan(300);
  });

  it('decodeSegmentBody handles gzip and plain bodies', () => {
    expect(clockStep.decodeSegmentBody(SEQ0_GZ)).toBe(SEQ0);
    expect(clockStep.decodeSegmentBody(Buffer.from(SEQ0))).toBe(SEQ0);
  });

  it('applySessionClockCorrection: bounds from the segments, accumulating audit columns', async () => {
    await clockStep.applySessionClockCorrection(fakeDb as never, {
      sessionId: SESSION,
      shiftMs: STEP_MS,
      staleBefore: 1792458356539,
      bytesDelta: 3,
    });
    const [u] = updatesOn('telemetry_sessions');
    expect(u.set.startedAt).toContain('select min("telemetry_segments"."start_ts") from "telemetry_segments"');
    expect(u.set.endedAt).toContain('select max("telemetry_segments"."end_ts")');
    expect(u.set.clockCorrectionMs).toContain('coalesce("telemetry_sessions"."clock_correction_ms", 0) + $1::bigint');
    expect(u.set.clockCorrectionMs).toContain(String(STEP_MS));
    expect(u.set.clockStaleBefore).toContain('least(coalesce("telemetry_sessions"."clock_stale_before"');
    expect(u.set.clockStaleBefore).toContain('2026-10-20T01:05:56.539Z');
    expect(u.set.overviewStale).toContain('"telemetry_sessions"."overview_key" is not null');
    expect(u.set.clockCorrectedAt).toContain('now()');
  });

  it('applySegmentShifts: absolute bounds per file, readings by exact ts in chunks', async () => {
    const ts = Array.from({ length: 450 }, (_, i) => 1792231625531 + i * 1000);
    const moved = await clockStep.applySegmentShifts(fakeDb as never, DEVICE, [
      { s3Key: KEY0, firstTs: ts[0] + STEP_MS, lastTs: ts[449] + STEP_MS, bytes: 10, bytesDelta: 0, staleTsGroups: [{ shiftMs: STEP_MS, ts }], rewritten: true },
    ]);
    const seg = updatesOn('telemetry_segments');
    expect(seg).toHaveLength(1);
    expect(seg[0].set.startTs).toContain(iso(ts[0] + STEP_MS));
    expect(seg[0].where).toContain(KEY0);
    const readings = updatesOn('telemetry_readings');
    expect(readings).toHaveLength(3);
    expect(readings.map((r) => (r.where.match(/::timestamptz/g) ?? []).length)).toEqual([200, 200, 50]);
    expect(readings[0].set.ts).toContain(`"telemetry_readings"."ts" + $1::bigint * interval '1 millisecond'`);
    expect(readings[0].set.ts).toContain(String(STEP_MS));
    expect(readings[0].where).toContain(DEVICE);
    expect(readings[0].where).toContain(iso(ts[0]));
    expect(moved).toBe(450);
  });
});

// ---- handler ----------------------------------------------------------------
describe('telemetry-batch-ingest with clock-step correction', () => {
  function seedStraddle() {
    store.set(KEY0, { body: gzipSync(Buffer.from(SEQ0)), contentEncoding: 'gzip', contentType: 'application/x-ndjson' });
    store.set(KEY1, { body: Buffer.from(SEQ1_GZ) }); // as the device PUT it
    state.session = { clockCorrectionMs: null, clockStaleBefore: null };
    state.earlierRows = [{ s3Key: KEY0, bytes: store.get(KEY0)!.body.length }];
  }

  it('the straddling file: rewrites itself and the earlier file, then corrects rows, bounds and the session', async () => {
    seedStraddle();
    const log = vi.spyOn(console, 'log');
    await handler(event(KEY1));

    // (a) this object: corrected text, normalised headers, `own` record.
    const expected = parseSegment(SEQ1, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15, clockStepMinMs: 10_000 });
    expect(textOf(KEY1)).toBe(expected.correctedText);
    expect(store.get(KEY1)!.contentEncoding).toBe('gzip');
    expect(metaOf(KEY1)?.own).toEqual({
      steps: [{ atIndex: 1, jumpMs: STEP_MS }],
      shiftMs: STEP_MS,
      rawFirstTs: 1792231686490,
      staleBefore: 1792458356539,
    });
    // (b) the earlier file: shifted whole, recorded as applied for seq 1.
    expect(textOf(KEY0)).toBe(clockStep.planWholeFileShift(SEQ0, null, STEP_MS, 'seq:1').text);
    expect(metaOf(KEY0)?.applied).toEqual([{ by: 'seq:1', ms: STEP_MS }]);
    expect(puts.map((p) => p.key)).toEqual([KEY1, KEY0]);
    expect(copies).toEqual([]); // our PUT is already normalised: no CopyObject, no second re-fire

    // (c) earlier file's bounds + readings by its 60 raw ts.
    const segUpdates = updatesOn('telemetry_segments').filter((u) => u.where.includes(KEY0) && u.set.startTs);
    expect(segUpdates).toHaveLength(1);
    expect(segUpdates[0].set.startTs).toContain('2026-10-20T01:04:54.536Z');
    expect(segUpdates[0].set.endTs).toContain('2026-10-20T01:05:54.495Z');
    const readingUpdates = updatesOn('telemetry_readings');
    expect(readingUpdates).toHaveLength(1);
    expect((readingUpdates[0].where.match(/::timestamptz/g) ?? []).length).toBe(60);
    expect(readingUpdates[0].where).toContain('2026-10-17T10:07:05.531Z');

    // This file's rows: corrected, none at the stale stamp.
    expect(state.readings.length).toBeGreaterThan(0);
    expect(state.readings.some((r) => r.ts.getTime() === 1792231686490)).toBe(false);
    expect(Math.min(...state.readings.map((r) => r.ts.getTime()))).toBe(1792231686490 + STEP_MS);

    // (d) the session: after indexSegment, with the accumulated correction.
    const sessionUpdates = updatesOn('telemetry_sessions');
    const corr = sessionUpdates.filter((u) => u.set.clockCorrectionMs);
    expect(corr).toHaveLength(1);
    expect(sessionUpdates.indexOf(corr[0])).toBe(sessionUpdates.length - 1); // after indexSegment's roll-forward
    expect(corr[0].set.clockCorrectionMs).toContain(String(STEP_MS));
    expect(corr[0].set.clockStaleBefore).toContain('2026-10-20T01:05:56.539Z');
    expect(state.inserts.at(-1)).toBe('telemetry_ingest_log');

    const line = log.mock.calls.find((c) => c[0] === 'telemetry-batch-ingest: clock step corrected');
    expect(line?.[1]).toMatchObject({ key: KEY1, kind: 'step', shiftMs: STEP_MS, filesRewritten: 2, earlierFiles: 1, readingsMoved: 60 });
    log.mockRestore();
  });

  it('a retry after the S3 phase (or our re-fired event racing the commit) replays the same DB work without rewriting', async () => {
    seedStraddle();
    await handler(event(KEY1)); // pretend this attempt's transaction then failed
    const firstRun = { readings: state.readings.map((r) => r.ts.getTime()), updates: state.updates.map((u) => ({ ...u })) };
    const objects = new Map([...store].map(([k, v]) => [k, Buffer.from(v.body)]));
    puts.length = 0;
    state.updates = [];
    state.readings = [];

    await handler(event(KEY1));
    expect(puts).toEqual([]); // nothing rewritten twice
    for (const [k, body] of objects) expect(store.get(k)!.body.equals(body)).toBe(true);
    expect(state.readings.map((r) => r.ts.getTime())).toEqual(firstRun.readings);
    // Same clock-step statements (indexSegment's own roll-forward carries now(), so it is left out).
    const clockWork = (updates: UpdateCall[]) =>
      updates.filter((u) => u.table === 'telemetry_readings' || u.set.startTs !== undefined || u.set.clockCorrectionMs !== undefined);
    expect(clockWork(firstRun.updates)).toHaveLength(3);
    expect(clockWork(state.updates)).toEqual(clockWork(firstRun.updates));
  });

  it('a later delivery of an already-ingested key (our own PUT re-firing) is absorbed by the fast path', async () => {
    seedStraddle();
    await handler(event(KEY1));
    puts.length = 0;
    state.updates = [];
    state.ingestLogged = true;
    await handler(event(KEY1));
    await handler(event(KEY0));
    expect(puts).toEqual([]);
    expect(copies).toEqual([]);
    expect(updatesOn('telemetry_readings')).toEqual([]);
  });

  it('D10: a late stale file on a corrected session is shifted whole by the session correction', async () => {
    store.set(KEY0, { body: Buffer.from(SEQ0_GZ) });
    state.session = { clockCorrectionMs: STEP_MS, clockStaleBefore: new Date(1792458356539) };
    await handler(event(KEY0));
    expect(metaOf(KEY0)?.applied).toEqual([{ by: 'straggler', ms: STEP_MS }]);
    expect(textOf(KEY0)).toBe(clockStep.planWholeFileShift(SEQ0, null, STEP_MS, 'straggler').text);
    expect(Math.min(...state.readings.map((r) => r.ts.getTime()))).toBe(1792231625531 + STEP_MS);
    expect(updatesOn('telemetry_sessions').some((u) => u.set.clockCorrectionMs)).toBe(false);
    expect(updatesOn('telemetry_readings')).toEqual([]);
    // Its retry ingests the shifted content as is.
    puts.length = 0;
    state.readings = [];
    await handler(event(KEY0));
    expect(puts).toEqual([]);
    expect(Math.min(...state.readings.map((r) => r.ts.getTime()))).toBe(1792231625531 + STEP_MS);
  });

  it('a file stamped after the step on a corrected session is left alone', async () => {
    const real = parseSegment(SEQ1, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15, clockStepMinMs: 10_000 }).correctedText!;
    const key = `telemetry/v1/${DEVICE}/${SESSION}/1792458416511-00002.jsonl.gz`;
    store.set(key, { body: gzipSync(Buffer.from(clockStep.planWholeFileShift(real, null, 61_000, 'x').text)) });
    state.session = { clockCorrectionMs: STEP_MS, clockStaleBefore: new Date(1792458356539) };
    await handler(event(key));
    expect(puts).toEqual([]);
  });

  it('kill switch (CLOCK_STEP_CORRECTION=0): ingests the raw stamps, no S3 rewrite, no session correction', async () => {
    seedStraddle();
    (recordingConfig as { clockStepCorrection: boolean }).clockStepCorrection = false;
    await handler(event(KEY1));
    expect(puts).toEqual([]);
    expect(state.readings.some((r) => r.ts.getTime() === 1792231686490)).toBe(true);
    expect(updatesOn('telemetry_sessions').some((u) => u.set.clockCorrectionMs)).toBe(false);
    expect(copies).toEqual([KEY1]); // today's normalisation copy, unchanged
  });

  it('a device re-PUT of the raw straddling file after ingest is re-stamped in S3 (DB untouched)', async () => {
    store.set(KEY1, { body: Buffer.from(SEQ1_GZ) }); // re-PUT: no gzip header, no record
    state.ingestLogged = true;
    await handler(event(KEY1));
    expect(copies).toEqual([KEY1]);
    expect(metaOf(KEY1)?.own?.shiftMs).toBe(STEP_MS);
    expect(textOf(KEY1)).toBe(
      parseSegment(SEQ1, { deviceId: DEVICE, now: Date.now(), maxAgeMs: 1e15, maxFutureMs: 1e15, clockStepMinMs: 10_000 }).correctedText,
    );
    expect(state.updates.filter((u) => u.table !== 'telemetry_segments')).toEqual([]); // only the normalized flag
  });
});

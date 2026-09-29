import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

/**
 * xorgate-webhooks Phase 3: which ingest paths write a `*_session.started`
 * outbox row. No database and no S3 here: `db` is a recorder whose builder
 * calls resolve to per-table answers, S3 returns canned objects, and the
 * outbox insert (`emitWebhookEvent`) is a spy. Pins: the live ingests emit
 * exactly when their session INSERT returned a row; a re-ingest of the same
 * key emits nothing; the backfill (`reconcileTelemetryIndex`) never emits.
 */

const DEVICE = '58b51737-196e-4c29-a6f6-36f6793a5126';
const SESSION = '01a0cee6-0ca3-750b-bb29-9a8c41363905';
const BUCKET = 'xorgate-test-bucket';

/** Per-scenario answers: what each INSERT's RETURNING yields. */
const state = {
  sessionCreated: true,
  segmentInserted: true,
  logInserted: true,
  mediaAlreadyIngested: false,
  telemetryAlreadyLogged: false,
  inserts: [] as string[],
  reconcilePending: [] as { s3Key: string; ingestedAt: Date }[],
};

function chain(value: unknown): unknown {
  return new Proxy(() => undefined, {
    get: (_t, prop) =>
      prop === 'then'
        ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej)
        : () => chain(value),
  });
}

function insertResult(table: string): unknown[] {
  switch (table) {
    case 'media_sessions':
    case 'telemetry_sessions':
      return state.sessionCreated ? [{ id: SESSION }] : [];
    case 'media_segments':
      return state.segmentInserted ? [{ id: 'seg-1' }] : [];
    case 'telemetry_segments':
      return state.segmentInserted ? [{ s3Key: 'k' }] : [];
    case 'telemetry_ingest_log':
      return state.logInserted ? [{ s3Key: 'k' }] : [];
    default:
      return [];
  }
}

let selectCalls = 0;
const fakeDb = {
  insert: (table: Table) => {
    state.inserts.push(getTableName(table));
    return chain(insertResult(getTableName(table)));
  },
  update: () => chain(undefined),
  delete: () => chain([]),
  execute: () => chain({ rows: [] }),
  select: () => ({
    from: (table: Table) => {
      const name = getTableName(table);
      if (name === 'devices') return chain([{ workspaceId: 'ws-1', organizationId: 'org-1' }]);
      // reconcileTelemetryIndex: first the counts, then the pending page.
      if (name === 'telemetry_ingest_log') {
        selectCalls++;
        return chain(selectCalls % 2 === 1 ? [{ remaining: state.reconcilePending.length, orphaned: 0 }] : state.reconcilePending);
      }
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
        mediaSegments: { findFirst: async () => (state.mediaAlreadyIngested ? { id: 'seg-0' } : undefined) },
        devices: { findFirst: async () => ({ id: DEVICE }) },
        telemetryIngestLog: { findFirst: async () => (state.telemetryAlreadyLogged ? { s3Key: 'k' } : undefined) },
      },
    },
  };
});

const telemetryText = [
  JSON.stringify({ type: 'header', deviceId: DEVICE, sessionId: SESSION, rateHz: 1, timeSource: 'ntp' }),
  JSON.stringify({ ts: Date.now() - 2000, metrics: { gps: { speed: { value: 1 } } } }),
  JSON.stringify({ ts: Date.now() - 1000, metrics: { gps: { speed: { value: 2 } } } }),
].join('\n');

vi.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetObjectCommand extends Cmd {}
  class HeadObjectCommand extends Cmd {}
  class CopyObjectCommand extends Cmd {}
  class PutObjectCommand extends Cmd {}
  class DeleteObjectsCommand extends Cmd {}
  class S3Client {
    async send(cmd: Cmd) {
      if (cmd instanceof HeadObjectCommand) {
        return { ContentEncoding: 'gzip', ContentType: 'application/x-ndjson' };
      }
      if (cmd instanceof GetObjectCommand) {
        const key = String(cmd.input.Key);
        if (key.endsWith('.json')) {
          const sidecar = {
            deviceId: DEVICE,
            streamKey: 'cam0',
            sessionId: SESSION,
            seq: 0,
            startTs: Date.now() - 60_000,
            durationMs: 60_000,
            sizeBytes: 1024,
            timeSource: 'ntp',
            codec: 'h264',
            width: 1920,
            height: 1080,
            fps: 30,
          };
          return { Body: { transformToString: async () => JSON.stringify(sidecar) } };
        }
        const gz = gzipSync(Buffer.from(telemetryText));
        return { ContentLength: gz.length, Body: { transformToByteArray: async () => new Uint8Array(gz) } };
      }
      return {};
    }
  }
  return { S3Client, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, PutObjectCommand, DeleteObjectsCommand };
});

const emitWebhookEvent = vi.fn(async () => 'evt-1');
const dispatchWebhookEvents = vi.fn(async () => ({ sent: [], failed: [], disabled: true }));
vi.mock('../src/services/webhooks/emit', () => ({
  emitWebhookEvent,
  emitWebhookEvents: vi.fn(async () => []),
  dispatchWebhookEvents,
}));
vi.mock('../src/services/workflow-triggers', () => ({
  evaluateSegmentUploadedTriggers: vi.fn(),
  evaluateSessionCompletedTriggers: vi.fn(),
  evaluateTelemetrySessionCompletedTriggers: vi.fn(),
}));

process.env.BUCKET_NAME = BUCKET;
const { handler: mediaIngest } = await import('../src/handlers/media-segment-ingest');
const { handler: telemetryIngest } = await import('../src/handlers/telemetry-batch-ingest');
const { reconcileTelemetryIndex } = await import('../src/services/telemetry-sessions');

const event = (key: string) =>
  ({ id: 'e1', detail: { bucket: { name: BUCKET }, object: { key, size: 100 } } }) as never;
const MEDIA_KEY = `media-sessions/v1/${DEVICE}/cam0/${SESSION}/00000.mp4`;
const TELEMETRY_KEY = `telemetry/v1/${DEVICE}/${SESSION}/${Date.now() - 2000}-0.jsonl.gz`;

type EmitArgs = { type: string; dedupeKey: string; data: Record<string, unknown> };
const emitted = (): EmitArgs[] => (emitWebhookEvent.mock.calls as unknown as [unknown, EmitArgs][]).map((c) => c[1]);

beforeEach(() => {
  Object.assign(state, {
    sessionCreated: true,
    segmentInserted: true,
    logInserted: true,
    mediaAlreadyIngested: false,
    telemetryAlreadyLogged: false,
    inserts: [],
    reconcilePending: [],
  });
  selectCalls = 0;
  emitWebhookEvent.mockClear();
  dispatchWebhookEvents.mockClear();
});

describe('media ingest -> media_session.started', () => {
  it('the delivery that creates the session emits once, in its transaction, then dispatches', async () => {
    await mediaIngest(event(MEDIA_KEY));
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({
      type: 'media_session.started',
      dedupeKey: `media_session:${SESSION}:started`,
      data: { sessionId: SESSION, deviceId: DEVICE, streamKey: 'cam0', codec: 'h264', firstSeq: 0, timeSource: 'ntp' },
    });
    expect(dispatchWebhookEvents).toHaveBeenCalledWith(['evt-1']);
  });

  it('a later segment of an existing session emits nothing', async () => {
    state.sessionCreated = false;
    await mediaIngest(event(MEDIA_KEY));
    expect(emitted()).toHaveLength(0);
    expect(dispatchWebhookEvents).toHaveBeenCalledWith([null]);
  });

  it('a re-ingest of an already-ingested key emits nothing (fast path and rolled-back race)', async () => {
    state.mediaAlreadyIngested = true;
    await mediaIngest(event(MEDIA_KEY));
    state.mediaAlreadyIngested = false;
    state.segmentInserted = false; // lost the race inside the transaction
    await mediaIngest(event(MEDIA_KEY));
    expect(emitted()).toHaveLength(0);
  });
});

describe('telemetry ingest -> telemetry_session.started', () => {
  it('the delivery that creates the session emits once', async () => {
    await telemetryIngest(event(TELEMETRY_KEY));
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0]).toMatchObject({
      type: 'telemetry_session.started',
      dedupeKey: `telemetry_session:${SESSION}:started`,
      data: { sessionId: SESSION, deviceId: DEVICE, rateHz: 1, timeSource: 'ntp' },
    });
    expect(dispatchWebhookEvents).toHaveBeenCalledWith(['evt-1']);
  });

  it('an existing session emits nothing', async () => {
    state.sessionCreated = false;
    await telemetryIngest(event(TELEMETRY_KEY));
    expect(emitted()).toHaveLength(0);
  });

  it('a re-ingest (ingest-log hit, or the log insert losing the race) emits nothing', async () => {
    state.telemetryAlreadyLogged = true;
    await telemetryIngest(event(TELEMETRY_KEY));
    state.telemetryAlreadyLogged = false;
    state.logInserted = false;
    await telemetryIngest(event(TELEMETRY_KEY));
    expect(emitted()).toHaveLength(0);
  });
});

describe('reconcileTelemetryIndex (backfill) never emits', () => {
  it('creates the session closed and writes no outbox row', async () => {
    state.reconcilePending = [{ s3Key: TELEMETRY_KEY, ingestedAt: new Date(Date.now() - 86_400_000) }];
    const r = await reconcileTelemetryIndex({ bucket: BUCKET });
    expect(r.indexed).toBe(1);
    expect(state.inserts).toContain('telemetry_sessions');
    expect(state.inserts).not.toContain('webhook_events');
    expect(emitWebhookEvent).not.toHaveBeenCalled();
    expect(dispatchWebhookEvents).not.toHaveBeenCalled();
  });
});

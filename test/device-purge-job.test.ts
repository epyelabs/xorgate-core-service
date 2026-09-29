import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, is, Table } from 'drizzle-orm';

/**
 * The purge job (plans/device-wf-data-delete, README §3c): step order, the
 * cursor and counts persisted after every chunk, resuming from the row, the
 * budget yield, the give-up on the last SQS receive, and the readings window
 * halving on a Data API timeout. Postgres, S3 and ECS are faked; the SQL a
 * chunk issues is recognised by the table it names.
 */

process.env.RECORDER_CLUSTER_ARN = 'arn:aws:ecs:us-east-1:1:cluster/test';

const ecsSend = vi.fn();
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: class {
    send = ecsSend;
  },
  StopTaskCommand: class {
    constructor(public input: unknown) {}
  },
}));

const drainPrefix = vi.fn();
vi.mock('../src/services/s3-drain', () => ({ drainPrefix }));

const enqueueModelJob = vi.fn();
vi.mock('../src/services/model-jobs', () => ({ enqueueModelJob }));

// ---- db fake ---------------------------------------------------------------
type Row = Record<string, unknown>;
let claimRow: Row | undefined;
const updates: { table: string; vals: Row }[] = [];
/** Scripted answers for select builders, keyed by table, consumed in order. */
let selects: Record<string, Row[][]>;
/** Scripted answers for db.execute, keyed by "verb table", consumed in order. */
let executes: Record<string, Array<Row | Error>>;
const executed: string[] = [];

function describeSql(q: unknown): { verb: string; table: string } {
  let table = '';
  let text = '';
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (is(node, Table)) {
      if (!table) table = getTableName(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (Array.isArray(node.queryChunks)) return node.queryChunks.forEach(walk);
    if (Array.isArray(node.value) && node.value.every((v: unknown) => typeof v === 'string')) {
      text += node.value.join('');
    }
  };
  walk(q);
  const verb = /^\s*delete/i.test(text) ? 'delete' : /^\s*select/i.test(text) ? 'select' : 'other';
  return { verb, table };
}

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    update: (table: unknown) => ({
      set: (vals: Row) => ({
        where: () => {
          // Snapshot: the job mutates its cursor and counts in place between persists.
          const snap = { ...vals } as Row;
          if (vals.cursor && typeof vals.cursor === 'object') snap.cursor = { ...(vals.cursor as Row) };
          if (vals.counts && typeof vals.counts === 'object') snap.counts = { ...(vals.counts as Row) };
          const rec = { table: getTableName(table as Table), vals: snap };
          updates.push(rec);
          const p = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<Row[]> };
          p.returning = async () => (claimRow ? [claimRow] : []);
          return p;
        },
      }),
    }),
    select: () => {
      let table = '';
      const self: any = {
        from: (t: unknown) => {
          table = getTableName(t as Table);
          return self;
        },
        where: () => self,
        orderBy: () => self,
        limit: () => self,
        then: (resolve: (v: Row[]) => void, reject: (e: unknown) => void) => {
          const queue = selects[table] ?? [];
          const next = queue.shift() ?? [];
          Promise.resolve(next).then(resolve, reject);
        },
      };
      return self;
    },
    execute: async (q: unknown) => {
      const { verb, table } = describeSql(q);
      const key = `${verb} ${table}`;
      executed.push(key);
      const queue = executes[key] ?? [];
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? { numberOfRecordsUpdated: 0, rows: [] };
    },
  };
  return { schema, db };
});

const { runDevicePurge } = await import('../src/services/device-purge');

const PURGE = '01997a00-0000-7000-8000-000000000001';
const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_B = '00000000-0000-4000-8000-00000000000b';
const CUTOFF = new Date('2026-09-03T05:00:00.000Z');

function row(over: Partial<Row> = {}): Row {
  return {
    id: PURGE,
    deviceId: DEVICE,
    scopes: ['workflows', 'telemetry', 'media'],
    status: 'running',
    cutoff: CUTOFF,
    cursor: null,
    counts: {},
    ...over,
  };
}

const persistedSteps = () =>
  updates
    .filter((u) => u.table === 'device_purges' && u.vals.cursor)
    .map((u) => (u.vals.cursor as { step: string }).step);

function run(over: { remainingMs?: () => number; receiveCount?: number } = {}) {
  return runDevicePurge({
    bucket: 'b',
    purgeId: PURGE,
    remainingMs: over.remainingMs ?? (() => 600_000),
    receiveCount: over.receiveCount ?? 1,
    log: () => {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  executed.length = 0;
  claimRow = row();
  selects = {
    workflow_runs: [
      [{ id: RUN_A, taskArn: 'arn:task/a' }], // workflows.stop
      [{ id: RUN_A, artifacts: null }, { id: RUN_B, artifacts: null }], // workflows.runs page 1
      [], // page 2 -> next
    ],
  };
  executes = {
    'delete workflow_attachments': [{ numberOfRecordsUpdated: 2 }],
    'delete workflow_runs': [{ numberOfRecordsUpdated: 2 }],
    'delete telemetry_sessions': [{ numberOfRecordsUpdated: 3 }],
    'delete telemetry_ingest_log': [{ numberOfRecordsUpdated: 4 }],
    'select telemetry_readings': [{ rows: [{ oldest: '2026-09-01T10:00:00.000Z' }] }],
    'delete telemetry_readings': [
      { numberOfRecordsUpdated: 5 }, // 09-01
      { numberOfRecordsUpdated: 0 }, // 09-02
      { numberOfRecordsUpdated: 2 }, // 09-03 -> cutoff
    ],
    'delete media_sessions': [{ numberOfRecordsUpdated: 1 }],
  };
  drainPrefix.mockResolvedValue({ complete: true, deleted: 7 });
  ecsSend.mockResolvedValue({});
  enqueueModelJob.mockResolvedValue(undefined);
});

describe('runDevicePurge', () => {
  it('acks when the row cannot be claimed', async () => {
    claimRow = undefined;
    expect(await run()).toBe('skipped');
    expect(executed).toEqual([]);
  });

  it('walks every step in order, persists after each chunk and finishes succeeded', async () => {
    expect(await run()).toBe('done');
    expect(persistedSteps()).toEqual([
      'workflows.stop', // after attachments
      'workflows.runs', // after stop
      'workflows.runs', // page 1 done, more
      'telemetry.s3', // page 2 empty -> next
      'telemetry.sessions',
      'telemetry.ingestLog',
      'telemetry.readings',
      'telemetry.readings', // oldest found
      'telemetry.readings', // 09-01
      'telemetry.readings', // 09-02
      'telemetry.readings', // 09-03
      'media.s3',
      'media.sessions',
      'done',
      'done', // the final status write
    ]);
    const final = updates.at(-1)!.vals;
    expect(final).toMatchObject({ status: 'succeeded', leaseUntil: null });
    expect(final.counts).toEqual({
      attachments: 2,
      runs: 2,
      runObjects: 14, // two runs, one prefix each, 7 objects per drain
      telemetrySessions: 3,
      telemetryObjects: 7,
      ingestLogRows: 4,
      readings: 7,
      mediaSessions: 1,
      mediaObjects: 7,
    });
    // The running Fargate task was stopped and its row flipped before deletion.
    expect(ecsSend).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.table === 'workflow_runs')?.vals).toMatchObject({ status: 'failed', error: 'purged' });
    // Runs are drained by their v2 prefix; the telemetry and media prefixes keep newer uploads.
    expect(drainPrefix).toHaveBeenCalledWith('b', `workflows/v2/runs/${RUN_A}/`);
    expect(drainPrefix).toHaveBeenCalledWith('b', `telemetry/v1/${DEVICE}/`, expect.objectContaining({ olderThan: CUTOFF }));
    expect(drainPrefix).toHaveBeenCalledWith('b', `media-sessions/v1/${DEVICE}/`, expect.objectContaining({ olderThan: CUTOFF }));
    expect(enqueueModelJob).not.toHaveBeenCalled();
  });

  it('resumes from the row\'s cursor and only runs the steps its scopes ask for', async () => {
    claimRow = row({ scopes: ['media'], cursor: { step: 'media.sessions' }, counts: { mediaObjects: 9 } });
    expect(await run()).toBe('done');
    expect(executed).toEqual(['delete media_sessions']);
    expect(drainPrefix).not.toHaveBeenCalled();
    expect(updates.at(-1)!.vals.counts).toMatchObject({ mediaObjects: 9, mediaSessions: 1 });
  });

  it('yields before the budget runs out: persists the cursor and re-enqueues itself', async () => {
    let calls = 0;
    // Enough budget for the first two chunks, then not.
    const remainingMs = () => (calls++ < 2 ? 600_000 : 30_000);
    expect(await run({ remainingMs })).toBe('continued');
    expect(enqueueModelJob).toHaveBeenCalledWith({ kind: 'device_purge', purgeId: PURGE });
    expect(persistedSteps().at(-1)).toBe('workflows.runs');
    expect(updates.at(-1)!.vals.status).toBeUndefined();
  });

  it('carries an S3 continuation token across chunks', async () => {
    claimRow = row({ scopes: ['media'] });
    drainPrefix
      .mockResolvedValueOnce({ complete: false, deleted: 1000, token: 'tok-1' })
      .mockResolvedValueOnce({ complete: true, deleted: 10 });
    expect(await run()).toBe('done');
    expect(drainPrefix).toHaveBeenNthCalledWith(2, 'b', `media-sessions/v1/${DEVICE}/`, expect.objectContaining({ token: 'tok-1' }));
    expect(updates.at(-1)!.vals.counts).toMatchObject({ mediaObjects: 1010 });
  });

  it('halves the readings window on a Data API timeout and carries on', async () => {
    claimRow = row({ scopes: ['telemetry'] });
    const timeout = Object.assign(new Error('cancelled'), { name: 'StatementTimeoutException' });
    executes['delete telemetry_readings'] = [
      timeout, // day window times out
      { numberOfRecordsUpdated: 3 }, // half day
      { numberOfRecordsUpdated: 3 }, // other half
      { numberOfRecordsUpdated: 0 }, // 09-02 first half -> widened back to a day
      { numberOfRecordsUpdated: 0 }, // 09-02T12 .. cutoff (clipped)
    ];
    expect(await run()).toBe('done');
    const spans = updates
      .filter((u) => u.table === 'device_purges' && (u.vals.cursor as { step?: string })?.step === 'telemetry.readings')
      .map((u) => (u.vals.cursor as { spanMs?: number }).spanMs);
    expect(spans[1]).toBe(24 * 60 * 60 * 1000);
    expect(spans[2]).toBe(12 * 60 * 60 * 1000);
    expect(updates.at(-1)!.vals.counts).toMatchObject({ readings: 6 });
    expect(executed.filter((e) => e === 'delete telemetry_readings')).toHaveLength(5);
  });

  it('releases the lease and rethrows on an error SQS will still retry', async () => {
    executes['delete workflow_attachments'] = [new Error('boom')];
    await expect(run({ receiveCount: 1 })).rejects.toThrow('boom');
    expect(updates.at(-1)!.vals).toMatchObject({ leaseUntil: null });
    expect(updates.at(-1)!.vals.status).toBeUndefined();
  });

  it('marks the row failed on the last receive instead of leaving it running', async () => {
    executes['delete workflow_attachments'] = [new Error('boom')];
    expect(await run({ receiveCount: 3 })).toBe('failed');
    expect(updates.at(-1)!.vals).toMatchObject({ status: 'failed', error: 'boom', leaseUntil: null });
  });
});

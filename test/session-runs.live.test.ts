import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExecuteStatementCommand,
  RDSDataClient,
  type ExecuteStatementCommandOutput,
} from '@aws-sdk/client-rds-data';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  foldRunRows,
  runCountQuery,
  runPageQuery,
  type RunMemberSession,
  type RunPageRow,
} from '../src/services/session-runs';

/**
 * The half of the run-clustering contract that only Postgres can answer: which
 * sessions the window function puts in which run. `session-runs.test.ts` covers
 * the fold and the emitted SQL without a database; this file runs the SAME
 * emitted SQL against the dev cluster over the 7 fixture scenarios that
 * `frontend/src/lib/replay/runs.test.ts` defines for `clusterRuns`.
 *
 * Opt-in — it writes to a real database, so `npm test` skips it:
 *
 *   XORGATE_LIVE_DB=1 npx vitest run test/session-runs.live.test.ts
 *
 * Fixtures live on the real test device but in a **timestamp island** (the year
 * 2000, 26 years before any real recording), so they cluster only among
 * themselves and can never merge with production rows. Every fixture session
 * carries a `zz-fixture-` stream key, which is also the cleanup key — an
 * interrupted run is recoverable with:
 *
 *   delete from media_sessions where stream_key like 'zz-fixture-%';
 */

const RESOURCE_ARN = 'arn:aws:rds:us-east-1:111910761410:cluster:epye-sandbox-db';
const SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:111910761410:secret:epye-sandbox/xorgate-db-credentials-PxoDqV';
const DATABASE = process.env.XORGATE_LIVE_DB_NAME ?? 'xorgatedb_dev';
const DEVICE = process.env.XORGATE_LIVE_DEVICE ?? 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';

const FIXTURE_PREFIX = 'zz-fixture-';
/** The island. Every fixture timestamp is an offset from here. */
const T0 = Date.parse('2000-01-01T00:00:00.000Z');
const ISLAND_FROM = '1999-12-01T00:00:00.000Z';
const ISLAND_TO = '2000-02-01T00:00:00.000Z';

const client = new RDSDataClient({ region: 'us-east-1' });
const dialect = new PgDialect();

async function exec(sql: string, params?: unknown[]): Promise<ExecuteStatementCommandOutput> {
  return client.send(
    new ExecuteStatementCommand({
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      sql,
      parameters: params?.map((value, i) => ({
        name: String(i + 1),
        value: value === null ? { isNull: true } : { stringValue: String(value) },
      })),
    }),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run a Drizzle-built statement through the Data API, binding its params. The
 * Lambda gets this for free from the aws-data-api driver; here we reproduce the
 * two things it does that matter — `$n` → `:pn`, and the UUID typeHint without
 * which Postgres rejects `uuid = text`.
 */
async function execBuilt(built: { sql: string; params: unknown[] }) {
  const res = await client.send(
    new ExecuteStatementCommand({
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      sql: built.sql.replace(/\$(\d+)/g, ':p$1'),
      parameters: built.params.map((value, i) => ({
        name: `p${i + 1}`,
        value: { stringValue: String(value) },
        ...(UUID_RE.test(String(value)) ? { typeHint: 'UUID' as const } : {}),
      })),
    }),
  );
  return (res.records ?? []).map((rec) =>
    rec.map((f) => (f.isNull ? null : (Object.values(f)[0] as unknown))),
  );
}

interface Fixture {
  key: string;
  streamKey: string;
  startOffsetMs: number;
  endOffsetMs: number | null;
  /** Uploaded duration, i.e. what an open session's end is estimated from. */
  durationMs: number;
  status?: string;
  timeSource?: string;
}

/** Ids are deterministic so a re-run overwrites rather than accumulates. */
const idFor = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function insertFixtures(fixtures: Fixture[]) {
  await cleanup();
  for (const [i, f] of fixtures.entries()) {
    const id = idFor(i + 1);
    await client.send(
      new ExecuteStatementCommand({
        resourceArn: RESOURCE_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql: `insert into media_sessions
                (id, device_id, stream_key, started_at, ended_at, status, time_source, source)
              values (:id::uuid, :dev::uuid, :sk, :sa::timestamptz,
                      case when :ea = '' then null else :ea::timestamptz end, :st, :ts, 'fixture')`,
        parameters: [
          { name: 'id', value: { stringValue: id } },
          { name: 'dev', value: { stringValue: DEVICE } },
          { name: 'sk', value: { stringValue: FIXTURE_PREFIX + f.streamKey } },
          { name: 'sa', value: { stringValue: new Date(T0 + f.startOffsetMs).toISOString() } },
          {
            name: 'ea',
            value: {
              stringValue:
                f.endOffsetMs === null ? '' : new Date(T0 + f.endOffsetMs).toISOString(),
            },
          },
          { name: 'st', value: { stringValue: f.status ?? 'closed' } },
          { name: 'ts', value: { stringValue: f.timeSource ?? 'ntp' } },
        ],
      }),
    );
    // One segment carrying the whole uploaded duration — enough for the rollups
    // the run aggregates and for the open-session end estimate.
    await client.send(
      new ExecuteStatementCommand({
        resourceArn: RESOURCE_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql: `insert into media_segments
                (device_id, session_id, stream_key, s3_key, seq, start_ts, duration_ms, size_bytes)
              values (:dev::uuid, :id::uuid, :sk, :key, 0, :sa::timestamptz, :dur, 1000)`,
        parameters: [
          { name: 'dev', value: { stringValue: DEVICE } },
          { name: 'id', value: { stringValue: id } },
          { name: 'sk', value: { stringValue: FIXTURE_PREFIX + f.streamKey } },
          { name: 'key', value: { stringValue: `fixture/${id}/0.mp4` } },
          { name: 'sa', value: { stringValue: new Date(T0 + f.startOffsetMs).toISOString() } },
          { name: 'dur', value: { longValue: f.durationMs } },
        ],
      }),
    );
  }
}

async function cleanup() {
  await exec(`delete from media_sessions where stream_key like '${FIXTURE_PREFIX}%'`);
  await exec(`delete from media_segments where s3_key like 'fixture/%'`);
}

/** Cluster the island and return the runs the API would emit for it. */
async function islandRuns() {
  const built = dialect.sqlToQuery(
    runPageQuery(
      DEVICE,
      { from: ISLAND_FROM, to: ISLAND_TO },
      { limit: 50, offset: 0, order: 'desc' },
    ),
  );
  const rows = (await execBuilt(built)) as [string, number, number][];
  const pageRows: RunPageRow[] = rows.map(([session_id, run_no, rn]) => ({
    session_id,
    run_no: Number(run_no),
    rn: Number(rn),
  }));

  const detail = await exec(
    `select id::text, stream_key, started_at::text, coalesce(ended_at::text,''), status,
            coalesce(time_source,''),
            (select count(*) from media_segments g where g.session_id = s.id)::int,
            (select coalesce(sum(size_bytes),0) from media_segments g where g.session_id = s.id)::int,
            (select coalesce(sum(duration_ms),0) from media_segments g where g.session_id = s.id)::int
       from media_sessions s where stream_key like '${FIXTURE_PREFIX}%'`,
  );
  const byId = new Map<string, RunMemberSession>();
  for (const rec of detail.records ?? []) {
    const v = rec.map((f) => (f.isNull ? null : (Object.values(f)[0] as string | number)));
    byId.set(String(v[0]), {
      id: String(v[0]),
      streamKey: String(v[1]),
      startedAt: new Date(String(v[2]).replace(' ', 'T').replace('+00', 'Z')),
      endedAt: v[3] ? new Date(String(v[3]).replace(' ', 'T').replace('+00', 'Z')) : null,
      status: String(v[4]),
      timeSource: v[5] ? String(v[5]) : null,
      segmentCount: Number(v[6]),
      totalBytes: Number(v[7]),
      totalDurationMs: Number(v[8]),
    });
  }
  return foldRunRows(pageRows, byId);
}

async function islandCount(filters: Record<string, string> = {}) {
  const built = dialect.sqlToQuery(
    runCountQuery(DEVICE, { from: ISLAND_FROM, to: ISLAND_TO, ...filters }),
  );
  const rows = await execBuilt(built);
  return Number(rows[0]?.[0] ?? 0);
}

// The dual-cam shape, matching the frontend fixture: cam1 starts 2 s after cam0.
const CAM0: Fixture = {
  key: 'cam0',
  streamKey: 'cam0',
  startOffsetMs: 0,
  endOffsetMs: 1_800_000,
  durationMs: 1_800_000,
};
const CAM1: Fixture = {
  key: 'cam1',
  streamKey: 'cam1',
  startOffsetMs: 2_000,
  endOffsetMs: 1_802_000,
  durationMs: 1_800_000,
};

describe.skipIf(!process.env.XORGATE_LIVE_DB)('run clustering against Postgres', () => {
  beforeAll(async () => {
    await cleanup();
  }, 60_000);
  afterAll(async () => {
    await cleanup();
  }, 60_000);

  it('clusters overlapping dual-cam sessions into one run (case 1)', async () => {
    await insertFixtures([CAM0, CAM1]);
    const runs = await islandRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].streamKeys).toEqual([`${FIXTURE_PREFIX}cam0`, `${FIXTURE_PREFIX}cam1`]);
    expect(runs[0].fromTs).toBe(new Date(T0).toISOString());
    expect(runs[0].toTs).toBe(new Date(T0 + 1_802_000).toISOString());
    expect(await islandCount()).toBe(1);
  }, 120_000);

  it('joins a capture restart within the gap tolerance (case 2)', async () => {
    // 28 s after cam1's end — inside the 60 s tolerance.
    await insertFixtures([
      CAM0,
      CAM1,
      { key: 'restart', streamKey: 'cam0', startOffsetMs: 1_830_000, endOffsetMs: 2_400_000, durationMs: 570_000 },
    ]);
    const runs = await islandRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].toTs).toBe(new Date(T0 + 2_400_000).toISOString());
  }, 120_000);

  it('splits runs separated by more than the tolerance (case 3)', async () => {
    // 61 s after cam1's end — outside the tolerance.
    await insertFixtures([
      CAM0,
      CAM1,
      { key: 'later', streamKey: 'cam0', startOffsetMs: 1_863_000, endOffsetMs: 2_400_000, durationMs: 537_000 },
    ]);
    const runs = await islandRuns();
    expect(runs).toHaveLength(2);
    // Newest-first table order.
    expect(runs[0].fromTs).toBe(new Date(T0 + 1_863_000).toISOString());
    expect(runs[1].fromTs).toBe(new Date(T0).toISOString());
    expect(await islandCount()).toBe(2);
  }, 120_000);

  it('keeps single sessions as single-session runs (case 4)', async () => {
    await insertFixtures([
      { key: 'lone', streamKey: 'cam0', startOffsetMs: -86_400_000, endOffsetMs: -86_340_000, durationMs: 60_000 },
      CAM0,
      CAM1,
    ]);
    const runs = await islandRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1].sessionCount).toBe(1);
    expect(runs[1].streamKeys).toEqual([`${FIXTURE_PREFIX}cam0`]);
  }, 120_000);

  it('spans an open session over its uploaded duration and flags the run (case 5)', async () => {
    await insertFixtures([
      { key: 'open', streamKey: 'cam0', startOffsetMs: 0, endOffsetMs: null, durationMs: 300_000, status: 'open' },
    ]);
    const runs = await islandRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].toTs).toBe(new Date(T0 + 300_000).toISOString());
    expect(runs[0].anyOpen).toBe(true);
  }, 120_000);

  it('flags unsynced members (case 6)', async () => {
    await insertFixtures([CAM0, { ...CAM1, timeSource: 'unsynced' }]);
    const runs = await islandRuns();
    expect(runs[0].anyUnsynced).toBe(true);
  }, 120_000);

  it('chains overlap transitively — A↔B overlap, B↔C adjacent (case 7)', async () => {
    await insertFixtures([
      CAM0,
      CAM1,
      // Within tolerance of cam1's end only, not cam0's.
      { key: 'c', streamKey: 'cam0', startOffsetMs: 1_810_000, endOffsetMs: 2_000_000, durationMs: 190_000 },
    ]);
    const runs = await islandRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].sessionCount).toBe(3);
  }, 120_000);

  it('option (b): a streamKey filter returns the whole run, every camera intact', async () => {
    await insertFixtures([CAM0, CAM1]);
    const built = dialect.sqlToQuery(
      runPageQuery(
        DEVICE,
        { from: ISLAND_FROM, to: ISLAND_TO, streamKey: `${FIXTURE_PREFIX}cam0` },
        { limit: 50, offset: 0, order: 'desc' },
      ),
    );
    const rows = await execBuilt(built);
    // The run matched on cam0 — but BOTH its sessions come back.
    expect(rows).toHaveLength(2);
    expect(await islandCount({ streamKey: `${FIXTURE_PREFIX}cam0` })).toBe(1);
  }, 120_000);

  it('option (b): a range that clips a run still returns it whole', async () => {
    await insertFixtures([CAM0, CAM1]);
    const built = dialect.sqlToQuery(
      runPageQuery(
        DEVICE,
        // A 1-minute window in the MIDDLE of the 30-minute run.
        {
          from: new Date(T0 + 600_000).toISOString(),
          to: new Date(T0 + 660_000).toISOString(),
        },
        { limit: 50, offset: 0, order: 'desc' },
      ),
    );
    const rows = await execBuilt(built);
    expect(rows).toHaveLength(2);
  }, 120_000);
});

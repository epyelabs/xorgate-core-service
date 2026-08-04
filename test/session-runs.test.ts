import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  RUN_GAP_TOLERANCE_MS,
  foldRunRows,
  runCountQuery,
  runPageQuery,
  type RunMemberSession,
  type RunPageRow,
} from '../src/services/session-runs';

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const dialect = new PgDialect();
const render = (sql: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(sql).sql;

const T0 = Date.parse('2026-07-20T16:00:00.000Z');

// Mirrors the frontend fixture in src/lib/replay/runs.test.ts so the two suites
// describe the same sessions.
function session(
  partial: Partial<RunMemberSession> & { id: string; startedAt: Date },
): RunMemberSession {
  return {
    streamKey: 'cam0',
    endedAt: null,
    status: 'closed',
    timeSource: 'ntp',
    segmentCount: 10,
    totalBytes: 100_000_000,
    totalDurationMs: 600_000,
    ...partial,
  };
}

const at = (ms: number) => new Date(T0 + ms);

/** The rows runPageQuery emits: one per session, tagged with its run. */
function pageRows(...groups: RunMemberSession[][]): RunPageRow[] {
  return groups.flatMap((members, i) =>
    members.map((m) => ({ session_id: m.id, run_no: i + 1, rn: i + 1 })),
  );
}

const byId = (...members: RunMemberSession[]) => new Map(members.map((m) => [m.id, m]));

// --- The dual-cam shape: cam1 starts 2 s after cam0 (pipeline stagger). ---
const cam0 = session({
  id: 's-cam0',
  startedAt: at(0),
  endedAt: at(1_800_000),
  totalDurationMs: 1_800_000,
});
const cam1 = session({
  id: 's-cam1',
  streamKey: 'cam1',
  startedAt: at(2_000),
  endedAt: at(1_802_000),
  totalDurationMs: 1_800_000,
});

/**
 * Aggregation half of the 7 clustering cases that `frontend/src/lib/replay/
 * runs.test.ts` defines. The other half — which sessions land in which run — is
 * decided by the window function, so it is covered against the real SQL in
 * `session-runs.live.test.ts`.
 */
describe('foldRunRows', () => {
  it('folds overlapping dual-cam sessions into one run (case 1)', () => {
    const [run] = foldRunRows(pageRows([cam0, cam1]), byId(cam0, cam1));
    expect(run.sessions.map((s) => s.id)).toEqual(['s-cam0', 's-cam1']);
    expect(run.streamKeys).toEqual(['cam0', 'cam1']);
    expect(run.sessionCount).toBe(2);
    expect(run.fromTs).toBe(new Date(T0).toISOString());
    expect(run.toTs).toBe(new Date(T0 + 1_802_000).toISOString());
    expect(run.segmentCount).toBe(20);
    expect(run.totalBytes).toBe(200_000_000);
    expect(run.anyOpen).toBe(false);
    expect(run.anyUnsynced).toBe(false);
  });

  it('extends toTs to the run\'s max end, not its last member\'s (case 2)', () => {
    // A capture restart that ends BEFORE the long cam1 session already in the
    // run must not shorten the run — `toMs = max(...)`, never "the last one".
    const restart = session({
      id: 's-restart',
      startedAt: at(1_500_000),
      endedAt: at(1_600_000),
    });
    const [run] = foldRunRows(pageRows([cam0, cam1, restart]), byId(cam0, cam1, restart));
    expect(run.toTs).toBe(new Date(T0 + 1_802_000).toISOString());
    expect(run.sessionCount).toBe(3);
  });

  it('keeps separate runs separate and keys each on its own earliest member (cases 3, 4)', () => {
    const later = session({ id: 's-later', startedAt: at(1_863_000), endedAt: at(2_400_000) });
    const runs = foldRunRows(pageRows([later], [cam0, cam1]), byId(later, cam0, cam1));
    expect(runs).toHaveLength(2);
    expect(runs[0].key).toBe('s-later');
    expect(runs[0].sessionCount).toBe(1);
    expect(runs[0].streamKeys).toEqual(['cam0']);
    expect(runs[1].key).toBe('s-cam0');
  });

  it('spans an open session over its uploaded duration and flags the run (case 5)', () => {
    const open = session({
      id: 's-open',
      status: 'open',
      startedAt: at(0),
      endedAt: null,
      totalDurationMs: 300_000,
    });
    const [run] = foldRunRows(pageRows([open]), byId(open));
    expect(run.toTs).toBe(new Date(T0 + 300_000).toISOString());
    expect(run.anyOpen).toBe(true);
  });

  it('flags unsynced members (case 6)', () => {
    const unsynced = { ...cam1, timeSource: 'unsynced' };
    const [run] = foldRunRows(pageRows([cam0, unsynced]), byId(cam0, unsynced));
    expect(run.anyUnsynced).toBe(true);
  });

  it('accumulates every member of a transitively chained run (case 7)', () => {
    const c = session({ id: 's-c', startedAt: at(1_810_000), endedAt: at(2_000_000) });
    const [run] = foldRunRows(pageRows([cam0, cam1, c]), byId(cam0, cam1, c));
    expect(run.sessions).toHaveLength(3);
    expect(run.toTs).toBe(new Date(T0 + 2_000_000).toISOString());
    expect(run.segmentCount).toBe(30);
  });

  it('dedupes and sorts stream keys', () => {
    const b = session({ id: 's-b', streamKey: 'cam1', startedAt: at(1_000) });
    const a = session({ id: 's-a', streamKey: 'cam0', startedAt: at(2_000) });
    const [run] = foldRunRows(pageRows([b, a, { ...cam1, id: 's-d' }]), byId(b, a, { ...cam1, id: 's-d' }));
    expect(run.streamKeys).toEqual(['cam0', 'cam1']);
  });

  it('takes fromTs from the earliest member even if rows arrive out of order', () => {
    const early = session({ id: 's-early', startedAt: at(-5_000), endedAt: at(10_000) });
    const [run] = foldRunRows(pageRows([cam0, early]), byId(cam0, early));
    expect(run.fromTs).toBe(new Date(T0 - 5_000).toISOString());
    // `key` follows the row order the query guarantees, not the recomputed min:
    // it is the id the pager and React keyed on.
    expect(run.key).toBe('s-cam0');
  });

  it('skips a session deleted between the two statements rather than emitting a hole', () => {
    const runs = foldRunRows(pageRows([cam0, cam1]), byId(cam1));
    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe('s-cam1');
    expect(runs[0].sessionCount).toBe(1);
  });

  it('returns no runs for no rows', () => {
    expect(foldRunRows([], byId())).toEqual([]);
  });
});

describe('run clustering SQL', () => {
  it('derives the gap tolerance from the shared constant, not a literal interval', () => {
    const sql = render(runPageQuery(DEVICE, {}, { limit: 25, offset: 0, order: 'desc' }));
    expect(sql).toContain(`make_interval(secs => ${RUN_GAP_TOLERANCE_MS} / 1000.0)`);
    expect(sql).not.toContain("interval '60 seconds'");
  });

  it('clusters over the UNFILTERED session set — predicates never reach the `s` CTE', () => {
    // ⚠ This is the regression guard for Q1/option (b). If a future "efficiency"
    // change pushes streamKey/status/from/to up into `s`, a 3-camera run
    // filtered to cam0 silently renders as a 1-camera run again.
    const sql = render(
      runPageQuery(
        DEVICE,
        { streamKey: 'cam0', status: 'closed', from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
        { limit: 25, offset: 0, order: 'desc' },
      ),
    );
    const beforeMarked = sql.slice(0, sql.indexOf('marked as ('));
    expect(beforeMarked).not.toContain('stream_key =');
    expect(beforeMarked).not.toContain('status =');
    expect(beforeMarked).not.toContain('coalesce(ended_at, started_at) >=');

    const matching = sql.slice(sql.indexOf('matching as ('), sql.indexOf('ranked as ('));
    expect(matching).toContain('stream_key =');
    expect(matching).toContain('status =');
    expect(matching).toContain('coalesce(ended_at, started_at) >=');
    expect(matching).toContain('started_at <');
  });

  it('keeps the ungrouped endpoint\'s overlap semantics for the range filter', () => {
    const sql = render(
      runCountQuery(DEVICE, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' }),
    );
    // Started-before-`from`-but-still-recording must match, hence coalesce on
    // the end, and the `to` bound is exclusive on the start.
    expect(sql).toMatch(/coalesce\(ended_at, started_at\) >= \$\d+::timestamptz/);
    expect(sql).toMatch(/started_at < \$\d+::timestamptz/);
  });

  it('applies no predicate when unfiltered', () => {
    const sql = render(runCountQuery(DEVICE, {}));
    expect(sql).toContain('select distinct run_no from grouped where true');
  });

  it('counts runs, not sessions', () => {
    const sql = render(runCountQuery(DEVICE, {}));
    expect(sql).toContain('group by run_no) r');
  });

  it('paginates on the run rank so a run can never straddle a page boundary', () => {
    const sql = render(runPageQuery(DEVICE, {}, { limit: 25, offset: 50, order: 'desc' }));
    expect(sql).toContain('row_number() over (order by f desc) as rn');
    expect(sql).toContain('where p.rn > 50 and p.rn <= 75');
    expect(sql).toContain('order by p.rn, g.started_at, g.stream_key');
  });

  it('honours order=asc', () => {
    const sql = render(runPageQuery(DEVICE, {}, { limit: 4, offset: 0, order: 'asc' }));
    expect(sql).toContain('row_number() over (order by f asc) as rn');
    expect(sql).toContain('where p.rn > 0 and p.rn <= 4');
  });

  it('estimates an open session\'s end from its uploaded duration, like the fold does', () => {
    const sql = render(runCountQuery(DEVICE, {}));
    expect(sql).toContain('greatest(coalesce(a.dur_ms, 0), 0) / 1000.0');
    expect(sql).toContain('greatest(media_sessions.ended_at, media_sessions.started_at)');
  });
});

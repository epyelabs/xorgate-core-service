import { eq, sql, type SQL } from 'drizzle-orm';
import { mediaSegments, mediaSessions } from '../db/schema';
import { tsParam } from '../utils/sql';

/**
 * Server-side RECORDING RUN grouping for `GET /devices/{id}/sessions?group=runs`
 * (improve-recording-history-fetching plan, Phase 3).
 *
 * One drive with N cameras produces N per-camera `media_sessions` rows. The
 * Media Recordings table — and Overview's "Recent on-device recordings" — do not
 * render sessions, they render **runs**: sessions clustered by time overlap.
 * That clustering used to happen in the browser over whatever one page returned
 * (`frontend/src/lib/replay/runs.ts` `clusterRuns`), which meant the server
 * paginated sessions while the UI displayed runs. Measured consequences on the
 * dev test device: pages of 21, 13, 8, 11, 4… rows at a page size of 25; seven
 * runs straddling a page boundary rendered twice as partial runs with wrong
 * durations, segment counts and camera lists; and a footer counting sessions
 * under a table of runs. Grouping here makes the API paginate the thing the UI
 * shows.
 *
 * Scale is a non-issue and must not be used to justify "optimising" this: the
 * whole table is ~256 rows for the busiest device in dev and ~2 300 segments.
 *
 * ## Why the SQL window is equivalent to `clusterRuns`
 *
 * `clusterRuns` compares each session's start against the running max end
 * **within the current cluster**; the window below compares against the running
 * max end over **all preceding rows**. These are equal:
 *
 * > A new cluster starts only when its first session's start exceeds the
 * > previous cluster's max end plus the tolerance. So each cluster's max end
 * > strictly exceeds the previous cluster's, i.e. the per-cluster maxima are
 * > monotonically increasing — which makes the global running max identical to
 * > the current cluster's max at every row.
 *
 * Without that note the next reader will assume the two differ and "fix" one of
 * them. Verified empirically as well: over all 256 sessions of device
 * `a73f7a36-2a9c-45c4-a66c-54d3b018a7f7` on 2026-08-04 this SQL and
 * `clusterRuns` produced the same 98 runs, field for field (key, from, to,
 * session count, stream keys, segment count, bytes, open flag).
 *
 * ## Filter semantics — Q1, answered by the user 2026-08-03: option (b)
 *
 * Clustering runs over the device's **unfiltered** sessions; filters then select
 * *which runs to show*, never which sessions to cluster. `streamKey=cam0`
 * returns the runs in which cam0 recorded, with every camera in those runs still
 * present; a date range returns runs that overlap it, whole rather than clipped.
 * That is why the predicates live in the `matching` CTE **downstream** of
 * `grouped` — see the warning on `matchingCte`.
 */

/**
 * A session that starts within this of the running max end joins the same run.
 * Covers capture restarts and per-camera pipeline start staggers; the device
 * rotates segments every ~60 s, so a genuinely separate recording is minutes
 * away in practice.
 *
 * ⚠ Single source of truth for the backend. The frontend mirror is
 * `RUN_GAP_TOLERANCE_MS` in `src/lib/replay/runs.ts`; the two must agree or the
 * Media tab and the API will disagree about what a run is. Never write
 * `interval '60 seconds'` inline — every use goes through this constant.
 */
export const RUN_GAP_TOLERANCE_MS = 60_000;

/** Filters applied to whole runs (never to the sessions being clustered). */
export interface RunFilters {
  streamKey?: string;
  status?: string;
  /** ISO-8601, already normalized by `parseListParams`. */
  from?: string;
  to?: string;
}

/**
 * `agg` / `s` / `marked` / `grouped` — the clustering chain, minus the leading
 * `with`. Every query below starts from this and differs only in what it
 * selects out of `grouped`.
 *
 * `s` is deliberately the device's ENTIRE session set: no filter predicate may
 * appear here (see `matchingCte`). `end_eff` mirrors `clusterRuns`'s `endMs`
 * exactly, including the `greatest()` guards for an `ended_at` that precedes
 * `started_at` and for a negative duration rollup.
 *
 * The `order by started_at, stream_key` tie-break matches the frontend's
 * `startMs(a) - startMs(b) || streamKey.localeCompare(...)`. For the stream keys
 * these devices emit (`cam0`, `cam1`, …) the database collation and
 * `localeCompare` agree; the tie-break only decides which of two
 * same-millisecond sessions is the run's `key`, never which run they land in.
 */
function clusteringCtes(deviceId: string): SQL {
  const toleranceMs = sql.raw(String(RUN_GAP_TOLERANCE_MS));
  return sql`agg as (
  select session_id,
         count(*)::int                        as segs,
         coalesce(sum(size_bytes), 0)::bigint as bytes,
         coalesce(sum(duration_ms), 0)::bigint as dur_ms
  from ${mediaSegments}
  where ${eq(mediaSegments.deviceId, deviceId)}
  group by session_id
), s as (
  select media_sessions.id,
         media_sessions.stream_key,
         media_sessions.started_at,
         media_sessions.ended_at,
         media_sessions.status,
         case
           when media_sessions.ended_at is not null
             then greatest(media_sessions.ended_at, media_sessions.started_at)
           else media_sessions.started_at
                + make_interval(secs => greatest(coalesce(a.dur_ms, 0), 0) / 1000.0)
         end as end_eff
  from ${mediaSessions}
  left join agg a on a.session_id = media_sessions.id
  where ${eq(mediaSessions.deviceId, deviceId)}
), marked as (
  select s.*,
         case when started_at > max(end_eff) over (
                order by started_at, stream_key
                rows between unbounded preceding and 1 preceding
              ) + make_interval(secs => ${toleranceMs} / 1000.0)
              then 1 else 0 end as new_run
  from s
), grouped as (
  select marked.*,
         sum(new_run) over (order by started_at, stream_key rows unbounded preceding) as run_no
  from marked
)`;
}

/**
 * `matching` — the runs to show — and nothing else.
 *
 * ⚠ **Do not push these predicates up into the `s` CTE "for efficiency".** That
 * silently reverts to option (a): clustering only the *matching* sessions, so a
 * three-camera run filtered to `cam0` renders as a one-camera run with a wrong
 * duration and segment count, and a date range clips a run at the window edge.
 * That is the exact bug this phase exists to remove, and moving the predicates
 * looks like a harmless optimisation to a reviewer. The whole table is a few
 * hundred rows; there is nothing to optimise.
 *
 * Range semantics are the ungrouped endpoint's, unchanged: a session OVERLAPS
 * `[from, to)`. A run matches when *any* of its sessions does, and it is then
 * returned whole.
 */
function matchingCte(f: RunFilters): SQL {
  const preds: SQL[] = [];
  if (f.streamKey !== undefined) preds.push(sql`stream_key = ${f.streamKey}`);
  if (f.status !== undefined) preds.push(sql`status = ${f.status}`);
  if (f.from !== undefined) {
    preds.push(sql`coalesce(ended_at, started_at) >= ${tsParam(f.from)}`);
  }
  if (f.to !== undefined) preds.push(sql`started_at < ${tsParam(f.to)}`);
  const where = preds.length ? sql.join(preds, sql` and `) : sql`true`;
  return sql`matching as (
  select distinct run_no from grouped where ${where}
)`;
}

/**
 * How many runs match — the new `page.total`. Counts RUNS, not sessions: the
 * footer under a table of runs must count runs.
 *
 * `media_sessions` is ~256 rows for the busiest dev device, so this stays an
 * exact count. It must NOT adopt the `totalIsCapped` treatment Phase 1 added
 * for `/telemetry/readings` — that endpoint's table is 3 700× larger.
 */
export function runCountQuery(deviceId: string, filters: RunFilters): SQL {
  return sql`with ${clusteringCtes(deviceId)}, ${matchingCte(filters)}
select count(*)::int as total
from (select run_no from grouped where run_no in (select run_no from matching) group by run_no) r`;
}

/**
 * The page's sessions, pre-assigned to runs and ordered so the handler can fold
 * them without re-clustering.
 *
 * The page boundary is on `rn`, which ranks RUNS — so a run can never be split
 * across pages, which is the whole point. Returning the member sessions rather
 * than only the run aggregates is **not** "assembling on the server side of the
 * same mistake": the rows arrive pre-assigned, ordered and contiguous, so the
 * handler is deserializing a grouped result, not clustering an arbitrary page.
 * At 25 runs the page carries ~68 sessions for this device (256/98 ≈ 2.6
 * average, max 16), which keeps the row's expand interaction working without a
 * second request.
 *
 * ⚠ `run_no` is a positional counter, not an identity — it shifts the moment an
 * older session is inserted. The run's stable key is its earliest session's id,
 * which the fold takes from the first row of each group (hence the
 * `g.started_at, g.stream_key` tie-break in the ordering).
 */
export function runPageQuery(
  deviceId: string,
  filters: RunFilters,
  page: { limit: number; offset: number; order: 'asc' | 'desc' },
): SQL {
  // parseListParams has already validated both as non-negative integers; they
  // are inlined because the Data API binds params as stringValue, which
  // Postgres rejects in `limit $n` (same reason `tsParam` exists).
  const lo = sql.raw(String(page.offset));
  const hi = sql.raw(String(page.offset + page.limit));
  const dir = sql.raw(page.order === 'asc' ? 'asc' : 'desc');
  return sql`with ${clusteringCtes(deviceId)}, ${matchingCte(filters)}, ranked as (
  select run_no, min(started_at) as f
  from grouped
  where run_no in (select run_no from matching)
  group by run_no
), page as (
  select run_no, row_number() over (order by f ${dir}) as rn from ranked
)
select g.id as session_id, p.run_no::int as run_no, p.rn::int as rn
from grouped g join page p using (run_no)
where p.rn > ${lo} and p.rn <= ${hi}
order by p.rn, g.started_at, g.stream_key`;
}

/** One row of `runPageQuery`. Raw `db.execute` returns snake_case scalars. */
export interface RunPageRow extends Record<string, unknown> {
  session_id: string;
  run_no: number;
  rn: number;
}

/**
 * The session fields a run's aggregates are computed from. Structurally the
 * subset of a `media_sessions` row (plus its computed rollups) that
 * `clusterRuns` reads, so the handler can pass its response objects straight in.
 */
export interface RunMemberSession {
  id: string;
  streamKey: string;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
  timeSource: string | null;
  segmentCount: number;
  totalBytes: number;
  /** Sum of the members' uploaded segment durations — the open-session estimate. */
  totalDurationMs: number;
}

/** A run as the API returns it. `sessions` are the members, ordered. */
export interface SessionRun<S extends RunMemberSession> {
  /** Stable identity for React keys/expansion: the earliest session's id. */
  key: string;
  fromTs: string;
  toTs: string;
  streamKeys: string[];
  sessionCount: number;
  segmentCount: number;
  totalBytes: number;
  anyOpen: boolean;
  anyUnsynced: boolean;
  sessions: S[];
}

/**
 * A session's interval end for clustering and for the run's replay window — the
 * exact port of `clusterRuns`'s `endMs`. An open session has no `ended_at` yet,
 * so its end is estimated from the duration actually uploaded. That is an
 * under-estimate while a backlog drains, which is why a run's boundaries can
 * shift between polls; consistent with the replay page's "reload to extend".
 *
 * ⚠ Must stay identical to the `end_eff` expression in `clusteringCtes` AND to
 * the frontend's `endMs`. The replay window is computed from `toTs`, so drift
 * here silently shifts what gets played.
 */
function sessionEndMs(s: RunMemberSession): number {
  const start = s.startedAt.getTime();
  if (s.endedAt) {
    const ended = s.endedAt.getTime();
    if (!Number.isNaN(ended)) return Math.max(ended, start);
  }
  return start + Math.max(s.totalDurationMs, 0);
}

/**
 * Fold `runPageQuery`'s rows into run objects.
 *
 * Input must be in the query's order: run rank first, then `started_at`,
 * `stream_key` — so each group is contiguous and its first member is the
 * earliest, which becomes the run's `key`. Sessions with no matching row in
 * `sessionsById` are skipped (a delete racing the two statements), and a run
 * left with no members is dropped rather than emitted empty.
 *
 * Every aggregate mirrors `clusterRuns`: `segmentCount`/`totalBytes` sum the
 * members' rollups, `streamKeys` is the deduped sorted set, `anyOpen`/
 * `anyUnsynced` are member disjunctions, and `fromTs`/`toTs` are the earliest
 * start and the max effective end.
 */
export function foldRunRows<S extends RunMemberSession>(
  rows: readonly RunPageRow[],
  sessionsById: ReadonlyMap<string, S>,
): SessionRun<S>[] {
  const runs: SessionRun<S>[] = [];
  let currentRunNo: number | null = null;
  let fromMs = 0;
  let toMs = 0;

  for (const row of rows) {
    const session = sessionsById.get(row.session_id);
    if (!session) continue;
    const runNo = Number(row.run_no);

    if (currentRunNo !== runNo || runs.length === 0) {
      currentRunNo = runNo;
      fromMs = session.startedAt.getTime();
      toMs = sessionEndMs(session);
      runs.push({
        key: session.id,
        fromTs: new Date(fromMs).toISOString(),
        toTs: new Date(toMs).toISOString(),
        streamKeys: [session.streamKey],
        sessionCount: 1,
        segmentCount: session.segmentCount,
        totalBytes: session.totalBytes,
        anyOpen: session.status === 'open',
        anyUnsynced: session.timeSource === 'unsynced',
        sessions: [session],
      });
      continue;
    }

    const run = runs[runs.length - 1];
    run.sessions.push(session);
    run.sessionCount += 1;
    run.segmentCount += session.segmentCount;
    run.totalBytes += session.totalBytes;
    run.anyOpen ||= session.status === 'open';
    run.anyUnsynced ||= session.timeSource === 'unsynced';
    if (!run.streamKeys.includes(session.streamKey)) run.streamKeys.push(session.streamKey);
    fromMs = Math.min(fromMs, session.startedAt.getTime());
    toMs = Math.max(toMs, sessionEndMs(session));
    run.fromTs = new Date(fromMs).toISOString();
    run.toTs = new Date(toMs).toISOString();
  }

  for (const run of runs) run.streamKeys.sort();
  return runs;
}

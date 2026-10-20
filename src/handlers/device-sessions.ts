import { routeKey as canonicalRouteKey } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DeleteObjectsCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { badRequest, conflict, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams, type ListParams } from '../utils/list-params';
import { tsParam } from '../utils/sql';
import { closeStaleMediaSessions } from '../services/media-sessions';
import { recordingConfig } from '../config/recording';
import { nominalSegmentMs } from '../services/clock-step';
import { closeStaleTelemetrySessions } from '../services/telemetry-sessions';
import {
  buildSessionTimeline,
  buildTelemetryManifest,
  REPLAY_TELEMETRY_MAX_SEGMENTS,
  type ReplayTelemetry,
  type SessionTimeline,
} from '../services/replay-manifest';
import {
  foldRunRows,
  runCountQuery,
  runPageQuery,
  type RunFilters,
  type RunPageRow,
} from '../services/session-runs';
import { apiHandler } from '../utils/api-handler';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const PLAYBACK_TTL_SECONDS = 3600;

// Replay manifest (Composite Replays plan, Phase 2 — decision R3): one
// response carries every presigned URL the player needs, so cap what one
// request may expand into. 600 segments ≈ 10 h of 60 s video; the session and
// range caps only bind in ?from&to (composite) mode.
const REPLAY_MAX_SEGMENTS = 600;
const REPLAY_MAX_SESSIONS = 10;
const REPLAY_MAX_RANGE_MS = 24 * 60 * 60 * 1000;
// Telemetry sessions overlapping the replay window ride along with their
// presigned overview + segment URLs (telemetry-session-artifacts plan, Phase
// 2). Their cap is separate from the video one (README Q7) and is honoured by
// truncation, never a 400: services/replay-manifest.ts REPLAY_TELEMETRY_MAX_SEGMENTS.
// Clients refetch the manifest when urlExpiresAt nears; report expiry with a
// safety margin so they refresh BEFORE URLs actually die mid-scrub.
const REPLAY_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * APIs over device-recorded media sessions/segments (offline recording plan,
 * Phase 4 — the index Composite Replays will consume). Routes (all → this
 * Lambda; rows are populated by media-segment-ingest):
 *   GET    /devices/{id}/sessions                                  list + per-session rollups
 *   GET    /devices/{id}/sessions?group=runs                       the same list paginated by
 *            RECORDING RUN (time-clustered sessions), members nested — Phase 3
 *            of improve-recording-history-fetching; services/session-runs.ts
 *   GET    /devices/{id}/sessions/{sessionId}/segments             ordered segment index
 *   GET    /devices/{id}/sessions/{sessionId}/segments/{seq}/playback  presigned GET
 *   GET    /devices/{id}/replay-manifest?sessionId=… | ?from&to[&streamKey]
 *            gap-aware replay timeline + batch-presigned segment URLs (R3)
 *   DELETE /devices/{id}/sessions/{sessionId}                      segments (S3+rows) + session
 * Ownership: the device must belong to a workspace in the caller's org (same
 * check as devices.ts). Response casing: drizzle camelCase rows, matching the
 * dialect every other device sub-resource uses.
 */
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const deviceId = event.pathParameters?.id;
  const sessionId = event.pathParameters?.sessionId;

  if (!deviceId) return notFound('Device "" not found');

  let auth;
  try {
    // DELETE destroys recorded data — restrict to owner/admin. A
    // device-recorded session is not re-creatable, and since Phase W it is
    // also a workflow video input, so a delete can invalidate future runs.
    auth = await requireOrgContext(
      event,
      method === 'DELETE' ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);

  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, deviceId),
      inArray(schema.devices.workspaceId, orgWorkspaceIds),
    ),
    columns: { id: true, recordingConfig: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

  async function loadSession() {
    return db.query.mediaSessions.findFirst({
      where: and(
        eq(schema.mediaSessions.id, sessionId as string),
        eq(schema.mediaSessions.deviceId, deviceId as string),
      ),
    });
  }

  switch (routeKey) {
    case 'GET /devices/{id}/sessions': {
      // Close-on-read (Phase 6.4 dev-UX decision): the sweeper schedule is OFF
      // in dev (Aurora auto-pause), so without this, sessions sit at
      // status='open' ("Receiving") forever. Running the same advisory close —
      // device-scoped — on every list keeps statuses honest wherever anyone is
      // actually looking, with zero new infra and no new DB wake source (the
      // list is already a DB call). In prod it coexists with the 1-min
      // schedule; both are idempotent. Best-effort: a close failure must not
      // break the listing. Fires session_completed triggers on transitions,
      // same as the sweeper (at-least-once contract).
      // Skipped where the sweeper schedule runs (prod): there it closes the
      // same sessions within a minute, and this transaction is three Data API
      // round trips on every list (a third of a warm `?group=runs` read).
      if (!recordingConfig.sweeperScheduled) {
        try {
          await closeStaleMediaSessions(deviceId);
        } catch (err) {
          console.warn('device-sessions: close-on-read failed', { deviceId, err });
        }
      }
      const parsed = parseListParams(event, {
        sortable: ['startedAt', 'createdAt'],
        defaultSort: 'startedAt',
        statusValues: ['open', 'closed'],
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy, status, from, to } = parsed;

      const streamKey = event.queryStringParameters?.streamKey;
      const sortCol =
        sortBy === 'createdAt' ? schema.mediaSessions.createdAt : schema.mediaSessions.startedAt;

      // ?group=runs — paginate RECORDING RUNS instead of sessions (Phase 3).
      // The card renders runs, so the API has to page runs or the page sizes
      // come out uneven and boundary-straddling runs render twice. Opt-in on
      // the existing route rather than a new one: it reuses requireOrgContext,
      // the ownership check above, close-on-read, and parseListParams.
      const group = event.queryStringParameters?.group;
      if (group !== undefined && group !== '' && group !== 'runs') {
        return badRequest('"group" must be "runs"');
      }
      if (group === 'runs') {
        // A run has no created_at of its own — its members were received over
        // whatever span the uploads took — so sorting runs by it is meaningless.
        // Reject rather than silently ignore the caller's sort.
        if (sortBy !== 'startedAt') {
          return badRequest('"sort" must be "startedAt" when "group" is "runs"');
        }
        return listRuns(deviceId, parsed, { streamKey, status, from, to });
      }

      // Time-range semantics: sessions that OVERLAP [from, to) — a session
      // spans a window, so filtering started_at alone would drop long sessions
      // that started before `from` but were still recording inside it.
      const where = and(
        eq(schema.mediaSessions.deviceId, deviceId),
        streamKey ? eq(schema.mediaSessions.streamKey, streamKey) : undefined,
        status ? eq(schema.mediaSessions.status, status) : undefined,
        from
          ? sql`coalesce(${schema.mediaSessions.endedAt}, ${schema.mediaSessions.startedAt}) >= ${tsParam(from)}`
          : undefined,
        to ? sql`${schema.mediaSessions.startedAt} < ${tsParam(to)}` : undefined,
      );

      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.mediaSessions)
        .where(where);
      const total = Number(totalRows[0]?.total ?? 0);

      const rows = await db.query.mediaSessions.findMany({
        where,
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });

      const sessions = await withRollups(rows);
      return ok({ sessions, page: pageMeta(parsed, total) });
    }

    case 'GET /devices/{id}/sessions/{sessionId}/segments': {
      const session = await loadSession();
      if (!session) return notFound(`Session "${sessionId}" not found`);
      // A session is bounded (max ~ hours of 60 s segments); return the whole
      // ordered index — it IS the replay/stitching input, pagination would
      // only complicate consumers. seq asc = chronological by construction.
      const segments = await db.query.mediaSegments.findMany({
        where: eq(schema.mediaSegments.sessionId, session.id),
        orderBy: [asc(schema.mediaSegments.seq)],
      });
      return ok({ session, segments });
    }

    case 'GET /devices/{id}/sessions/{sessionId}/segments/{seq}/playback': {
      const seqRaw = event.pathParameters?.seq;
      if (!seqRaw || !/^\d+$/.test(seqRaw)) return badRequest('"seq" must be a non-negative integer');
      const session = await loadSession();
      if (!session) return notFound(`Session "${sessionId}" not found`);
      const segment = await db.query.mediaSegments.findFirst({
        where: and(
          eq(schema.mediaSegments.sessionId, session.id),
          eq(schema.mediaSegments.seq, Number(seqRaw)),
        ),
      });
      if (!segment) return notFound(`Segment ${seqRaw} not found in session "${sessionId}"`);
      if (!BUCKET) return conflict('Storage bucket is not configured');
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: segment.s3Key }),
        { expiresIn: PLAYBACK_TTL_SECONDS },
      );
      return ok({ url, expiresIn: PLAYBACK_TTL_SECONDS, segment });
    }

    case 'GET /devices/{id}/replay-manifest':
      return replayManifest(
        event,
        deviceId,
        // D14 safety cap: no row may claim more than nominal + the step
        // threshold, so an uncorrected clock-step row never bridges the step.
        nominalSegmentMs(device.recordingConfig) + recordingConfig.clockStepMinMs,
      );

    case 'DELETE /devices/{id}/sessions/{sessionId}': {
      const session = await loadSession();
      if (!session) return notFound(`Session "${sessionId}" not found`);
      if (!BUCKET) return conflict('Storage bucket is not configured');

      // Collect object keys BEFORE deleting rows: every segment's .mp4 plus
      // its .json sidecar (uploaded pairwise by the device; the sidecar is not
      // row-tracked, its key is the .mp4 key with the extension swapped), and
      // the poster frame when one was generated. (A thumbnail still being
      // generated mid-delete can leave an orphan object — the lifecycle rule
      // expires it, same as straggler segments.)
      const segments = await db.query.mediaSegments.findMany({
        where: eq(schema.mediaSegments.sessionId, session.id),
        columns: { s3Key: true },
      });
      const keys = segments.flatMap((s) => [
        s.s3Key,
        s.s3Key.replace(/\.mp4$/, '.json'),
      ]);
      if (session.thumbnailKey) keys.push(session.thumbnailKey);

      // Best-effort S3 cleanup in batches of 1000 (DeleteObjects cap). Objects
      // already expired by the lifecycle rule just delete as no-ops. A failed
      // batch is logged but doesn't abort: rows still go, and any surviving
      // objects are bounded by the lifecycle expiry.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        try {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: BUCKET,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
            }),
          );
        } catch (err) {
          console.warn(`delete session ${session.id}: S3 batch delete failed`, err);
        }
      }

      // Session row last; media_segments rows cascade (FK ON DELETE CASCADE).
      // NOTE: a straggler segment still uploading after this recreates the
      // session via ingest (at-least-once pipeline) — its objects then live
      // until the lifecycle expires them or the session is deleted again.
      await db.delete(schema.mediaSessions).where(eq(schema.mediaSessions.id, session.id));
      return { statusCode: 204, body: '' };
    }

    default:
      return methodNotAllowed(method, 'GET, DELETE');
  }
};

/**
 * Attach the per-session rollups (computed, not stored — so they can't drift
 * from the segment rows) that the list endpoint's consumers depend on. Shared
 * by both the session and the run branch so a run's members are byte-identical
 * in shape to an ungrouped listing. Also presigns thumbnail_key into
 * `thumbnailUrl` (list-only, like the rollups): local SigV4 crypto per row, no
 * S3 round trips, so a page of sessions stays one DB query.
 */
async function withRollups(rows: (typeof schema.mediaSessions.$inferSelect)[]) {
  return attachRollups(rows, await segmentRollups(rows.map((r) => r.id)));
}

/** Segment count / bytes / duration per session, one grouped query. */
async function segmentRollups(ids: string[]) {
  return ids.length
    ? await db
        .select({
          sessionId: schema.mediaSegments.sessionId,
          segmentCount: sql<number>`count(*)::int`,
          totalBytes: sql<number>`coalesce(sum(${schema.mediaSegments.sizeBytes}), 0)::bigint`,
          totalDurationMs: sql<number>`coalesce(sum(${schema.mediaSegments.durationMs}), 0)::bigint`,
        })
        .from(schema.mediaSegments)
        .where(inArray(schema.mediaSegments.sessionId, ids))
        .groupBy(schema.mediaSegments.sessionId)
    : [];
}

async function attachRollups(
  rows: (typeof schema.mediaSessions.$inferSelect)[],
  rollups: Awaited<ReturnType<typeof segmentRollups>>,
) {
  const bySession = new Map(rollups.map((r) => [r.sessionId, r]));
  return Promise.all(
    rows.map(async (r) => {
      const agg = bySession.get(r.id);
      return {
        ...r,
        segmentCount: Number(agg?.segmentCount ?? 0),
        totalBytes: Number(agg?.totalBytes ?? 0),
        // The Data API returns bigint aggregates as strings on some paths — keep
        // coercing, the frontend schema expects numbers.
        totalDurationMs: Number(agg?.totalDurationMs ?? 0),
        thumbnailUrl:
          r.thumbnailKey && BUCKET
            ? await getSignedUrl(
                s3,
                new GetObjectCommand({ Bucket: BUCKET, Key: r.thumbnailKey }),
                { expiresIn: PLAYBACK_TTL_SECONDS },
              )
            : null,
      };
    }),
  );
}

/**
 * GET /devices/{id}/sessions?group=runs — the run-paginated listing.
 *
 * Three steps, all scoped to one device (services/session-runs.ts owns the
 * clustering SQL and the equivalence proof). 1 and 2 run concurrently, then 3:
 *
 *   1. count the matching RUNS → `page.total` (the footer counts runs now)
 *   2. rank the runs and return the page's sessions, each tagged with its run
 *   3. load those sessions in full + their rollups (concurrently), then fold
 *
 * Step 3 goes through the same rows + rollups path the ungrouped
 * branch uses, so `runs[].sessions[]` are exactly the objects a caller already
 * knows how to read. The fold is deserialization, not clustering: step 2's rows
 * arrive pre-assigned to runs, ordered, and contiguous.
 */
async function listRuns(
  deviceId: string,
  parsed: ListParams,
  filters: RunFilters,
): Promise<APIGatewayProxyResultV2> {
  const { limit, offset, order } = parsed;

  // Independent reads go out together: each Data API call is a round trip
  // (~50-100 ms from the Lambda) and the SQL itself is sub-millisecond, so
  // the count of SEQUENTIAL calls is what this route's latency is.
  const [totalRows, pageRows] = await Promise.all([
    db.execute<{ total: number } & Record<string, unknown>>(runCountQuery(deviceId, filters)),
    db.execute<RunPageRow>(runPageQuery(deviceId, filters, { limit, offset, order })),
  ]);
  const total = Number(totalRows.rows[0]?.total ?? 0);
  const rows = pageRows.rows ?? [];
  if (rows.length === 0) return ok({ runs: [], page: pageMeta(parsed, total) });

  const ids = rows.map((r) => r.session_id);
  const [sessionRows, rollups] = await Promise.all([
    db.query.mediaSessions.findMany({ where: inArray(schema.mediaSessions.id, ids) }),
    segmentRollups(ids),
  ]);
  const sessions = await attachRollups(sessionRows, rollups);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return ok({ runs: foldRunRows(rows, byId), page: pageMeta(parsed, total) });
}

/**
 * GET /devices/{id}/replay-manifest — everything the replay page needs to
 * render and play, in one response (Composite Replays R3): session metadata +
 * gap-aware timeline (services/replay-manifest.ts owns the R2 math) + every
 * segment with a presigned URL. Two addressing modes, one response shape:
 *   ?sessionId=…            single session (MVP; Phase 3 consumes this)
 *   ?from&to[&streamKey]    every session overlapping the range (composite,
 *                           Phase 5) — segments clipped to the window
 * Timestamps in the response are epoch ms (the R2 replay-clock unit), not
 * ISO — the exception to the sessions-API dialect, per the plan contract.
 * Honest-degradation rules (R6): a sessionId whose segments all expired
 * returns the session with empty segments/gaps (telemetry-only replay);
 * range mode omits sessions with no in-range media.
 *
 * Since the telemetry-session-artifacts plan (Phase 2) the response also
 * carries `replay.telemetry`: the TELEMETRY sessions overlapping the replay
 * window (README §2.6: a different id space, joined by time), each with its
 * presigned `overview.v1.json.gz` (null while open) and its normalised raw
 * segments clipped to the window, plus the session's `insights`. Every URL is
 * presigned in the same batch as the video segments and shares `urlExpiresAt`.
 * `?telemetry=0` omits the block; a device with no telemetry gets
 * `{ sessions: [], truncated: false }`.
 */
async function replayManifest(
  event: APIGatewayProxyEventV2,
  deviceId: string,
  maxSegmentMs: number,
): Promise<APIGatewayProxyResultV2> {
  const qs = event.queryStringParameters ?? {};
  const sessionIdParam = qs.sessionId;
  const hasRangeParams = qs.from !== undefined || qs.to !== undefined;
  if (sessionIdParam && hasRangeParams) {
    return badRequest('Provide either "sessionId" or "from"/"to", not both');
  }
  if (!sessionIdParam && !hasRangeParams) {
    return badRequest('Provide "sessionId", or "from" and "to"');
  }
  if (qs.telemetry !== undefined && !['0', '1', 'true', 'false'].includes(qs.telemetry)) {
    return badRequest('"telemetry" must be "0" or "1"');
  }
  const includeTelemetry = qs.telemetry !== '0' && qs.telemetry !== 'false';
  if (!BUCKET) return conflict('Storage bucket is not configured');

  // Same advisory close-on-read as the sessions list (best-effort): the
  // manifest's session.status feeds the replay page's open/closed badge. The
  // telemetry index gets the same treatment so `telemetry.sessions[].status`
  // is honest on dev, where the sweeper schedule is off (closing does not
  // build: the overview stays null until a housekeeping pass).
  try {
    await closeStaleMediaSessions(deviceId);
  } catch (err) {
    console.warn('replay-manifest: close-on-read failed', { deviceId, err });
  }
  if (includeTelemetry) {
    try {
      await closeStaleTelemetrySessions(deviceId);
    } catch (err) {
      console.warn('replay-manifest: telemetry close-on-read failed', { deviceId, err });
    }
  }

  let sessionRows;
  let rangeFromMs: number | null = null;
  let rangeToMs: number | null = null;

  if (sessionIdParam) {
    if (!UUID_RE.test(sessionIdParam)) return badRequest('"sessionId" must be a UUID');
    const session = await db.query.mediaSessions.findFirst({
      where: and(
        eq(schema.mediaSessions.id, sessionIdParam),
        eq(schema.mediaSessions.deviceId, deviceId),
      ),
    });
    if (!session) return notFound(`Session "${sessionIdParam}" not found`);
    sessionRows = [session];
  } else {
    const fromMs = Date.parse(qs.from ?? '');
    const toMs = Date.parse(qs.to ?? '');
    if (Number.isNaN(fromMs)) return badRequest('"from" must be a valid ISO-8601 timestamp');
    if (Number.isNaN(toMs)) return badRequest('"to" must be a valid ISO-8601 timestamp');
    if (fromMs >= toMs) return badRequest('"from" must be earlier than "to"');
    if (toMs - fromMs > REPLAY_MAX_RANGE_MS) {
      return badRequest('Replay range must not exceed 24 hours');
    }
    rangeFromMs = fromMs;
    rangeToMs = toMs;
    const streamKey = qs.streamKey;
    // Overlap semantics match the sessions list: a session spans a window, so
    // filter on [coalesce(endedAt, startedAt), startedAt) crossing the range.
    sessionRows = await db.query.mediaSessions.findMany({
      where: and(
        eq(schema.mediaSessions.deviceId, deviceId),
        streamKey ? eq(schema.mediaSessions.streamKey, streamKey) : undefined,
        sql`coalesce(${schema.mediaSessions.endedAt}, ${schema.mediaSessions.startedAt}) >= ${tsParam(new Date(fromMs).toISOString())}`,
        sql`${schema.mediaSessions.startedAt} < ${tsParam(new Date(toMs).toISOString())}`,
      ),
      orderBy: [asc(schema.mediaSessions.startedAt)],
    });
    if (sessionRows.length > REPLAY_MAX_SESSIONS) {
      return badRequest(
        `Range overlaps ${sessionRows.length} sessions (max ${REPLAY_MAX_SESSIONS}); narrow the range or filter by streamKey`,
      );
    }
  }

  const sessionIds = sessionRows.map((s) => s.id);
  const segmentRows = sessionIds.length
    ? await db.query.mediaSegments.findMany({
        where: and(
          inArray(schema.mediaSegments.sessionId, sessionIds),
          // Range mode: clip to segments whose media overlaps [from, to).
          rangeToMs !== null
            ? sql`${schema.mediaSegments.startTs} < ${tsParam(new Date(rangeToMs).toISOString())}`
            : undefined,
          rangeFromMs !== null
            ? sql`${schema.mediaSegments.startTs} + ${schema.mediaSegments.durationMs} * interval '1 millisecond' > ${tsParam(new Date(rangeFromMs).toISOString())}`
            : undefined,
        ),
        orderBy: [asc(schema.mediaSegments.startTs)],
      })
    : [];
  if (segmentRows.length > REPLAY_MAX_SEGMENTS) {
    return badRequest(
      `Replay would span ${segmentRows.length} segments (max ${REPLAY_MAX_SEGMENTS}); use "from"/"to" to replay part of it`,
    );
  }

  const bySession = new Map<string, typeof segmentRows>();
  for (const row of segmentRows) {
    if (!row.sessionId) continue;
    const list = bySession.get(row.sessionId);
    if (list) list.push(row);
    else bySession.set(row.sessionId, [row]);
  }

  // Timelines first (pure): the replay window they define is the clock the
  // replay runs on, and it is what the telemetry sessions are joined by.
  let fromMs = rangeFromMs ?? Number.POSITIVE_INFINITY;
  let toMs = rangeToMs ?? Number.NEGATIVE_INFINITY;
  const timelines: { s: (typeof sessionRows)[number]; timeline: SessionTimeline | null }[] = [];
  for (const s of sessionRows) {
    const timeline = buildSessionTimeline(bySession.get(s.id) ?? [], {
      // Evicted-head detection only makes sense against the session's own
      // start; in range mode the window boundary clips segments arbitrarily.
      sessionStartedAt: rangeToMs === null ? s.startedAt : undefined,
      maxSegmentMs,
    });
    if (!timeline) {
      // No (in-range) media. Range mode: omit the session entirely. Session
      // mode: return it with an empty timeline so the client can offer a
      // telemetry-only replay over the session's recorded span (R6).
      if (rangeToMs !== null) continue;
      fromMs = s.startedAt.getTime();
      toMs = (s.endedAt ?? s.startedAt).getTime();
      timelines.push({ s, timeline: null });
      continue;
    }
    if (timeline.outOfOrder) {
      console.warn('replay-manifest: out-of-order segment startTs (sorted)', {
        deviceId,
        sessionId: s.id,
      });
    }
    if (rangeToMs === null) {
      fromMs = Math.min(fromMs, timeline.fromTs);
      toMs = Math.max(toMs, timeline.toTs);
    }
    timelines.push({ s, timeline });
  }

  // Telemetry sessions overlapping the window, and their normalised segments
  // clipped to it (telemetry-session-artifacts Phase 2). Both predicates are
  // the ones buildTelemetryManifest applies; SQL runs them so the read stays
  // an indexed range scan on (device_id, started_at) / (session_id, start_ts),
  // and the pure function owns the cap, the ordering and the shape.
  let telemetry: ReplayTelemetry | null = null;
  if (includeTelemetry) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      telemetry = { sessions: [], truncated: false };
    } else {
      const fromIso = new Date(fromMs).toISOString();
      const toIso = new Date(toMs).toISOString();
      const t = schema.telemetrySessions;
      const telemetrySessions = await db.query.telemetrySessions.findMany({
        where: and(
          eq(t.deviceId, deviceId),
          sql`${t.startedAt} < ${tsParam(toIso)}`,
          sql`coalesce(${t.endedAt}, ${t.startedAt}) >= ${tsParam(fromIso)}`,
        ),
        orderBy: [asc(t.startedAt)],
      });
      const g = schema.telemetrySegments;
      const telemetrySegments = telemetrySessions.length
        ? await db.query.telemetrySegments.findMany({
            where: and(
              inArray(
                g.sessionId,
                telemetrySessions.map((row) => row.id),
              ),
              eq(g.normalized, true),
              sql`${g.startTs} < ${tsParam(toIso)}`,
              sql`${g.endTs} >= ${tsParam(fromIso)}`,
            ),
            orderBy: [asc(g.startTs), asc(g.seq)],
            // One past the cap is enough to know it was hit.
            limit: REPLAY_TELEMETRY_MAX_SEGMENTS + 1,
          })
        : [];
      telemetry = buildTelemetryManifest(telemetrySessions, telemetrySegments, { fromMs, toMs });
    }
  }

  // Batch presign: local SigV4 crypto, no S3 round trips — cheap even at the
  // 600 + 1 500 segment caps. NOT inside a DB transaction, so Promise.all is
  // fine. Video segments, telemetry overviews and telemetry segments all go in
  // the same batch and share one urlExpiresAt.
  const keys = new Set<string>(segmentRows.map((row) => row.s3Key));
  for (const ts of telemetry?.sessions ?? []) {
    if (ts.overview) keys.add(ts.overview.s3Key);
    for (const seg of ts.segments) keys.add(seg.s3Key);
  }
  const urlExpiresAt = Date.now() + PLAYBACK_TTL_SECONDS * 1000 - REPLAY_URL_REFRESH_MARGIN_MS;
  const urlByKey = new Map(
    await Promise.all(
      [...keys].map(async (key): Promise<[string, string]> => [
        key,
        await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
          expiresIn: PLAYBACK_TTL_SECONDS,
        }),
      ]),
    ),
  );
  const urlFor = (key: string): string => urlByKey.get(key) as string;

  const sessions = timelines.map(({ s, timeline }) =>
    timeline
      ? sessionManifestShape(
          s,
          timeline.segments.map(({ s3Key, ...seg }) => ({ ...seg, url: urlFor(s3Key) })),
          timeline.gaps,
        )
      : sessionManifestShape(s, [], []),
  );

  const replay: Record<string, unknown> = { deviceId, from: fromMs, to: toMs, sessions, urlExpiresAt };
  if (telemetry) {
    replay.telemetry = {
      sessions: telemetry.sessions.map((ts) => ({
        ...ts,
        overview: ts.overview
          ? (({ s3Key, ...overview }) => ({ ...overview, url: urlFor(s3Key) }))(ts.overview)
          : null,
        segments: ts.segments.map(({ s3Key, ...seg }) => ({ ...seg, url: urlFor(s3Key) })),
      })),
      truncated: telemetry.truncated,
    };
  }
  return ok({ replay });
}

function sessionManifestShape(
  s: typeof schema.mediaSessions.$inferSelect,
  segments: unknown[],
  gaps: unknown[],
) {
  return {
    id: s.id,
    streamKey: s.streamKey,
    status: s.status,
    timeSource: s.timeSource,
    codec: s.codec,
    width: s.width,
    height: s.height,
    fps: s.fps,
    // Clock-step correction (D9): the cumulative shift ingest applied to this
    // session's stale-clock rows; null = never corrected.
    clockCorrectionMs: s.clockCorrectionMs ?? null,
    segments,
    gaps,
  };
}

export const handler = apiHandler(restHandler);

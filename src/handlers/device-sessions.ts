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
import { buildSessionTimeline } from '../services/replay-manifest';
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
    columns: { id: true },
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
      try {
        await closeStaleMediaSessions(deviceId);
      } catch (err) {
        console.warn('device-sessions: close-on-read failed', { deviceId, err });
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
      return replayManifest(event, deviceId);

    case 'DELETE /devices/{id}/sessions/{sessionId}': {
      const session = await loadSession();
      if (!session) return notFound(`Session "${sessionId}" not found`);
      if (!BUCKET) return conflict('Storage bucket is not configured');

      // Collect object keys BEFORE deleting rows: every segment's .mp4 plus
      // its .json sidecar (uploaded pairwise by the device; the sidecar is not
      // row-tracked, its key is the .mp4 key with the extension swapped).
      const segments = await db.query.mediaSegments.findMany({
        where: eq(schema.mediaSegments.sessionId, session.id),
        columns: { s3Key: true },
      });
      const keys = segments.flatMap((s) => [
        s.s3Key,
        s.s3Key.replace(/\.mp4$/, '.json'),
      ]);

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
 * in shape to an ungrouped listing.
 */
async function withRollups(rows: (typeof schema.mediaSessions.$inferSelect)[]) {
  const ids = rows.map((r) => r.id);
  const rollups = ids.length
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
  const bySession = new Map(rollups.map((r) => [r.sessionId, r]));
  return rows.map((r) => {
    const agg = bySession.get(r.id);
    return {
      ...r,
      segmentCount: Number(agg?.segmentCount ?? 0),
      totalBytes: Number(agg?.totalBytes ?? 0),
      // The Data API returns bigint aggregates as strings on some paths — keep
      // coercing, the frontend schema expects numbers.
      totalDurationMs: Number(agg?.totalDurationMs ?? 0),
    };
  });
}

/**
 * GET /devices/{id}/sessions?group=runs — the run-paginated listing.
 *
 * Three statements, in this order, all scoped to one device (services/
 * session-runs.ts owns the clustering SQL and the equivalence proof):
 *
 *   1. count the matching RUNS → `page.total` (the footer counts runs now)
 *   2. rank the runs and return the page's sessions, each tagged with its run
 *   3. load those sessions in full + their rollups, then fold
 *
 * Step 3 goes through the same `findMany` + `withRollups` path the ungrouped
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

  const totalRows = await db.execute<{ total: number } & Record<string, unknown>>(
    runCountQuery(deviceId, filters),
  );
  const total = Number(totalRows.rows[0]?.total ?? 0);

  const pageRows = await db.execute<RunPageRow>(
    runPageQuery(deviceId, filters, { limit, offset, order }),
  );
  const rows = pageRows.rows ?? [];
  if (rows.length === 0) return ok({ runs: [], page: pageMeta(parsed, total) });

  const sessionRows = await db.query.mediaSessions.findMany({
    where: inArray(
      schema.mediaSessions.id,
      rows.map((r) => r.session_id),
    ),
  });
  const sessions = await withRollups(sessionRows);
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
 */
async function replayManifest(
  event: APIGatewayProxyEventV2,
  deviceId: string,
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
  if (!BUCKET) return conflict('Storage bucket is not configured');

  // Same advisory close-on-read as the sessions list (best-effort): the
  // manifest's session.status feeds the replay page's open/closed badge.
  try {
    await closeStaleMediaSessions(deviceId);
  } catch (err) {
    console.warn('replay-manifest: close-on-read failed', { deviceId, err });
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

  // Batch presign: local SigV4 crypto, no S3 round trips — cheap even at the
  // 600-segment cap. NOT inside a DB transaction, so Promise.all is fine.
  const urlExpiresAt = Date.now() + PLAYBACK_TTL_SECONDS * 1000 - REPLAY_URL_REFRESH_MARGIN_MS;
  const urlByKey = new Map(
    await Promise.all(
      segmentRows.map(async (row): Promise<[string, string]> => [
        row.s3Key,
        await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: row.s3Key }), {
          expiresIn: PLAYBACK_TTL_SECONDS,
        }),
      ]),
    ),
  );

  let fromMs = rangeFromMs ?? Number.POSITIVE_INFINITY;
  let toMs = rangeToMs ?? Number.NEGATIVE_INFINITY;
  const sessions = [];
  for (const s of sessionRows) {
    const timeline = buildSessionTimeline(bySession.get(s.id) ?? [], {
      // Evicted-head detection only makes sense against the session's own
      // start; in range mode the window boundary clips segments arbitrarily.
      sessionStartedAt: rangeToMs === null ? s.startedAt : undefined,
    });
    if (!timeline) {
      // No (in-range) media. Range mode: omit the session entirely. Session
      // mode: return it with an empty timeline so the client can offer a
      // telemetry-only replay over the session's recorded span (R6).
      if (rangeToMs !== null) continue;
      fromMs = s.startedAt.getTime();
      toMs = (s.endedAt ?? s.startedAt).getTime();
      sessions.push(sessionManifestShape(s, [], []));
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
    sessions.push(
      sessionManifestShape(
        s,
        timeline.segments.map(({ s3Key, ...seg }) => ({
          ...seg,
          url: urlByKey.get(s3Key) as string,
        })),
        timeline.gaps,
      ),
    );
  }

  return ok({
    replay: { deviceId, from: fromMs, to: toMs, sessions, urlExpiresAt },
  });
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
    segments,
    gaps,
  };
}

export const handler = apiHandler(restHandler);

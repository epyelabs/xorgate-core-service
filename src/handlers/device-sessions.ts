import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DeleteObjectsCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, conflict, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { tsParam } from '../utils/sql';
import { closeStaleMediaSessions } from '../services/media-sessions';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const PLAYBACK_TTL_SECONDS = 3600;

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * APIs over device-recorded media sessions/segments (offline recording plan,
 * Phase 4 — the index Composite Replays will consume). Routes (all → this
 * Lambda; rows are populated by media-segment-ingest):
 *   GET    /devices/{id}/sessions                                  list + per-session rollups
 *   GET    /devices/{id}/sessions/{sessionId}/segments             ordered segment index
 *   GET    /devices/{id}/sessions/{sessionId}/segments/{seq}/playback  presigned GET
 *   DELETE /devices/{id}/sessions/{sessionId}                      segments (S3+rows) + session
 * Ownership: the device must belong to a workspace in the caller's org (same
 * check as device-recordings.ts). Response casing: drizzle camelCase rows,
 * same dialect as /recordings.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  const deviceId = event.pathParameters?.id;
  const sessionId = event.pathParameters?.sessionId;

  if (!deviceId) return notFound('Device "" not found');

  let auth;
  try {
    // DELETE destroys recorded data — restrict to owner/admin (tighter than
    // the recordings delete, which members may also call: a cloud recording is
    // re-creatable from a live stream, a device-recorded session is not).
    auth = await requireOrgContext(
      event,
      method === 'DELETE' ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);
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

      // Per-session rollups for the page (computed, not stored — can't drift).
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
      const sessions = rows.map((r) => {
        const agg = bySession.get(r.id);
        return {
          ...r,
          segmentCount: Number(agg?.segmentCount ?? 0),
          totalBytes: Number(agg?.totalBytes ?? 0),
          totalDurationMs: Number(agg?.totalDurationMs ?? 0),
        };
      });
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

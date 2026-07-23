import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, conflict, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { tsParam } from '../utils/sql';

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
 * Read APIs over device-recorded media sessions/segments (offline recording
 * plan, Phase 4 — the index Composite Replays will consume). Routes (all →
 * this Lambda; read-only, rows are populated by media-segment-ingest):
 *   GET /devices/{id}/sessions                                  list + per-session rollups
 *   GET /devices/{id}/sessions/{sessionId}/segments             ordered segment index
 *   GET /devices/{id}/sessions/{sessionId}/segments/{seq}/playback  presigned GET
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
    auth = await requireOrgContext(event);
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

    default:
      return methodNotAllowed(method, 'GET');
  }
};

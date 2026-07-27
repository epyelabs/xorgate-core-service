import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index';
import type { ReplaySegmentInput } from './replay-manifest';
import type { ResolvedVideoSession } from '../workflows/production';
import { resolveSessionVideo } from '../workflows/session-video';

/**
 * The workflow engine's media-input reader (destroy-kvs-recorder Phase W):
 * turns on-device `media_sessions` + `media_segments` rows into the ordered,
 * wall-clock-anchored segment lists the `device_session` executor binding
 * carries. Replaces the cloud `recordings` table as Workflows' video source.
 *
 * Shared by BOTH resolution paths so they can't drift:
 *  - the production trigger path (services/workflow-engine-v2.ts), and
 *  - the simulator (handlers/workflow-simulations.ts).
 *
 * This module is the DB half only; the mapping itself is pure and lives in
 * workflows/session-video.ts (`resolveSessionVideo`), which delegates the
 * timeline math to `buildSessionTimeline` — the same function the replay
 * player uses. That is deliberate: the player is Phase W's correctness
 * baseline (decision I), so any drift between what a workflow sees and what a
 * human scrubbing the replay sees would be a bug in one of them, not two
 * independent opinions about a session's clock.
 *
 * ⚠️ Segments are ordered by `startTs`, NEVER by `seq` — eviction holes and
 * reopened sessions make seq arithmetic a lie (replay-manifest.ts gotcha), and
 * multi-camera runs interleave.
 */

/** The `media_sessions` columns the resolver needs. */
export interface SessionRow {
  id: string;
  deviceId: string;
  streamKey: string;
  startedAt: Date;
  endedAt: Date | null;
  timeSource: string | null;
}

const SESSION_COLUMNS = {
  id: schema.mediaSessions.id,
  deviceId: schema.mediaSessions.deviceId,
  streamKey: schema.mediaSessions.streamKey,
  startedAt: schema.mediaSessions.startedAt,
  endedAt: schema.mediaSessions.endedAt,
  timeSource: schema.mediaSessions.timeSource,
};

/** Hand-picked sessions on one device, in the id order the caller gave. */
export async function findDeviceSessions(
  deviceId: string,
  sessionIds: string[],
): Promise<SessionRow[]> {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(schema.mediaSessions)
    .where(
      and(
        eq(schema.mediaSessions.deviceId, deviceId),
        inArray(schema.mediaSessions.id, sessionIds),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return sessionIds.map((id) => byId.get(id)).filter((r): r is SessionRow => r !== undefined);
}

/**
 * The device's most recent N sessions (newest first). Deliberately NOT
 * filtered to status='closed': a still-open session already has uploaded
 * segments, and close is advisory (it can take ~10 min after the last chunk).
 */
export async function findRecentDeviceSessions(deviceId: string, n: number): Promise<SessionRow[]> {
  return db
    .select(SESSION_COLUMNS)
    .from(schema.mediaSessions)
    .where(eq(schema.mediaSessions.deviceId, deviceId))
    .orderBy(desc(schema.mediaSessions.startedAt))
    .limit(Math.max(1, n));
}

/**
 * Sessions the calling ORGANIZATION owns (the simulator's scoping rule: the
 * session's device must belong to a workspace in the caller's org). Also
 * returns the device/workspace so the handler can set the run's device.
 */
export async function findOrgSessions(
  sessionIds: string[],
  organizationId: string,
): Promise<Array<SessionRow & { workspaceId: string }>> {
  if (sessionIds.length === 0) return [];
  return db
    .select({ ...SESSION_COLUMNS, workspaceId: schema.devices.workspaceId })
    .from(schema.mediaSessions)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.mediaSessions.deviceId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.devices.workspaceId))
    .where(
      and(
        inArray(schema.mediaSessions.id, sessionIds),
        eq(schema.workspaces.organizationId, organizationId),
      ),
    );
}

/**
 * Reads each session's segments and hands them to the pure mapper
 * (workflows/session-video.ts `resolveSessionVideo`). Sessions with no usable
 * segments are dropped; see that function for the `onlySeq` narrowing rule.
 */
export async function resolveVideoSessions(
  sessions: SessionRow[],
  opts: { onlySeq?: number | null } = {},
): Promise<ResolvedVideoSession[]> {
  const out: ResolvedVideoSession[] = [];
  for (const session of sessions) {
    const rows = await db
      .select({
        seq: schema.mediaSegments.seq,
        startTs: schema.mediaSegments.startTs,
        durationMs: schema.mediaSegments.durationMs,
        finalized: schema.mediaSegments.finalized,
        sizeBytes: schema.mediaSegments.sizeBytes,
        s3Key: schema.mediaSegments.s3Key,
        meta: schema.mediaSegments.meta,
      })
      .from(schema.mediaSegments)
      .where(eq(schema.mediaSegments.sessionId, session.id))
      // startTs, never seq (see the file header).
      .orderBy(schema.mediaSegments.startTs);

    const resolved = resolveSessionVideo(session, rows as ReplaySegmentInput[], opts);
    if (resolved) out.push(resolved);
  }
  return out;
}

import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';
import { evaluateSessionCompletedTriggers } from './workflow-triggers';

/**
 * Advisory close for device-recorded media sessions (offline recording plan,
 * Phase 4). There is no explicit end-of-session signal — the device may die
 * mid-session, and upload can lag recording by hours — so a session is
 * considered closed once no new segment has ARRIVED (last_segment_at, server
 * clock) for `mediaSessionCloseAfterMs`. Runs on the existing 1-min
 * housekeeping tick (offline-sweeper.ts); a straggler segment after close
 * flips the session back to open (media-segment-ingest sets status='open' on
 * every insert), and the sweeper simply closes it again later. Segments stay
 * queryable regardless of status.
 *
 * Sessions that never received a segment can't exist here (the session row is
 * only created by the first segment's ingest), so no NULL last_segment_at
 * special case is needed — but guard anyway for hand-made rows.
 */
export async function closeStaleMediaSessions(deviceId?: string): Promise<number> {
  const staleSecs = Math.round(recordingConfig.mediaSessionCloseAfterMs / 1000);
  const closed = await db
    .update(schema.mediaSessions)
    .set({ status: 'closed' })
    .where(
      and(
        eq(schema.mediaSessions.status, 'open'),
        deviceId ? eq(schema.mediaSessions.deviceId, deviceId) : undefined,
        sql`coalesce(${schema.mediaSessions.lastSegmentAt}, ${schema.mediaSessions.createdAt}) < now() - make_interval(secs => ${sql.raw(String(staleSecs))})`,
      ),
    )
    .returning({
      id: schema.mediaSessions.id,
      deviceId: schema.mediaSessions.deviceId,
      streamKey: schema.mediaSessions.streamKey,
      startedAt: schema.mediaSessions.startedAt,
      endedAt: schema.mediaSessions.endedAt,
    });

  // Phase 6.4: each open→closed transition fires `session_completed` workflow
  // triggers (at-least-once — a straggler-reopened session fires again on
  // re-close; see evaluateSessionCompletedTriggers). Best-effort per session so
  // one bad template never blocks the close pass or the other sessions.
  for (const session of closed) {
    try {
      await evaluateSessionCompletedTriggers(session);
    } catch (err) {
      console.error('media-sessions: session_completed trigger eval failed', {
        sessionId: session.id,
        err,
      });
    }
  }
  return closed.length;
}

/**
 * DB-side companion of the S3 lifecycle rules (Phase 6.3): expire index rows
 * whose segment objects the lifecycle already deleted. Runs one day BEHIND the
 * S3 age (retention + 1 d) so object deletion always leads — a row is only
 * removed once its object is certainly gone, never the other way around (a
 * dangling row would only 404 at playback; a dangling object would be
 * invisible, which is worse for storage accounting).
 *
 *  - media_segments: by uploaded_at (server arrival clock, same domain the
 *    lifecycle uses via object creation time).
 *  - media_sessions: rows left with zero segments AND no arrival inside the
 *    window (guards a mid-expiry session whose newest segments still live).
 *  - telemetry_ingest_log: by ingested_at. The telemetry_readings HISTORY does
 *    NOT expire here — it is the authoritative record and outlives the raw
 *    .jsonl.gz upload artifacts (documented decision, Phase 6.3). Re-ingest of
 *    a re-uploaded old segment stays blocked by partition-age rejection, so
 *    dropping old ingest-log rows cannot double-ingest history.
 *
 * No index on the timestamp columns — both tables stay small (one row per
 * segment / per upload), a per-minute scan with an almost-always-empty match
 * set is fine on Aurora; revisit if either table ever hits millions of rows.
 */
export async function expireSegmentIndexRows(): Promise<{
  segments: number;
  sessions: number;
  ingestLog: number;
}> {
  const cutoffDays = recordingConfig.segmentRetentionDays + 1;
  const cutoff = sql`now() - make_interval(days => ${sql.raw(String(cutoffDays))})`;

  const segments = await db
    .delete(schema.mediaSegments)
    .where(sql`${schema.mediaSegments.uploadedAt} < ${cutoff}`)
    .returning({ id: schema.mediaSegments.id });

  const sessions = await db
    .delete(schema.mediaSessions)
    .where(
      and(
        sql`not exists (select 1 from ${schema.mediaSegments} where ${schema.mediaSegments.sessionId} = ${schema.mediaSessions.id})`,
        sql`coalesce(${schema.mediaSessions.lastSegmentAt}, ${schema.mediaSessions.createdAt}) < ${cutoff}`,
      ),
    )
    .returning({ id: schema.mediaSessions.id });

  const ingestLog = await db
    .delete(schema.telemetryIngestLog)
    .where(sql`${schema.telemetryIngestLog.ingestedAt} < ${cutoff}`)
    .returning({ s3Key: schema.telemetryIngestLog.s3Key });

  return { segments: segments.length, sessions: sessions.length, ingestLog: ingestLog.length };
}

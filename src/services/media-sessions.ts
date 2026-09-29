import { and, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';
import { evaluateSessionCompletedTriggers } from './workflow-triggers';
import { dispatchWebhookEvents, emitWebhookEvents } from './webhooks/emit';
import { mediaCloseSql, mediaEndedEvents, type MediaClosedRow } from './webhooks/sessions';

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
  // xorgate-webhooks P3: the close and its `media_session.ended` outbox rows
  // commit together (README D3), so a crash after the close cannot lose the
  // event. The emit lives HERE, not in a caller: the sweeper and the
  // close-on-read API routes both close through this function.
  const { rows, eventIds } = await db.transaction(async (tx) => {
    const res = await tx.execute<MediaClosedRow & Record<string, unknown>>(mediaCloseSql(staleSecs, deviceId));
    const rows = (res?.rows ?? []) as MediaClosedRow[];
    const eventIds = await emitWebhookEvents(tx, mediaEndedEvents(rows));
    return { rows, eventIds };
  });
  await dispatchWebhookEvents(eventIds);
  const closed = rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    streamKey: r.stream_key,
    startedAt: new Date(r.started_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
  }));

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
 * DB-side companion of the S3 lifecycle rules (Phase 6.3, extended by the
 * telemetry-session-artifacts plan, Phase 5): expire index rows whose objects
 * the lifecycle already deleted. Runs one day BEHIND the S3 age (retention +
 * 1 d) so object deletion always leads — a row is only removed once its object
 * is certainly gone, never the other way around (a dangling row would only 404
 * at playback; a dangling object would be invisible, which is worse for
 * storage accounting).
 *
 * Two clocks, one per prefix (storage-stack has the matching rules):
 *
 *  MEDIA, `segmentRetentionDays` (90 d):
 *  - media_segments: by uploaded_at (server arrival clock, same domain the
 *    lifecycle uses via object creation time).
 *  - media_sessions: rows left with zero segments AND no arrival inside the
 *    window (guards a mid-expiry session whose newest segments still live).
 *
 *  TELEMETRY, `telemetryArtifactRetentionDays` (365 d, README D8):
 *  - telemetry_segments: by uploaded_at, same rule as media_segments. The
 *    overview object shares the session prefix and the lifecycle rule, so it
 *    is gone by the time the last segment row is.
 *  - telemetry_sessions: rows left with zero segments AND no arrival inside
 *    the window, same guard as media_sessions (the FK cascade would also
 *    empty them, but a session with no rows and no objects is noise in every
 *    listing and in the manifest's overlap join).
 *  - telemetry_ingest_log: by ingested_at, on the TELEMETRY clock now (it was
 *    on the media clock while both prefixes shared one rule). The row is the
 *    duplicate-delivery guard for its object, so it must outlive the object:
 *    the normalisation CopyObject re-fires Object Created (README Q14) and a
 *    365-day object with a 91-day log row would re-run the ingest fast path
 *    with nothing to dedupe against. Re-ingest of a re-uploaded OLD segment is
 *    still blocked by partition-age rejection, so dropping expired rows cannot
 *    double-ingest history.
 *
 * `telemetry_readings` is NOT touched here: it is the hot window, dropped a
 * month at a time by handlers/partition-maintenance.ts.
 *
 * No index on the timestamp columns — every table here stays small (one row
 * per segment / per upload / per session), a per-minute scan with an
 * almost-always-empty match set is fine on Aurora; revisit if any of them
 * ever hits millions of rows.
 */
export interface SegmentIndexExpiry {
  segments: number;
  sessions: number;
  ingestLog: number;
  telemetrySegments: number;
  telemetrySessions: number;
}

/** `now() - (days + 1)`: the one-day lead over the S3 lifecycle, as SQL. */
export function indexExpiryCutoff(retentionDays: number): SQL {
  const cutoffDays = Math.max(0, Math.floor(retentionDays)) + 1;
  return sql`now() - make_interval(days => ${sql.raw(String(cutoffDays))})`;
}

export async function expireSegmentIndexRows(): Promise<SegmentIndexExpiry> {
  const mediaCutoff = indexExpiryCutoff(recordingConfig.segmentRetentionDays);
  const telemetryCutoff = indexExpiryCutoff(recordingConfig.telemetryArtifactRetentionDays);

  const segments = await db
    .delete(schema.mediaSegments)
    .where(sql`${schema.mediaSegments.uploadedAt} < ${mediaCutoff}`)
    .returning({ id: schema.mediaSegments.id });

  const sessions = await db
    .delete(schema.mediaSessions)
    .where(
      and(
        sql`not exists (select 1 from ${schema.mediaSegments} where ${schema.mediaSegments.sessionId} = ${schema.mediaSessions.id})`,
        sql`coalesce(${schema.mediaSessions.lastSegmentAt}, ${schema.mediaSessions.createdAt}) < ${mediaCutoff}`,
      ),
    )
    .returning({ id: schema.mediaSessions.id });

  const telemetrySegments = await db
    .delete(schema.telemetrySegments)
    .where(sql`${schema.telemetrySegments.uploadedAt} < ${telemetryCutoff}`)
    .returning({ s3Key: schema.telemetrySegments.s3Key });

  const telemetrySessions = await db
    .delete(schema.telemetrySessions)
    .where(
      and(
        sql`not exists (select 1 from ${schema.telemetrySegments} where ${schema.telemetrySegments.sessionId} = ${schema.telemetrySessions.id})`,
        sql`${schema.telemetrySessions.lastSegmentAt} < ${telemetryCutoff}`,
      ),
    )
    .returning({ id: schema.telemetrySessions.id });

  const ingestLog = await db
    .delete(schema.telemetryIngestLog)
    .where(sql`${schema.telemetryIngestLog.ingestedAt} < ${telemetryCutoff}`)
    .returning({ s3Key: schema.telemetryIngestLog.s3Key });

  return {
    segments: segments.length,
    sessions: sessions.length,
    ingestLog: ingestLog.length,
    telemetrySegments: telemetrySegments.length,
    telemetrySessions: telemetrySessions.length,
  };
}

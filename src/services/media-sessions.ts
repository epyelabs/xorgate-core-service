import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { recordingConfig } from '../config/recording';

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
export async function closeStaleMediaSessions(): Promise<number> {
  const staleSecs = Math.round(recordingConfig.mediaSessionCloseAfterMs / 1000);
  const closed = await db
    .update(schema.mediaSessions)
    .set({ status: 'closed' })
    .where(
      and(
        eq(schema.mediaSessions.status, 'open'),
        sql`coalesce(${schema.mediaSessions.lastSegmentAt}, ${schema.mediaSessions.createdAt}) < now() - make_interval(secs => ${sql.raw(String(staleSecs))})`,
      ),
    )
    .returning({ id: schema.mediaSessions.id });
  return closed.length;
}

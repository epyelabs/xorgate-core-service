import type { Context } from 'aws-lambda';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db, schema } from '../db/index';
import {
  closeStaleMediaSessions,
  expireSegmentIndexRows,
} from '../services/media-sessions';
import {
  reconcileTelemetryIndex,
  runTelemetryHousekeeping,
} from '../services/telemetry-sessions';
import { recordingConfig } from '../config/recording';
import { EXPIRED_TOKEN_GRACE_MS } from '../services/session-token-auth';

/** Leave this much of the invocation for the last statement to finish. */
const DEADLINE_MARGIN_MS = 5_000;
const INSPECT_URL_TTL_SECONDS = 3600;

/**
 * Operator jobs, run INSTEAD of the tick when the function is invoked directly
 * with one of these payloads (scripts/backfill-telemetry-sessions.ts). The
 * schedule invokes with an EventBridge event, which has none of these fields.
 */
export type SweeperJob =
  | { job: 'telemetry-backfill'; limit?: number }
  | { job: 'telemetry-session-inspect'; sessionId: string };

const isJob = (event: unknown): event is SweeperJob =>
  typeof event === 'object' && event !== null && typeof (event as { job?: unknown }).job === 'string';

/**
 * Housekeeping tick (kvs-webrtc-lts Phase 2). Invoked by the existing EventBridge
 * schedule (~1 min, gated by disableScheduledJobs so it stays OFF in the shared
 * sandbox — which means every job here is INERT on dev). Folds five jobs onto
 * the ONE tick — deliberately no new schedule, so no new Aurora wake source
 * (§7.3):
 *
 *  1. Offline sweep: flip devices that stopped reporting `online` -> `offline`
 *     (badge only, telemetry-staleness based). Only touches `online` rows, so
 *     `provisioned`/`decommissioned` are never affected.
 *  2. Media-session close (offline recording plan, Phase 4): advisorily flip
 *     device-recorded media_sessions to 'closed' once segments stop arriving.
 *     Each open→closed transition also fires `session_completed` workflow
 *     triggers (Phase 6.4, at-least-once — see closeStaleMediaSessions).
 *  2b. Telemetry-session close + overview build (telemetry-session-artifacts
 *     plan, Phase 1, README D6/Q5): same close rule and knob as media, then
 *     build `overview.v1.json.gz` for every closed session without a current
 *     artifact, bounded per tick, plus metadata-normalisation retries.
 *     Deliberately on THIS tick: no new schedule, no new Aurora wake source.
 *  3. Segment index-row expiry (Phase 6.3): delete media_segments /
 *     empty media_sessions / telemetry_ingest_log rows one day after the S3
 *     lifecycle expired their objects.
 *  4. Session-token expiry (platform-auth Phase 3): delete `session_tokens`
 *     rows that expired more than a day ago. Hygiene only — the verify path
 *     checks `expires_at` itself and never trusts the table to be clean.
 *
 * Each job is isolated in its own try/catch so one failing job never starves the
 * others. Pure server-side time; idempotent.
 */
export const handler = async (event: unknown, context?: Context): Promise<unknown> => {
  const deadline = context
    ? Date.now() + context.getRemainingTimeInMillis() - DEADLINE_MARGIN_MS
    : undefined;

  if (isJob(event)) return runJob(event, deadline);

  // 1: offline sweep.
  try {
    const staleSecs = Math.round(recordingConfig.deviceOfflineStaleMs / 1000);
    await db
      .update(schema.devices)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(
        and(
          eq(schema.devices.status, 'online'),
          sql`(${schema.devices.lastSeenAt} IS NULL OR ${schema.devices.lastSeenAt} < now() - make_interval(secs => ${sql.raw(String(staleSecs))}))`,
        ),
      );
  } catch (err) {
    console.error('offline-sweeper: offline sweep failed', err);
  }

  // 2: advisory close of device-recorded media sessions that stopped receiving
  // segments (offline recording plan, Phase 4 — same "no new schedule" stance).
  try {
    const closed = await closeStaleMediaSessions();
    if (closed > 0) console.log('offline-sweeper: closed stale media sessions', { closed });
  } catch (err) {
    console.error('offline-sweeper: media-session close failed', err);
  }

  // 2b: telemetry-session close + overview build (Phase 1 of the artifacts plan).
  try {
    const telemetry = await runTelemetryHousekeeping({ deadline });
    if (
      telemetry.closed > 0 ||
      telemetry.built > 0 ||
      telemetry.buildFailures > 0 ||
      telemetry.normalized > 0
    ) {
      const { builds: _builds, ...summary } = telemetry;
      console.log('offline-sweeper: telemetry sessions', summary);
    }
  } catch (err) {
    console.error('offline-sweeper: telemetry-session housekeeping failed', err);
  }

  // 3: expire segment index rows behind the S3 lifecycle (Phase 6.3).
  try {
    const expired = await expireSegmentIndexRows();
    if (expired.segments > 0 || expired.sessions > 0 || expired.ingestLog > 0) {
      console.log('offline-sweeper: expired segment index rows', expired);
    }
  } catch (err) {
    console.error('offline-sweeper: segment index expiry failed', err);
  }

  // 4: delete long-expired session tokens (platform-auth Phase 3). Piggybacked
  // on this tick for the same reason as jobs 2 and 3 — no new schedule, so no
  // new Aurora wake source. One indexed DELETE per tick, usually matching
  // nothing.
  //
  // Purely hygienic. An expired row is already dead to the verify path, which
  // checks `expires_at` rather than trusting the table to be clean; this only
  // stops the table growing forever. The 24-hour grace is so a token that just
  // expired is still there to be looked at while someone is debugging why their
  // browser started 401ing.
  try {
    const cutoff = new Date(Date.now() - EXPIRED_TOKEN_GRACE_MS);
    const deleted = await db
      .delete(schema.sessionTokens)
      .where(lt(schema.sessionTokens.expiresAt, cutoff))
      .returning({ id: schema.sessionTokens.id });
    if (deleted.length > 0) {
      console.log('offline-sweeper: deleted expired session tokens', {
        count: deleted.length,
      });
    }
  } catch (err) {
    console.error('offline-sweeper: session-token expiry failed', err);
  }
  return undefined;
};

/**
 * Direct-invoke jobs. `telemetry-backfill` indexes ingest-log objects that
 * predate the index (bounded per call; the script loops until `remaining` is
 * 0) and then runs one housekeeping pass so builds start immediately.
 * `telemetry-session-inspect` returns one session's index rows with presigned
 * GET URLs for its overview and segments: the same presigning the Phase 2
 * manifest will do, exposed early so the artifacts can be opened and measured
 * from a workstation whose IAM user has no object access to the bucket.
 */
async function runJob(job: SweeperJob, deadline?: number): Promise<unknown> {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) throw new Error('BUCKET_NAME is not set');
  switch (job.job) {
    case 'telemetry-backfill': {
      const reconcile = await reconcileTelemetryIndex({ bucket, limit: job.limit ?? 50, deadline });
      console.log('offline-sweeper: telemetry backfill', reconcile);
      const housekeeping =
        deadline === undefined || Date.now() < deadline
          ? await runTelemetryHousekeeping({ bucket, deadline })
          : null;
      return {
        reconcile,
        housekeeping: housekeeping ? { ...housekeeping, builds: undefined } : null,
      };
    }
    case 'telemetry-session-inspect': {
      const s3 = new S3Client({});
      const session = await db.query.telemetrySessions.findFirst({
        where: eq(schema.telemetrySessions.id, job.sessionId),
      });
      if (!session) return { session: null };
      const segments = await db
        .select()
        .from(schema.telemetrySegments)
        .where(eq(schema.telemetrySegments.sessionId, job.sessionId))
        .orderBy(asc(schema.telemetrySegments.seq));
      const presign = (key: string): Promise<string> =>
        getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
          expiresIn: INSPECT_URL_TTL_SECONDS,
        });
      const overviewUrl = session.overviewKey ? await presign(session.overviewKey) : null;
      const segmentUrls = await Promise.all(
        segments.map(async (seg) => ({ seq: seg.seq, s3Key: seg.s3Key, url: await presign(seg.s3Key) })),
      );
      return { session, overviewUrl, segments: segmentUrls };
    }
    default:
      throw new Error(`unknown sweeper job ${JSON.stringify(job)}`);
  }
}

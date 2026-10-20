import type { Context } from 'aws-lambda';
import { asc, eq, lt } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db, schema } from '../db/index';
import {
  closeStaleMediaSessions,
  expireSegmentIndexRows,
} from '../services/media-sessions';
import { runClockStepBackfill } from '../services/clock-step-backfill';
import {
  deleteTelemetrySession,
  reconcileTelemetryIndex,
  runTelemetryHousekeeping,
} from '../services/telemetry-sessions';
import { recordingConfig } from '../config/recording';
import { claimAndEmitPresence, offlineClaimSql } from '../services/device-presence';
import { EXPIRED_TOKEN_GRACE_MS } from '../services/session-token-auth';
import {
  expireWebhookHistory,
  redispatchStaleEvents,
  requeueDueDeliveries,
} from '../services/webhooks/deliver';

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
  | { job: 'telemetry-session-inspect'; sessionId: string }
  | { job: 'telemetry-session-delete'; sessionId: string }
  // xorgate-webhooks Phase 1: steps 5 and 6 of the tick, on demand (dev runs
  // with the schedule off, so this is how a due retry is forced there).
  | { job: 'webhooks-requeue' }
  | { job: 'webhooks-retention' }
  // plans/clock-step-correction P3: repair sessions ingested before the
  // ingest-time clock-step correction (scripts/clock-step-backfill.ts).
  | {
      job: 'clock-step-backfill';
      dryRun?: boolean;
      sessionId?: string;
      mediaOnly?: boolean;
      telemetryOnly?: boolean;
      limit?: number;
      after?: string;
    };

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
 *  3. Segment index-row expiry (Phase 6.3 + telemetry-session-artifacts P5):
 *     delete media_segments / empty media_sessions (90 d clock) and
 *     telemetry_segments / empty telemetry_sessions / telemetry_ingest_log
 *     (365 d artifact clock) one day after the S3 lifecycle expired their
 *     objects.
 *  4. Session-token expiry (platform-auth Phase 3): delete `session_tokens`
 *     rows that expired more than a day ago. Hygiene only — the verify path
 *     checks `expires_at` itself and never trusts the table to be clean.
 *  5. Webhook outbox safety net (xorgate-webhooks Phase 1, README D4): outbox
 *     rows still undispatched after 60 s are dispatched, and pending
 *     deliveries whose due time (or lease) has passed are re-enqueued: a lost
 *     SendMessage, a crashed deliver Lambda, a retry beyond SQS's 15-minute
 *     delay cap. A no-op while the `webhooks` stack flag is off.
 *  6. Webhook retention: deliveries, then events, older than 30 days.
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
    // Every flipped row emits `device.offline` (source 'sweeper') in the same
    // transaction as the flip (xorgate-webhooks P2).
    const flipped = await claimAndEmitPresence(offlineClaimSql({ staleSecs }), 'sweeper');
    if (flipped.length > 0) console.log('offline-sweeper: flipped devices offline', { count: flipped.length });
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
      telemetry.normalized > 0 ||
      telemetry.bytesBackfilled > 0 ||
      telemetry.completedFired > 0
    ) {
      const { builds: _builds, ...summary } = telemetry;
      console.log('offline-sweeper: telemetry sessions', summary);
    }
  } catch (err) {
    console.error('offline-sweeper: telemetry-session housekeeping failed', err);
  }

  // 3: expire segment index rows behind the S3 lifecycle (Phase 6.3; the
  // telemetry half on its own 365 d clock since telemetry-session-artifacts P5).
  try {
    const expired = await expireSegmentIndexRows();
    if (Object.values(expired).some((n) => n > 0)) {
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

  // 5: webhook outbox safety net. Both halves are one indexed read each when
  // there is nothing to do; neither wakes Aurora on its own (this tick already did).
  if (deadline === undefined || Date.now() < deadline) {
    try {
      const requeue = await webhooksRequeue();
      if (requeue.events.found > 0 || requeue.deliveries.requeued > 0) {
        console.log('offline-sweeper: webhooks requeue', requeue);
      }
    } catch (err) {
      console.error('offline-sweeper: webhooks requeue failed', err);
    }
  }

  // 6: webhook retention (30 days), same hygiene stance as job 4.
  if (deadline === undefined || Date.now() < deadline) {
    try {
      const expired = await expireWebhookHistory();
      if (expired.deliveries > 0 || expired.events > 0) {
        console.log('offline-sweeper: expired webhook history', expired);
      }
    } catch (err) {
      console.error('offline-sweeper: webhook retention failed', err);
    }
  }
  return undefined;
};

async function webhooksRequeue() {
  const events = await redispatchStaleEvents();
  const deliveries = await requeueDueDeliveries();
  return { events, deliveries };
}

/**
 * Direct-invoke jobs. `telemetry-backfill` indexes ingest-log objects that
 * predate the index (bounded per call; the script loops until `remaining` is
 * 0) and, once nothing remains, runs one housekeeping pass per call so the
 * script can drain the build queue.
 * `telemetry-session-inspect` returns one session's index rows with presigned
 * GET URLs for its overview and segments. Kept after Phase 2 shipped the same
 * presigning in the replay manifest, as an OPERATOR tool: it needs no API
 * credential and no device ownership, only Lambda invoke, so support can open
 * any session's artifacts from a workstation with no object access to the
 * bucket (`npm run backfill:telemetry -- --stage <stage> --inspect <sessionId>`).
 */
async function runJob(job: SweeperJob, deadline?: number): Promise<unknown> {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) throw new Error('BUCKET_NAME is not set');
  switch (job.job) {
    case 'telemetry-backfill': {
      const reconcile = await reconcileTelemetryIndex({ bucket, limit: job.limit ?? 50, deadline });
      console.log('offline-sweeper: telemetry backfill', reconcile);
      // Build only once every object is indexed: a session built while its
      // later segments are still being indexed just goes stale and is built
      // again (correct, but wasted work on a 2 000-object prod backfill).
      const housekeeping =
        reconcile.remaining === 0 && (deadline === undefined || Date.now() < deadline)
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
    case 'webhooks-requeue':
      return webhooksRequeue();
    case 'webhooks-retention':
      return expireWebhookHistory();
    case 'clock-step-backfill':
      return runClockStepBackfill({
        dryRun: job.dryRun !== false,
        sessionId: job.sessionId,
        mediaOnly: job.mediaOnly,
        telemetryOnly: job.telemetryOnly,
        limit: job.limit,
        after: job.after,
        bucket,
        deadline,
      });
    case 'telemetry-session-delete':
      // Operator-only (P6): objects + ingest-log rows + index rows of ONE
      // session, so a backfill pass cannot bring it back. Dev fixture cleanup.
      return deleteTelemetrySession(job.sessionId, bucket);
    default:
      throw new Error(`unknown sweeper job ${JSON.stringify(job)}`);
  }
}

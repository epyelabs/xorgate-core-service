import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';

// The IoT topic rule injects `recordingId` via `topic(3)` and forwards the published
// JSON body (e.g. {"state":"capturing","frames":N,"ts":...}). We trust the topic
// segment (set by the recorder from its RECORDING_ID env), not the body.
const captureEventSchema = z.object({
  recordingId: z.string().uuid(),
  state: z.string().optional(),
  frames: z.number().optional(),
  ts: z.number().optional(),
});

/**
 * Recording capture heartbeat. Invoked directly by the IoT Topic Rule
 *
 *   SELECT *, topic(3) AS recordingId FROM 'xorgate/recordings/+/status'
 *
 * The cloud viewer-recorder publishes this on its first received video frame and
 * then periodically (every RECORDER_HEARTBEAT_MS) while frames keep arriving
 * (kvs-webrtc-lts Phase 4). Two jobs:
 *
 *  - `capture_started_at` (first signal only, via COALESCE): drives the UI badge
 *    from "Starting…" (NULL) to "REC" (non-NULL).
 *  - `capture_heartbeat_at` (every signal): the media-plane liveness the §4.5
 *    offline-stop corroboration + the orphan reconciler check against
 *    CAPTURE_STALE_MS. Because the recorder only heartbeats while frames actually
 *    arrive, a stalled media plane -> heartbeat stops -> backend can tell.
 *
 * Tolerates an unknown recordingId (row deleted, or a manual test) — logs and returns.
 * Error semantics mirror telemetry-ingest (IoT rule lambda actions are async invokes):
 * bad payloads can never succeed on retry -> log and drop; a transient DB error throws
 * so the async-retry path gets a chance to recover.
 */
export const handler = async (event: unknown): Promise<void> => {
  const parsed = captureEventSchema.safeParse(event);
  if (!parsed.success) {
    console.error('recording-capture: invalid event, dropping', {
      issues: parsed.error.issues,
    });
    return;
  }
  const { recordingId } = parsed.data;

  const updated = await db
    .update(schema.recordings)
    .set({
      // Every heartbeat bumps liveness; first signal also stamps the start (COALESCE
      // keeps the first-signal-wins semantics for the badge).
      captureHeartbeatAt: new Date(),
      captureStartedAt: sql`COALESCE(${schema.recordings.captureStartedAt}, now())`,
    })
    .where(
      and(
        eq(schema.recordings.id, recordingId),
        inArray(schema.recordings.status, ['recording', 'stopping']),
      ),
    )
    .returning({ id: schema.recordings.id });

  if (updated.length === 0) {
    console.warn('recording-capture: no active row to update (completed or unknown id)', {
      recordingId,
    });
  }
};

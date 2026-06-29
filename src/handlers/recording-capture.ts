import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';

// The IoT topic rule injects `recordingId` via `topic(3)` and forwards the published
// JSON body (e.g. {"state":"capturing"}). We trust the topic segment (set by the
// recorder from its RECORDING_ID env), not the body.
const captureEventSchema = z.object({
  recordingId: z.string().uuid(),
  state: z.string().optional(),
});

/**
 * Recording capture signal. Invoked directly by the IoT Topic Rule
 *
 *   SELECT *, topic(3) AS recordingId FROM 'xorgate/recordings/+/status'
 *
 * The cloud viewer-recorder publishes this once, on its first received video frame.
 * Stamping `capture_started_at` lets the UI distinguish "row created, task still
 * cold-starting" (NULL -> "Starting…") from "recorder is actually capturing"
 * (non-NULL -> "REC"). First signal wins; duplicates are no-ops (the isNull guard).
 * Tolerates an unknown recordingId (row deleted, or a manual test) — logs and returns.
 *
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
    .set({ captureStartedAt: new Date() })
    .where(
      and(
        eq(schema.recordings.id, recordingId),
        inArray(schema.recordings.status, ['recording', 'stopping']),
        isNull(schema.recordings.captureStartedAt),
      ),
    )
    .returning({ id: schema.recordings.id });

  if (updated.length === 0) {
    console.warn('recording-capture: no row to update (already set or unknown id)', {
      recordingId,
    });
  } else {
    console.log('recording-capture: capture started', { id: updated[0].id });
  }
};

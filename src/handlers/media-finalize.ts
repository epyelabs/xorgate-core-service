import type { EventBridgeEvent } from 'aws-lambda';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index';

// Shape of the S3 "Object Created" event delivered via EventBridge.
interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number };
}

/**
 * Recording finalizer. Invoked by an EventBridge rule on S3 "Object Created"
 * events for the core bucket under media/v1/. The cloud viewer-recorder uploads the
 * finished MP4 on stop; we match it to its `recordings` row by S3 key and flip the
 * row to `completed` with the final size.
 *
 * Tolerates objects with no matching active row (e.g. a recording deleted
 * mid-flight, or a non-.mp4 object) — just logs and returns.
 */
export const handler = async (
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>,
): Promise<void> => {
  const key = event.detail?.object?.key;
  if (!key) {
    console.warn('media-finalize: event missing object key', { id: event.id });
    return;
  }
  if (!key.endsWith('.mp4')) {
    return; // not a recording artifact
  }
  const sizeBytes = event.detail.object.size ?? null;

  const updated = await db
    .update(schema.recordings)
    .set({
      status: 'completed',
      sizeBytes,
      endedAt: new Date(),
    })
    .where(
      and(
        eq(schema.recordings.s3Key, key),
        inArray(schema.recordings.status, ['recording', 'stopping']),
      ),
    )
    .returning({ id: schema.recordings.id });

  if (updated.length === 0) {
    console.warn('media-finalize: no active recording matched S3 key', { key });
  } else {
    console.log('media-finalize: recording completed', { id: updated[0].id, key, sizeBytes });
  }
};

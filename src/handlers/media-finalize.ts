/**
 * TOMBSTONE — delete this file in Phase 5 (destroy-kvs-recorder).
 *
 * The cloud viewer-recorder's finalize step (S3 `media/v1/*.mp4` → flip the
 * `recordings` row to completed → fire `recording_saved` workflow triggers) was
 * removed in Phase 3. This stub exists only so `cdk synth` can still resolve the
 * `MediaFinalizeFn` entry path (see device-recordings.ts for the full note).
 *
 * Nothing writes `media/v1/*` any more. `recording_saved` has no producer until
 * Phase W replaces it with `session_completed` / `segment_uploaded`. Phase 5
 * deletes the Lambda and its EventBridge rule — delete this file in the same change.
 */
export const handler = async (_event: unknown): Promise<void> => {
  console.warn('media-finalize: cloud recorder removed — ignoring media/v1 object event');
};

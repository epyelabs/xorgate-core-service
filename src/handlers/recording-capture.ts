/**
 * TOMBSTONE — delete this file in Phase 5 (destroy-kvs-recorder).
 *
 * The cloud viewer-recorder's capture-heartbeat target (IoT rule on
 * `xorgate/recordings/+/status` → `recordings.capture_started_at`) was removed in
 * Phase 3. This stub exists only so `cdk synth` can still resolve the
 * `RecordingCaptureFn` entry path (see device-recordings.ts for the full note).
 *
 * Nothing publishes to that topic any more; if a stale message arrives it is
 * dropped. Phase 5 deletes the Lambda, the IoT rule and its invoke permission —
 * delete this file in the same change.
 */
export const handler = async (_event: unknown): Promise<void> => {
  console.warn('recording-capture: cloud recorder removed — ignoring capture heartbeat');
};

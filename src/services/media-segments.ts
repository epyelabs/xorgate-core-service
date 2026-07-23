import { z } from 'zod';
import type { NewMediaSegment, NewMediaSession } from '../db/schema';

/**
 * Pure parsing/validation for device video-segment ingest (offline recording
 * plan, Phase 4): S3 key → identifiers, sidecar JSON → segment/session rows.
 * Free of AWS/DB imports so it unit-tests directly; the Lambda in
 * handlers/media-segment-ingest.ts does the I/O.
 */

/** S3 key contract: media-sessions/v1/<deviceId>/<streamKey>/<sessionId>/<seq>.mp4|.json
 *  (seq is splitmuxsink's fragment number, zero-padded ≥5 digits on-device). */
const KEY_RE =
  /^media-sessions\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9_-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{1,10})\.(mp4|json)$/;

export interface MediaSegmentObjectKey {
  deviceId: string;
  streamKey: string;
  sessionId: string;
  seq: number;
  ext: 'mp4' | 'json';
}

export function parseMediaSegmentObjectKey(key: string): MediaSegmentObjectKey | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return {
    deviceId: m[1],
    streamKey: m[2],
    sessionId: m[3],
    seq: Number(m[4]),
    ext: m[5] as 'mp4' | 'json',
  };
}

/** The mp4 key's companion sidecar key (uploaded first by the device). */
export function sidecarKeyFor(mp4Key: string): string {
  return mp4Key.replace(/\.mp4$/, '.json');
}

// Device sidecar contract (device src/recording/video-segments.ts). Loose by
// design: unknown extra fields are ignored; `anchor`/`finalized` are Phase 3
// provenance additions the README contract doesn't carry — tolerated and
// stored (finalized as a column, the rest in meta).
export const videoSidecarSchema = z.object({
  v: z.number().optional(),
  deviceId: z.string().uuid(),
  streamKey: z.string(),
  sessionId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  startTs: z.number().int().positive(),
  startMono: z.number().optional(),
  durationMs: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  timeSource: z.string().optional(),
  codec: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fps: z.number().int().optional(),
  bitrateKbps: z.number().int().optional(),
  anchor: z.enum(['fstat', 'computed']).optional(),
  finalized: z.boolean().optional(),
});
export type VideoSidecar = z.infer<typeof videoSidecarSchema>;

export interface SegmentRows {
  /** Insert-or-ignore values for media_sessions (id = the device session uuid). */
  session: NewMediaSession;
  /** Insert-or-ignore values for media_segments (unique s3_key = idempotency). */
  segment: NewMediaSegment;
  /** Rolling end of the covered wall-clock window (segment start + duration). */
  segmentEnd: Date;
}

/**
 * Build the session + segment rows for one uploaded mp4. The key (IAM-scoped
 * ground truth) supplies identity; the sidecar supplies timing/media facts.
 * Callers must have verified sidecar identity against the key first
 * (`sidecarMatchesKey`).
 */
export function buildSegmentRows(key: MediaSegmentObjectKey, s3Key: string, sc: VideoSidecar): SegmentRows {
  const startTs = new Date(sc.startTs);
  const segmentEnd = new Date(sc.startTs + sc.durationMs);
  return {
    session: {
      id: key.sessionId,
      deviceId: key.deviceId,
      streamKey: key.streamKey,
      startedAt: startTs,
      endedAt: segmentEnd,
      lastSegmentAt: new Date(),
      source: 'device-offline',
      status: 'open',
      codec: sc.codec ?? null,
      width: sc.width ?? null,
      height: sc.height ?? null,
      fps: sc.fps ?? null,
      bitrateKbps: sc.bitrateKbps ?? null,
      timeSource: sc.timeSource ?? null,
    },
    segment: {
      deviceId: key.deviceId,
      sessionId: key.sessionId,
      streamKey: key.streamKey,
      s3Key,
      seq: key.seq,
      startTs,
      durationMs: sc.durationMs,
      sizeBytes: sc.sizeBytes,
      keyframe: true, // segments start on keyframes by construction (key-int ≤ fragment)
      finalized: sc.finalized ?? true,
      meta: {
        ...(sc.anchor ? { anchor: sc.anchor } : {}),
        ...(sc.timeSource ? { timeSource: sc.timeSource } : {}),
        ...(sc.startMono !== undefined ? { startMono: sc.startMono } : {}),
      },
    },
    segmentEnd,
  };
}

/** The key prefix is IAM-scoped ground truth; a contradicting sidecar means a
 *  mis-built file — refuse rather than attribute media to the wrong place. */
export function sidecarMatchesKey(key: MediaSegmentObjectKey, sc: VideoSidecar): boolean {
  return (
    sc.deviceId === key.deviceId &&
    sc.streamKey === key.streamKey &&
    sc.sessionId === key.sessionId &&
    sc.seq === key.seq
  );
}

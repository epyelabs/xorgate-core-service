import type { MediaSegmentObjectKey } from './media-segments';

/**
 * Pure pieces of the session-thumbnail pipeline (handlers/media-thumbnail.ts):
 * key construction and the ffmpeg argv, kept side-effect-free so the tests can
 * pin them without S3 or a binary.
 *
 * A session's poster frame is extracted from its FIRST segment (seq 0), which
 * starts on a keyframe by construction (encoder key-int <= fragment duration),
 * and stored inside the session's own S3 prefix so the segment lifecycle rule
 * and the session DELETE cleanup both cover it with no extra bookkeeping.
 */

export const THUMBNAIL_FILENAME = 'thumb.jpg';

// Matches the FE tile it feeds (aspect-video, half a side panel wide) with
// headroom for 2x displays; -2 keeps the height even for the scaler.
export const THUMBNAIL_MAX_WIDTH = 640;

/** The EventBridge rule's suffix filter — first segment of a session, only. */
export const FIRST_SEGMENT_SUFFIX = '/00000.mp4';

// The camera's first frames are blown out while the sensor/AE initializes
// (observed on the real fleet: frame 0 is plain white), so seek past the
// warm-up before grabbing the poster. Segments shorter than this (crash-cut,
// or a recording stopped immediately) yield no frame at the seek — the
// handler falls back to frame 0 for those rather than no thumbnail at all.
export const THUMBNAIL_SEEK_SECONDS = 5;

export function thumbnailKeyFor(key: MediaSegmentObjectKey): string {
  return `media-sessions/v1/${key.deviceId}/${key.streamKey}/${key.sessionId}/${THUMBNAIL_FILENAME}`;
}

/**
 * One frame, JPEG, capped width, taken `seekSeconds` into the segment (input
 * seek: lands on the nearest keyframe first, cheap). Same quiet/scale idiom as
 * the workflow media executors (the engine package's media module, video.decode_sample)
 * — argv for a direct spawn, no shell.
 */
export function ffmpegThumbnailArgs(
  inputPath: string,
  outputPath: string,
  seekSeconds: number = THUMBNAIL_SEEK_SECONDS,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(iw,${THUMBNAIL_MAX_WIDTH})':-2`,
    '-q:v',
    '4',
    '-y',
    outputPath,
  ];
}

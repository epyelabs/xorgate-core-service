import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { EventBridgeEvent } from 'aws-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { parseMediaSegmentObjectKey } from '../services/media-segments';
import { ffmpegThumbnailArgs, thumbnailKeyFor } from '../services/media-thumbnails';

// Shape of the S3 "Object Created" event delivered via EventBridge.
interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number };
}

const s3 = new S3Client({});

/**
 * Session poster-frame extraction (session-thumbnails feature). EventBridge
 * rule on S3 "Object Created" with suffix /00000.mp4 under the media bucket →
 * this Lambda. It downloads the session's first segment (keyframe-aligned by
 * construction), extracts one downscaled JPEG with the layer-provided ffmpeg
 * (FFMPEG_PATH=/opt/bin/ffmpeg), stores it as .../<sessionId>/thumb.jpg next
 * to the segments, and records the key on media_sessions.thumbnail_key. The
 * sessions list presigns it as `thumbnailUrl`.
 *
 * Error semantics (async EventBridge invoke, retries + DLQ, same split as
 * media-segment-ingest):
 *  - Permanent (foreign key shape, ffmpeg cannot decode the segment) → log +
 *    return; the session simply keeps thumbnail_key NULL, which every consumer
 *    must tolerate anyway.
 *  - Transient (S3/DB failure, ffmpeg binary missing = broken deploy, session
 *    row not ingested yet — this rule races media-segment-ingest on the very
 *    same object) → throw, so the retry lands after ingest has won the race.
 *
 * Idempotent: a duplicate delivery sees thumbnail_key already set and returns;
 * the object PUT itself is a same-bytes overwrite either way.
 */
export const handler = async (
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>,
): Promise<void> => {
  const bucket = event.detail?.bucket?.name;
  const key = event.detail?.object?.key;
  if (!bucket || !key) {
    console.warn('media-thumbnail: event missing bucket/key', { id: event.id });
    return;
  }

  // The rule filters on suffix only; the key parser is the prefix/shape gate
  // (a /00000.mp4 under any other prefix parses to null and is dropped).
  const parsedKey = parseMediaSegmentObjectKey(key);
  if (!parsedKey || parsedKey.ext !== 'mp4' || parsedKey.seq !== 0) {
    console.log('media-thumbnail: not a first media segment, dropping', { key });
    return;
  }
  const { deviceId, sessionId, streamKey } = parsedKey;

  const session = await db.query.mediaSessions.findFirst({
    where: and(
      eq(schema.mediaSessions.id, sessionId),
      eq(schema.mediaSessions.deviceId, deviceId),
    ),
    columns: { id: true, thumbnailKey: true },
  });
  if (!session) {
    // Ingest processes the same Object Created event and creates the row;
    // losing that race is expected. Throw → EventBridge retry lands later.
    throw new Error(`media-thumbnail: session ${sessionId} not ingested yet, retrying`);
  }
  if (session.thumbnailKey) {
    console.log('media-thumbnail: already generated, skipping', { key });
    return;
  }

  const segmentPath = path.join(tmpdir(), `${sessionId}-00000.mp4`);
  const thumbPath = path.join(tmpdir(), `${sessionId}-thumb.jpg`);
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(obj.Body as Readable, createWriteStream(segmentPath));

    const decoded = await extractFrame(segmentPath, thumbPath);
    if (!decoded) return; // permanent: logged inside, session keeps NULL

    const thumbnailKey = thumbnailKeyFor(parsedKey);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: thumbnailKey,
        Body: await readFile(thumbPath),
        ContentType: 'image/jpeg',
      }),
    );

    // thumbnail_key IS NULL guard: a concurrent duplicate that got past the
    // read above loses here without clobbering anything. Zero rows can also
    // mean the session was deleted mid-flight — the orphan object then expires
    // with the segment lifecycle rule, same as straggler segments.
    const updated = await db
      .update(schema.mediaSessions)
      .set({ thumbnailKey })
      .where(
        and(
          eq(schema.mediaSessions.id, sessionId),
          isNull(schema.mediaSessions.thumbnailKey),
        ),
      )
      .returning({ id: schema.mediaSessions.id });
    if (updated.length === 0) {
      console.log('media-thumbnail: session row gone or already thumbed, object left to lifecycle', { key });
      return;
    }

    console.log('media-thumbnail: generated', { key, deviceId, streamKey, sessionId, thumbnailKey });
  } finally {
    // Lambda sandboxes are reused — leaving segments in /tmp would fill it.
    await rm(segmentPath, { force: true }).catch(() => {});
    await rm(thumbPath, { force: true }).catch(() => {});
  }
};

/**
 * Extract one poster frame: THUMBNAIL_SEEK_SECONDS in (the camera's first
 * frames are blown-out white while the sensor/AE warms up), falling back to
 * frame 0 when the segment is shorter than the seek (crash-cut, or a
 * recording stopped immediately). Returns false when even the fallback fails
 * (a segment ffmpeg cannot decode fails identically on every retry —
 * permanent, log and drop; the session just keeps thumbnail_key NULL).
 */
async function extractFrame(segmentPath: string, thumbPath: string): Promise<boolean> {
  const seeked = await runFfmpeg(segmentPath, thumbPath, undefined);
  // A past-EOF seek can exit 0 with no output file — treat both shapes as
  // "no frame there" and retry from the start.
  if (seeked.ok && existsSync(thumbPath)) return true;
  const fallback = await runFfmpeg(segmentPath, thumbPath, 0);
  if (fallback.ok && existsSync(thumbPath)) return true;
  console.error('media-thumbnail: ffmpeg failed, dropping (no thumbnail for this session)', {
    segmentPath,
    seeked: seeked.detail,
    fallback: fallback.detail,
  });
  return false;
}

/**
 * One ffmpeg run. A non-zero exit is reported to the caller (it decides
 * whether a fallback remains); a spawn error (binary missing from the layer)
 * is a broken deploy and throws instead, so it alarms via the DLQ.
 */
async function runFfmpeg(
  segmentPath: string,
  thumbPath: string,
  seekSeconds: number | undefined,
): Promise<{ ok: boolean; detail: string }> {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const child = spawn(ffmpeg, ffmpegThumbnailArgs(segmentPath, thumbPath, seekSeconds), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2048);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? -1));
  });
  return {
    ok: code === 0,
    detail: `exit ${code}: ${stderrTail.trim().split('\n').slice(-3).join(' | ') || 'no stderr'}`,
  };
}

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { readImageDimensions } from '../models/image-dimensions';
import { datasetItemKey, MAX_IMPORT_FRAMES, MAX_ITEMS_PER_DATASET } from '../models/keys';
import type { ResolvedVideoSession } from '../workflows/production';
import { findOrgSessions, resolveVideoSessions } from './media-session-input';
import { datasetS3, putBytesObject } from './dataset-store';
import { enqueueModelJob } from './model-jobs';

/**
 * Recording-frame import (design §4f): `POST /datasets/{id}/imports {kind:
 * recording}` names a media session the organization owns; this job walks
 * the session's segments in `startTs` order (never `seq`: the replay-manifest
 * rule), extracts JPEGs at `everySeconds` with the layer's ffmpeg, dedupes by
 * sha256 against the dataset, uploads each frame as an item and registers the
 * row with `source {kind: recording, deviceId, sessionId, segmentSeq, ts}` and
 * `groupKey = <sessionId>:<floor(ts / 60 s)>`.
 *
 * Long sessions chunk across invocations: after every segment the row's
 * `progress.cursor` advances, and when the Lambda's remaining time drops
 * under the reserve the job re-enqueues itself with that cursor and returns.
 * The first delivery claims the row through `dispatched_at`; a continuation
 * is accepted only while `progress.cursor` equals the message's cursor, so a
 * redelivered continuation is a no-op.
 */

const DEFAULT_EVERY_SECONDS = 2;
const CONTINUE_RESERVE_MS = 120_000;
const FRAME_QUALITY = '2';

export interface ImportParams {
  sessionId: string;
  everySeconds?: number;
  fps?: number;
  maxFrames?: number;
  from?: string;
  to?: string;
}

interface ImportProgress {
  cursor: number;
  segments: number;
  framesSeen: number;
  duplicates: number;
  skippedSegments: number;
  note?: string;
}

function progressOf(row: typeof schema.datasetImports.$inferSelect): ImportProgress {
  const p = (row.progress ?? {}) as Partial<ImportProgress>;
  return {
    cursor: p.cursor ?? 0,
    segments: p.segments ?? 0,
    framesSeen: p.framesSeen ?? 0,
    duplicates: p.duplicates ?? 0,
    skippedSegments: p.skippedSegments ?? 0,
    ...(p.note ? { note: p.note } : {}),
  };
}

export function intervalSecondsOf(params: ImportParams): number {
  if (params.fps && params.fps > 0) return 1 / params.fps;
  if (params.everySeconds && params.everySeconds > 0) return params.everySeconds;
  return DEFAULT_EVERY_SECONDS;
}

async function runFfmpeg(args: string[]): Promise<{ ok: boolean; detail: string }> {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2048);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? -1));
  });
  return { ok: code === 0, detail: `exit ${code}: ${stderrTail.trim().split('\n').slice(-3).join(' | ') || 'no stderr'}` };
}

/** `ffmpeg -ss <offset> -i seg.mp4 -vf fps=1/<interval> -q:v 2 out/%05d.jpg` */
export function ffmpegSampleArgs(inputPath: string, outDir: string, offsetSeconds: number, intervalSeconds: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(offsetSeconds > 0 ? ['-ss', offsetSeconds.toFixed(3)] : []),
    '-i',
    inputPath,
    '-vf',
    `fps=1/${intervalSeconds}`,
    '-q:v',
    FRAME_QUALITY,
    '-y',
    path.join(outDir, '%05d.jpg'),
  ];
}

export type ImportOutcome = 'done' | 'continued' | 'skipped';

export async function runRecordingImport(args: {
  bucket: string;
  importId: string;
  cursor: number | undefined;
  remainingMs: () => number;
  log: (m: string) => void;
}): Promise<ImportOutcome> {
  const { bucket, importId, log } = args;
  const row = await db.query.datasetImports.findFirst({ where: eq(schema.datasetImports.id, importId) });
  if (!row) {
    log(`import ${importId} not found, acking`);
    return 'skipped';
  }
  let progress = progressOf(row);
  if (args.cursor === undefined) {
    if (row.status !== 'queued') return 'skipped';
    const claimed = await db
      .update(schema.datasetImports)
      .set({ dispatchedAt: new Date(), startedAt: new Date(), status: 'running', updatedAt: new Date() })
      .where(
        and(
          eq(schema.datasetImports.id, importId),
          eq(schema.datasetImports.status, 'queued'),
          isNull(schema.datasetImports.dispatchedAt),
        ),
      )
      .returning({ id: schema.datasetImports.id });
    if (claimed.length === 0) {
      log(`import ${importId} already claimed, acking`);
      return 'skipped';
    }
  } else {
    if (row.status !== 'running' || progress.cursor !== args.cursor) {
      log(`import ${importId}: stale continuation (cursor ${args.cursor} vs ${progress.cursor}), acking`);
      return 'skipped';
    }
  }

  const dataset = await db.query.datasets.findFirst({ where: eq(schema.datasets.id, row.datasetId) });
  if (!dataset) {
    await fail(importId, 'Dataset no longer exists');
    return 'done';
  }
  const params = row.params as ImportParams;
  const workDir = path.join(tmpdir(), `import-${importId}`);
  try {
    const sessions = await findOrgSessions([params.sessionId], dataset.organizationId);
    if (sessions.length === 0) {
      await fail(importId, `Session "${params.sessionId}" not found in this organization`);
      return 'done';
    }
    const [resolved] = await resolveVideoSessions(sessions);
    if (!resolved || resolved.segments.length === 0) {
      await fail(importId, `Session "${params.sessionId}" has no stored segments`);
      return 'done';
    }
    const session = sessions[0];
    const interval = intervalSecondsOf(params);
    const maxFrames = Math.min(params.maxFrames ?? MAX_IMPORT_FRAMES, MAX_IMPORT_FRAMES);
    const fromTs = params.from ? Date.parse(params.from) : -Infinity;
    const toTs = params.to ? Date.parse(params.to) : Infinity;
    progress.segments = resolved.segments.length;

    const existing = await db
      .select({ sha256: schema.datasetItems.sha256 })
      .from(schema.datasetItems)
      .where(eq(schema.datasetItems.datasetId, dataset.id));
    const seen = new Set(existing.map((r) => r.sha256));
    let itemCount = existing.length;
    let itemsAdded = row.itemsAdded;

    await mkdir(workDir, { recursive: true });
    for (let i = progress.cursor; i < resolved.segments.length; i++) {
      if (progress.framesSeen >= maxFrames) break;
      if (itemCount >= MAX_ITEMS_PER_DATASET) {
        progress.note = `dataset cap of ${MAX_ITEMS_PER_DATASET} items reached`;
        break;
      }
      const seg = resolved.segments[i];
      const segEnd = seg.startTs + seg.effectiveDurationMs;
      // Sample times on the session-wide grid (fromTs, fromTs + interval, ...)
      // that fall inside this segment and the requested window.
      const gridOrigin = Number.isFinite(fromTs) ? fromTs : resolved.fromTs;
      const firstK = Math.max(0, Math.ceil((Math.max(seg.startTs, fromTs) - gridOrigin) / (interval * 1000)));
      const firstTs = gridOrigin + firstK * interval * 1000;
      if (firstTs >= segEnd || firstTs > toTs) {
        progress.cursor = i + 1;
        await saveProgress(importId, progress, itemsAdded);
        continue;
      }
      const offsetSeconds = Math.max(0, (firstTs - seg.startTs) / 1000);
      const segPath = path.join(workDir, `seg-${seg.seq}.mp4`);
      const framesDir = path.join(workDir, `frames-${seg.seq}`);
      await mkdir(framesDir, { recursive: true });
      try {
        const obj = await datasetS3().send(new GetObjectCommand({ Bucket: bucket, Key: seg.s3Key }));
        await pipeline(obj.Body as Readable, createWriteStream(segPath));
        const res = await runFfmpeg(ffmpegSampleArgs(segPath, framesDir, offsetSeconds, interval));
        if (!res.ok) {
          log(`import ${importId}: segment ${seg.seq} ffmpeg failed (${res.detail}), skipping`);
          progress.skippedSegments += 1;
        } else {
          const files = (await readdir(framesDir)).filter((f) => f.endsWith('.jpg')).sort();
          for (let k = 0; k < files.length; k++) {
            if (progress.framesSeen >= maxFrames || itemCount >= MAX_ITEMS_PER_DATASET) break;
            const ts = firstTs + k * interval * 1000;
            if (ts >= segEnd || ts > toTs) break;
            const bytes = await readFile(path.join(framesDir, files[k]));
            progress.framesSeen += 1;
            const dims = readImageDimensions(bytes);
            if (!dims) continue;
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            if (seen.has(sha256)) {
              progress.duplicates += 1;
              continue;
            }
            const itemId = randomUUID();
            const key = datasetItemKey(dataset.id, itemId, 'jpg');
            await putBytesObject(bucket, key, bytes, 'image/jpeg');
            await db.insert(schema.datasetItems).values({
              id: itemId,
              datasetId: dataset.id,
              s3Key: key,
              width: dims.width,
              height: dims.height,
              bytes: bytes.length,
              sha256,
              source: {
                kind: 'recording',
                deviceId: session.deviceId,
                sessionId: session.id,
                streamKey: session.streamKey,
                segmentSeq: seg.seq,
                ts: new Date(ts).toISOString(),
                importId,
              },
              groupKey: `${session.id}:${Math.floor(ts / 60_000)}`,
              status: 'unlabeled',
            });
            seen.add(sha256);
            itemCount += 1;
            itemsAdded += 1;
          }
        }
      } finally {
        await rm(segPath, { force: true }).catch(() => {});
        await rm(framesDir, { recursive: true, force: true }).catch(() => {});
      }
      progress.cursor = i + 1;
      await saveProgress(importId, progress, itemsAdded);
      if (progress.cursor < resolved.segments.length && progress.framesSeen < maxFrames && args.remainingMs() < CONTINUE_RESERVE_MS) {
        await enqueueModelJob({ kind: 'import', importId, cursor: progress.cursor });
        log(`import ${importId}: continuing at segment ${progress.cursor}/${resolved.segments.length} (${itemsAdded} added so far)`);
        return 'continued';
      }
    }
    await db
      .update(schema.datasetImports)
      .set({ status: 'succeeded', itemsAdded, progress, endedAt: new Date(), updatedAt: new Date(), error: null })
      .where(eq(schema.datasetImports.id, importId));
    await refreshItemCount(dataset.id);
    log(`import ${importId} succeeded: ${itemsAdded} item(s) added from ${describe(resolved)} (${progress.framesSeen} frames seen, ${progress.duplicates} duplicates)`);
    return 'done';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`import ${importId} failed: ${message}`);
    await fail(importId, message);
    await refreshItemCount(dataset.id).catch(() => {});
    return 'done';
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function describe(resolved: ResolvedVideoSession): string {
  return `${resolved.segments.length} segment(s) of ${resolved.streamKey}`;
}

async function saveProgress(importId: string, progress: ImportProgress, itemsAdded: number): Promise<void> {
  await db
    .update(schema.datasetImports)
    .set({ progress, itemsAdded, updatedAt: new Date() })
    .where(eq(schema.datasetImports.id, importId));
}

async function fail(importId: string, message: string): Promise<void> {
  await db
    .update(schema.datasetImports)
    .set({ status: 'failed', error: message.slice(0, 2000), endedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.datasetImports.id, importId));
}

/** `datasets.item_count` from the rows (the one place counts are recomputed after a bulk change). */
export async function refreshItemCount(datasetId: string): Promise<void> {
  await db
    .update(schema.datasets)
    .set({
      itemCount: sql<number>`(select count(*)::int from dataset_items i where i.dataset_id = ${schema.datasets.id} and i.status <> 'excluded')`,
      labeledCount: sql<number>`(select count(*)::int from dataset_items i where i.dataset_id = ${schema.datasets.id} and i.status = 'labeled')`,
      updatedAt: new Date(),
    })
    .where(eq(schema.datasets.id, datasetId));
}

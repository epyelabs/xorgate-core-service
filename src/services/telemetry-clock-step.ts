import { gunzipSync, gzipSync } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import { isStaleStraggler, totalTelemetryShiftMs, type TelemetryClockStep } from './clock-step';
import { plausibleSampleTs, shiftSegmentText, type ParsedSegment, type StaleTsGroup } from './telemetry-batch';
import { SEGMENT_CACHE_CONTROL, SEGMENT_CONTENT_ENCODING, SEGMENT_CONTENT_TYPE } from './telemetry-sessions';

/**
 * Clock-step correction, the telemetry I/O half (plans/clock-step-correction
 * §4.3, D6-D11). Shared by the ingest Lambda (handlers/telemetry-batch-ingest.ts)
 * and the one-off backfill (P3). The pure half is services/clock-step.ts
 * (detection, offsets) and services/telemetry-batch.ts (line re-stamping).
 *
 * Two phases, in this order:
 *  1. S3, BEFORE the caller's transaction: rewrite the straddling object with
 *     its stale lines re-stamped, and every earlier file of the session
 *     shifted whole (D7). Readers (core cold path, the @xorgate/react raw
 *     reader, the overview builder) read these objects directly, so the
 *     objects themselves are corrected rather than annotated.
 *  2. DB, inside the caller's transaction, strictly sequential (RDS Data
 *     API): segment bounds, `telemetry_readings` rows by exact stale ts, then
 *     the session roll-up + audit columns (D9).
 *
 * Idempotency (D8). A retry after phase 1 but before the commit reads a file
 * that no longer contains its step, so detection alone cannot recover it. Each
 * rewritten object therefore carries what was done in its user metadata
 * (`x-amz-meta-xg-clock-step`, CLOCK_STEP_META_KEY):
 *  - `own`: the step(s) this object was corrected for, with the raw values
 *    the session correction needs, so a redelivery (or the event our own PUT
 *    re-fires, racing the commit) replays phase 2 identically;
 *  - `applied`: whole-file shifts applied on behalf of a step file (`seq:<n>`)
 *    or as a D10 straggler, so a retry never shifts the same file twice and
 *    still knows the ts values `telemetry_readings` holds (current − shift).
 * Every DB write is absolute or an exact-ts match, and the caller's
 * `telemetry_ingest_log` PK lets only one transaction per key commit, so the
 * accumulating `clock_correction_ms` is applied once.
 */

const s3 = new S3Client({});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** S3 user-metadata key (lower-case: S3 returns metadata keys lower-cased). */
export const CLOCK_STEP_META_KEY = 'xg-clock-step';
/** Stale ts values per `UPDATE telemetry_readings ... ts IN (...)` (Data API statement size). */
export const READINGS_TS_CHUNK = 200;
/** `applied.by` for a D10 straggler shift. */
export const STRAGGLER_SHIFT_ID = 'straggler';

const stepSchema = z.object({ atIndex: z.number().int().nonnegative(), jumpMs: z.number() });
const metaSchema = z.object({
  v: z.literal(1),
  own: z
    .object({
      steps: z.array(stepSchema).min(1),
      shiftMs: z.number(),
      rawFirstTs: z.number(),
      staleBefore: z.number(),
    })
    .optional(),
  applied: z.array(z.object({ by: z.string(), ms: z.number() })).optional(),
});
export type ClockStepObjectMeta = z.infer<typeof metaSchema>;

/** The object's clock-step record, or null when absent / unreadable (treated as never corrected). */
export function readClockStepMeta(metadata: Record<string, string> | undefined | null): ClockStepObjectMeta | null {
  const raw = metadata?.[CLOCK_STEP_META_KEY];
  if (!raw) return null;
  try {
    const parsed = metaSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeClockStepMeta(meta: ClockStepObjectMeta): Record<string, string> {
  return { [CLOCK_STEP_META_KEY]: JSON.stringify(meta) };
}

/** `applied.by` for shifts made on behalf of the step found in segment `seq`. */
export const stepShiftId = (seq: number): string => `seq:${seq}`;

/** Split a list into chunks of `size` (the readings UPDATE's IN-list). */
export function chunk<T>(items: readonly T[], size = READINGS_TS_CHUNK): T[][] {
  if (!(size > 0)) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Gunzip when the body is gzip (it always is for a segment); pass plain text through. */
export function decodeSegmentBody(body: Buffer): string {
  const gz = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  return (gz ? gunzipSync(body) : body).toString('utf8');
}

export interface SegmentObject {
  text: string;
  meta: ClockStepObjectMeta | null;
  bytes: number;
}

/** GET + decode one segment; null when the lifecycle already removed it. */
export async function readSegmentObject(bucket: string, key: string): Promise<SegmentObject | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await obj.Body!.transformToByteArray());
    return { text: decodeSegmentBody(body), meta: readClockStepMeta(obj.Metadata), bytes: obj.ContentLength ?? body.length };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/**
 * PUT a corrected segment onto its own key with the normalised metadata
 * (README Q14) plus the clock-step record. Gzip is deterministic, so two
 * concurrent attempts write identical bytes. Returns the stored size.
 */
export async function rewriteSegmentObject(
  bucket: string,
  key: string,
  text: string,
  meta: ClockStepObjectMeta,
): Promise<number> {
  const body = gzipSync(Buffer.from(text, 'utf8'));
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: SEGMENT_CONTENT_TYPE,
      ContentEncoding: SEGMENT_CONTENT_ENCODING,
      CacheControl: SEGMENT_CACHE_CONTROL,
      Metadata: encodeClockStepMeta(meta),
    }),
  );
  return body.length;
}

/** One rewritten (or already-rewritten) segment and what its DB rows need. */
export interface SegmentShift {
  s3Key: string;
  /** Corrected bounds (null: the file has no valid sample, bounds untouched). */
  firstTs: number | null;
  lastTs: number | null;
  /** Stored size after the rewrite, and its difference to the indexed `bytes`. */
  bytes: number;
  bytesDelta: number;
  /** Ts values `telemetry_readings` holds for this file now, and the shift each needs. */
  staleTsGroups: StaleTsGroup[];
  /** False when a previous attempt already rewrote the object (retry path). */
  rewritten: boolean;
}

/**
 * Pure: the whole-file shift for one object's current content. When `meta`
 * says `by` was already applied, the content is already shifted: nothing to
 * write, and the readings still hold `current − shiftMs` (the DB half never
 * committed, or the caller would not be here).
 */
export function planWholeFileShift(
  text: string,
  meta: ClockStepObjectMeta | null,
  shiftMs: number,
  by: string,
): { alreadyApplied: boolean; text: string; firstTs: number | null; lastTs: number | null; staleTs: number[]; meta: ClockStepObjectMeta } {
  const alreadyApplied = Boolean(meta?.applied?.some((a) => a.by === by));
  if (alreadyApplied) {
    const current = shiftSegmentText(text, 0);
    return {
      alreadyApplied,
      text,
      firstTs: current.firstTs,
      lastTs: current.lastTs,
      staleTs: current.staleTs.map((ts) => ts - shiftMs),
      meta: meta!,
    };
  }
  const shifted = shiftSegmentText(text, shiftMs);
  return {
    alreadyApplied,
    text: shifted.text,
    firstTs: shifted.firstTs,
    lastTs: shifted.lastTs,
    staleTs: shifted.staleTs,
    meta: { ...(meta ?? {}), v: 1, applied: [...(meta?.applied ?? []), { by, ms: shiftMs }] },
  };
}

/**
 * D7 (b): every earlier indexed file of the session stamped no later than the
 * step file's raw first sample, shifted whole by `shiftMs` and PUT back.
 * Sequential (S3 + bounded by the stale period). A file the lifecycle removed
 * is skipped with a warning.
 */
export async function shiftEarlierSegments(
  bucket: string,
  input: { sessionId: string; beforeSeq: number; rawFirstTs: number; shiftMs: number; by: string },
): Promise<SegmentShift[]> {
  const seg = schema.telemetrySegments;
  const rows = await db
    .select({ s3Key: seg.s3Key, bytes: seg.bytes })
    .from(seg)
    .where(
      and(
        eq(seg.sessionId, input.sessionId),
        lt(seg.seq, input.beforeSeq),
        sql`${seg.startTs} <= ${tsParam(new Date(input.rawFirstTs).toISOString())}`,
      ),
    )
    .orderBy(asc(seg.seq));

  const out: SegmentShift[] = [];
  for (const row of rows) {
    const obj = await readSegmentObject(bucket, row.s3Key);
    if (!obj) {
      console.warn('telemetry-clock-step: earlier segment missing from S3, skipped', { key: row.s3Key });
      continue;
    }
    const plan = planWholeFileShift(obj.text, obj.meta, input.shiftMs, input.by);
    const bytes = plan.alreadyApplied ? obj.bytes : await rewriteSegmentObject(bucket, row.s3Key, plan.text, plan.meta);
    out.push({
      s3Key: row.s3Key,
      firstTs: plan.firstTs,
      lastTs: plan.lastTs,
      bytes,
      bytesDelta: bytes - row.bytes,
      staleTsGroups: plan.staleTs.length > 0 ? [{ shiftMs: input.shiftMs, ts: plan.staleTs }] : [],
      rewritten: !plan.alreadyApplied,
    });
  }
  return out;
}

/** The session's correction state, read before parsing (D10). */
export interface SessionClockState {
  clockCorrectionMs: number | null;
  clockStaleBefore: Date | null;
}

export async function loadSessionClockState(sessionId: string): Promise<SessionClockState | null> {
  const t = schema.telemetrySessions;
  const [row] = await db
    .select({ clockCorrectionMs: t.clockCorrectionMs, clockStaleBefore: t.clockStaleBefore })
    .from(t)
    .where(eq(t.id, sessionId))
    .limit(1);
  return row ?? null;
}

export interface PreparedTelemetryClockStep {
  /** `step`: this file straddles a step (fresh, or replayed from `own`). `straggler`: D10 whole-file shift. */
  kind: 'step' | 'straggler';
  /** What to ingest: rows and bounds match the corrected object. */
  parsed: ParsedSegment;
  /** Stored size of THIS object when this call rewrote it, else null (use the event's size). */
  bytes: number | null;
  rewroteSelf: boolean;
  /** Total forward shift: the step file's sum of jumps, or the straggler's session correction. */
  shiftMs: number;
  steps: TelemetryClockStep[];
  /** Raw ts of the first post-step sample (`clock_stale_before`); null for a straggler. */
  staleBefore: number | null;
  rawFirstTs: number | null;
  /** Earlier files shifted for this step (empty for a straggler). */
  earlier: SegmentShift[];
}

export interface PrepareClockStepInput {
  bucket: string;
  key: string;
  sessionId: string;
  seq: number;
  /** The object's decoded content and clock-step record as just read. */
  text: string;
  meta: ClockStepObjectMeta | null;
  /** parseSegment(text) WITH clockStepMinMs. */
  parsed: ParsedSegment;
  session: SessionClockState | null;
  /** parseSegment with the same options and NO detection (for a shifted straggler). */
  reparse: (text: string) => ParsedSegment;
}

/**
 * Phase 1 for the object being ingested: decide what kind of correction it
 * needs, perform the S3 rewrites (this object, earlier files) and return the
 * plan for phase 2. Null when the file needs nothing.
 *
 *  - Steps in the content: rewrite it (D7, metadata `own`), shift earlier files.
 *  - No steps but metadata `own`: an earlier attempt already rewrote it
 *    (retry, or the event our PUT re-fired racing that attempt's commit);
 *    replay the same plan without rewriting it.
 *  - No steps, no record, and the session says the file is still stale (D10):
 *    shift it whole by the session's `clock_correction_ms`.
 */
export async function prepareTelemetryClockStep(input: PrepareClockStepInput): Promise<PreparedTelemetryClockStep | null> {
  const { bucket, key, parsed, meta } = input;
  const by = stepShiftId(input.seq);

  if (parsed.clockSteps.length > 0 || meta?.own) {
    const fresh = parsed.clockSteps.length > 0;
    const own = fresh
      ? {
          steps: parsed.clockSteps,
          shiftMs: totalTelemetryShiftMs(parsed.clockSteps),
          rawFirstTs: parsed.rawFirstTs!,
          staleBefore: parsed.staleBefore!,
        }
      : meta!.own!;
    let bytes: number | null = null;
    if (fresh && parsed.correctedText !== undefined) {
      bytes = await rewriteSegmentObject(bucket, key, parsed.correctedText, { ...(meta ?? {}), v: 1, own });
    }
    const earlier =
      own.shiftMs === 0
        ? []
        : await shiftEarlierSegments(bucket, {
            sessionId: input.sessionId,
            beforeSeq: input.seq,
            rawFirstTs: own.rawFirstTs,
            shiftMs: own.shiftMs,
            by,
          });
    return {
      kind: 'step',
      parsed,
      bytes,
      rewroteSelf: bytes !== null,
      shiftMs: own.shiftMs,
      steps: own.steps,
      staleBefore: own.staleBefore,
      rawFirstTs: own.rawFirstTs,
      earlier,
    };
  }

  if (meta?.applied?.length) return null; // already shifted by an earlier attempt or on behalf of a step file
  if (
    input.session &&
    parsed.rawFirstTs !== null &&
    isStaleStraggler(parsed.rawFirstTs, input.session)
  ) {
    const shiftMs = input.session.clockCorrectionMs!;
    const plan = planWholeFileShift(input.text, meta, shiftMs, STRAGGLER_SHIFT_ID);
    const bytes = await rewriteSegmentObject(bucket, key, plan.text, plan.meta);
    return {
      kind: 'straggler',
      parsed: input.reparse(plan.text),
      bytes,
      rewroteSelf: true,
      shiftMs,
      steps: [],
      staleBefore: null,
      rawFirstTs: parsed.rawFirstTs,
      earlier: [],
    };
  }
  return null;
}

/**
 * Phase 2 (c): bounds + readings of already-indexed files, inside the
 * caller's transaction, strictly sequential. Bounds are absolute (from file
 * contents, clamped like indexSegment); readings move by exact stale ts, so a
 * re-run after a commit matches nothing. Returns the readings moved.
 */
export async function applySegmentShifts(tx: Tx, deviceId: string, files: readonly SegmentShift[]): Promise<number> {
  const seg = schema.telemetrySegments;
  const r = schema.telemetryReadings;
  const nowMs = Date.now();
  let moved = 0;
  for (const file of files) {
    if (file.firstTs !== null && file.lastTs !== null) {
      const start = plausibleSampleTs(file.firstTs, nowMs);
      const end = Math.max(start, plausibleSampleTs(file.lastTs, nowMs));
      await tx
        .update(seg)
        .set({
          startTs: tsParam(new Date(start).toISOString()),
          endTs: tsParam(new Date(end).toISOString()),
          bytes: file.bytes,
        })
        .where(eq(seg.s3Key, file.s3Key));
    }
    for (const group of file.staleTsGroups) {
      if (group.shiftMs === 0) continue;
      for (const part of chunk(group.ts)) {
        const res = await tx
          .update(r)
          .set({ ts: sql`${r.ts} + ${group.shiftMs}::bigint * interval '1 millisecond'` })
          .where(
            and(
              eq(r.deviceId, deviceId),
              sql`${r.ts} in (${sql.join(
                part.map((ts) => tsParam(new Date(ts).toISOString())),
                sql`, `,
              )})`,
            ),
          );
        moved += updatedCount(res);
      }
    }
  }
  return moved;
}

/**
 * Phase 2 (d): the session roll-up after every segment row it owns carries
 * corrected bounds (call AFTER indexSegment for the step file). Bounds are
 * recomputed from the segments (absolute); the audit columns accumulate (D11):
 * `clock_stale_before` keeps the EARLIEST post-step raw stamp, so a straggler
 * from before the first step still matches it. A built overview goes stale and
 * the housekeeping pass rebuilds it.
 */
export async function applySessionClockCorrection(
  tx: Tx,
  input: { sessionId: string; shiftMs: number; staleBefore: number | null; bytesDelta?: number },
): Promise<void> {
  const t = schema.telemetrySessions;
  const seg = schema.telemetrySegments;
  const staleBefore = input.staleBefore === null ? null : tsParam(new Date(input.staleBefore).toISOString());
  await tx
    .update(t)
    .set({
      startedAt: sql`coalesce((select min(${seg.startTs}) from ${seg} where ${seg.sessionId} = ${t.id}), ${t.startedAt})`,
      endedAt: sql`coalesce((select max(${seg.endTs}) from ${seg} where ${seg.sessionId} = ${t.id}), ${t.endedAt})`,
      byteCount: sql`${t.byteCount} + ${input.bytesDelta ?? 0}::bigint`,
      clockCorrectionMs: sql`coalesce(${t.clockCorrectionMs}, 0) + ${input.shiftMs}::bigint`,
      clockStaleBefore:
        staleBefore === null ? sql`${t.clockStaleBefore}` : sql`least(coalesce(${t.clockStaleBefore}, ${staleBefore}), ${staleBefore})`,
      clockCorrectedAt: sql`now()`,
      overviewStale: sql`(${t.overviewKey} is not null)`,
      updatedAt: sql`now()`,
    })
    .where(eq(t.id, input.sessionId));
}

/**
 * Phase 2 in one call, for callers whose step file is already indexed (the P3
 * backfill passes it in `files` with its own stale groups): segment shifts,
 * then the session correction.
 */
export async function applyTelemetryClockStep(
  tx: Tx,
  input: { sessionId: string; deviceId: string; files: readonly SegmentShift[]; shiftMs: number; staleBefore: number | null },
): Promise<{ readingsMoved: number }> {
  const readingsMoved = await applySegmentShifts(tx, input.deviceId, input.files);
  await applySessionClockCorrection(tx, {
    sessionId: input.sessionId,
    shiftMs: input.shiftMs,
    staleBefore: input.staleBefore,
    bytesDelta: input.files.reduce((sum, f) => sum + f.bytesDelta, 0),
  });
  return { readingsMoved };
}

/**
 * A device uploader retry can re-PUT a key AFTER we corrected it (the
 * duplicate-delivery path sees it as a fresh normalisation copy). The DB is
 * already corrected; put the object back in line with it: in-file steps are
 * re-stamped, a fully stale file is shifted by the session's correction.
 * S3 only, never the DB. Returns what it did.
 */
export async function repairReputSegment(
  bucket: string,
  key: string,
  opts: { clockStepMinMs: number; reparse: (text: string, clockStepMinMs?: number) => ParsedSegment },
): Promise<'restamped' | 'shifted' | 'none'> {
  const obj = await readSegmentObject(bucket, key);
  if (!obj || obj.meta) return 'none';
  const parsed = opts.reparse(obj.text, opts.clockStepMinMs);
  if (parsed.clockSteps.length > 0 && parsed.correctedText !== undefined) {
    await rewriteSegmentObject(bucket, key, parsed.correctedText, {
      v: 1,
      own: {
        steps: parsed.clockSteps,
        shiftMs: totalTelemetryShiftMs(parsed.clockSteps),
        rawFirstTs: parsed.rawFirstTs!,
        staleBefore: parsed.staleBefore!,
      },
    });
    return 'restamped';
  }
  const sessionId = key.split('/')[3];
  const session = sessionId ? await loadSessionClockState(sessionId) : null;
  if (session && parsed.rawFirstTs !== null && isStaleStraggler(parsed.rawFirstTs, session)) {
    const plan = planWholeFileShift(obj.text, null, session.clockCorrectionMs!, STRAGGLER_SHIFT_ID);
    await rewriteSegmentObject(bucket, key, plan.text, plan.meta);
    return 'shifted';
  }
  return 'none';
}

/** `numberOfRecordsUpdated` from a Data API UPDATE without RETURNING. */
function updatedCount(res: unknown): number {
  const n = (res as { numberOfRecordsUpdated?: unknown } | undefined)?.numberOfRecordsUpdated;
  return typeof n === 'number' ? n : 0;
}

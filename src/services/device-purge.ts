import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { isoSql, tsParam, uuidParam } from '../utils/sql';
import { enqueueModelJob } from './model-jobs';
import { drainPrefix } from './s3-drain';
import {
  dayFloor,
  halveWindow,
  initialCounts,
  isStatementTimeout,
  nextReadingsWindow,
  purgeSteps,
  READINGS_DAY_MS,
  runArtifactPrefixes,
  widenWindow,
  type PurgeCounts,
  type PurgeCursor,
  type PurgeStep,
} from './device-purge-rules';

/**
 * The device data purge job (plans/device-wf-data-delete, README §3c).
 *
 * `POST /devices/{id}/purges` writes a `device_purges` row and drops
 * `{ kind: 'device_purge', purgeId }` on the ModelJobQueue; this runs it. Every
 * step is idempotent and the row is the only state: the job claims the row by
 * taking its lease, walks the steps its scopes ask for, persists `cursor` and
 * `counts` after every chunk, and when the Lambda's remaining time drops under
 * the reserve it re-enqueues the same message and returns. A redelivered
 * message therefore resumes from the row, never repeats.
 *
 * Why chunks at all: `telemetry_readings` has no FK and is partitioned by
 * `ts`, so a delete by device probes every partition and a busy device holds
 * millions of rows, while the RDS Data API cancels any statement at ~45 s. The
 * readings step deletes one day at a time and halves the window on a timeout
 * (the 008 migration's rule). Nothing here runs inside a transaction: the Data
 * API allows no concurrent statements, and each chunk is safe to repeat.
 */

// Inlined with sql.raw where used: the Data API binds a JS number as bigint and
// make_interval(mins => bigint) does not exist (the scheduler does the same).
const LEASE_MINUTES = 16; // > the dispatcher's 15-minute budget
const CONTINUE_RESERVE_MS = 60_000;
const RUN_PAGE = 100; // each run also costs an S3 list + delete
const S3_PAGES_PER_CHUNK = 20; // persist the continuation token this often
const MAX_RECEIVES = 3; // ModelJobQueue's maxReceiveCount

const ecs = new ECSClient({});
const CLUSTER = process.env.RECORDER_CLUSTER_ARN;

export type PurgeRow = typeof schema.devicePurges.$inferSelect;
export type PurgeOutcome = 'done' | 'continued' | 'skipped' | 'failed';

/** `numberOfRecordsUpdated` from a raw Data API DELETE / UPDATE (no RETURNING, so no 1 MiB cap). */
function updatedCount(res: unknown): number {
  const n = (res as { numberOfRecordsUpdated?: unknown }).numberOfRecordsUpdated;
  return typeof n === 'number' ? n : 0;
}

export async function runDevicePurge(args: {
  bucket: string;
  purgeId: string;
  remainingMs: () => number;
  receiveCount: number;
  log: (m: string) => void;
}): Promise<PurgeOutcome> {
  const { bucket, purgeId, remainingMs, log } = args;
  const startedAtMs = Date.now();

  // Claim: queued or running, with no live lease. No row means done, deleted
  // (the device went with it) or held by another worker: ack in every case.
  const [row] = await db
    .update(schema.devicePurges)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${schema.devicePurges.startedAt}, now())`,
      leaseUntil: sql`now() + make_interval(mins => ${sql.raw(String(LEASE_MINUTES))})`,
    })
    .where(
      and(
        eq(schema.devicePurges.id, purgeId),
        inArray(schema.devicePurges.status, ['queued', 'running']),
        or(isNull(schema.devicePurges.leaseUntil), lt(schema.devicePurges.leaseUntil, sql`now()`)),
      ),
    )
    .returning();
  if (!row) {
    log(`purge ${purgeId}: nothing to claim (done, gone or leased), acking`);
    return 'skipped';
  }

  const steps = purgeSteps(row.scopes);
  const counts: PurgeCounts = { ...initialCounts(), ...((row.counts ?? {}) as Partial<PurgeCounts>) };
  let cursor: PurgeCursor = (row.cursor as PurgeCursor | null) ?? { step: steps[0] };
  let idx = Math.max(0, steps.indexOf(cursor.step));
  const cutoff = row.cutoff;
  const deviceId = row.deviceId;

  const persist = async () => {
    await db
      .update(schema.devicePurges)
      .set({
        cursor,
        counts,
        leaseUntil: sql`now() + make_interval(mins => ${sql.raw(String(LEASE_MINUTES))})`,
      })
      .where(eq(schema.devicePurges.id, purgeId));
  };

  try {
    for (;;) {
      const step = steps[idx];
      if (step === 'done') {
        await db
          .update(schema.devicePurges)
          .set({ status: 'succeeded', cursor: { step: 'done' }, counts, finishedAt: new Date(), leaseUntil: null })
          .where(eq(schema.devicePurges.id, purgeId));
        console.log(
          '[device-purge]',
          JSON.stringify({ purgeId, deviceId, scopes: row.scopes, counts, ms: Date.now() - startedAtMs }),
        );
        return 'done';
      }
      if (remainingMs() < CONTINUE_RESERVE_MS) {
        await persist();
        await enqueueModelJob({ kind: 'device_purge', purgeId });
        log(`purge ${purgeId}: budget low at ${step}, re-enqueued`);
        return 'continued';
      }
      const outcome = await runChunk(step, { bucket, deviceId, cutoff, cursor, counts, log });
      if (outcome === 'next') {
        idx += 1;
        cursor = { step: steps[idx] };
      }
      await persist();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.receiveCount >= MAX_RECEIVES) {
      // SQS is about to dead-letter this message; the row must say so rather
      // than sit `running` forever.
      await db
        .update(schema.devicePurges)
        .set({ status: 'failed', error: message.slice(0, 2000), cursor, counts, finishedAt: new Date(), leaseUntil: null })
        .where(eq(schema.devicePurges.id, purgeId));
      console.error('[device-purge] failed', { purgeId, deviceId, step: cursor.step, err });
      return 'failed';
    }
    // Release the lease so the retry can claim it, keep the position.
    await db
      .update(schema.devicePurges)
      .set({ cursor, counts, leaseUntil: null })
      .where(eq(schema.devicePurges.id, purgeId));
    throw err;
  }
}

interface ChunkContext {
  bucket: string;
  deviceId: string;
  cutoff: Date;
  cursor: PurgeCursor;
  counts: PurgeCounts;
  log: (m: string) => void;
}

/** One bounded unit of work. `more` = same step, call again; `next` = step complete. */
async function runChunk(step: PurgeStep, ctx: ChunkContext): Promise<'more' | 'next'> {
  const { bucket, deviceId, cutoff, cursor, counts } = ctx;
  const device = uuidParam(deviceId);
  const before = tsParam(cutoff.toISOString());

  switch (step) {
    case 'workflows.attachments': {
      const res = await db.execute(
        sql`delete from ${schema.workflowAttachments} where ${schema.workflowAttachments.deviceId} = ${device}`,
      );
      counts.attachments += updatedCount(res);
      return 'next';
    }

    case 'workflows.stop': {
      // A run still executing on Fargate is stopped; its row is flipped so a
      // late result.json no-ops in finalize. Lambda-target runs cannot be
      // stopped; finalize drains what they write once their row is gone.
      const running = await db
        .select({ id: schema.workflowRuns.id, taskArn: schema.workflowRuns.taskArn })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.deviceId, deviceId),
            eq(schema.workflowRuns.status, 'running'),
            eq(schema.workflowRuns.mode, 'production'),
            sql`${schema.workflowRuns.startedAt} < ${before}`,
          ),
        );
      for (const run of running) {
        if (run.taskArn && CLUSTER) {
          try {
            await ecs.send(
              new StopTaskCommand({ cluster: CLUSTER, task: run.taskArn, reason: 'xorgate: device data purge' }),
            );
          } catch (err) {
            console.warn('[device-purge] StopTask failed', { runId: run.id, err });
          }
        }
      }
      if (running.length) {
        await db
          .update(schema.workflowRuns)
          .set({ status: 'failed', endedAt: new Date(), error: 'purged' })
          .where(
            and(
              inArray(
                schema.workflowRuns.id,
                running.map((r) => r.id),
              ),
              eq(schema.workflowRuns.status, 'running'),
            ),
          );
      }
      return 'next';
    }

    case 'workflows.runs': {
      const page = await db
        .select({ id: schema.workflowRuns.id, artifacts: schema.workflowRuns.artifacts })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.deviceId, deviceId),
            eq(schema.workflowRuns.mode, 'production'),
            sql`${schema.workflowRuns.startedAt} < ${before}`,
            cursor.afterRunId ? sql`${schema.workflowRuns.id} > ${uuidParam(cursor.afterRunId)}` : undefined,
          ),
        )
        .orderBy(asc(schema.workflowRuns.id))
        .limit(RUN_PAGE);
      if (page.length === 0) return 'next';
      for (const run of page) {
        for (const prefix of runArtifactPrefixes(run.id, run.artifacts)) {
          const out = await drainPrefix(bucket, prefix);
          counts.runObjects += out.deleted;
        }
      }
      // Rows by id (steps and events cascade). No RETURNING: a count is enough.
      const res = await db.execute(
        sql`delete from ${schema.workflowRuns} where ${schema.workflowRuns.id} in (${sql.join(
          page.map((r) => uuidParam(r.id)),
          sql`, `,
        )})`,
      );
      counts.runs += updatedCount(res);
      cursor.afterRunId = page[page.length - 1].id;
      return 'more';
    }

    case 'telemetry.s3':
    case 'media.s3': {
      const prefix =
        step === 'telemetry.s3' ? `telemetry/v1/${deviceId}/` : `media-sessions/v1/${deviceId}/`;
      const out = await drainPrefix(bucket, prefix, {
        olderThan: cutoff,
        token: cursor.s3Token,
        budget: { pages: S3_PAGES_PER_CHUNK },
      });
      if (step === 'telemetry.s3') counts.telemetryObjects += out.deleted;
      else counts.mediaObjects += out.deleted;
      if (out.complete) return 'next';
      cursor.s3Token = out.token;
      return 'more';
    }

    case 'telemetry.sessions': {
      const res = await db.execute(
        sql`delete from ${schema.telemetrySessions} where ${schema.telemetrySessions.deviceId} = ${device} and ${schema.telemetrySessions.startedAt} < ${before}`,
      );
      counts.telemetrySessions += updatedCount(res);
      return 'next';
    }

    case 'telemetry.ingestLog': {
      const res = await db.execute(
        sql`delete from ${schema.telemetryIngestLog} where ${schema.telemetryIngestLog.deviceId} = ${device} and ${schema.telemetryIngestLog.ingestedAt} < ${before}`,
      );
      counts.ingestLogRows += updatedCount(res);
      return 'next';
    }

    case 'telemetry.readings': {
      if (!cursor.windowStart || !cursor.spanMs) {
        // The oldest sample bounds the walk; the (device_id, ts, metric) index
        // answers it per partition without a scan.
        const res = await db.execute<{ oldest: string | null }>(
          sql`select ${isoSql(sql`min(${schema.telemetryReadings.ts})`)} as oldest from ${schema.telemetryReadings} where ${schema.telemetryReadings.deviceId} = ${device}`,
        );
        const oldest = res.rows[0]?.oldest ?? null;
        if (!oldest) return 'next';
        cursor.windowStart = dayFloor(new Date(oldest)).toISOString();
        cursor.spanMs = READINGS_DAY_MS;
        return 'more';
      }
      const window = nextReadingsWindow({ windowStart: cursor.windowStart, spanMs: cursor.spanMs }, cutoff);
      if (!window) return 'next';
      try {
        const res = await db.execute(
          sql`delete from ${schema.telemetryReadings} where ${schema.telemetryReadings.deviceId} = ${device} and ${schema.telemetryReadings.ts} >= ${tsParam(window.start.toISOString())} and ${schema.telemetryReadings.ts} < ${tsParam(window.end.toISOString())}`,
        );
        const n = updatedCount(res);
        counts.readings += n;
        cursor.windowStart = window.end.toISOString();
        if (n === 0) cursor.spanMs = widenWindow(cursor.spanMs);
        return 'more';
      } catch (err) {
        if (!isStatementTimeout(err)) throw err;
        const halved = halveWindow(cursor.spanMs);
        if (halved === null) {
          throw new Error(
            `telemetry.readings: a ${cursor.spanMs} ms window from ${cursor.windowStart} still times out`,
          );
        }
        ctx.log(`purge: readings window ${cursor.spanMs} ms timed out, halving to ${halved}`);
        cursor.spanMs = halved;
        return 'more';
      }
    }

    case 'media.sessions': {
      const res = await db.execute(
        sql`delete from ${schema.mediaSessions} where ${schema.mediaSessions.deviceId} = ${device} and ${schema.mediaSessions.startedAt} < ${before}`,
      );
      counts.mediaSessions += updatedCount(res);
      return 'next';
    }

    case 'done':
      return 'next';
  }
}

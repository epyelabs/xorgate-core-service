import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { db, schema } from '../db/index';
import type { Recording } from '../db/schema';
import { recordingConfig } from '../config/recording';

/**
 * Recording orchestration shared by the HTTP handler (`device-recordings.ts`) and
 * the auto-record path (`telemetry-ingest.ts`).
 *
 * A recording is captured by a cloud-side "viewer-recorder": a headless KVS WebRTC
 * VIEWER (a Fargate task) joins the device's existing signaling channel as one more
 * viewer, remuxes the incoming H.264 to a single MP4, and uploads it to S3 on stop.
 * The device and the browser's live P2P viewing are untouched.
 *
 * Lifecycle: insert row (status='recording') -> RunTask -> persist taskArn. On stop
 * we StopTask; the recorder finalizes + uploads, and the S3 ObjectCreated finalize
 * Lambda flips the row to 'completed'. We never flip to 'completed' here (avoids
 * racing the finalizer).
 */

const ecs = new ECSClient({});

const CLUSTER = process.env.RECORDER_CLUSTER_ARN;
// Task family (not a revision-pinned ARN): RunTask resolves the latest ACTIVE
// revision, so task-def changes don't churn a cross-stack export.
const TASKDEF = process.env.RECORDER_TASKDEF;
const SUBNETS = (process.env.RECORDER_SUBNETS ?? '').split(',').filter(Boolean);
const SECURITY_GROUP = process.env.RECORDER_SG;
const CONTAINER = process.env.RECORDER_CONTAINER_NAME ?? 'recorder';
const BUCKET = process.env.BUCKET_NAME;

/** Row status that means "a recorder task should be running for this stream". */
export const ACTIVE_STATUS = 'recording';

/**
 * Why a recording ended, stamped into `recordings.end_reason` by whichever path
 * terminated it (kvs-webrtc-lts §4.1). `stream_ended` is also the natural-EOS
 * default applied by media-finalize when no explicit reason was set.
 */
export type RecordingEndReason =
  | 'user_stop'
  | 'device_offline'
  | 'stream_ended'
  | 'max_duration'
  | 'task_lost'
  | 'error';

/** Typed error so the HTTP handler can map known failures to 4xx instead of 500. */
export class RecordingError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'NO_CHANNEL',
    message: string,
  ) {
    super(message);
    this.name = 'RecordingError';
  }
}

export function recorderConfigured(): boolean {
  return Boolean(CLUSTER && TASKDEF && SUBNETS.length > 0 && SECURITY_GROUP && BUCKET);
}

/** True when a recorder is already (supposed to be) running for this stream. */
export async function hasActiveRecording(deviceId: string, streamKey: string): Promise<boolean> {
  const row = await db.query.recordings.findFirst({
    where: and(
      eq(schema.recordings.deviceId, deviceId),
      eq(schema.recordings.streamKey, streamKey),
      eq(schema.recordings.status, ACTIVE_STATUS),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/** Active recordings for a device, keyed by streamKey (the in-flight set). */
export async function activeRecordings(deviceId: string): Promise<Recording[]> {
  return db.query.recordings.findMany({
    where: and(
      eq(schema.recordings.deviceId, deviceId),
      eq(schema.recordings.status, ACTIVE_STATUS),
    ),
  });
}

/**
 * Start recording one stream: insert the row, launch the Fargate viewer-recorder,
 * persist its task ARN. Throws `RecordingError` for caller-visible problems
 * (recorder not configured / no such channel) and rolls the row back to 'failed'
 * if RunTask itself fails.
 */
export async function startRecording(
  deviceId: string,
  streamKey: string,
  trigger: 'manual' | 'auto',
): Promise<Recording> {
  if (!recorderConfigured()) {
    throw new RecordingError('NOT_CONFIGURED', 'Recorder is not configured (missing RECORDER_* env)');
  }

  const channel = await db.query.kvsChannels.findFirst({
    where: and(
      eq(schema.kvsChannels.deviceId, deviceId),
      eq(schema.kvsChannels.streamKey, streamKey),
    ),
  });
  if (!channel) {
    throw new RecordingError('NO_CHANNEL', `No KVS channel for stream "${streamKey}"`);
  }

  const recordingId = randomUUID();
  const s3Key = `media/v1/${deviceId}/${streamKey}/${recordingId}.mp4`;

  await db.insert(schema.recordings).values({
    id: recordingId,
    deviceId,
    streamKey,
    status: ACTIVE_STATUS,
    trigger,
    startedAt: new Date(),
    s3Key,
  });

  let taskArn: string | undefined;
  try {
    const run = await ecs.send(
      new RunTaskCommand({
        cluster: CLUSTER,
        taskDefinition: TASKDEF,
        launchType: 'FARGATE',
        count: 1,
        // 36-char UUID fits ECS's startedBy limit; lets a reconciler map tasks->rows.
        startedBy: recordingId,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: SUBNETS,
            securityGroups: [SECURITY_GROUP as string],
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: CONTAINER,
              environment: [
                { name: 'AWS_REGION', value: channel.region },
                { name: 'KVS_CHANNEL_ARN', value: channel.channelArn },
                { name: 'KVS_CHANNEL_NAME', value: channel.channelName },
                { name: 'RECORDING_ID', value: recordingId },
                { name: 'DEVICE_ID', value: deviceId },
                { name: 'STREAM_KEY', value: streamKey },
                { name: 'S3_BUCKET', value: BUCKET as string },
                { name: 'S3_KEY', value: s3Key },
                // Ride-through + capture-heartbeat knobs (kvs-webrtc-lts Phase 4).
                // Overriding these via RunTask needs no recorder-image rebuild.
                { name: 'RECORDER_HEARTBEAT_MS', value: String(recordingConfig.recorder.heartbeatMs) },
                {
                  name: 'RECORDER_RECONNECT_WINDOW_MS',
                  value: String(recordingConfig.recorder.reconnectWindowMs),
                },
                {
                  name: 'RECORDER_REOFFER_INTERVAL_MS',
                  value: String(recordingConfig.recorder.reofferIntervalMs),
                },
              ],
            },
          ],
        },
      }),
    );
    taskArn = run.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const reason = run.failures?.[0]?.reason ?? 'no task returned';
      throw new Error(`RunTask failed: ${reason}`);
    }
  } catch (err) {
    await db
      .update(schema.recordings)
      .set({ status: 'failed', endedAt: new Date(), endReason: 'error' })
      .where(eq(schema.recordings.id, recordingId));
    throw err;
  }

  const [updated] = await db
    .update(schema.recordings)
    .set({ taskArn })
    .where(eq(schema.recordings.id, recordingId))
    .returning();
  return updated;
}

/**
 * Stop a recording: signal the Fargate task to stop, then immediately mark the row
 * 'stopping' so the UI reflects the stop right away (without waiting on the upload).
 * The recorder finalizes the MP4 on SIGTERM and the finalize Lambda flips the row
 * 'stopping' -> 'completed' once the object lands. A row that never produces a file
 * (the task had already died) stays 'stopping' until the watchdog reconciles it.
 * Tolerates a task that has already exited. Idempotent: guarded on ACTIVE_STATUS so
 * a double-stop (e.g. LWT handler + sweeper) is harmless.
 *
 * @param opts.endReason stamped into `recordings.end_reason` (kvs-webrtc-lts §4.1).
 * @param opts.expectedTrigger when set, no-ops unless the row's trigger matches
 *   (lets the auto-record path avoid touching a manual row and vice-versa).
 */
export async function stopRecording(
  recordingId: string,
  opts: { endReason?: RecordingEndReason; expectedTrigger?: 'manual' | 'auto' } = {},
): Promise<void> {
  const row = await db.query.recordings.findFirst({
    where: eq(schema.recordings.id, recordingId),
    columns: { taskArn: true, status: true, trigger: true },
  });
  if (!row) return;
  if (opts.expectedTrigger && row.trigger !== opts.expectedTrigger) return;

  if (row.taskArn && CLUSTER) {
    try {
      await ecs.send(
        new StopTaskCommand({
          cluster: CLUSTER,
          task: row.taskArn,
          reason: `xorgate: recording stopped (${opts.endReason ?? 'unspecified'})`,
        }),
      );
    } catch (err) {
      console.warn(`stopRecording: StopTask failed for ${recordingId}`, err);
    }
  }

  // Only transition out of the active state; never clobber a row already
  // completed/failed (e.g. a double-stop racing the finalize Lambda).
  if (row.status === ACTIVE_STATUS) {
    await db
      .update(schema.recordings)
      .set({
        status: 'stopping',
        endedAt: new Date(),
        ...(opts.endReason ? { endReason: opts.endReason } : {}),
      })
      .where(
        and(eq(schema.recordings.id, recordingId), eq(schema.recordings.status, ACTIVE_STATUS)),
      );
  }
}

/**
 * Stop a device's active recordings because it went offline — but ONLY those whose
 * media plane has also gone quiet (capture heartbeat NULL or stale). This is the
 * §4.5 corroboration: the MQTT control plane and the KVS media plane are independent,
 * so "device offline" is a hint, never proof the media stopped. If a recording is
 * still receiving frames (fresh heartbeat) it is LEFT running; the recorder's own
 * dead-air / ride-through window ends it if the media truly stopped.
 *
 * Shared by the LWT handler (`device-status`) and the offline-sweeper so every
 * offline path behaves identically (kvs-webrtc-lts Phase 2.3). Gated by
 * `offlineStopEnabled` (R6): a no-op until the recorder heartbeat (Phase 4) exists,
 * so it can never truncate a healthy recording in the interim. Returns how many were
 * stopped.
 */
export async function stopRecordingsForOfflineDevice(deviceId: string): Promise<number> {
  if (!recordingConfig.offlineStopEnabled) return 0;
  const staleSecs = Math.round(recordingConfig.captureStaleMs / 1000);
  const stale = await db
    .select({ id: schema.recordings.id })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.deviceId, deviceId),
        eq(schema.recordings.status, ACTIVE_STATUS),
        sql`(${schema.recordings.captureHeartbeatAt} IS NULL OR ${schema.recordings.captureHeartbeatAt} < now() - make_interval(secs => ${sql.raw(String(staleSecs))}))`,
      ),
    );
  for (const r of stale) {
    try {
      await stopRecording(r.id, { endReason: 'device_offline' });
    } catch (err) {
      console.error('offline-stop: stopRecording failed', { id: r.id, err });
    }
  }
  return stale.length;
}

/**
 * Recording watchdog (kvs-webrtc-lts Phase 2), run on the existing 1-min sweeper
 * tick (no new schedule -> no new Aurora wake source; see §7.3). Two backstops:
 *   1. Max-duration cap: stop any recording running longer than its cap
 *      (devices.max_recording_ms, else the stack default) — the runaway guard.
 *   2. Orphan/stuck reconcile: flip a recording/stopping row whose Fargate task is
 *      gone (and no MP4 landed) to terminal 'failed' so nothing sticks forever.
 */
export async function runRecordingWatchdog(): Promise<void> {
  // Isolate the two sub-jobs: a throw in the max-duration pass (e.g. a DB blip) must
  // not starve the orphan reconciler on the same tick.
  try {
    await stopOverlongRecordings();
  } catch (err) {
    console.error('watchdog: max-duration pass failed', err);
  }
  try {
    await reconcileStuckRecordings();
  } catch (err) {
    console.error('watchdog: orphan reconcile pass failed', err);
  }
}

async function stopOverlongRecordings(): Promise<void> {
  const defMs = recordingConfig.maxRecordingMs;
  // Per-device override via devices.max_recording_ms; fall back to the stack default.
  const overlong = await db
    .select({ id: schema.recordings.id })
    .from(schema.recordings)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.recordings.deviceId))
    .where(
      and(
        eq(schema.recordings.status, ACTIVE_STATUS),
        sql`${schema.recordings.startedAt} < now() - make_interval(secs => (COALESCE(${schema.devices.maxRecordingMs}, ${sql.raw(String(defMs))}) / 1000.0))`,
      ),
    );
  for (const r of overlong) {
    try {
      await stopRecording(r.id, { endReason: 'max_duration' });
    } catch (err) {
      console.error('watchdog: max-duration stop failed', { id: r.id, err });
    }
  }
  if (overlong.length > 0) {
    console.log('watchdog: stopped overlong recordings', { count: overlong.length });
  }
}

// Give media-finalize (S3 -> EventBridge -> Lambda) a window to land the MP4 and
// flip the row to 'completed' before the watchdog reaps a just-stopped task's row.
const FINALIZE_SETTLE_MS = 2 * 60 * 1000;

async function reconcileStuckRecordings(): Promise<void> {
  const graceSecs = Math.round(recordingConfig.reconcileStuckMs / 1000);
  const stuck = await db
    .select({
      id: schema.recordings.id,
      taskArn: schema.recordings.taskArn,
    })
    .from(schema.recordings)
    .where(
      and(
        inArray(schema.recordings.status, [ACTIVE_STATUS, 'stopping']),
        sql`${schema.recordings.startedAt} < now() - make_interval(secs => ${sql.raw(String(graceSecs))})`,
      ),
    );

  for (const r of stuck) {
    let taskAlive = true;
    if (!r.taskArn) {
      // No task ever recorded (RunTask never persisted an ARN) -> nothing running.
      taskAlive = false;
    } else if (CLUSTER) {
      try {
        const desc = await ecs.send(
          new DescribeTasksCommand({ cluster: CLUSTER, tasks: [r.taskArn] }),
        );
        const t = desc.tasks?.[0];
        if (!t) {
          // ECS no longer knows this task (GC'd long after it stopped) -> gone.
          taskAlive = false;
        } else if (t.lastStatus === 'STOPPED') {
          // Stopped: reap only after the finalize settle window, so we don't race
          // media-finalize flipping the same row to 'completed' for a good upload.
          const stoppedAt = t.stoppedAt ? t.stoppedAt.getTime() : 0;
          taskAlive = stoppedAt === 0 || Date.now() - stoppedAt < FINALIZE_SETTLE_MS;
        } else {
          taskAlive = true; // RUNNING / PROVISIONING / etc.
        }
      } catch (err) {
        console.warn('watchdog: DescribeTasks failed; not reaping this tick', { id: r.id, err });
        taskAlive = true; // err on the side of leaving it; retry next tick
      }
    }
    if (taskAlive) continue;

    // Task is gone and no MP4 landed (else media-finalize would have flipped it to
    // 'completed', dropping it out of this set). Mark terminal, guarded so we never
    // clobber a row a concurrent finalize just completed.
    const [flipped] = await db
      .update(schema.recordings)
      .set({ status: 'failed', endedAt: new Date(), endReason: 'task_lost' })
      .where(
        and(
          eq(schema.recordings.id, r.id),
          inArray(schema.recordings.status, [ACTIVE_STATUS, 'stopping']),
        ),
      )
      .returning({ id: schema.recordings.id });
    if (flipped) {
      console.log('watchdog: reconciled stuck recording to failed', { id: r.id });
    }
  }
}

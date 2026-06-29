import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { db, schema } from '../db/index';
import type { Recording } from '../db/schema';

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
      .set({ status: 'failed', endedAt: new Date() })
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
 * (the task had already died) stays 'stopping' — a dud the user can delete.
 * Tolerates a task that has already exited.
 */
export async function stopRecording(recordingId: string): Promise<void> {
  const row = await db.query.recordings.findFirst({
    where: eq(schema.recordings.id, recordingId),
    columns: { taskArn: true, status: true },
  });
  if (!row) return;

  if (row.taskArn && CLUSTER) {
    try {
      await ecs.send(
        new StopTaskCommand({
          cluster: CLUSTER,
          task: row.taskArn,
          reason: 'xorgate: recording stopped',
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
      .set({ status: 'stopping', endedAt: new Date() })
      .where(
        and(eq(schema.recordings.id, recordingId), eq(schema.recordings.status, ACTIVE_STATUS)),
      );
  }
}

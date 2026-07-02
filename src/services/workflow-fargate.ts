import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { db, schema } from '../db/index';
import type { WorkflowRun } from '../db/schema';
import type { WorkflowDefinition } from '../schemas/workflows';

/**
 * Launches the Python CV runner (Fargate) for a video graph. Writes a manifest to
 * s3://<bucket>/workflows/v1/runs/<runId>/manifest.json and RunTask's the ARM64 CV
 * container (env: RUN_ID / MANIFEST_BUCKET / MANIFEST_KEY / AWS_REGION only — ECS
 * env overrides cap at 8KB, so the definition travels via the S3 manifest). The
 * task posts result.json back to S3, which the finalize Lambda ingests.
 *
 * The CV runner reuses the recorder stack's cluster/VPC/SG; its launch config
 * arrives via CV_* env (threaded through bin/app.ts -> api-stack).
 */

const ecs = new ECSClient({});
const s3 = new S3Client({});

const BUCKET = process.env.BUCKET_NAME;
const CV_CLUSTER = process.env.CV_CLUSTER_ARN;
const CV_TASKDEF = process.env.CV_TASKDEF;
const CV_SUBNETS = (process.env.CV_SUBNETS ?? '').split(',').filter(Boolean);
const CV_SG = process.env.CV_SG;
const CV_CONTAINER = process.env.CV_CONTAINER_NAME ?? 'cv-runner';
const MAX_RUNTIME_SECONDS = 1800;

function cvConfigured(): boolean {
  return Boolean(BUCKET && CV_CLUSTER && CV_TASKDEF && CV_SUBNETS.length > 0 && CV_SG);
}

type VideoInput = {
  s3Key: string;
  recordingId: string | null;
  recordingStartedAt: string | null;
  captureStartedAt: string | null;
};

// Resolve the MP4 input(s) for a video run from its trigger context.
async function resolveVideoInputs(run: WorkflowRun): Promise<VideoInput[]> {
  const ctx = (run.triggerContext ?? {}) as Record<string, unknown>;

  // recording_saved (auto or manual): a single s3Key is already in the context.
  if (typeof ctx.s3Key === 'string' && ctx.s3Key) {
    return [
      {
        s3Key: ctx.s3Key,
        recordingId: typeof ctx.recordingId === 'string' ? ctx.recordingId : null,
        recordingStartedAt: typeof ctx.recordingStartedAt === 'string' ? ctx.recordingStartedAt : null,
        captureStartedAt: typeof ctx.captureStartedAt === 'string' ? ctx.captureStartedAt : null,
      },
    ];
  }

  // schedule selection: hand-picked recordings or the most recent N.
  const selection = ctx.selection as { mode?: string; recordingIds?: string[]; n?: number } | undefined;
  if (selection?.mode === 'recordings' && Array.isArray(selection.recordingIds) && selection.recordingIds.length > 0) {
    const recs = await db
      .select()
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.deviceId, run.deviceId),
          inArray(schema.recordings.id, selection.recordingIds),
          isNotNull(schema.recordings.s3Key),
        ),
      );
    return recs.map(toVideoInput);
  }
  if (selection?.mode === 'lastN') {
    const recs = await db
      .select()
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.deviceId, run.deviceId),
          eq(schema.recordings.status, 'completed'),
          isNotNull(schema.recordings.s3Key),
        ),
      )
      .orderBy(desc(schema.recordings.createdAt))
      .limit(Math.max(1, selection.n ?? 1));
    return recs.map(toVideoInput);
  }

  return [];
}

function toVideoInput(r: typeof schema.recordings.$inferSelect): VideoInput {
  return {
    s3Key: r.s3Key as string,
    recordingId: r.id,
    recordingStartedAt: r.startedAt ? r.startedAt.toISOString() : null,
    captureStartedAt: r.captureStartedAt ? r.captureStartedAt.toISOString() : null,
  };
}

async function failRun(run: WorkflowRun, error: string): Promise<void> {
  await db
    .update(schema.workflowRuns)
    .set({ status: 'failed', endedAt: new Date(), error })
    .where(eq(schema.workflowRuns.id, run.id));
}

export async function dispatchFargateRun(run: WorkflowRun): Promise<void> {
  if (!cvConfigured()) {
    console.error('workflow-fargate: CV runner not configured (missing CV_* env)', { runId: run.id });
    return failRun(run, 'Video workflow runner is not configured');
  }

  const inputs = await resolveVideoInputs(run);
  if (inputs.length === 0) {
    return failRun(run, 'No video input (recording) available for this run');
  }

  const def = run.definition as WorkflowDefinition;
  const videoNodes = def.nodes.filter((n) => n.type === 'source.video');
  const primary = inputs[0];
  // One manifest input per source.video node (v1: single stream -> same recording).
  const manifestInputs = (videoNodes.length > 0 ? videoNodes.map((n) => n.id) : [null]).map(
    (nodeId) => ({
      nodeId,
      s3Bucket: BUCKET,
      s3Key: primary.s3Key,
      recordingId: primary.recordingId,
      recordingStartedAt: primary.recordingStartedAt,
      captureStartedAt: primary.captureStartedAt,
    }),
  );

  const manifestKey = `workflows/v1/runs/${run.id}/manifest.json`;
  const manifest = {
    runId: run.id,
    deviceId: run.deviceId,
    definition: def,
    triggerContext: run.triggerContext ?? null,
    inputs: manifestInputs,
    output: {
      bucket: BUCKET,
      resultKey: `workflows/v1/runs/${run.id}/result.json`,
      clipPrefix: `workflows/v1/runs/${run.id}/clips/`,
    },
    limits: { maxRuntimeSeconds: MAX_RUNTIME_SECONDS },
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
    }),
  );

  let taskArn: string | undefined;
  try {
    const res = await ecs.send(
      new RunTaskCommand({
        cluster: CV_CLUSTER,
        taskDefinition: CV_TASKDEF,
        launchType: 'FARGATE',
        count: 1,
        startedBy: run.id, // 36-char uuid fits ECS's startedBy limit
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: CV_SUBNETS,
            securityGroups: [CV_SG as string],
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: CV_CONTAINER,
              environment: [
                { name: 'RUN_ID', value: run.id },
                { name: 'MANIFEST_BUCKET', value: BUCKET as string },
                { name: 'MANIFEST_KEY', value: manifestKey },
                { name: 'AWS_REGION', value: process.env.AWS_REGION ?? 'us-east-1' },
              ],
            },
          ],
        },
      }),
    );
    taskArn = res.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const reason = res.failures?.[0]?.reason ?? 'no task returned';
      throw new Error(`RunTask failed: ${reason}`);
    }
  } catch (err) {
    console.error('workflow-fargate: RunTask failed', { runId: run.id, err });
    return failRun(run, `Failed to launch CV task: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db
    .update(schema.workflowRuns)
    .set({ taskArn })
    .where(eq(schema.workflowRuns.id, run.id));
  console.log('workflow-fargate: CV task launched', { runId: run.id, taskArn });
}

import type { EventBridgeEvent } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { updateAttachmentStatusIfLatest } from '../services/workflow-runner';

const s3 = new S3Client({});

// Shape of the S3 "Object Created" event delivered via EventBridge.
interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number };
}

// result.json contract written by the Python CV runner (cv-runner/app/result.py).
const resultStepSchema = z.object({
  seq: z.number(),
  nodeId: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  output: z.string().default(''),
  durationMs: z.number().default(0),
});
const resultEventSchema = z.object({
  kind: z.string(),
  occurredAt: z.string(),
  confidence: z.number().default(0),
  payloadSummary: z.string().default(''),
  payload: z.unknown().optional(),
  clipKey: z.string().nullish(),
});
const resultSchema = z.object({
  runId: z.string(),
  status: z.enum(['succeeded', 'failed']),
  error: z.string().nullish(),
  failedNodeId: z.string().nullish(),
  steps: z.array(resultStepSchema).default([]),
  events: z.array(resultEventSchema).default([]),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
});

/**
 * Fargate CV-run finalizer. Invoked by an EventBridge rule on S3 "Object Created"
 * under workflows/v1/; acts only on `.../result.json`. The Python runner ALWAYS
 * writes a result.json (even on failure/timeout), so this is the single place run
 * status is resolved for video runs — the same proven pattern as media-finalize.
 *
 * Idempotent: skips if the run is no longer 'running' (a redelivered event or the
 * watchdog having already failed the run).
 */
export const handler = async (
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>,
): Promise<void> => {
  const key = event.detail?.object?.key;
  const bucket = event.detail?.bucket?.name;
  if (!key || !bucket) {
    console.warn('workflow-run-finalize: event missing bucket/key', { id: event.id });
    return;
  }
  if (!key.endsWith('/result.json')) return; // manifest.json, clips, etc.

  // Fetch + validate result.json.
  let parsed;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    parsed = resultSchema.parse(JSON.parse(body ?? '{}'));
  } catch (err) {
    console.error('workflow-run-finalize: unreadable/invalid result.json', { key, err });
    return; // nothing actionable
  }

  const run = await db.query.workflowRuns.findFirst({
    where: eq(schema.workflowRuns.id, parsed.runId),
  });
  if (!run) {
    console.warn('workflow-run-finalize: run not found', { runId: parsed.runId, key });
    return;
  }
  if (run.status !== 'running') {
    console.log('workflow-run-finalize: run already finalized, skipping', {
      runId: run.id,
      status: run.status,
    });
    return;
  }

  // Persist steps + events (best-effort: partial writes are tolerable — the run
  // status is the source of truth for the UI).
  if (parsed.steps.length > 0) {
    await db.insert(schema.workflowRunSteps).values(
      parsed.steps.map((s) => ({
        runId: run.id,
        seq: s.seq,
        nodeId: s.nodeId,
        label: s.label,
        status: s.status,
        output: s.output,
        durationMs: Math.round(s.durationMs),
      })),
    );
  }
  if (parsed.events.length > 0) {
    await db.insert(schema.workflowEvents).values(
      parsed.events.map((e) => ({
        runId: run.id,
        deviceId: run.deviceId,
        kind: e.kind,
        occurredAt: new Date(e.occurredAt),
        confidence: e.confidence,
        clip: Boolean(e.clipKey),
        clipS3Key: e.clipKey ?? null,
        payloadSummary: e.payloadSummary,
        payload: e.payload ?? null,
      })),
    );
  }

  const durationMs = Date.now() - run.startedAt.getTime();
  await db
    .update(schema.workflowRuns)
    .set({
      status: parsed.status,
      endedAt: new Date(),
      durationMs,
      metrics: parsed.metrics,
      eventCount: parsed.events.length,
      error: parsed.error ?? null,
      failedNodeId: parsed.failedNodeId ?? null,
    })
    .where(eq(schema.workflowRuns.id, run.id));

  await updateAttachmentStatusIfLatest(run, parsed.status);
  console.log('workflow-run-finalize: run finalized', {
    runId: run.id,
    status: parsed.status,
    events: parsed.events.length,
  });
};

import type { EventBridgeEvent } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { updateAttachmentStatusIfLatest } from '../services/workflow-triggers';
import { v2EventRows, v2RunUpdate, v2StepRows } from '../workflows/host/finalize';
import { platformResultSchema } from '../workflows/host/result';

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
 * Workflow-run finalizer. Invoked by EventBridge rules on S3 "Object Created"
 * under workflows/v1/ (Python cv-runner results) and workflows/v2/ (TS engine
 * results); acts only on `.../result.json`. Both engines ALWAYS write a
 * result.json (even on failure/timeout), so this is the single place run
 * status is resolved for S3-results runs — the same S3-event-driven finalize
 * pattern media-segment-ingest uses for uploaded segments.
 *
 * The two result shapes are versioned: `resultVersion: 2` routes to the v2
 * branch (platformResultSchema = the package's engineResultSchema plus the
 * additive `artifacts.videos`; stamps engine_version + artifacts); anything
 * else is the unchanged v1 cv-runner path.
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
  if (!key.endsWith('/result.json')) return; // manifest.json, clips, frames, etc.

  // Fetch result.json and route on its resultVersion.
  let raw: unknown;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    raw = JSON.parse(body ?? '{}');
  } catch (err) {
    console.error('workflow-run-finalize: unreadable result.json', { key, err });
    return; // nothing actionable
  }
  if ((raw as { resultVersion?: unknown })?.resultVersion === 2) {
    return finalizeV2(raw, key);
  }

  // --- v1 (cv-runner) path, unchanged ---
  let parsed;
  try {
    parsed = resultSchema.parse(raw);
  } catch (err) {
    console.error('workflow-run-finalize: invalid v1 result.json', { key, err });
    return;
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

// --- v2 (TS engine) path ---
// Same lifecycle as v1 (idempotency guard, best-effort steps/events, run row
// last) with the v2-only stamps: engine_version = 2 and the result's artifacts
// map (Data Capture keys) on the run row. Row mapping lives in
// workflows/host/finalize.ts so the smoke script can unit-test it.
// Deploy note: needs migrations 0013 (engine_version) and 0014 (artifacts)
// applied before any v2 producer is enabled.
async function finalizeV2(raw: unknown, key: string): Promise<void> {
  let result;
  try {
    result = platformResultSchema.parse(raw);
  } catch (err) {
    console.error('workflow-run-finalize: invalid v2 result.json', { key, err });
    return;
  }

  const run = await db.query.workflowRuns.findFirst({
    where: eq(schema.workflowRuns.id, result.runId),
  });
  if (!run) {
    console.warn('workflow-run-finalize: v2 run not found', { runId: result.runId, key });
    return;
  }
  if (run.status !== 'running') {
    console.log('workflow-run-finalize: v2 run already finalized, skipping', {
      runId: run.id,
      status: run.status,
    });
    return;
  }

  // Sequential awaits throughout: the RDS Data API forbids concurrent statements.
  const stepRows = v2StepRows(run.id, result);
  if (stepRows.length > 0) {
    await db.insert(schema.workflowRunSteps).values(stepRows);
  }
  const eventRows = v2EventRows(run, result);
  if (eventRows.length > 0) {
    await db.insert(schema.workflowEvents).values(eventRows);
  }

  await db
    .update(schema.workflowRuns)
    .set(v2RunUpdate(result, run.startedAt, new Date()))
    .where(eq(schema.workflowRuns.id, run.id));

  await updateAttachmentStatusIfLatest(run, result.status);
  console.log('workflow-run-finalize: v2 run finalized', {
    runId: run.id,
    status: result.status,
    events: result.events.length,
    outputs: Object.keys(result.artifacts.outputs).length,
    videos: Object.keys(result.artifacts.videos ?? {}).length,
  });
}

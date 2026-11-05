import type { EventBridgeEvent } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { drainPrefix } from '../services/s3-drain';
import { updateAttachmentStatusIfLatest } from '../services/workflow-triggers';
import { v2EventRows, v2RunUpdate, v2StepRows } from '../workflows/host/finalize';
import { platformResultSchema } from '../workflows/host/result';
import { dispatchWebhookEvents, emitWebhookEvents } from '../services/webhooks/emit';
import {
  endpointIdsByName,
  planWorkflowEventEmits,
  webhookNamesByNode,
  type WorkflowEventRunInfo,
} from '../services/webhooks/workflow-events';

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
  status: z.enum(['ok', 'failed', 'skipped', 'cancelled']),
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
    return finalizeV2(raw, key, bucket);
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
    await drainOrphanedRun(bucket, key);
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
    // Conditional like the v2 claim: a run cancelled (or watchdog-failed) since
    // the read above keeps its terminal status.
    .where(and(eq(schema.workflowRuns.id, run.id), eq(schema.workflowRuns.status, 'running')));

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
async function finalizeV2(raw: unknown, key: string, bucket: string): Promise<void> {
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
    await drainOrphanedRun(bucket, key);
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
  // Ids minted here rather than RETURNed: the outbox rows key on them and a
  // RETURNING of every payload could exceed the Data API's 1 MiB response cap.
  const eventRows = v2EventRows(run, result).map((row) => ({ id: randomUUID(), ...row }));

  // workflow.event routing inputs (xorgate-webhooks P2, README D1): production
  // runs only; the node's `webhook` name resolves to an endpoint of the
  // template's org. Reads, so they stay outside the transaction.
  const namesByNode = run.mode === 'production' ? webhookNamesByNode(run.definition) : new Map<string, string>();
  let webhookRun: WorkflowEventRunInfo | null = null;
  let endpointsByName = new Map<string, string>();
  if (namesByNode.size > 0 && eventRows.some((e) => e.nodeId && namesByNode.has(e.nodeId))) {
    const [tpl] = await db
      .select({ organizationId: schema.workflowTemplates.organizationId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, run.templateId));
    if (tpl) {
      webhookRun = {
        id: run.id,
        organizationId: tpl.organizationId,
        workspaceId: run.workspaceId,
        templateId: run.templateId,
        templateVersion: run.templateVersion,
        trigger: run.trigger,
        triggerContext: run.triggerContext,
        deviceId: run.deviceId,
      };
      endpointsByName = await endpointIdsByName(db, tpl.organizationId, [...namesByNode.values()]);
    }
  }

  // ONE transaction, run row first as the claim: a concurrent or redelivered
  // finalize that loses the `status = 'running'` claim writes nothing, and a
  // crash anywhere rolls the steps, events and outbox rows back with the run
  // update, so the redelivery starts clean (events are never doubled and a
  // workflow.event is never lost to a crash between the run update and the
  // outbox insert). Dispatch happens after commit; the tick covers a crash there.
  const outcome = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(schema.workflowRuns)
      .set(v2RunUpdate(result, run.startedAt, new Date()))
      .where(and(eq(schema.workflowRuns.id, run.id), eq(schema.workflowRuns.status, 'running')))
      .returning({ id: schema.workflowRuns.id });
    if (claimed.length === 0) return null;
    if (stepRows.length > 0) {
      await tx.insert(schema.workflowRunSteps).values(stepRows);
    }
    if (eventRows.length > 0) {
      await tx.insert(schema.workflowEvents).values(eventRows);
    }
    if (!webhookRun) return { webhookIds: [] as string[], unresolved: [] as string[], planned: 0 };
    const plan = planWorkflowEventEmits(webhookRun, eventRows, namesByNode, endpointsByName);
    const webhookIds = await emitWebhookEvents(tx, plan.emits);
    return { webhookIds, unresolved: plan.unresolved, planned: plan.emits.length };
  });
  if (!outcome) {
    console.log('workflow-run-finalize: v2 run finalized concurrently, skipping', { runId: run.id });
    return;
  }
  if (outcome.unresolved.length > 0) {
    console.warn('workflow-run-finalize: webhook name(s) with no endpoint in the org; events unrouted', {
      runId: run.id,
      webhooks: outcome.unresolved,
    });
  }
  if (outcome.webhookIds.length > 0) {
    const dispatched = await dispatchWebhookEvents(outcome.webhookIds);
    console.log('workflow-run-finalize: workflow.event emitted', {
      runId: run.id,
      emitted: outcome.webhookIds.length,
      sent: dispatched.sent.length,
      dispatchDisabled: dispatched.disabled,
    });
  }

  await updateAttachmentStatusIfLatest(run, result.status);
  console.log('workflow-run-finalize: v2 run finalized', {
    runId: run.id,
    status: result.status,
    events: result.events.length,
    outputs: Object.keys(result.artifacts.outputs).length,
    videos: Object.keys(result.artifacts.videos ?? {}).length,
  });
}

/**
 * A result.json whose run row is gone (the device, the template or a purge
 * took it) would otherwise leave the whole run prefix behind forever: nothing
 * under `workflows/v2/runs/` or `workflows/v1/` has a lifecycle rule. The key
 * names the run directory, so sweep it. Best-effort, like the finalize itself.
 */
async function drainOrphanedRun(bucket: string, key: string): Promise<void> {
  if (!key.startsWith('workflows/v2/runs/') && !key.startsWith('workflows/v1/')) return;
  const prefix = key.slice(0, key.lastIndexOf('/') + 1);
  try {
    const out = await drainPrefix(bucket, prefix);
    console.log('workflow-run-finalize: drained orphaned run prefix', { prefix, deleted: out.deleted });
  } catch (err) {
    console.warn('workflow-run-finalize: orphan drain failed', { prefix, err });
  }
}

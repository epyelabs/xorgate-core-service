import { and, eq, sql } from 'drizzle-orm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { db, schema } from '../db/index';
import type { WorkflowRun } from '../db/schema';
import { flattenTelemetryToRows, type TelemetryPayload } from '../schemas/telemetry';
import type { AttachmentTrigger, WorkflowDefinition } from '../schemas/workflows';
import { upgradeDefinition } from '../workflows/compat';
import { engineTargetForDefinition } from '../workflows/simulations';

/**
 * Shared trigger plumbing: fireWorkflowRun() pre-creates a workflow_runs row and
 * enqueues {runId}, and evaluateTelemetryTriggers() is the (near-zero-cost) hook
 * called on the 1 Hz telemetry hot path. All firing paths (recording_saved,
 * telemetry_condition, schedule, manual, rerun) go through fireWorkflowRun.
 */

const sqs = new SQSClient({});
const QUEUE_URL = process.env.WORKFLOW_QUEUE_URL;

async function enqueueRun(runId: string): Promise<void> {
  if (!QUEUE_URL) throw new Error('WORKFLOW_QUEUE_URL is not configured');
  await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify({ runId }) }));
}

export interface FireArgs {
  workspaceId: string;
  deviceId: string;
  attachmentId: string | null;
  templateId: string;
  templateVersion: number;
  definition: WorkflowDefinition;
  trigger: 'event' | 'schedule' | 'manual';
  triggerContext: unknown;
}

/**
 * Create a run (status=running) and enqueue it for the dispatcher. Redelivery-safe:
 * the message body is just {runId}; the dispatcher re-reads authoritative state.
 * If enqueue fails after the insert, the run is flipped to failed and returned so
 * callers never leave a dangling "running" row.
 */
export async function fireWorkflowRun(args: FireArgs): Promise<WorkflowRun> {
  // M6 cutover: the run snapshots the definition that will actually RUN — the
  // upgraded (schemaVersion 2) view. upgradeDefinition is pure and a no-op for
  // v2 definitions; v1 sources (unupgraded pinned versions, reruns of
  // historical snapshots) map through the same compat aliases the read path
  // serves. executionMode is the v2 dispatch target (lambda | fargate),
  // catalog-derived — VIDEO_NODE_TYPES is retired.
  const definition = upgradeDefinition(args.definition);
  const executionMode = engineTargetForDefinition(definition);
  const [run] = await db
    .insert(schema.workflowRuns)
    .values({
      workspaceId: args.workspaceId,
      deviceId: args.deviceId,
      attachmentId: args.attachmentId,
      templateId: args.templateId,
      templateVersion: args.templateVersion,
      definition,
      trigger: args.trigger,
      triggerContext: args.triggerContext ?? null,
      status: 'running',
      executionMode,
      metrics: {},
    })
    .returning();

  if (args.attachmentId) {
    await db
      .update(schema.workflowAttachments)
      .set({
        runCount: sql`${schema.workflowAttachments.runCount} + 1`,
        lastRunAt: new Date(),
        lastRunStatus: 'running',
        updatedAt: new Date(),
      })
      .where(eq(schema.workflowAttachments.id, args.attachmentId));
  }

  try {
    await enqueueRun(run.id);
  } catch (err) {
    console.error('fireWorkflowRun: enqueue failed, flipping run to failed', { runId: run.id, err });
    const [failed] = await db
      .update(schema.workflowRuns)
      .set({
        status: 'failed',
        endedAt: new Date(),
        error: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      .where(eq(schema.workflowRuns.id, run.id))
      .returning();
    return failed ?? run;
  }
  return run;
}

/**
 * Update the attachment's denormalized lastRunStatus only if this run is its
 * most recent (guards against an older run clobbering a newer one's status).
 * Shared by the v2 finalize Lambda and the scheduler watchdog. (Lived in the
 * retired workflow-runner.ts until M6.)
 */
export async function updateAttachmentStatusIfLatest(run: WorkflowRun, status: string): Promise<void> {
  if (!run.attachmentId) return;
  const [latest] = await db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.attachmentId, run.attachmentId))
    .orderBy(sql`${schema.workflowRuns.startedAt} desc`)
    .limit(1);
  if (latest?.id !== run.id) return;
  await db
    .update(schema.workflowAttachments)
    .set({ lastRunStatus: status, updatedAt: new Date() })
    .where(eq(schema.workflowAttachments.id, run.attachmentId));
}

// --- Recording-saved trigger (media-finalize hook) ---------------------------

type RecordingSavedTrigger = Extract<AttachmentTrigger, { type: 'recording_saved' }>;

/**
 * Fire workflow runs for a freshly-completed recording. Called (best-effort) from
 * media-finalize.ts after the recording row flips to `completed`. Low frequency,
 * so no cache: query enabled attachments for the device, keep those whose
 * recording_saved trigger includes this stream, and fire one run per attachment.
 */
export async function evaluateRecordingSavedTriggers(rec: {
  id: string;
  deviceId: string;
  streamKey: string;
  s3Key: string | null;
  startedAt: Date;
  captureStartedAt: Date | null;
}): Promise<void> {
  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, rec.deviceId),
    columns: { workspaceId: true },
  });
  if (!device) return;

  const rows = await db
    .select({
      id: schema.workflowAttachments.id,
      templateId: schema.workflowAttachments.templateId,
      pinnedVersion: schema.workflowAttachments.pinnedVersion,
      triggers: schema.workflowAttachments.triggers,
      publishedVersion: schema.workflowTemplates.publishedVersion,
    })
    .from(schema.workflowAttachments)
    .innerJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.workflowAttachments.templateId),
    )
    .where(
      and(
        eq(schema.workflowAttachments.deviceId, rec.deviceId),
        eq(schema.workflowAttachments.enabled, true),
      ),
    );

  for (const a of rows) {
    const triggers = (a.triggers as AttachmentTrigger[]) ?? [];
    const matches = triggers.some(
      (t): t is RecordingSavedTrigger =>
        t.type === 'recording_saved' && t.streamKeys.includes(rec.streamKey),
    );
    if (!matches) continue;
    const resolvedVersion = a.pinnedVersion ?? a.publishedVersion;
    if (resolvedVersion == null) continue;
    const [ver] = await db
      .select({ definition: schema.workflowTemplateVersions.definition })
      .from(schema.workflowTemplateVersions)
      .where(
        and(
          eq(schema.workflowTemplateVersions.templateId, a.templateId),
          eq(schema.workflowTemplateVersions.version, resolvedVersion),
        ),
      );
    if (!ver) continue;

    await fireWorkflowRun({
      workspaceId: device.workspaceId,
      deviceId: rec.deviceId,
      attachmentId: a.id,
      templateId: a.templateId,
      templateVersion: resolvedVersion,
      definition: ver.definition as WorkflowDefinition,
      trigger: 'event',
      triggerContext: {
        type: 'recording_saved',
        recordingId: rec.id,
        streamKey: rec.streamKey,
        s3Key: rec.s3Key,
        recordingStartedAt: rec.startedAt.toISOString(),
        captureStartedAt: rec.captureStartedAt ? rec.captureStartedAt.toISOString() : null,
      },
    });
  }
}

// --- Telemetry condition trigger (1 Hz hot path) -----------------------------

type ConditionTrigger = Extract<AttachmentTrigger, { type: 'telemetry_condition' }>;

interface CachedAttachment {
  attachmentId: string;
  templateId: string;
  workspaceId: string;
  resolvedVersion: number;
  definition: WorkflowDefinition;
  triggers: Array<{ triggerIndex: number; condition: ConditionTrigger }>;
}

// 30s TTL per-device cache: devices with no telemetry-condition attachments cache
// an empty array, so the steady-state per-message cost is zero.
const attCache = new Map<string, { value: CachedAttachment[]; expires: number }>();
const CACHE_TTL_MS = 30_000;
// In-memory per-(attachment,trigger) last-fire clock handles the common
// "still true, cooling down" case with no DB touch.
const lastFired = new Map<string, number>();
const DEFAULT_COOLDOWN_SECONDS = 300;

async function loadTelemetryAttachments(deviceId: string): Promise<CachedAttachment[]> {
  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, deviceId),
    columns: { workspaceId: true },
  });
  if (!device) return [];

  const rows = await db
    .select({
      id: schema.workflowAttachments.id,
      templateId: schema.workflowAttachments.templateId,
      pinnedVersion: schema.workflowAttachments.pinnedVersion,
      triggers: schema.workflowAttachments.triggers,
      publishedVersion: schema.workflowTemplates.publishedVersion,
    })
    .from(schema.workflowAttachments)
    .innerJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.workflowAttachments.templateId),
    )
    .where(
      and(
        eq(schema.workflowAttachments.deviceId, deviceId),
        eq(schema.workflowAttachments.enabled, true),
      ),
    );

  const out: CachedAttachment[] = [];
  for (const a of rows) {
    const triggers = (a.triggers as AttachmentTrigger[]) ?? [];
    const condTriggers = triggers
      .map((t, i) => ({ t, i }))
      .filter((x): x is { t: ConditionTrigger; i: number } => x.t.type === 'telemetry_condition');
    if (condTriggers.length === 0) continue;
    const resolvedVersion = a.pinnedVersion ?? a.publishedVersion;
    if (resolvedVersion == null) continue;
    const [ver] = await db
      .select({ definition: schema.workflowTemplateVersions.definition })
      .from(schema.workflowTemplateVersions)
      .where(
        and(
          eq(schema.workflowTemplateVersions.templateId, a.templateId),
          eq(schema.workflowTemplateVersions.version, resolvedVersion),
        ),
      );
    if (!ver) continue;
    out.push({
      attachmentId: a.id,
      templateId: a.templateId,
      workspaceId: device.workspaceId,
      resolvedVersion,
      definition: ver.definition as WorkflowDefinition,
      triggers: condTriggers.map((x) => ({ triggerIndex: x.i, condition: x.t })),
    });
  }
  return out;
}

async function cachedTelemetryAttachments(deviceId: string): Promise<CachedAttachment[]> {
  const now = Date.now();
  const hit = attCache.get(deviceId);
  if (hit && hit.expires > now) return hit.value;
  const value = await loadTelemetryAttachments(deviceId);
  attCache.set(deviceId, { value, expires: now + CACHE_TTL_MS });
  return value;
}

function compare(op: ConditionTrigger['conditions'][number]['operator'], observed: number, value: number): boolean {
  switch (op) {
    case 'gt':
      return observed > value;
    case 'gte':
      return observed >= value;
    case 'lt':
      return observed < value;
    case 'lte':
      return observed <= value;
    case 'eq':
      return observed === value;
    case 'neq':
      return observed !== value;
  }
}

// Evaluate a condition trigger against the in-message metric values. Returns the
// per-condition observations (for triggerContext) and whether the trigger matched.
function evaluate(
  trigger: ConditionTrigger,
  valueByMetric: Map<string, number>,
): { matched: boolean; details: Array<{ metric: string; operator: string; value: number; observed: number | null }> } {
  const details = trigger.conditions.map((c) => {
    const observed = valueByMetric.has(c.metric) ? valueByMetric.get(c.metric)! : null;
    return { metric: c.metric, operator: c.operator, value: c.value, observed };
  });
  const results = trigger.conditions.map((c) => {
    const observed = valueByMetric.get(c.metric);
    return observed !== undefined && compare(c.operator, observed, c.value);
  });
  const matched = trigger.combinator === 'and' ? results.every(Boolean) : results.some(Boolean);
  return { matched, details };
}

// Atomic conditional claim: exactly one container wins per cooldown window.
// Returns true if THIS invocation should fire.
async function claimTriggerSlot(
  attachmentId: string,
  triggerIndex: number,
  cooldownSeconds: number,
): Promise<boolean> {
  const secs = Math.max(1, Math.trunc(cooldownSeconds));
  const claimed = await db
    .insert(schema.workflowTriggerState)
    .values({
      attachmentId,
      triggerIndex,
      lastFiredAt: new Date(),
      lastConditionMet: true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.workflowTriggerState.attachmentId, schema.workflowTriggerState.triggerIndex],
      set: { lastFiredAt: new Date(), lastConditionMet: true, updatedAt: new Date() },
      setWhere: sql`${schema.workflowTriggerState.lastFiredAt} IS NULL OR ${schema.workflowTriggerState.lastFiredAt} < now() - make_interval(secs => ${sql.raw(String(secs))})`,
    })
    .returning({ id: schema.workflowTriggerState.id });
  return claimed.length > 0;
}

/**
 * Telemetry condition hook, called from telemetry-ingest.ts. Best-effort: the
 * caller wraps it in try/catch so a workflow failure can never break ingestion.
 */
export async function evaluateTelemetryTriggers(payload: TelemetryPayload): Promise<void> {
  const attachments = await cachedTelemetryAttachments(payload.deviceId);
  if (attachments.length === 0) return; // zero steady-state cost

  const valueByMetric = new Map<string, number>();
  for (const row of flattenTelemetryToRows(payload)) {
    if (row.value != null) valueByMetric.set(row.metric, row.value);
  }
  const nowMs = Date.now();
  const toIso = new Date(payload.ts).toISOString();
  const fromIso = new Date(payload.ts - 5 * 60_000).toISOString();

  for (const att of attachments) {
    for (const { triggerIndex, condition } of att.triggers) {
      const { matched, details } = evaluate(condition, valueByMetric);
      if (!matched) continue;
      const key = `${att.attachmentId}:${triggerIndex}`;
      const cooldownSeconds = condition.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      const lf = lastFired.get(key) ?? 0;
      if (nowMs - lf < cooldownSeconds * 1000) continue; // in-memory cooldown, no DB

      const didFire = await claimTriggerSlot(att.attachmentId, triggerIndex, cooldownSeconds);
      lastFired.set(key, nowMs);
      if (!didFire) continue; // another container already fired this window

      await fireWorkflowRun({
        workspaceId: att.workspaceId,
        deviceId: payload.deviceId,
        attachmentId: att.attachmentId,
        templateId: att.templateId,
        templateVersion: att.resolvedVersion,
        definition: att.definition,
        trigger: 'event',
        triggerContext: {
          type: 'telemetry_condition',
          matched: details.filter((d) => d.observed !== null),
          window: { from: fromIso, to: toIso },
        },
      });
    }
  }
}

import { and, eq, sql } from 'drizzle-orm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { db, schema } from '../db/index';
import type { WorkflowRun } from '../db/schema';
import { flattenTelemetryToRows, type TelemetryPayload } from '../schemas/telemetry';
import type { AttachmentTrigger, WorkflowDefinition } from '../schemas/workflows';
import { upgradeDefinition } from '@xorgate/workflow-engine';
import { engineTargetForDefinition } from '../workflows/simulations';

/**
 * Shared trigger plumbing: fireWorkflowRun() pre-creates a workflow_runs row and
 * enqueues {runId}, and evaluateTelemetryTriggers() is the (near-zero-cost) hook
 * called on the 1 Hz telemetry hot path. All firing paths (session_completed,
 * segment_uploaded, telemetry_condition, schedule, manual, rerun) go through
 * fireWorkflowRun.
 *
 * The cloud recorder's `recording_saved` path was removed with the recorder
 * (destroy-kvs-recorder Phase 3) and its trigger TYPE with Phase W. Recorded
 * video now comes from on-device sessions: `session_completed` (batch, fired
 * on advisory close) and `segment_uploaded` (near-realtime, fired per chunk
 * from media-segment-ingest).
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

// --- Media triggers: session_completed + segment_uploaded --------------------
//
// The two media triggers (destroy-kvs-recorder decision L) differ only in WHEN
// they fire and what their context names; both resolve to the same
// `device_session` executor binding downstream (a chunk is the N=1 case), so
// they share the attachment fan-out below.

/** Any attachment trigger keyed by stream (both media triggers today). */
type StreamKeyedTrigger = Extract<
  AttachmentTrigger,
  { type: 'session_completed' | 'segment_uploaded' }
>;

/**
 * Enabled attachments on `deviceId` subscribed to `type` for `streamKey`,
 * each resolved to the template version that would actually run.
 */
async function subscribedAttachments(
  deviceId: string,
  type: StreamKeyedTrigger['type'],
  streamKey: string,
): Promise<SubscribedAttachments> {
  return attachmentsMatching(deviceId, (t): t is StreamKeyedTrigger => t.type === type && t.streamKeys.includes(streamKey));
}

interface SubscribedAttachments {
  workspaceId: string;
  matches: Array<{ id: string; templateId: string; version: number; definition: WorkflowDefinition }>;
}

/**
 * Enabled attachments on `deviceId` with at least one trigger `matches`
 * accepts, each resolved to the template version that would actually run.
 * The stream-keyed media triggers and the telemetry-session trigger share it.
 */
async function attachmentsMatching(
  deviceId: string,
  matches: (t: AttachmentTrigger) => boolean,
): Promise<SubscribedAttachments> {
  const empty = { workspaceId: '', matches: [] };
  const device = await db.query.devices.findFirst({
    where: eq(schema.devices.id, deviceId),
    columns: { workspaceId: true },
  });
  if (!device) return empty;

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

  const subscribed = rows.filter((a) => ((a.triggers as AttachmentTrigger[]) ?? []).some(matches));
  if (subscribed.length === 0) return empty;

  const resolved: SubscribedAttachments['matches'] = [];
  for (const a of subscribed) {
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
    resolved.push({
      id: a.id,
      templateId: a.templateId,
      version: resolvedVersion,
      definition: ver.definition as WorkflowDefinition,
    });
  }
  return { workspaceId: device.workspaceId, matches: resolved };
}

// --- Telemetry-session trigger: telemetry_session_completed -----------------

/** The telemetry_sessions columns the trigger payload is built from. */
export interface TelemetrySessionForTrigger {
  id: string;
  deviceId: string;
  startedAt: Date;
  endedAt: Date | null;
  rateHz: number | null;
  timeSource: string | null;
  segmentCount: number;
  sampleCount: number;
  insights: unknown;
}

/**
 * The `telemetry_session_completed` run context (pure, unit-tested). Carries
 * the session's identity, bounds and its whole `insights` block (README D12:
 * the canonical, versioned summaries) plus an explicit `window`, which is
 * what the dispatcher's resolveTriggeredWindow reads, so a `source.telemetry`
 * node in the run gets exactly the session's recorded span through
 * readTelemetryWindow (artifacts when cold, Postgres when hot).
 */
export function telemetrySessionTriggerContext(session: TelemetrySessionForTrigger): Record<string, unknown> {
  const from = session.startedAt.toISOString();
  const to = (session.endedAt ?? session.startedAt).toISOString();
  return {
    type: 'telemetry_session_completed',
    sessionId: session.id,
    deviceId: session.deviceId,
    from,
    to,
    rateHz: session.rateHz,
    timeSource: session.timeSource,
    segmentCount: session.segmentCount,
    sampleCount: session.sampleCount,
    insights: session.insights ?? null,
    window: { from, to },
  };
}

/**
 * Fire workflow runs for a device-recorded TELEMETRY session that has closed
 * and whose overview (hence insights) is built (telemetry-session-artifacts
 * P6 item 9, README Q15). Called from the sweeper's telemetry housekeeping
 * pass (services/telemetry-sessions.ts fireTelemetrySessionCompleted), which
 * is the one place a close and a build meet; the manifest's and listing's
 * close-on-read only close, and the next tick fires for them.
 *
 * AT-LEAST-ONCE like the media twin: a straggler segment reopens the session,
 * the next pass re-closes and rebuilds it, and `completed_fired_at <
 * last_segment_at` re-arms the fire with the rebuilt insights. Consumers that
 * must run once per session dedupe on triggerContext.sessionId. Returns the
 * number of runs fired.
 */
export async function evaluateTelemetrySessionCompletedTriggers(
  session: TelemetrySessionForTrigger,
): Promise<number> {
  const { workspaceId, matches } = await attachmentsMatching(
    session.deviceId,
    (t) => t.type === 'telemetry_session_completed',
  );
  if (matches.length === 0) return 0;
  const triggerContext = telemetrySessionTriggerContext(session);
  for (const a of matches) {
    await fireWorkflowRun({
      workspaceId,
      deviceId: session.deviceId,
      attachmentId: a.id,
      templateId: a.templateId,
      templateVersion: a.version,
      definition: a.definition,
      trigger: 'event',
      triggerContext,
    });
  }
  return matches.length;
}

/**
 * Fire workflow runs when a device-recorded media session flips open→closed
 * (offline recording plan, Phase 6.4). Called (best-effort) from the sweeper's
 * close pass AND the close-on-read path in device-sessions.ts.
 *
 * AT-LEAST-ONCE by design: close is advisory and reversible. A straggler
 * segment reopens the session (media-segment-ingest sets status='open' on
 * every insert) and the next sweep re-closes it, firing this again with
 * updated rollups. Consumers that must run once per session dedupe on
 * triggerContext.sessionId.
 *
 * The run then resolves `sessionId` to the whole ordered segment list
 * (services/media-session-input.ts) — this is the BATCH media path.
 */
export async function evaluateSessionCompletedTriggers(session: {
  id: string;
  deviceId: string;
  streamKey: string;
  startedAt: Date;
  endedAt: Date | null;
}): Promise<void> {
  const { workspaceId, matches } = await subscribedAttachments(
    session.deviceId,
    'session_completed',
    session.streamKey,
  );
  if (matches.length === 0) return;

  // Rollups computed once per fire (not stored — same stance as the list API).
  const [agg] = await db
    .select({
      segmentCount: sql<number>`count(*)::int`,
      totalBytes: sql<number>`coalesce(sum(${schema.mediaSegments.sizeBytes}), 0)::bigint`,
      totalDurationMs: sql<number>`coalesce(sum(${schema.mediaSegments.durationMs}), 0)::bigint`,
    })
    .from(schema.mediaSegments)
    .where(eq(schema.mediaSegments.sessionId, session.id));

  for (const a of matches) {
    await fireWorkflowRun({
      workspaceId,
      deviceId: session.deviceId,
      attachmentId: a.id,
      templateId: a.templateId,
      templateVersion: a.version,
      definition: a.definition,
      trigger: 'event',
      triggerContext: {
        type: 'session_completed',
        sessionId: session.id,
        streamKey: session.streamKey,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt ? session.endedAt.toISOString() : null,
        segmentCount: Number(agg?.segmentCount ?? 0),
        totalBytes: Number(agg?.totalBytes ?? 0),
        totalDurationMs: Number(agg?.totalDurationMs ?? 0),
      },
    });
  }
}

/**
 * The NEAR-REALTIME media trigger (decision L): fires once per ~60 s chunk, from
 * media-segment-ingest, as soon as the `media_segments` row is written. The run
 * resolves to the SAME `device_session` binding with a one-element `segments`
 * array, so incident detection and alerting get ~one-chunk latency without a
 * second media path.
 *
 * Firing is per (segment, subscribed attachment) — it does NOT also fire
 * `session_completed`; those are independent subscriptions on the attachment.
 *
 * ⚠️ NO freshness gate and NO burst throttling (decision K — prototyping, no
 * fleet). A device back from hours offline uploads a flood of chunks and this
 * fires a run for every one of them, over stale video. That is inherent to
 * edge IoT and WILL matter with a real fleet; carried as known debt in
 * destroy-kvs-recorder README §10, deliberately not built here.
 */
export async function evaluateSegmentUploadedTriggers(segment: {
  sessionId: string;
  deviceId: string;
  streamKey: string;
  s3Key: string;
  seq: number;
  startTs: Date;
  durationMs: number;
}): Promise<void> {
  const { workspaceId, matches } = await subscribedAttachments(
    segment.deviceId,
    'segment_uploaded',
    segment.streamKey,
  );
  if (matches.length === 0) return; // zero steady-state cost on the ingest path

  for (const a of matches) {
    await fireWorkflowRun({
      workspaceId,
      deviceId: segment.deviceId,
      attachmentId: a.id,
      templateId: a.templateId,
      templateVersion: a.version,
      definition: a.definition,
      trigger: 'event',
      triggerContext: {
        type: 'segment_uploaded',
        sessionId: segment.sessionId,
        streamKey: segment.streamKey,
        s3Key: segment.s3Key,
        seq: segment.seq,
        startTs: segment.startTs.toISOString(),
        durationMs: segment.durationMs,
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

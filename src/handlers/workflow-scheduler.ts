import { and, eq, inArray, sql } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { db, schema } from '../db/index';
import { fireWorkflowRun, updateAttachmentStatusIfLatest } from '../services/workflow-triggers';
import type { AttachmentTrigger, ContextWindow, WorkflowDefinition } from '../schemas/workflows';

/**
 * Minute-ticked scheduler (EventBridge rate(1 minute), gated by disableScheduledJobs
 * so it is OFF in dev by default — the shared sandbox Aurora must be free to
 * auto-pause). Two jobs per tick:
 *
 *  1. Watchdog: flip runs stuck 'running' past 45 min to 'failed' (StopTask any
 *     lingering Fargate task). Belt-and-braces behind the CV task's own self-limit.
 *  2. Schedule triggers: fire attachments whose cron elapsed since the last run,
 *     gated by an atomic conditional claim so overlapping ticks fire exactly once.
 *
 * All crons are evaluated in UTC (cron-parser).
 */

const ecs = new ECSClient({});
const CLUSTER = process.env.RECORDER_CLUSTER_ARN; // CV + recorder tasks share this cluster
const WATCHDOG_MINUTES = 45;
const CLAIM_COOLDOWN_SECONDS = 55; // dedupe overlapping 1-min ticks

export const handler = async (): Promise<void> => {
  try {
    await runWatchdog();
  } catch (err) {
    console.error('workflow-scheduler: watchdog failed', err);
  }
  try {
    await runSchedules();
  } catch (err) {
    console.error('workflow-scheduler: schedule scan failed', err);
  }
};

// --- Watchdog ----------------------------------------------------------------

async function runWatchdog(): Promise<void> {
  const stale = await db.query.workflowRuns.findMany({
    where: and(
      eq(schema.workflowRuns.status, 'running'),
      sql`${schema.workflowRuns.startedAt} < now() - make_interval(mins => ${sql.raw(String(WATCHDOG_MINUTES))})`,
    ),
  });
  for (const run of stale) {
    if (run.taskArn && CLUSTER) {
      try {
        await ecs.send(
          new StopTaskCommand({ cluster: CLUSTER, task: run.taskArn, reason: 'xorgate: workflow run watchdog timeout' }),
        );
      } catch (err) {
        console.warn('workflow-scheduler: StopTask failed', { runId: run.id, err });
      }
    }
    const [flipped] = await db
      .update(schema.workflowRuns)
      .set({ status: 'failed', endedAt: new Date(), error: 'timeout (watchdog)' })
      .where(and(eq(schema.workflowRuns.id, run.id), eq(schema.workflowRuns.status, 'running')))
      .returning({ id: schema.workflowRuns.id });
    if (flipped) await updateAttachmentStatusIfLatest(run, 'failed');
  }
  if (stale.length > 0) {
    console.log('workflow-scheduler: watchdog failed stuck runs', { count: stale.length });
  }
}

// --- Schedule triggers -------------------------------------------------------

async function runSchedules(): Promise<void> {
  const now = new Date();
  const rows = await db
    .select({
      id: schema.workflowAttachments.id,
      deviceId: schema.workflowAttachments.deviceId,
      templateId: schema.workflowAttachments.templateId,
      pinnedVersion: schema.workflowAttachments.pinnedVersion,
      triggers: schema.workflowAttachments.triggers,
      createdAt: schema.workflowAttachments.createdAt,
      publishedVersion: schema.workflowTemplates.publishedVersion,
      workspaceId: schema.devices.workspaceId,
    })
    .from(schema.workflowAttachments)
    .innerJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.workflowAttachments.templateId),
    )
    .innerJoin(schema.devices, eq(schema.devices.id, schema.workflowAttachments.deviceId))
    .where(eq(schema.workflowAttachments.enabled, true));
  if (rows.length === 0) return;

  const states = await db
    .select()
    .from(schema.workflowTriggerState)
    .where(
      inArray(
        schema.workflowTriggerState.attachmentId,
        rows.map((r) => r.id),
      ),
    );
  const stateByKey = new Map(states.map((s) => [`${s.attachmentId}:${s.triggerIndex}`, s]));

  for (const a of rows) {
    const triggers = (a.triggers as AttachmentTrigger[]) ?? [];
    for (let index = 0; index < triggers.length; index++) {
      const trigger = triggers[index];
      if (trigger.type !== 'schedule') continue;

      let lastOccurrence: Date;
      try {
        lastOccurrence = CronExpressionParser.parse(trigger.cron, {
          currentDate: now,
          tz: 'UTC',
        })
          .prev()
          .toDate();
      } catch {
        console.warn('workflow-scheduler: invalid cron, skipping', { attachmentId: a.id, cron: trigger.cron });
        continue;
      }

      const state = stateByKey.get(`${a.id}:${index}`);
      const since = state?.lastFiredAt ?? a.createdAt;
      if (lastOccurrence.getTime() <= since.getTime()) continue; // not due

      // Atomic claim (55s cooldown) so overlapping ticks / containers fire once.
      const claimed = await claimSchedule(a.id, index, now);
      if (!claimed) continue;

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

      // sinceLastRun advances from the pre-claim cursor (persisted below by claim).
      const cursor = state?.lastWindowEnd ?? a.createdAt;
      const window = resolveScheduleWindow(trigger.telemetryContext, cursor, now);

      await fireWorkflowRun({
        workspaceId: a.workspaceId,
        deviceId: a.deviceId,
        attachmentId: a.id,
        templateId: a.templateId,
        templateVersion: resolvedVersion,
        definition: ver.definition as WorkflowDefinition,
        trigger: 'schedule',
        triggerContext: {
          type: 'schedule',
          cron: trigger.cron,
          window,
          telemetryContext: trigger.telemetryContext,
          mediaContext: trigger.mediaContext,
        },
      });
    }
  }
}

// Conditional claim + cursor advance. Returns true if this tick won the slot.
async function claimSchedule(attachmentId: string, triggerIndex: number, now: Date): Promise<boolean> {
  const claimed = await db
    .insert(schema.workflowTriggerState)
    .values({ attachmentId, triggerIndex, lastFiredAt: now, lastWindowEnd: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.workflowTriggerState.attachmentId, schema.workflowTriggerState.triggerIndex],
      set: { lastFiredAt: now, lastWindowEnd: now, updatedAt: now },
      setWhere: sql`${schema.workflowTriggerState.lastFiredAt} IS NULL OR ${schema.workflowTriggerState.lastFiredAt} < now() - make_interval(secs => ${sql.raw(String(CLAIM_COOLDOWN_SECONDS))})`,
    })
    .returning({ id: schema.workflowTriggerState.id });
  return claimed.length > 0;
}

function resolveScheduleWindow(
  context: ContextWindow,
  cursor: Date,
  now: Date,
): { from: string; to: string } {
  if (context.mode === 'range') {
    return { from: new Date(context.from).toISOString(), to: new Date(context.to).toISOString() };
  }
  if (context.mode === 'lastN') {
    // Approximate the last-N window as N seconds ending now (~1 Hz telemetry).
    return { from: new Date(now.getTime() - context.n * 1000).toISOString(), to: now.toISOString() };
  }
  // sinceLastRun: everything accumulated since the previous scheduled run.
  return { from: cursor.toISOString(), to: now.toISOString() };
}

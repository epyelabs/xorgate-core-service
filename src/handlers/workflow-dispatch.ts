import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { dispatchV2TriggeredRun } from '../services/workflow-engine-v2';

/**
 * Run dispatcher. SQS event source (batchSize 1, reportBatchItemFailures). The
 * message body is just {runId}; this re-reads authoritative run state. Since
 * the M6 cutover every triggered run executes on the v2 engine
 * (dispatchV2TriggeredRun routes lambda vs fargate off the catalog); the PoC
 * inline runner and Python cv-runner are retired.
 *
 * Idempotency under SQS redelivery:
 *   - run missing / not 'running'      -> ack (already finalized or gone)
 *   - dispatched_at claim lost         -> ack (another delivery dispatched it)
 * The claim is an atomic conditional UPDATE (migration 0016) stamped BEFORE
 * any engine launch, so a redelivery mid-run can never double-invoke. The one
 * residual window: a crash AFTER the claim but BEFORE the launch strands the
 * run for the 45-minute watchdog — accepted, same backstop as a lost task.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { runId?: unknown };
      if (typeof body.runId !== 'string') {
        console.error('workflow-dispatch: message missing runId, dropping', { body: record.body });
        continue; // unprocessable — ack so it doesn't loop to the DLQ forever
      }
      await dispatchRun(body.runId);
    } catch (err) {
      console.error('workflow-dispatch: record failed, will retry', {
        messageId: record.messageId,
        err,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

async function dispatchRun(runId: string): Promise<void> {
  const run = await db.query.workflowRuns.findFirst({
    where: eq(schema.workflowRuns.id, runId),
  });
  if (!run) {
    console.warn('workflow-dispatch: run not found, acking', { runId });
    return;
  }
  if (run.status !== 'running') return; // already finalized (or failed at fire time)

  // Atomic idempotency claim: exactly one delivery proceeds per run.
  const claimed = await db
    .update(schema.workflowRuns)
    .set({ dispatchedAt: new Date() })
    .where(
      and(
        eq(schema.workflowRuns.id, runId),
        eq(schema.workflowRuns.status, 'running'),
        isNull(schema.workflowRuns.dispatchedAt),
      ),
    )
    .returning({ id: schema.workflowRuns.id });
  if (claimed.length === 0) {
    console.log('workflow-dispatch: run already claimed, acking', { runId });
    return;
  }

  // Fails the run row itself on any error (no retry semantics on this path).
  await dispatchV2TriggeredRun(run);
}

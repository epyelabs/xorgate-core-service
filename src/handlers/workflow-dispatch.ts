import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import type { WorkflowDefinition } from '../schemas/workflows';
import { runWorkflowInline } from '../services/workflow-runner';
import { dispatchFargateRun } from '../services/workflow-fargate';
import {
  dispatchV2LambdaRun,
  isV2TelemetryOnly,
  v2ExperimentEnabled,
} from '../services/workflow-engine-v2';

/**
 * Run dispatcher. SQS event source (batchSize 1, reportBatchItemFailures). The
 * message body is just {runId}; this re-reads authoritative run state, so it is
 * idempotent under SQS redelivery:
 *   - run missing / not 'running'  -> ack (already finalized or gone)
 *   - run already has a taskArn / steps -> ack (already dispatched/processed)
 *   - inline graph  -> runWorkflowInline() in this invocation
 *   - video graph   -> launch the Fargate CV runner (result.json -> finalize Lambda)
 *
 * EXPERIMENTAL (WORKFLOW_V2_EXPERIMENT=on, default off): schemaVersion-2
 * telemetry-only definitions route to the v2 Lambda engine instead. Production
 * routing is otherwise unchanged until M6.
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
  // Idempotency guards: only a fresh 'running' run with no task/steps proceeds.
  if (run.status !== 'running') return;
  if (run.taskArn) return; // a Fargate task was already launched
  const [existingStep] = await db
    .select({ id: schema.workflowRunSteps.id })
    .from(schema.workflowRunSteps)
    .where(eq(schema.workflowRunSteps.runId, runId))
    .limit(1);
  if (existingStep) return; // inline run already persisted steps

  if (v2ExperimentEnabled() && isV2TelemetryOnly(run.definition as WorkflowDefinition)) {
    await dispatchV2LambdaRun(run);
    return;
  }

  if (run.executionMode === 'inline') {
    await runWorkflowInline(run);
  } else {
    await dispatchFargateRun(run);
  }
}

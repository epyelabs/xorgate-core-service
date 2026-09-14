/**
 * Warm simulator session loop (M5, architecture §5). A session task is one
 * Fargate engine-runner that, instead of executing a single manifest and
 * exiting, long-polls a per-editing-session SQS queue for `{ runId }` jobs and
 * idles out after a quiet period. The first simulation in an editing session
 * pays the ~33 s Fargate cold start; every tweak-and-rerun after that starts
 * near-instantly on the warm task.
 *
 * This module is the PURE loop — receive/run are injected — so the smoke
 * script can exercise idle-out and job sequencing without AWS. The SQS wiring
 * lives in engine-runner/main.ts (session mode).
 *
 * Semantics:
 * - Jobs run strictly one at a time; queued messages wait (a tweak-and-rerun
 *   editing session is serial by nature).
 * - A job failure is logged and the loop continues: every run writes its own
 *   result.json on failure paths, and a run whose execution crashed entirely
 *   is caught by the 45-minute watchdog exactly like a lost cold task.
 * - Idle-out is measured from the END of the last activity (job or poll).
 * - Exit closes the dispatcher's race window (M6): once the idle timeout has
 *   elapsed the loop takes ONE final short receive (`receiveFinal`), serves
 *   anything it finds, and only when that comes back empty retires the queue
 *   (`retireQueue`, a DeleteQueue in the runner) before returning. A
 *   dispatcher that saw this task RUNNING a moment ago and enqueues after the
 *   retire fails its SendMessage (or its CreateQueue, refused for 60 s after a
 *   delete) and takes its cold path. The window that is left is the few
 *   milliseconds between the final receive returning empty and the delete
 *   completing; before, it was the whole last long poll.
 */

export interface SessionJob {
  runId: string;
}

export interface SessionLoopDeps {
  /** Long-poll for one job; resolves null when the wait elapsed empty. */
  receive(): Promise<SessionJob | null>;
  runJob(job: SessionJob): Promise<void>;
  idleTimeoutMs: number;
  /**
   * One short receive taken when the idle timeout has elapsed, before the
   * queue is retired: serves a job enqueued during the tail of the last long
   * poll. A job returned here is run and the idle clock restarts. Optional
   * (the smoke harness drives it; the runner wires a 1 s wait).
   */
  receiveFinal?(): Promise<SessionJob | null>;
  /**
   * Retires the queue right before the loop returns (the runner deletes it).
   * A throw is logged, never fatal: the task still exits and the watchdog
   * still backstops a stranded run.
   */
  retireQueue?(): Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

export interface SessionLoopOutcome {
  jobsRun: number;
  jobFailures: number;
  endedReason: 'idle';
  /** True when `retireQueue` ran and did not throw. */
  queueRetired: boolean;
}

export async function runSessionLoop(deps: SessionLoopDeps): Promise<SessionLoopOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`session: ${m}`));
  const now = deps.now ?? Date.now;
  let lastActivity = now();
  let jobsRun = 0;
  let jobFailures = 0;
  const serve = async (job: SessionJob): Promise<void> => {
    jobsRun += 1;
    log(`job ${jobsRun}: run ${job.runId}`);
    try {
      await deps.runJob(job);
    } catch (err) {
      jobFailures += 1;
      log(`job for run ${job.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    lastActivity = now();
  };
  for (;;) {
    const job = await deps.receive();
    if (job) {
      await serve(job);
      continue;
    }
    if (now() - lastActivity < deps.idleTimeoutMs) continue;
    // Idle timeout reached. One final short receive before the queue goes:
    // anything enqueued in the tail of the last long poll is served here.
    const lateJob = deps.receiveFinal ? await deps.receiveFinal() : null;
    if (lateJob) {
      log(`late job found on the final receive: run ${lateJob.runId}`);
      await serve(lateJob);
      continue;
    }
    let queueRetired = false;
    if (deps.retireQueue) {
      try {
        await deps.retireQueue();
        queueRetired = true;
        log('queue retired; later dispatches take the cold path');
      } catch (err) {
        log(`queue retire failed (exiting anyway): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`idle for ${Math.round(deps.idleTimeoutMs / 1000)}s; session ending (${jobsRun} job(s) served)`);
    return { jobsRun, jobFailures, endedReason: 'idle', queueRetired };
  }
}

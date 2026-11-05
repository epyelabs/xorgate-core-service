import { z } from 'zod';
import { runPrefix } from '@xorgate/workflow-engine';

/**
 * Pure halves of "cancel an in-flight simulation" and "save a simulation run"
 * (sim-cancel-save, 2026-11-05). No DB or AWS imports, so the decisions here
 * are unit-testable; the handlers (workflow-runs.ts cancel, workflow-
 * simulations.ts saved routes) do the I/O.
 */

/** Terminal `workflow_runs.status` written by POST /workflow-runs/{id}/cancel. */
export const RUN_CANCELLED_STATUS = 'cancelled';
/** `workflow_runs.error` on a cancelled row. */
export const RUN_CANCELLED_ERROR = 'Cancelled by user';
/** ECS StopTask reason for a cancelled simulation's engine task. */
export const CANCEL_STOP_REASON = 'xorgate: simulation cancelled by user';

/**
 * S3 key of the cancel marker, `<runPrefix(runId)>cancel.json`. Harmless today;
 * a future engine release polls it (HeadObject) and aborts the run.
 */
export function cancelMarkerKey(runId: string): string {
  return `${runPrefix(runId)}cancel.json`;
}

export function cancelMarkerBody(args: {
  runId: string;
  requestedAt: Date;
  requestedByUserId: string | null;
}): string {
  return JSON.stringify({
    runId: args.runId,
    requestedAt: args.requestedAt.toISOString(),
    requestedByUserId: args.requestedByUserId,
  });
}

export type StopTaskDecision =
  | { stop: true; taskArn: string }
  | { stop: false; reason: 'lambda' | 'no_task' | 'no_cluster' | 'shared_session' };

/**
 * Whether cancelling a run may ECS-StopTask its engine task. A Lambda run
 * cannot be stopped (and is sub-second anyway); a run that has no task yet
 * (cancelled before dispatch stamped it) has nothing to stop. A Fargate warm
 * session task is SHARED by every simulation on that (org, template), so it is
 * stopped only when no OTHER running row is stamped with the same task ARN —
 * otherwise the engine finishes and finalize skips the cancelled row.
 */
export function decideStopTask(args: {
  executionMode: string;
  taskArn: string | null;
  otherRunningOnTask: number;
  clusterConfigured: boolean;
}): StopTaskDecision {
  if (args.executionMode === 'lambda') return { stop: false, reason: 'lambda' };
  if (!args.taskArn) return { stop: false, reason: 'no_task' };
  if (!args.clusterConfigured) return { stop: false, reason: 'no_cluster' };
  if (args.otherRunningOnTask > 0) return { stop: false, reason: 'shared_session' };
  return { stop: true, taskArn: args.taskArn };
}

/** Run duration for a cancel stamped at `endedAt` (never negative). */
export function cancelledDurationMs(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

// --- Saved simulations -------------------------------------------------------

export const SAVED_SIMULATION_NAME_MAX = 120;

/** POST /workflow-templates/{id}/simulations/{runId}/save body. */
export const saveSimulationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .max(SAVED_SIMULATION_NAME_MAX, `name must be at most ${SAVED_SIMULATION_NAME_MAX} characters`)
      .optional()
      .nullable(),
  })
  .strict();

/** Default save name: `Simulation YYYY-MM-DD HH:mm` (UTC) of the run's start. */
export function defaultSavedSimulationName(at: Date): string {
  const iso = at.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `Simulation ${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** The name to store: the caller's (trimmed, non-empty) or the default. */
export function resolveSavedSimulationName(name: string | null | undefined, runStartedAt: Date): string {
  const trimmed = (name ?? '').trim();
  return trimmed.length > 0 ? trimmed : defaultSavedSimulationName(runStartedAt);
}

/** `triggerContext.bindings` of a simulation row (display snapshot), else null. */
export function simulationBindingsSnapshot(triggerContext: unknown): unknown {
  if (!triggerContext || typeof triggerContext !== 'object') return null;
  const bindings = (triggerContext as { bindings?: unknown }).bindings;
  return bindings === undefined ? null : bindings;
}

/** Why a run cannot be saved on this template, or null when it can. */
export function saveRunRefusal(
  run: { templateId: string; mode: string; status: string },
  templateId: string,
): 'not_found' | 'not_terminal' | null {
  // Another template's run (or a production run) is "not found" here: the
  // saved list is per template and only holds simulation rows.
  if (run.templateId !== templateId || run.mode !== 'simulation') return 'not_found';
  if (run.status === 'running') return 'not_terminal';
  return null;
}

export type SavedSimulationRunRow = {
  id: string;
  status: string;
  mode: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  templateVersion: number;
  executionMode: string;
  error: string | null;
  eventCount: number;
};

export type SavedSimulationRow = {
  id: string;
  templateId: string;
  runId: string;
  name: string;
  bindings: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** The SavedSimulation wire shape (design brief, Feature 2). */
export function toSavedSimulation(save: SavedSimulationRow, run: SavedSimulationRunRow) {
  return {
    id: save.id,
    templateId: save.templateId,
    runId: save.runId,
    name: save.name,
    bindings: save.bindings ?? null,
    createdAt: save.createdAt.toISOString(),
    updatedAt: save.updatedAt.toISOString(),
    run: {
      id: run.id,
      status: run.status,
      mode: run.mode,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt ? run.endedAt.toISOString() : null,
      durationMs: run.durationMs ?? null,
      templateVersion: run.templateVersion,
      engineTarget: run.executionMode,
      error: run.error ?? null,
      eventCount: run.eventCount,
    },
  };
}

export type SavedSimulation = ReturnType<typeof toSavedSimulation>;

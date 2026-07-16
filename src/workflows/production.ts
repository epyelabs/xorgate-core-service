import type { WorkflowDefinition } from '../schemas/workflows';
import { getNodeType } from './catalog/index';
import { runManifestSchema, runPrefix, type RunManifest } from './engine/manifest';
import { runTopicPrefix } from './engine/progress';

/**
 * Pure half of the M6 production (triggered) dispatch: trigger-context
 * classification, manifest-input building for device-attachment runs, and the
 * production v2 manifest assembly. Mirrors simulations.ts (the pure half of
 * the simulator dispatch); no DB or AWS imports so the headless smoke script
 * exercises all of it. The DB/AWS legwork (recording row resolution, org
 * lookup, history materialization, dispatch) lives in
 * services/workflow-engine-v2.ts (dispatchV2TriggeredRun).
 */

// Engine budget per production target. Lambda mirrors the M2 default (under
// its 300 s function timeout); Fargate keeps the cv-runner's 30-minute
// production cap.
export const PRODUCTION_MAX_RUNTIME_SECONDS: Record<'lambda' | 'fargate', number> = {
  lambda: 240,
  fargate: 1800,
};

/** A recordings-table row reduced to what the recording binding needs. */
export interface ResolvedVideoInput {
  s3Key: string;
  recordingId: string | null;
  recordingStartedAt: string | null;
  captureStartedAt: string | null;
}

/**
 * How a triggered run's video input is chosen, classified from its trigger
 * context (pure; the dispatcher resolves selections against the recordings
 * table):
 *  - "context":    recording_saved (auto or manual) carries the s3Key directly
 *  - "recordings": schedule selection of hand-picked recording ids
 *  - "lastN":      schedule selection of the most recent N completed recordings
 *  - null:         no video input in the context (telemetry-only runs)
 */
export type TriggeredVideoSelection =
  | { kind: 'context'; input: ResolvedVideoInput }
  | { kind: 'recordings'; recordingIds: string[] }
  | { kind: 'lastN'; n: number }
  | null;

export function triggeredVideoSelection(triggerContext: unknown): TriggeredVideoSelection {
  const ctx = (triggerContext ?? {}) as Record<string, unknown>;
  if (typeof ctx.s3Key === 'string' && ctx.s3Key) {
    return {
      kind: 'context',
      input: {
        s3Key: ctx.s3Key,
        recordingId: typeof ctx.recordingId === 'string' ? ctx.recordingId : null,
        recordingStartedAt:
          typeof ctx.recordingStartedAt === 'string' ? ctx.recordingStartedAt : null,
        captureStartedAt: typeof ctx.captureStartedAt === 'string' ? ctx.captureStartedAt : null,
      },
    };
  }
  const selection = ctx.selection as
    | { mode?: string; recordingIds?: string[]; n?: number }
    | undefined;
  if (
    selection?.mode === 'recordings' &&
    Array.isArray(selection.recordingIds) &&
    selection.recordingIds.length > 0
  ) {
    return { kind: 'recordings', recordingIds: selection.recordingIds };
  }
  if (selection?.mode === 'lastN') {
    return { kind: 'lastN', n: Math.max(1, selection.n ?? 1) };
  }
  return null;
}

/** The run's data window from its trigger context, else the 15 minutes ending at run start. */
export function resolveTriggeredWindow(
  triggerContext: unknown,
  startedAt: Date | null,
): { from: string; to: string } {
  const ctx = triggerContext as { window?: { from?: string; to?: string } } | null;
  if (ctx?.window?.from && ctx?.window?.to) {
    return { from: ctx.window.from, to: ctx.window.to };
  }
  const to = startedAt ?? new Date();
  const from = new Date(to.getTime() - 15 * 60_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Node types in the definition that are not in the catalog (post-upgrade = a dead graph). */
export function unknownNodeTypes(definition: WorkflowDefinition): string[] {
  const unknown = new Set<string>();
  for (const node of definition.nodes) {
    if (!getNodeType(node.type)) unknown.add(node.type);
  }
  return [...unknown];
}

/**
 * Manifest inputs for a triggered production run over the UPGRADED (v2)
 * definition:
 *  - every source.video node binds the resolved recording (all nodes share the
 *    single trigger recording, the v1 cv-runner behavior);
 *  - on the FARGATE target, every source.telemetry node gets an explicit
 *    telemetry_history binding so materializeHistoryInputs can swap it for a
 *    dispatcher-written records.jsonl (the engine task role is DB-free);
 *  - on the LAMBDA target, telemetry sources take the executor default (a
 *    direct history read over the run window), so no input is emitted.
 *
 * Throws when a video node exists but no recording was resolved (the same
 * failure the v1 dispatcher surfaced).
 */
export function buildTriggeredInputs(
  definition: WorkflowDefinition,
  video: ResolvedVideoInput | null,
  target: 'lambda' | 'fargate',
): RunManifest['inputs'] {
  const inputs: RunManifest['inputs'] = [];
  for (const node of definition.nodes) {
    if (node.type === 'source.video') {
      if (!video) throw new Error('No video input (recording) available for this run');
      inputs.push({
        nodeId: node.id,
        binding: {
          kind: 'recording',
          s3Key: video.s3Key,
          ...(video.recordingId ? { recordingId: video.recordingId } : {}),
          ...(video.recordingStartedAt ? { recordingStartedAt: video.recordingStartedAt } : {}),
          ...(video.captureStartedAt ? { captureStartedAt: video.captureStartedAt } : {}),
        },
      });
    } else if (node.type === 'source.telemetry' && target === 'fargate') {
      inputs.push({ nodeId: node.id, binding: { kind: 'telemetry_history' } });
    }
  }
  return inputs;
}

/**
 * Assembles and schema-validates the v2 manifest for a triggered production
 * run. Production runs opt into the progress plane (M6): the additive
 * `progress` block points at wf/run/<orgId>/<runId>, the production twin of
 * the simulator's wf/sim prefix, so the run-detail page gets live updates.
 */
export function buildProductionManifest(args: {
  runId: string;
  orgId: string;
  bucket: string;
  definition: WorkflowDefinition; // already upgraded to v2
  deviceId: string | null;
  inputs: RunManifest['inputs'];
  window: { from: string; to: string } | null;
  target: 'lambda' | 'fargate';
}): RunManifest {
  return runManifestSchema.parse({
    manifestVersion: 2,
    runId: args.runId,
    mode: 'batch',
    orgId: args.orgId, // M7: per-org credential resolution in the secrets seam
    deviceId: args.deviceId,
    window: args.window,
    definition: args.definition,
    inputs: args.inputs,
    output: { bucket: args.bucket, prefix: runPrefix(args.runId) },
    progress: { channel: 'iot', topicPrefix: runTopicPrefix(args.orgId, args.runId) },
    limits: { maxRuntimeSeconds: PRODUCTION_MAX_RUNTIME_SECONDS[args.target] },
  });
}

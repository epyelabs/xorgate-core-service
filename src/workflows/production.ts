import type { WorkflowDefinition } from '../schemas/workflows';
import { runManifestSchema, runPrefix, runTopicPrefix, type RunManifest } from '@xorgate/workflow-engine';
import { getNodeType } from './catalog';

/**
 * Pure half of the M6 production (triggered) dispatch: trigger-context
 * classification, manifest-input building for device-attachment runs, and the
 * production v2 manifest assembly. Mirrors simulations.ts (the pure half of
 * the simulator dispatch); no DB or AWS imports so the headless smoke script
 * exercises all of it. The DB/AWS legwork (on-device session resolution via
 * services/media-session-input.ts, org lookup, history materialization,
 * dispatch) lives in services/workflow-engine-v2.ts (dispatchV2TriggeredRun).
 */

// Engine budget per production target. Lambda mirrors the M2 default (under
// its 300 s function timeout); Fargate keeps the cv-runner's 30-minute
// production cap.
export const PRODUCTION_MAX_RUNTIME_SECONDS: Record<'lambda' | 'fargate', number> = {
  lambda: 240,
  fargate: 1800,
};

/**
 * One on-device segment reduced to what the `device_session` binding needs.
 * `startTs` / `effectiveDurationMs` come straight from `buildSessionTimeline`
 * (services/replay-manifest.ts) — the SAME function the replay player uses, so
 * the engine and the player can never disagree about a session's wall clock.
 */
export interface ResolvedVideoSegment {
  s3Key: string;
  /** Epoch ms. The frame anchor for this segment: frames are startTs + i/fps. */
  startTs: number;
  durationMs: number;
  /** Next-segment delta when contiguous, else durationMs. Clamps frame emission. */
  effectiveDurationMs: number;
  seq: number;
  finalized: boolean;
}

/** An on-device media session reduced to an ordered, wall-clock-anchored segment list. */
export interface ResolvedVideoSession {
  sessionId: string;
  streamKey: string;
  /** ntp | rtc | unsynced — `unsynced` means the wall clock (and so telemetry correlation) is suspect. */
  timeSource: string | null;
  segments: ResolvedVideoSegment[];
  /** Timeline bounds (epoch ms) including a leading evicted-head gap. */
  fromTs: number;
  toTs: number;
  /** Holes > 2 s inside the session; frames are simply absent across them. */
  gaps: Array<{ fromTs: number; toTs: number; reason: string }>;
}

/**
 * How a triggered run's video input is chosen, classified from its trigger
 * context (pure; the dispatcher resolves selections against media_sessions /
 * media_segments):
 *  - "session":        session_completed (auto or manual) — one whole session
 *  - "segment":        segment_uploaded — ONE chunk of a session (the N=1 case)
 *  - "sessions":       schedule selection of hand-picked session ids
 *  - "lastNSessions":  schedule selection of the device's most recent N sessions
 *  - null:             no video input in the context (telemetry-only runs)
 */
export type TriggeredVideoSelection =
  | { kind: 'session'; sessionId: string; streamKey: string | null }
  | { kind: 'segment'; sessionId: string; streamKey: string | null; seq: number | null }
  | { kind: 'sessions'; sessionIds: string[] }
  | { kind: 'lastNSessions'; n: number }
  | null;

export function triggeredVideoSelection(triggerContext: unknown): TriggeredVideoSelection {
  const ctx = (triggerContext ?? {}) as Record<string, unknown>;
  const sessionId = typeof ctx.sessionId === 'string' && ctx.sessionId ? ctx.sessionId : null;
  const streamKey = typeof ctx.streamKey === 'string' && ctx.streamKey ? ctx.streamKey : null;
  if (sessionId && ctx.type === 'segment_uploaded') {
    return {
      kind: 'segment',
      sessionId,
      streamKey,
      seq: typeof ctx.seq === 'number' && Number.isFinite(ctx.seq) ? ctx.seq : null,
    };
  }
  if (sessionId) return { kind: 'session', sessionId, streamKey };

  const selection = ctx.selection as { mode?: string; sessionIds?: string[]; n?: number } | undefined;
  if (
    selection?.mode === 'sessions' &&
    Array.isArray(selection.sessionIds) &&
    selection.sessionIds.length > 0
  ) {
    return { kind: 'sessions', sessionIds: selection.sessionIds };
  }
  if (selection?.mode === 'lastNSessions') {
    return { kind: 'lastNSessions', n: Math.max(1, selection.n ?? 1) };
  }
  return null;
}

/** Epoch-ms span covering every resolved session; null when nothing resolved. */
export function sessionsWindow(
  sessions: ResolvedVideoSession[],
): { from: string; to: string } | null {
  let fromTs = Infinity;
  let toTs = -Infinity;
  for (const s of sessions) {
    fromTs = Math.min(fromTs, s.fromTs);
    toTs = Math.max(toTs, s.toTs);
  }
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return null;
  return { from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString() };
}

/**
 * The run's data window, most specific first: an explicit window on the trigger
 * context, else the resolved media timeline (so telemetry correlation covers
 * the REAL session rather than a 15-minute guess), else the 15 minutes ending
 * at run start.
 */
export function resolveTriggeredWindow(
  triggerContext: unknown,
  startedAt: Date | null,
  mediaWindow?: { from: string; to: string } | null,
): { from: string; to: string } {
  const ctx = triggerContext as { window?: { from?: string; to?: string } } | null;
  if (ctx?.window?.from && ctx?.window?.to) {
    return { from: ctx.window.from, to: ctx.window.to };
  }
  if (mediaWindow) return mediaWindow;
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
 * The node -> session rule for multi-camera graphs (README §9 risk 6). One
 * drive is N per-camera sessions, so a `source.video` node that declares
 * `config.streamKey` binds the session for THAT camera; a node with no
 * streamKey takes the primary (first) resolved session. A declared streamKey
 * that matches nothing resolved is an error, never a silent fallback to the
 * wrong camera.
 */
export function sessionForVideoNode(
  node: WorkflowDefinition['nodes'][number],
  sessions: ResolvedVideoSession[],
): ResolvedVideoSession | null {
  if (sessions.length === 0) return null;
  const configured = (node.data.config as { streamKey?: unknown } | undefined)?.streamKey;
  if (typeof configured === 'string' && configured) {
    return sessions.find((s) => s.streamKey === configured) ?? null;
  }
  return sessions[0];
}

/** The `device_session` executor binding for one resolved session. */
export function sessionBinding(session: ResolvedVideoSession): RunManifest['inputs'][number]['binding'] {
  return {
    kind: 'device_session',
    sessionId: session.sessionId,
    streamKey: session.streamKey,
    ...(session.timeSource ? { timeSource: session.timeSource } : {}),
    segments: session.segments.map((seg) => ({
      s3Key: seg.s3Key,
      startTs: seg.startTs,
      durationMs: seg.durationMs,
      effectiveDurationMs: seg.effectiveDurationMs,
      seq: seg.seq,
    })),
  };
}

/**
 * Manifest inputs for a triggered production run over the UPGRADED (v2)
 * definition:
 *  - every source.video node binds its resolved on-device SESSION as a
 *    `device_session` binding carrying the ordered segment list; the executor
 *    then yields one VideoPayload per segment, each anchored at its own
 *    startTs (destroy-kvs-recorder README §9);
 *  - on the FARGATE target, every source.telemetry node gets an explicit
 *    telemetry_history binding so materializeHistoryInputs can swap it for a
 *    dispatcher-written records.jsonl (the engine task role is DB-free);
 *  - on the LAMBDA target, telemetry sources take the executor default (a
 *    direct history read over the run window), so no input is emitted.
 *
 * Throws when a video node exists but no session was resolved for it (the same
 * failure shape the recorder-era dispatcher surfaced).
 */
export function buildTriggeredInputs(
  definition: WorkflowDefinition,
  sessions: ResolvedVideoSession[],
  target: 'lambda' | 'fargate',
): RunManifest['inputs'] {
  const inputs: RunManifest['inputs'] = [];
  for (const node of definition.nodes) {
    if (node.type === 'source.video') {
      const session = sessionForVideoNode(node, sessions);
      if (!session) {
        const configured = (node.data.config as { streamKey?: unknown } | undefined)?.streamKey;
        throw new Error(
          typeof configured === 'string' && configured && sessions.length > 0
            ? `No recorded session for stream "${configured}" in this run (resolved: ${sessions
                .map((s) => s.streamKey)
                .join(', ')})`
            : 'No video input (on-device session) available for this run',
        );
      }
      inputs.push({ nodeId: node.id, binding: sessionBinding(session) });
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

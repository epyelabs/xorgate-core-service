import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowDefinition } from '../schemas/workflows';
import { workflowDefinitionSchema } from '../schemas/workflows';
import { getNodeType } from './catalog/index';
import { runManifestSchema, runPrefix, type RunManifest } from './engine/manifest';
import { simTopicPrefix } from './engine/progress';
import { sessionBinding, sessionsWindow, type ResolvedVideoSession } from './production';

/**
 * Pure half of the simulations API (M3): request wire schemas, binding
 * validation, and the API-binding -> executor-binding -> v2 manifest mapping.
 * No DB or AWS imports so the headless smoke script exercises all of it; the
 * handler (src/handlers/workflow-simulations.ts) owns auth, row resolution,
 * and dispatch.
 *
 * FROZEN wire contracts for the M3 frontend session:
 *
 * POST /workflow-templates/{id}/simulations
 *   { "definition": { nodes, edges, schemaVersion? },     // the editor's DRAFT
 *     "bindings": { "<sourceNodeId>": SimulationBinding } }
 *   SimulationBinding (API union; maps onto the M2-frozen executor unions):
 *     { kind: "session", sessionId }                      // source.video (on-device)
 *     { kind: "video_file", uploadKey }                   // source.video (uploaded)
 *     { kind: "device_telemetry", deviceId,
 *       window: { from, to }, metrics? }                  // source.telemetry
 *     { kind: "telemetry_csv", uploadKey, metrics? }      // source.telemetry (uploaded)
 *   201 -> { run: { id, status: "running", mode: "simulation", startedAt,
 *                   templateId, templateVersion, engineTarget: "lambda"|"fargate",
 *                   deviceId, workspaceId },
 *            progress: { topicPrefix, topics: { status, steps, events,
 *                        previewPrefix, recordsPrefix } } }
 *   400 WORKFLOW_VALIDATION_FAILED   same issue shape as publish
 *   400 SIMULATION_BINDING_INVALID   { details: { issues: [{ nodeId?, message }] } }
 *   502 SIMULATION_DISPATCH_FAILED   run row already flipped to failed
 *
 * POST /workflow-templates/{id}/simulations/uploads
 *   { "kind": "video" | "csv", "filename", "contentType"? }
 *   201 -> { upload: { key, url, fields, expiresInSeconds, maxBytes } }
 *   (S3 presigned POST; the browser then binds the returned `key` as
 *   uploadKey. Keys live under workflows/v2/uploads/<orgId>/... and expire via
 *   a 7-day lifecycle rule.)
 */

export const SIM_UPLOAD_PREFIX = 'workflows/v2/uploads/';
export const SIM_UPLOAD_EXPIRES_SECONDS = 900;
export const SIM_UPLOAD_MAX_BYTES: Record<'video' | 'csv', number> = {
  video: 1024 * 1024 * 1024, // 1 GiB
  csv: 25 * 1024 * 1024, // 25 MiB
};
// Engine budget per simulation target. Lambda mirrors the M2 default (under
// its 300 s function timeout); Fargate simulations get 15 minutes, well under
// the cv-runner's 30-minute production cap (demo-scale batch inputs).
export const SIM_MAX_RUNTIME_SECONDS: Record<'lambda' | 'fargate', number> = {
  lambda: 240,
  fargate: 900,
};

export function uploadPrefixForOrg(orgId: string): string {
  return `${SIM_UPLOAD_PREFIX}${orgId}/`;
}

export const simulationBindingSchema = z.discriminatedUnion('kind', [
  // An on-device recording session (destroy-kvs-recorder Phase W; replaces the
  // cloud recorder's `{kind:'recording', recordingId}` outright — decision K,
  // no compatibility window). The handler resolves it to the ordered segment
  // list and emits the same `device_session` executor binding production runs
  // use, so a simulation exercises the real media path.
  z.object({ kind: z.literal('session'), sessionId: z.string().uuid() }),
  z.object({ kind: z.literal('video_file'), uploadKey: z.string().min(1) }),
  z.object({
    kind: z.literal('device_telemetry'),
    deviceId: z.string().uuid(),
    window: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    metrics: z.array(z.string().min(1)).min(1).optional(), // default: the node's config.metrics
  }),
  z.object({
    kind: z.literal('telemetry_csv'),
    uploadKey: z.string().min(1),
    metrics: z.array(z.string().min(1)).min(1).optional(), // default: every numeric CSV column
  }),
  // M5 live plane (SANCTIONED ADDITION to the M3-frozen union): the browser
  // publishes sampled JPEG frames to <topicPrefix>/ingest/<nodeId> during the
  // run; the engine consumes them over MQTT. No upload, no S3 key.
  z.object({
    kind: z.literal('webcam'),
    maxDurationSeconds: z.number().positive().max(1800).optional(), // default: executor's 300 s
  }),
]);
export type SimulationBinding = z.infer<typeof simulationBindingSchema>;

export const createSimulationSchema = z.object({
  definition: workflowDefinitionSchema,
  bindings: z.record(z.string(), simulationBindingSchema).default({}),
});
export type CreateSimulationRequest = z.infer<typeof createSimulationSchema>;

export const createSimulationUploadSchema = z.object({
  kind: z.enum(['video', 'csv']),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120).optional(),
});

export interface SimulationBindingIssue {
  nodeId?: string;
  message: string;
}

const KINDS_BY_NODE_TYPE: Record<string, ReadonlyArray<SimulationBinding['kind']>> = {
  'source.video': ['session', 'video_file', 'webcam'],
  'source.telemetry': ['device_telemetry', 'telemetry_csv'],
};

/** True when any binding is a live one (webcam today, device_live later). */
export function hasLiveBindings(bindings: Record<string, SimulationBinding>): boolean {
  return Object.values(bindings).some((b) => b.kind === 'webcam');
}

/**
 * Structural binding validation over the UPGRADED (v2) definition. Every
 * source.video / source.telemetry node needs a binding of a matching kind,
 * upload keys must live under the caller org's upload prefix, and all
 * device_telemetry bindings must reference one device (the run-level deviceId
 * feeds the telemetry_history executor). Row existence (sessions, devices)
 * is the handler's job.
 */
export function validateSimulationBindings(
  definition: WorkflowDefinition,
  bindings: Record<string, SimulationBinding>,
  orgId: string,
): SimulationBindingIssue[] {
  const issues: SimulationBindingIssue[] = [];
  const nodeIds = new Set(definition.nodes.map((n) => n.id));
  for (const nodeId of Object.keys(bindings)) {
    if (!nodeIds.has(nodeId)) issues.push({ nodeId, message: `Binding references unknown node "${nodeId}"` });
  }
  const telemetryDevices = new Set<string>();
  for (const node of definition.nodes) {
    const allowed = KINDS_BY_NODE_TYPE[node.type];
    if (!allowed) continue;
    const binding = bindings[node.id];
    if (!binding) {
      issues.push({ nodeId: node.id, message: `Source node "${node.data.label}" needs an input binding` });
      continue;
    }
    if (!allowed.includes(binding.kind)) {
      issues.push({
        nodeId: node.id,
        message: `Binding kind "${binding.kind}" does not fit ${node.type} (expected ${allowed.join(' or ')})`,
      });
      continue;
    }
    if (binding.kind === 'video_file' || binding.kind === 'telemetry_csv') {
      if (!binding.uploadKey.startsWith(uploadPrefixForOrg(orgId))) {
        issues.push({
          nodeId: node.id,
          message: 'uploadKey must come from this organization\'s upload endpoint',
        });
      }
    }
    if (binding.kind === 'device_telemetry') {
      const fromMs = Date.parse(binding.window.from);
      const toMs = Date.parse(binding.window.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
        issues.push({ nodeId: node.id, message: 'device_telemetry window must be a valid from < to range' });
      }
      telemetryDevices.add(binding.deviceId);
    }
  }
  if (telemetryDevices.size > 1) {
    issues.push({
      message: 'All device telemetry bindings in one simulation must reference the same device',
    });
  }
  return issues;
}

/** Engine target for a v2 definition: Fargate iff any node is media-bound. */
export function engineTargetForDefinition(definition: WorkflowDefinition): 'lambda' | 'fargate' {
  for (const node of definition.nodes) {
    if (getNodeType(node.type)?.runtime.target === 'media') return 'fargate';
  }
  return 'lambda';
}

/**
 * Maps API bindings to the M2-frozen executor binding unions. `sessions` is
 * the handler's sessionId -> media_sessions/media_segments resolution (shared
 * with the production path, services/media-session-input.ts); upload keys pass
 * through as s3Key on the run's output bucket.
 */
export function toManifestInputs(
  bindings: Record<string, SimulationBinding>,
  sessions: Map<string, ResolvedVideoSession>,
): RunManifest['inputs'] {
  const inputs: RunManifest['inputs'] = [];
  for (const [nodeId, binding] of Object.entries(bindings)) {
    switch (binding.kind) {
      case 'session': {
        const session = sessions.get(binding.sessionId);
        if (!session) throw new Error(`Session "${binding.sessionId}" was not resolved`);
        inputs.push({ nodeId, binding: sessionBinding(session) });
        break;
      }
      case 'video_file':
        inputs.push({ nodeId, binding: { kind: 'video_file', s3Key: binding.uploadKey } });
        break;
      case 'device_telemetry':
        inputs.push({
          nodeId,
          binding: {
            kind: 'telemetry_history',
            window: binding.window,
            ...(binding.metrics ? { metrics: binding.metrics } : {}),
          },
        });
        break;
      case 'telemetry_csv':
        inputs.push({
          nodeId,
          binding: {
            kind: 'telemetry_csv',
            s3Key: binding.uploadKey,
            ...(binding.metrics ? { metrics: binding.metrics } : {}),
          },
        });
        break;
      case 'webcam':
        inputs.push({
          nodeId,
          binding: {
            kind: 'webcam',
            ...(binding.maxDurationSeconds !== undefined
              ? { maxDurationSeconds: binding.maxDurationSeconds }
              : {}),
          },
        });
        break;
    }
  }
  return inputs;
}

/**
 * The run's data window: the union of device_telemetry binding windows,
 * falling back to the span of any bound on-device session (so a video-only
 * simulation still has a meaningful ctx.window). Null for upload-only
 * simulations, which anchor at upload metadata or wall clock.
 */
export function simulationWindow(
  bindings: Record<string, SimulationBinding>,
  sessions?: Map<string, ResolvedVideoSession>,
): { from: string; to: string } | null {
  let fromMs = Infinity;
  let toMs = -Infinity;
  for (const binding of Object.values(bindings)) {
    if (binding.kind !== 'device_telemetry') continue;
    fromMs = Math.min(fromMs, Date.parse(binding.window.from));
    toMs = Math.max(toMs, Date.parse(binding.window.to));
  }
  if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  }
  return sessionsWindow([...(sessions?.values() ?? [])]);
}

/**
 * Assembles and schema-validates the v2 manifest for a simulation run.
 * Simulations with a live binding get manifest mode "live" (already a legal
 * enum value on the frozen schema): the engine's frames channels switch to
 * drop-oldest so a slow consumer sees the LATEST webcam frames, never a
 * growing backlog. The run ROW keeps mode='simulation' either way — manifest
 * mode is engine channel policy, not run taxonomy.
 */
export function buildSimulationManifest(args: {
  runId: string;
  orgId: string;
  bucket: string;
  definition: WorkflowDefinition; // already upgraded to v2
  deviceId: string | null;
  inputs: RunManifest['inputs'];
  window: { from: string; to: string } | null;
  target: 'lambda' | 'fargate';
}): RunManifest {
  const live = args.inputs.some((i) => i.binding.kind === 'webcam');
  return runManifestSchema.parse({
    manifestVersion: 2,
    runId: args.runId,
    mode: live ? 'live' : 'simulation',
    orgId: args.orgId, // M7: per-org credential resolution in the secrets seam
    deviceId: args.deviceId,
    window: args.window,
    definition: args.definition,
    inputs: args.inputs,
    output: { bucket: args.bucket, prefix: runPrefix(args.runId) },
    progress: { channel: 'iot', topicPrefix: simTopicPrefix(args.orgId, args.runId) },
    limits: { maxRuntimeSeconds: SIM_MAX_RUNTIME_SECONDS[args.target] },
  });
}

// --- Warm simulator session naming (M5, architecture §5) ----------------------
// An "editing session" is one (org, template) pair: everyone tweak-and-
// rerunning a template shares one warm task and one queue. The key is a stable
// 32-hex digest so it fits ECS's 36-char startedBy field and SQS's 80-char
// queue-name limit with the stage prefix.

export function simulationSessionKey(orgId: string, templateId: string): string {
  return createHash('sha256').update(`${orgId}:${templateId}`).digest('hex').slice(0, 32);
}

/** Queue name under the stage prefix (e.g. "xorgate-wfsim-dev-<key>"). */
export function sessionQueueName(prefix: string, sessionKey: string): string {
  return `${prefix}${sessionKey}`;
}

/** The `progress` block of the simulations API response. */
export function simulationProgressResponse(orgId: string, runId: string) {
  const topicPrefix = simTopicPrefix(orgId, runId);
  return {
    topicPrefix,
    topics: {
      status: `${topicPrefix}/status`,
      steps: `${topicPrefix}/steps`,
      events: `${topicPrefix}/events`,
      previewPrefix: `${topicPrefix}/preview/`,
      recordsPrefix: `${topicPrefix}/records/`,
    },
  };
}

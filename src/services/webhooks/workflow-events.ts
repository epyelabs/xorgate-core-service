import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '../../db/index';
import type { EmitWebhookEventArgs, WebhookDb } from './emit';

/**
 * `workflow.event` (xorgate-webhooks Phase 2, README D1): routed by the
 * emitting `output.event` node's `webhook` field, which names an endpoint in
 * the run's organization. Finalize is the only emitter, production runs only;
 * simulations surface the same name as `wouldDeliverTo` on the run detail.
 */

const OUTPUT_EVENT = 'output.event';

/** Reason on an outbox row whose node names an endpoint the org does not have. */
export const UNROUTED_ENDPOINT_NOT_FOUND = 'endpoint_not_found';

/**
 * nodeId -> endpoint name, for every `output.event` node of a definition
 * snapshot (`workflow_runs.definition`) that sets `config.webhook`. Defensive
 * about the shape: old (v1) snapshots and unknown nodes simply contribute
 * nothing.
 */
export function webhookNamesByNode(definition: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const nodes = (definition as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    // Node config lives at `data.config` (the editor's node shape, as
    // production.ts reads `streamKey`).
    const n = node as { id?: unknown; type?: unknown; data?: { config?: { webhook?: unknown } | null } | null };
    if (n?.type !== OUTPUT_EVENT || typeof n.id !== 'string') continue;
    const name = n.data?.config?.webhook;
    if (typeof name === 'string' && name.trim().length > 0) out.set(n.id, name.trim());
  }
  return out;
}

/**
 * Endpoint name -> id within one org. Disabled endpoints resolve too: the event
 * is linked to its endpoint (visible in that endpoint's log, redeliverable once
 * re-enabled) and fan-out skips the delivery while it is disabled.
 */
export async function endpointIdsByName(
  dbx: WebhookDb,
  organizationId: string,
  names: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (names.length === 0) return out;
  const e = schema.webhookEndpoints;
  const rows = await dbx
    .select({ id: e.id, name: e.name })
    .from(e)
    .where(and(eq(e.organizationId, organizationId), inArray(e.name, [...new Set(names)])));
  for (const r of rows) out.set(r.name, r.id);
  return out;
}

export interface WorkflowEventRunInfo {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  templateId: string;
  templateVersion: number;
  trigger: string;
  triggerContext: unknown;
  deviceId: string | null;
}

export interface PersistedWorkflowEvent {
  id: string;
  nodeId: string | null;
  kind: string;
  occurredAt: Date;
  confidence: number | null;
  payloadSummary: string;
  payload: unknown;
}

export interface WorkflowEventPlan {
  emits: EmitWebhookEventArgs[];
  /** Webhook names the org has no endpoint for (one warn line per run). */
  unresolved: string[];
}

/**
 * One outbox row per persisted event whose node has a `webhook` (README §4).
 * Events from nodes without one (or with no `nodeId`: engine <= 0.4.0) emit
 * nothing. A name with no endpoint still writes the row, with
 * `endpointId: null` and `data.unrouted`, so the log shows the miss and fan-out
 * creates zero deliveries (README §7).
 */
export function planWorkflowEventEmits(
  run: WorkflowEventRunInfo,
  events: ReadonlyArray<PersistedWorkflowEvent>,
  namesByNode: ReadonlyMap<string, string>,
  endpointsByName: ReadonlyMap<string, string>,
): WorkflowEventPlan {
  const emits: EmitWebhookEventArgs[] = [];
  const unresolved = new Set<string>();
  for (const ev of events) {
    const name = ev.nodeId ? namesByNode.get(ev.nodeId) : undefined;
    if (!name) continue;
    const endpointId = endpointsByName.get(name) ?? null;
    if (!endpointId) unresolved.add(name);
    emits.push({
      organizationId: run.organizationId,
      workspaceId: run.workspaceId,
      type: 'workflow.event',
      dedupeKey: `workflow_event:${ev.id}`,
      endpointId,
      data: {
        eventId: ev.id,
        nodeId: ev.nodeId,
        webhook: name,
        kind: ev.kind,
        occurredAt: ev.occurredAt.toISOString(),
        confidence: ev.confidence ?? 0,
        payloadSummary: ev.payloadSummary,
        payload: ev.payload ?? null,
        run: {
          id: run.id,
          templateId: run.templateId,
          templateVersion: run.templateVersion,
          trigger: run.trigger,
          triggerContext: run.triggerContext ?? null,
          deviceId: run.deviceId,
        },
        ...(endpointId ? {} : { unrouted: UNROUTED_ENDPOINT_NOT_FOUND }),
      },
    });
  }
  return { emits, unresolved: [...unresolved] };
}

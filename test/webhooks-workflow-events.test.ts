import { describe, expect, it } from 'vitest';
import { buildEngineResult } from '@xorgate/workflow-engine';
import { v2EventRows } from '../src/workflows/host/finalize';
import { platformResultSchema } from '../src/workflows/host/result';
import {
  planWorkflowEventEmits,
  UNROUTED_ENDPOINT_NOT_FOUND,
  webhookNamesByNode,
  type WorkflowEventRunInfo,
} from '../src/services/webhooks/workflow-events';

/**
 * xorgate-webhooks Phase 2: `workflow.event` from finalize. The routing input
 * is the run's definition snapshot; the event's node comes from the engine
 * (0.5.0 `nodeId`), persisted in `workflow_events.node_id` (migration 029).
 */

const definition = {
  schemaVersion: 2,
  nodes: [
    { id: 'n1', type: 'source.telemetry', data: { config: {} } },
    { id: 'n4', type: 'output.event', data: { label: 'Overspeed', config: { kind: 'overspeed', webhook: 'dispatch' } } },
    { id: 'n5', type: 'output.event', data: { config: { kind: 'audit', webhook: '  audit  ' } } },
    { id: 'n6', type: 'output.event', data: { config: { kind: 'quiet' } } },
    { id: 'n7', type: 'output.event', data: { config: { kind: 'blank', webhook: '' } } },
    { id: 'n8', type: 'output.data_capture', data: { config: { webhook: 'not-an-event-node' } } },
    // A flat `config` is not the definition shape; it is ignored.
    { id: 'n9', type: 'output.event', config: { kind: 'flat', webhook: 'dispatch' } },
  ],
  edges: [],
};

const run: WorkflowEventRunInfo = {
  id: 'run-1',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  templateId: 'tpl-1',
  templateVersion: 3,
  trigger: 'manual',
  triggerContext: null,
  deviceId: 'dev-1',
};

const ev = (id: string, nodeId: string | null) => ({
  id,
  nodeId,
  kind: 'overspeed',
  occurredAt: new Date('2026-09-28T20:00:00.000Z'),
  confidence: 1,
  payloadSummary: 'overspeed · 92',
  payload: { observed: 92 },
});

describe('webhookNamesByNode', () => {
  it('maps only output.event nodes with a non-blank webhook (trimmed)', () => {
    expect([...webhookNamesByNode(definition)]).toEqual([
      ['n4', 'dispatch'],
      ['n5', 'audit'],
    ]);
  });

  it('reads the node shape the engine fixtures and the editor save (data.config)', () => {
    const def = { nodes: [{ id: 'n4', type: 'output.event', position: { x: 0, y: 0 }, data: { label: 'x', config: { kind: 'k', webhook: 'dispatch' } } }] };
    expect(webhookNamesByNode(def).get('n4')).toBe('dispatch');
  });

  it('tolerates snapshots without nodes (v1 / junk)', () => {
    expect(webhookNamesByNode(null).size).toBe(0);
    expect(webhookNamesByNode({ nodes: 'x' }).size).toBe(0);
    expect(webhookNamesByNode({}).size).toBe(0);
  });
});

describe('planWorkflowEventEmits', () => {
  const names = webhookNamesByNode(definition);

  it('one routed workflow.event per event of a webhook node, keyed on the event id', () => {
    const plan = planWorkflowEventEmits(run, [ev('e1', 'n4'), ev('e2', 'n4')], names, new Map([['dispatch', 'ep-1']]));
    expect(plan.unresolved).toEqual([]);
    expect(plan.emits).toHaveLength(2);
    expect(plan.emits[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      type: 'workflow.event',
      dedupeKey: 'workflow_event:e1',
      endpointId: 'ep-1',
    });
    expect(plan.emits[0]!.data).toEqual({
      eventId: 'e1',
      nodeId: 'n4',
      webhook: 'dispatch',
      kind: 'overspeed',
      occurredAt: '2026-09-28T20:00:00.000Z',
      confidence: 1,
      payloadSummary: 'overspeed · 92',
      payload: { observed: 92 },
      run: { id: 'run-1', templateId: 'tpl-1', templateVersion: 3, trigger: 'manual', triggerContext: null, deviceId: 'dev-1' },
    });
  });

  it('events from nodes without a webhook, and events with no nodeId (engine <= 0.4.0), emit nothing', () => {
    const plan = planWorkflowEventEmits(run, [ev('e1', 'n6'), ev('e2', null), ev('e3', 'nX')], names, new Map());
    expect(plan.emits).toEqual([]);
  });

  it('a name with no endpoint still writes the row: endpointId null + unrouted marker, reported once', () => {
    const plan = planWorkflowEventEmits(run, [ev('e1', 'n5'), ev('e2', 'n5'), ev('e3', 'n4')], names, new Map([['dispatch', 'ep-1']]));
    expect(plan.unresolved).toEqual(['audit']);
    const audit = plan.emits.filter((e) => e.data.webhook === 'audit');
    expect(audit).toHaveLength(2);
    for (const e of audit) {
      expect(e.endpointId).toBeNull();
      expect(e.data.unrouted).toBe(UNROUTED_ENDPOINT_NOT_FOUND);
    }
    expect(plan.emits.find((e) => e.data.webhook === 'dispatch')!.data).not.toHaveProperty('unrouted');
  });
});

describe('finalize event rows carry nodeId', () => {
  const base = (events: unknown[]) =>
    platformResultSchema.parse({
      ...buildEngineResult('run-1', {
        status: 'succeeded',
        error: null,
        failedNodeId: null,
        steps: [],
        events: [],
        captures: {},
        metrics: {},
      }),
      events,
    });
  const event = { kind: 'overspeed', occurredAt: '2026-09-28T20:00:00.000Z', confidence: 1, payloadSummary: 's', payload: null, clipKey: null };

  it('keeps nodeId from a 0.5.0 result', () => {
    const rows = v2EventRows({ id: 'run-1', deviceId: 'dev-1' }, base([{ ...event, nodeId: 'n4' }]));
    expect(rows[0]!.nodeId).toBe('n4');
  });

  it('a 0.4.0-shaped result (no nodeId) still parses and maps to null', () => {
    const rows = v2EventRows({ id: 'run-1', deviceId: null }, base([event]));
    expect(rows[0]!.nodeId).toBeNull();
  });
});

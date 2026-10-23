import { describe, expect, it } from 'vitest';
import { buildEngineResult } from '@xorgate/workflow-engine';
import { v2RunUpdate, v2StepRows } from '../src/workflows/host/finalize';
import { platformResultSchema } from '../src/workflows/host/result';

// Engine 0.5.1: a deadline or a graph stall reports still-running nodes as
// `cancelled` (not `skipped`). Finalize must parse and store it; the run status
// stays the result's own (`failed`), never derived from the steps.
describe('finalize accepts the engine 0.5.1 `cancelled` step status', () => {
  const result = platformResultSchema.parse(
    buildEngineResult('run-1', {
      status: 'failed',
      error: 'Run exceeded its max runtime',
      failedNodeId: null,
      steps: [
        { seq: 0, nodeId: 'src', label: 'Source', status: 'ok', output: '120 messages', durationMs: 4 },
        { seq: 1, nodeId: 'roads', label: 'Roads', status: 'cancelled', output: 'cancelled: graph stalled while waiting on src (0 queued)', durationMs: 30000 },
        { seq: 2, nodeId: 'evt', label: 'Event', status: 'skipped', output: 'skipped (upstream failure)', durationMs: 0 },
      ],
      events: [],
      captures: {},
      metrics: {},
    }),
  );

  it('maps a cancelled step row verbatim', () => {
    const rows = v2StepRows('run-1', result);
    expect(rows.map((r) => r.status)).toEqual(['ok', 'cancelled', 'skipped']);
  });

  it('keeps the run status from result.json', () => {
    const update = v2RunUpdate(result, new Date('2026-10-23T00:00:00Z'), new Date('2026-10-23T00:01:00Z'));
    expect(update.status).toBe('failed');
    expect(update.failedNodeId).toBeNull();
  });
});

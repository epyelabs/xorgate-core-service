import { describe, expect, it, vi } from 'vitest';
import type { EngineRunCtx } from '../src/workflows/catalog/types';
import { executor } from '../src/workflows/catalog/nodes/source-telemetry';

/**
 * disable_telemetry_recording DoD 8. With `recording.telemetry.enabled` now the
 * master switch for `telemetry_readings`, a fusion graph attached to a device
 * that is not recording reads an EMPTY history window — which used to be an edge
 * case and is, under Q1's answer (default stays `false`), the default path.
 *
 * So the empty window must be a clean no-op, not a throw: the node yields nothing
 * and reports 0 samples, leaving downstream nodes to see an empty telemetry
 * channel. `readTelemetryWindow` itself returns `[]` for zero rows (it groups
 * rows into a Map and spreads it), so this pins the executor half.
 */

function ctx(over: Partial<EngineRunCtx> = {}): EngineRunCtx {
  return {
    runId: 'run-1',
    mode: 'live',
    deviceId: 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7',
    window: { fromMs: Date.parse('2026-08-04T00:00:00Z'), toMs: Date.parse('2026-08-04T01:00:00Z') },
    nodeId: 'n1',
    binding: null, // no binding ⇒ history read over the run window
    sources: { readTelemetryWindow: vi.fn(async () => []) },
    artifacts: null,
    secrets: null,
    http: fetch,
    emitEvent: vi.fn(),
    captureRecord: vi.fn(),
    setSummary: vi.fn(),
    log: vi.fn(),
    ...over,
  } as EngineRunCtx;
}

describe('source.telemetry on an empty history window', () => {
  it('yields nothing and does not throw', async () => {
    const c = ctx();
    const emitted = [];
    for await (const item of executor([], { metrics: ['gps.speed'] }, c)) emitted.push(item);

    expect(emitted).toEqual([]);
    expect(c.sources.readTelemetryWindow).toHaveBeenCalledTimes(1);
  });

  it('reports 0 samples in the step summary rather than failing the node', async () => {
    const c = ctx();
    for await (const _ of executor([], { metrics: ['gps.speed', 'imu.accel_x'] }, c)) void _;

    expect(c.setSummary).toHaveBeenCalledWith('0 samples (history: gps.speed, imu.accel_x)');
  });
});

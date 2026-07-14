/**
 * Headless smoke test for the v2 engine core (M2 session 1). No test framework
 * in this repo; run from the service root with:
 *
 *   npx ts-node -T --compilerOptions '{"module":"commonjs","target":"ES2022"}' scripts/engine-smoke.ts
 *
 * Covers:
 *   1. bounded-channel backpressure (block policy, producer stalls at capacity)
 *   2. drop-oldest policy (live-mode frames channels: latest wins)
 *   3. scenario 5 (idle detect): telemetry -> ema -> window_aggregate ->
 *      threshold -> event, from an in-memory (telemetry_inline) source, through
 *      to the frozen result.json shape
 *   4. step/skip semantics: failing node -> failed step, descendants skipped,
 *      independent branch still ok
 *   5. output.data_capture collects records (unit level; no json producer
 *      exists among the session-1 executors)
 *   6. logic.debounce sustained-true / rising-edge behavior (unit level)
 */
import { strict as assert } from 'node:assert';
import { getExecutor } from '../src/workflows/catalog/index';
import type {
  EngineMessage,
  EngineRunCtx,
  EngineSourceReader,
} from '../src/workflows/catalog/types';
import { BoundedChannel } from '../src/workflows/engine/channel';
import { runGraph } from '../src/workflows/engine/index';
import { buildEngineResult, engineResultSchema } from '../src/workflows/engine/manifest';
import type { WorkflowDefinition } from '../src/schemas/workflows';

const failingSources: EngineSourceReader = {
  readTelemetryWindow: async () => {
    throw new Error('smoke test must not hit a telemetry store');
  },
};

function stubCtx(overrides: Partial<EngineRunCtx> = {}): EngineRunCtx & { captured: unknown[]; summary: string | null } {
  const captured: unknown[] = [];
  const ctx = {
    runId: 'smoke',
    mode: 'batch' as const,
    deviceId: null,
    window: null,
    nodeId: 'unit',
    binding: null,
    sources: failingSources,
    emitEvent: () => {},
    captureRecord: (r: unknown) => captured.push(r),
    setSummary: (s: string) => {
      ctx.summary = s;
    },
    log: () => {},
    captured,
    summary: null as string | null,
    ...overrides,
  };
  return ctx;
}

async function microtasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// --- 1. Backpressure -----------------------------------------------------------
async function testBackpressure(): Promise<void> {
  const ch = new BoundedChannel<number>(4);
  let resolvedPushes = 0;
  const producer = (async () => {
    for (let i = 0; i < 12; i++) {
      await ch.push(i);
      resolvedPushes += 1;
    }
    ch.close();
  })();
  await microtasks();
  assert.strictEqual(resolvedPushes, 4, `producer should stall at capacity (resolved ${resolvedPushes})`);
  const seen: number[] = [];
  for await (const v of ch) {
    seen.push(v);
    await microtasks(2); // slow consumer
  }
  await producer;
  assert.strictEqual(resolvedPushes, 12);
  assert.deepStrictEqual(seen, [...Array(12).keys()]);
  assert.ok(ch.maxDepth <= 4, `channel depth ${ch.maxDepth} exceeded capacity`);
  console.log('ok: backpressure (block policy, depth capped at capacity)');
}

// --- 2. Drop-oldest ---------------------------------------------------------------
async function testDropOldest(): Promise<void> {
  const ch = new BoundedChannel<number>(4, 'drop-oldest');
  for (let i = 0; i < 10; i++) await ch.push(i); // never blocks
  ch.close();
  const seen: number[] = [];
  for await (const v of ch) seen.push(v);
  assert.deepStrictEqual(seen, [6, 7, 8, 9], `drop-oldest kept ${JSON.stringify(seen)}`);
  console.log('ok: drop-oldest (latest wins)');
}

// --- 3. Scenario 5: idle detect from an in-memory telemetry source ----------------
function scenario5Definition(): WorkflowDefinition {
  const node = (id: string, type: string, label: string, config: Record<string, unknown>) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, config },
  });
  const edge = (source: string, target: string, sourceHandle: string, targetHandle: string) => ({
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  });
  return {
    schemaVersion: 2,
    nodes: [
      node('src', 'source.telemetry', 'Telemetry', { metrics: ['vehicle.speed'] }),
      node('ema', 'telemetry.ema', 'EMA Smoothing', { alpha: 0.5 }),
      node('agg', 'telemetry.window_aggregate', 'Window Aggregate', { windowSeconds: 30, fn: 'mean' }),
      node('thr', 'logic.threshold', 'Threshold', { operator: 'lt', value: 2 }),
      node('evt', 'output.event', 'Emit Event', { kind: 'idle_detect', cooldownSeconds: 300 }),
    ],
    edges: [
      edge('src', 'ema', 'telemetry', 'telemetry'),
      edge('ema', 'agg', 'telemetry', 'telemetry'),
      edge('agg', 'thr', 'telemetry', 'telemetry'),
      edge('thr', 'evt', 'condition', 'condition'),
    ],
  };
}

async function testScenario5(): Promise<void> {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const samples: Array<{ ts: number; signals: Record<string, number> }> = [];
  // 60 s of driving (~20 kph with jitter), then 120 s idling (~0.3 kph).
  for (let i = 0; i < 60; i++) {
    samples.push({ ts: t0 + i * 1000, signals: { 'vehicle.speed': 20 + (i % 3) } });
  }
  for (let i = 60; i < 180; i++) {
    samples.push({ ts: t0 + i * 1000, signals: { 'vehicle.speed': 0.3 } });
  }

  const outcome = await runGraph(
    {
      runId: 'run-scenario5',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition: scenario5Definition(),
      bindings: { src: { kind: 'telemetry_inline', samples } },
    },
    { sources: failingSources, channelCapacity: 8 }, // small capacity to exercise backpressure
  );

  assert.strictEqual(outcome.status, 'succeeded', `run failed: ${outcome.error}`);
  assert.strictEqual(outcome.steps.length, 5);
  for (const step of outcome.steps) {
    assert.strictEqual(step.status, 'ok', `step ${step.nodeId}: ${step.output}`);
  }
  assert.strictEqual(outcome.events.length, 1, `expected 1 idle event, got ${outcome.events.length}`);
  const event = outcome.events[0];
  assert.strictEqual(event.kind, 'idle_detect');
  const occurredMs = Date.parse(event.occurredAt);
  assert.ok(
    occurredMs > t0 + 60_000 && occurredMs <= t0 + 180_000,
    `event at ${event.occurredAt} is outside the idle period`,
  );
  assert.strictEqual(outcome.metrics.okSteps, 5);
  assert.ok(outcome.metrics.messages > 500, 'expected messages from all four streaming stages');

  // Freeze check: the outcome must assemble into a schema-valid result.json.
  const result = engineResultSchema.parse(buildEngineResult('run-scenario5', outcome));
  assert.strictEqual(result.status, 'succeeded');
  assert.strictEqual(result.artifacts.eventsKey, 'workflows/v2/runs/run-scenario5/events.jsonl');
  console.log(
    `ok: scenario 5 (idle detect) — event at ${event.occurredAt}, ${outcome.metrics.messages} messages`,
  );
}

// --- 4. Step/skip semantics --------------------------------------------------------
async function testSkipSemantics(): Promise<void> {
  const definition: WorkflowDefinition = {
    schemaVersion: 2,
    nodes: [
      {
        id: 'src',
        type: 'source.telemetry',
        position: { x: 0, y: 0 },
        data: { label: 'Telemetry', config: { metrics: ['a', 'b'] } },
      },
      {
        // Two signals + no config.signal -> the threshold executor throws.
        id: 'thr',
        type: 'logic.threshold',
        position: { x: 0, y: 0 },
        data: { label: 'Threshold', config: { operator: 'gt', value: 1 } },
      },
      {
        id: 'evt',
        type: 'output.event',
        position: { x: 0, y: 0 },
        data: { label: 'Emit Event', config: { kind: 'x' } },
      },
      {
        // Independent branch off the same source: must complete ok.
        id: 'ema',
        type: 'telemetry.ema',
        position: { x: 0, y: 0 },
        data: { label: 'EMA Smoothing', config: {} },
      },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'thr', sourceHandle: 'telemetry', targetHandle: 'telemetry' },
      { id: 'e2', source: 'thr', target: 'evt', sourceHandle: 'condition', targetHandle: 'condition' },
      { id: 'e3', source: 'src', target: 'ema', sourceHandle: 'telemetry', targetHandle: 'telemetry' },
    ],
  };
  const samples = [...Array(50).keys()].map((i) => ({
    ts: Date.UTC(2026, 0, 1) + i * 1000,
    signals: { a: i, b: i * 2 },
  }));
  const outcome = await runGraph(
    {
      runId: 'run-skip',
      mode: 'batch',
      deviceId: null,
      window: null,
      definition,
      bindings: { src: { kind: 'telemetry_inline', samples } },
    },
    { sources: failingSources, channelCapacity: 4 },
  );
  const byNode = new Map(outcome.steps.map((s) => [s.nodeId, s]));
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.failedNodeId, 'thr');
  assert.match(outcome.error ?? '', /signals/);
  assert.strictEqual(byNode.get('thr')!.status, 'failed');
  assert.strictEqual(byNode.get('evt')!.status, 'skipped');
  assert.strictEqual(byNode.get('src')!.status, 'ok', byNode.get('src')!.output);
  assert.strictEqual(byNode.get('ema')!.status, 'ok', byNode.get('ema')!.output);
  console.log('ok: skip semantics (failed node, skipped descendant, independent branch ok)');
}

// --- 5. output.data_capture (unit) --------------------------------------------------
async function testDataCapture(): Promise<void> {
  const executor = getExecutor('output.data_capture')!;
  const channel = new BoundedChannel<EngineMessage>(8);
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 3; i++) {
    await channel.push({ ch: 'json', tag: 'speed_limit', ts: t0 + i, seq: i, payload: { kph: 50 + i } });
  }
  channel.close();
  const ctx = stubCtx({ nodeId: 'cap' });
  const inputs = [{ port: 'records', from: { nodeId: 'up', port: 'out' }, messages: channel }];
  for await (const _msg of executor(inputs, { format: 'jsonl' }, ctx)) {
    assert.fail('data_capture must not emit messages');
  }
  assert.strictEqual(ctx.captured.length, 3);
  const first = ctx.captured[0] as { ts: number; tag: string; record: { kph: number } };
  assert.strictEqual(first.tag, 'speed_limit');
  assert.strictEqual(first.record.kph, 50);
  assert.strictEqual(ctx.summary, 'captured 3 record(s)');
  console.log('ok: data_capture (records collected via ctx)');
}

// --- 6. logic.debounce (unit) --------------------------------------------------------
async function testDebounce(): Promise<void> {
  const executor = getExecutor('logic.debounce')!;
  const channel = new BoundedChannel<EngineMessage>(64);
  const t0 = Date.UTC(2026, 0, 1);
  const feed: Array<[number, boolean]> = [];
  feed.push([t0, true]); // 1 s blip: must not pass
  feed.push([t0 + 1000, false]);
  for (let i = 10; i <= 20; i++) feed.push([t0 + i * 1000, true]); // sustained 10 s
  feed.push([t0 + 21_000, false]);
  let seq = 0;
  for (const [ts, value] of feed) {
    await channel.push({ ch: 'condition', ts, seq: seq++, payload: { value } });
  }
  channel.close();
  const ctx = stubCtx({ nodeId: 'deb' });
  const inputs = [{ port: 'condition', from: { nodeId: 'up', port: 'condition' }, messages: channel }];
  const out: Array<{ ts: number; value: boolean }> = [];
  for await (const msg of executor(inputs, { minDurationMs: 3000, cooldownMs: 0 }, ctx)) {
    out.push({ ts: msg.ts, value: (msg.payload as { value: boolean }).value });
  }
  const firstTrue = out.find((m) => m.value);
  assert.ok(firstTrue, 'debounce never turned true');
  assert.strictEqual(firstTrue!.ts, t0 + 13_000, `debounce turned true at ${firstTrue!.ts - t0}ms`);
  assert.strictEqual(out.filter((m, i) => m.value && (i === 0 || !out[i - 1].value)).length, 1);
  assert.ok(!out[0].value, 'the 1 s blip must not pass');
  console.log('ok: debounce (sustained-true gate)');
}

async function main(): Promise<void> {
  await testBackpressure();
  await testDropOldest();
  await testScenario5();
  await testSkipSemantics();
  await testDataCapture();
  await testDebounce();
  console.log('\nengine smoke: all checks passed');
}

main().catch((err) => {
  console.error('\nengine smoke FAILED:', err);
  process.exit(1);
});

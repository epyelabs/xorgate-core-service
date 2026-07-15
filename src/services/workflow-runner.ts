import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import type { WorkflowRun } from '../db/schema';
import type { WorkflowDefinition, WorkflowNode } from '../schemas/workflows';

/**
 * In-process runner for telemetry-only workflow graphs (the dispatcher routes
 * video graphs to Fargate instead). Kahn topo-sorts the definition, runs a small
 * executor registry over the run's data window, and persists steps + events + the
 * final run status. Video node types are registered as throw-if-inline (defensive:
 * the dispatcher should never send them here).
 *
 * The executors are deliberately v1-pragmatic: enough to make the overspeed
 * scenario (gps -> speed_from_gps -> speed_limit_check -> output.event) produce a
 * real event, with reasonable stubs for the rest.
 */

// Node types whose presence forces a Fargate run (they need ffmpeg/ONNX).
export const VIDEO_NODE_TYPES = new Set([
  'source.video',
  'processor.decode_sample',
  'processor.object_detection',
]);

export function executionModeForDefinition(def: WorkflowDefinition): 'inline' | 'fargate' {
  return def.nodes.some((n) => VIDEO_NODE_TYPES.has(n.type)) ? 'fargate' : 'inline';
}

type Point = { ts: string; value: number };
type EventCandidate = {
  kind: string;
  occurredAt: string;
  confidence: number;
  payloadSummary: string;
  payload?: unknown;
};
type NodeResult = { summary: string; data: Record<string, unknown>; events: EventCandidate[] };

interface RunCtx {
  deviceId: string;
  window: { from: string; to: string };
}

type NodeExecutor = (
  node: WorkflowNode,
  inputs: NodeResult[],
  ctx: RunCtx,
) => Promise<NodeResult>;

class InlineVideoError extends Error {}

// --- Telemetry access --------------------------------------------------------

type Reading = { ts: string; metric: string; value: number; unit: string | null };

// Reads telemetry_readings for the run window. `filter` is either a metric-prefix
// LIKE (e.g. "gps.%") or an explicit metric list.
async function fetchReadings(
  ctx: RunCtx,
  filter: { like?: string; metrics?: string[] },
): Promise<Reading[]> {
  const conds = [
    eq(schema.telemetryReadings.deviceId, ctx.deviceId),
    sql`${schema.telemetryReadings.ts} >= ${tsParam(ctx.window.from)}`,
    sql`${schema.telemetryReadings.ts} < ${tsParam(ctx.window.to)}`,
  ];
  if (filter.like) conds.push(sql`${schema.telemetryReadings.metric} LIKE ${filter.like}`);
  else if (filter.metrics && filter.metrics.length > 0) {
    conds.push(inArray(schema.telemetryReadings.metric, filter.metrics));
  }
  const rows = await db
    .select({
      ts: schema.telemetryReadings.ts,
      metric: schema.telemetryReadings.metric,
      value: schema.telemetryReadings.value,
      unit: schema.telemetryReadings.unit,
    })
    .from(schema.telemetryReadings)
    .where(and(...conds))
    .orderBy(asc(schema.telemetryReadings.ts));
  return rows
    .filter((r): r is typeof r & { value: number } => r.value !== null)
    .map((r) => ({ ts: r.ts.toISOString(), metric: r.metric, value: r.value, unit: r.unit }));
}

function pointsByMetric(readings: Reading[]): Record<string, Point[]> {
  const out: Record<string, Point[]> = {};
  for (const r of readings) (out[r.metric] ??= []).push({ ts: r.ts, value: r.value });
  return out;
}

// --- Executor helpers --------------------------------------------------------

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Speed series (kph) from the first upstream node that carries one: a
// speed_from_gps output, else a raw gps.speed series (converted from m/s).
function findSpeedSeries(inputs: NodeResult[]): Point[] | null {
  for (const inp of inputs) {
    const s = inp.data.speedSeries;
    if (Array.isArray(s)) return s as Point[];
  }
  for (const inp of inputs) {
    const points = inp.data.points as Record<string, Point[]> | undefined;
    const units = inp.data.units as Record<string, string | null> | undefined;
    if (points?.['gps.speed']) {
      const factor = units?.['gps.speed'] === 'm/s' ? 3.6 : 1;
      return points['gps.speed'].map((p) => ({ ts: p.ts, value: p.value * factor }));
    }
  }
  return null;
}

// Any crossing arrays produced upstream (speed_limit_check, threshold, ...).
function collectCrossings(inputs: NodeResult[]): Array<Point & Record<string, unknown>> {
  const out: Array<Point & Record<string, unknown>> = [];
  for (const inp of inputs) {
    const c = inp.data.crossings;
    if (Array.isArray(c)) out.push(...(c as Array<Point & Record<string, unknown>>));
  }
  return out;
}

// Collapse contiguous crossing points (<= gapSec apart) into episodes, keeping
// the peak observed value — one event per episode rather than one per sample.
function collapseEpisodes(
  crossings: Array<{ ts: string; value: number } & Record<string, unknown>>,
  gapSec = 5,
): Array<{ ts: string; peak: number; count: number }> {
  const sorted = [...crossings].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const episodes: Array<{ ts: string; peak: number; count: number }> = [];
  let cur: { ts: string; peak: number; count: number; last: number } | null = null;
  for (const c of sorted) {
    const t = Date.parse(c.ts);
    if (cur && t - cur.last <= gapSec * 1000) {
      cur.peak = Math.max(cur.peak, c.value);
      cur.count += 1;
      cur.last = t;
    } else {
      if (cur) episodes.push({ ts: cur.ts, peak: cur.peak, count: cur.count });
      cur = { ts: c.ts, peak: c.value, count: 1, last: t };
    }
  }
  if (cur) episodes.push({ ts: cur.ts, peak: cur.peak, count: cur.count });
  return episodes;
}

// --- Executor registry -------------------------------------------------------

const executors: Record<string, NodeExecutor> = {
  'source.gps': async (_n, _i, ctx) => {
    const readings = await fetchReadings(ctx, { like: 'gps.%' });
    const points = pointsByMetric(readings);
    const units: Record<string, string | null> = {};
    for (const r of readings) units[r.metric] = r.unit;
    const fixes = points['gps.lat']?.length ?? points['gps.speed']?.length ?? readings.length;
    return { summary: `${fixes} GPS fixes`, data: { points, units }, events: [] };
  },

  'source.imu': async (_n, _i, ctx) => {
    const readings = await fetchReadings(ctx, { like: 'imu.%' });
    const points = pointsByMetric(readings);
    const samples = Object.values(points)[0]?.length ?? 0;
    return { summary: `${samples} IMU samples`, data: { points }, events: [] };
  },

  'source.telemetry': async (node, _i, ctx) => {
    const metric = typeof node.data.config.metric === 'string' ? node.data.config.metric : '';
    const readings = metric ? await fetchReadings(ctx, { metrics: [metric] }) : [];
    const points = pointsByMetric(readings);
    return {
      summary: `${readings.length} readings${metric ? ` (${metric})` : ''}`,
      data: { metric, points, units: { [metric]: readings[0]?.unit ?? null } },
      events: [],
    };
  },

  'processor.speed_from_gps': async (node, inputs) => {
    const raw = findSpeedSeries(inputs) ?? [];
    // Optional EMA smoothing.
    const smoothing = String(node.data.config.smoothing ?? 'ema');
    let series = raw;
    if (smoothing === 'ema' && raw.length > 0) {
      const alpha = 0.4;
      let prev = raw[0].value;
      series = raw.map((p) => {
        prev = alpha * p.value + (1 - alpha) * prev;
        return { ts: p.ts, value: prev };
      });
    }
    const peak = series.reduce((m, p) => Math.max(m, p.value), 0);
    return {
      summary: `${series.length} samples, peak ${peak.toFixed(1)} kph`,
      data: { speedSeries: series },
      events: [],
    };
  },

  'processor.speed_limit_check': async (node, inputs) => {
    const speed = findSpeedSeries(inputs) ?? [];
    const limit = num(node.data.config, 'limitKph', 80);
    const crossings = speed
      .filter((p) => p.value > limit)
      .map((p) => ({ ts: p.ts, value: p.value, observed: p.value, limit }));
    const peak = crossings.reduce((m, c) => Math.max(m, c.value), 0);
    return {
      summary:
        crossings.length > 0
          ? `over ${limit} kph ${crossings.length}× (peak ${peak.toFixed(1)})`
          : `within ${limit} kph limit`,
      data: { crossings, limit },
      events: [],
    };
  },

  'processor.imu_decel': async (node, inputs) => {
    const axis = String(node.data.config.axis ?? 'x');
    let series: Point[] = [];
    for (const inp of inputs) {
      const points = inp.data.points as Record<string, Point[]> | undefined;
      if (points?.[`imu.accel_${axis}`]) {
        series = points[`imu.accel_${axis}`];
        break;
      }
    }
    const min = series.reduce((m, p) => Math.min(m, p.value), 0);
    const spike = series.find((p) => p.value === min);
    // A decel "crossing" so downstream logic/output can consume it uniformly.
    const crossings = spike ? [{ ts: spike.ts, value: min, observed: min }] : [];
    return {
      summary: series.length > 0 ? `min accel ${min.toFixed(2)}` : 'no IMU data',
      data: { crossings, min },
      events: [],
    };
  },

  'processor.sensor_fusion': async (_n, inputs) => ({
    summary: `aligned ${inputs.length} stream${inputs.length === 1 ? '' : 's'}`,
    // Pass through upstream crossings/series so it can sit mid-graph.
    data: {
      crossings: collectCrossings(inputs),
      speedSeries: findSpeedSeries(inputs) ?? undefined,
    },
    events: [],
  }),

  'logic.threshold': async (node, inputs) => {
    const op = String(node.data.config.operator ?? '>=');
    const value = num(node.data.config, 'value', 0);
    // Primary numeric series: a speed series, else the first upstream metric series.
    let series = findSpeedSeries(inputs);
    if (!series) {
      for (const inp of inputs) {
        const points = inp.data.points as Record<string, Point[]> | undefined;
        const first = points ? Object.values(points)[0] : undefined;
        if (first) {
          series = first;
          break;
        }
      }
    }
    const test = (v: number) =>
      op === '>' ? v > value : op === '>=' ? v >= value : op === '<' ? v < value : op === '<=' ? v <= value : v === value;
    const crossings = (series ?? [])
      .filter((p) => test(p.value))
      .map((p) => ({ ts: p.ts, value: p.value }));
    return {
      summary: `crossed ${op} ${value}: ${crossings.length}×`,
      data: { crossings },
      events: [],
    };
  },

  'logic.composite_rule': async (node, inputs) => {
    const combine = String(node.data.config.combine ?? 'all');
    const perInput = inputs.map((i) => collectCrossings([i]));
    let crossings: Array<Point & Record<string, unknown>> = [];
    if (combine === 'all') {
      // Require every input to have fired; emit the union if so.
      crossings = perInput.every((c) => c.length > 0) ? perInput.flat() : [];
    } else {
      crossings = perInput.flat();
    }
    return { summary: `matched ${crossings.length} point(s)`, data: { crossings }, events: [] };
  },

  'output.event': async (node, inputs) => {
    const crossings = collectCrossings(inputs);
    const kind = (typeof node.data.config.kind === 'string' && node.data.config.kind) || 'event';
    const episodes = collapseEpisodes(crossings);
    const events: EventCandidate[] = episodes.map((ep) => ({
      kind,
      occurredAt: ep.ts,
      confidence: 1,
      payloadSummary: `${kind} · peak ${ep.peak.toFixed(1)} (${ep.count} samples)`,
      payload: { peak: ep.peak, samples: ep.count },
    }));
    return { summary: `emitted ${events.length} event(s)`, data: { eventCount: events.length }, events };
  },

  'output.alert': async () => ({
    summary: 'alert delivery is a stub (no-op)',
    data: {},
    events: [],
  }),

  // Video nodes must never run inline — the dispatcher routes them to Fargate.
  'source.video': async () => {
    throw new InlineVideoError('video node reached the inline runner');
  },
  'processor.decode_sample': async () => {
    throw new InlineVideoError('video node reached the inline runner');
  },
  'processor.object_detection': async () => {
    throw new InlineVideoError('video node reached the inline runner');
  },
};

// --- Graph execution ---------------------------------------------------------

// Kahn topological sort. Returns null on a cycle.
function topoSort(def: WorkflowDefinition): string[] | null {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of def.nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of def.edges) {
    if (!indegree.has(e.target) || !adj.has(e.source)) continue; // dangling edge
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const queue = def.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  return order.length === def.nodes.length ? order : null;
}

// Reachable descendants of a node (to mark them skipped on failure).
function descendants(def: WorkflowDefinition, from: string): Set<string> {
  const out = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of def.edges) {
      if (e.source === id && !out.has(e.target)) {
        out.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return out;
}

function resolveWindow(run: WorkflowRun): { from: string; to: string } {
  const ctx = run.triggerContext as { window?: { from?: string; to?: string } } | null;
  if (ctx?.window?.from && ctx?.window?.to) {
    return { from: ctx.window.from, to: ctx.window.to };
  }
  // Fallback: the 15 minutes ending at run start.
  const to = run.startedAt ?? new Date();
  const from = new Date(to.getTime() - 15 * 60_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

type StepRow = typeof schema.workflowRunSteps.$inferInsert;

/**
 * Execute a telemetry-only run in-process and persist the outcome. Idempotency
 * (skip if already processed) is the dispatcher's responsibility.
 */
export async function runWorkflowInline(run: WorkflowRun): Promise<void> {
  const def = run.definition as WorkflowDefinition;
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const predecessors = new Map<string, string[]>();
  for (const n of def.nodes) predecessors.set(n.id, []);
  for (const e of def.edges) predecessors.get(e.target)?.push(e.source);

  const startMs = Date.now();

  // Fail fast on structural problems, before any step runs.
  const unknown = def.nodes.find((n) => !executors[n.type]);
  if (unknown) {
    return finalizeFailed(run, unknown.id, `Unknown node type "${unknown.type}"`, startMs);
  }
  const order = topoSort(def);
  if (!order) {
    return finalizeFailed(run, null, 'Workflow graph contains a cycle', startMs);
  }
  // Only device-triggered production runs reach this runner (deviceId is
  // nullable since migration 0015 for simulation rows, which never do).
  if (!run.deviceId) {
    return finalizeFailed(run, null, 'Run has no device', startMs);
  }

  const ctx: RunCtx = { deviceId: run.deviceId, window: resolveWindow(run) };
  const results = new Map<string, NodeResult>();
  const steps: StepRow[] = [];
  const events: EventCandidate[] = [];
  let seq = 0;
  let failedNodeId: string | null = null;
  let failedError: string | null = null;

  for (const nodeId of order) {
    const node = nodesById.get(nodeId)!;
    const inputs = (predecessors.get(nodeId) ?? [])
      .map((p) => results.get(p))
      .filter((r): r is NodeResult => !!r);
    const t0 = Date.now();
    try {
      const result = await executors[node.type](node, inputs, ctx);
      results.set(nodeId, result);
      events.push(...result.events);
      steps.push({
        runId: run.id,
        seq: seq++,
        nodeId,
        label: node.data.label,
        status: 'ok',
        output: result.summary,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      failedNodeId = nodeId;
      failedError = err instanceof Error ? err.message : String(err);
      steps.push({
        runId: run.id,
        seq: seq++,
        nodeId,
        label: node.data.label,
        status: 'failed',
        output: failedError,
        durationMs: Date.now() - t0,
      });
      // Mark reachable downstream nodes skipped.
      const skip = descendants(def, nodeId);
      for (const sid of order) {
        if (skip.has(sid)) {
          const sn = nodesById.get(sid)!;
          steps.push({
            runId: run.id,
            seq: seq++,
            nodeId: sid,
            label: sn.data.label,
            status: 'skipped',
            output: '—',
            durationMs: 0,
          });
        }
      }
      break;
    }
  }

  const status = failedNodeId ? 'failed' : 'succeeded';
  const durationMs = Date.now() - startMs;
  const metrics = {
    nodes: def.nodes.length,
    steps: steps.filter((s) => s.status === 'ok').length,
    events: events.length,
  };

  // Persist steps, events, and the final run/attachment state.
  if (steps.length > 0) await db.insert(schema.workflowRunSteps).values(steps);
  if (events.length > 0) {
    await db.insert(schema.workflowEvents).values(
      events.map((e) => ({
        runId: run.id,
        deviceId: run.deviceId,
        kind: e.kind,
        occurredAt: new Date(e.occurredAt),
        confidence: e.confidence,
        payloadSummary: e.payloadSummary,
        payload: e.payload ?? null,
      })),
    );
  }
  await db
    .update(schema.workflowRuns)
    .set({
      status,
      endedAt: new Date(),
      durationMs,
      metrics,
      eventCount: events.length,
      error: failedError,
      failedNodeId,
    })
    .where(eq(schema.workflowRuns.id, run.id));

  await updateAttachmentStatusIfLatest(run, status);
}

async function finalizeFailed(
  run: WorkflowRun,
  failedNodeId: string | null,
  error: string,
  startMs: number,
): Promise<void> {
  await db
    .update(schema.workflowRuns)
    .set({
      status: 'failed',
      endedAt: new Date(),
      durationMs: Date.now() - startMs,
      error,
      failedNodeId,
      eventCount: 0,
    })
    .where(eq(schema.workflowRuns.id, run.id));
  await updateAttachmentStatusIfLatest(run, 'failed');
}

// Update the attachment's denormalized lastRunStatus only if this run is its most
// recent (guards against an older run clobbering a newer one's status). Shared
// with the Fargate finalizer (workflow-run-finalize.ts).
export async function updateAttachmentStatusIfLatest(run: WorkflowRun, status: string): Promise<void> {
  if (!run.attachmentId) return;
  const [latest] = await db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.attachmentId, run.attachmentId))
    .orderBy(sql`${schema.workflowRuns.startedAt} desc`)
    .limit(1);
  if (latest?.id !== run.id) return;
  await db
    .update(schema.workflowAttachments)
    .set({ lastRunStatus: status, updatedAt: new Date() })
    .where(eq(schema.workflowAttachments.id, run.attachmentId));
}

"""Graph execution: Kahn topological sort + executor registry + step timing +
failedNodeId semantics. Mirrors the TypeScript inline runner
(src/services/workflow-runner.ts) so a video graph behaves identically here.

Semantics (must match the TS runner):
  - Kahn topo-sort. A cycle => status "failed", failedNodeId null, no steps.
  - Every node type resolves to an executor (video subset + a telemetry
    pass-through fallback), so a mixed graph never fails on an unknown type.
  - An executor exception => that node's step "failed" (output = message), all
    reachable downstream nodes "skipped" (output "—", 0 ms), status "failed".
  - Each executed node records a step: seq (topo index), nodeId, label, status,
    a short human output, durationMs.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from app.manifest import Definition
from app.nodes import NodeResult, RunContext, merged_upstream
from app.nodes import decode_sample as _decode_sample
from app.nodes import detect as _detect
from app.nodes import events as _events
from app.nodes import logic as _logic


class RunTimeout(Exception):
    """Raised by the watchdog (SIGALRM) when maxRuntimeSeconds is exceeded."""


# --- run state (accumulates the result as the graph executes) ----------------


@dataclass
class RunState:
    steps: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    status: str = "failed"  # pessimistic until execute() sets "succeeded"
    failed_node_id: Optional[str] = None
    failed_error: Optional[str] = None
    current_node_id: Optional[str] = None
    _seq: int = 0

    def add_step(
        self, node_id: str, label: str, status: str, output: str, duration_ms: int
    ) -> None:
        self.steps.append({
            "seq": self._seq,
            "nodeId": node_id,
            "label": label,
            "status": status,
            "output": output,
            "durationMs": duration_ms,
        })
        self._seq += 1

    def has_step(self, node_id: str) -> bool:
        return any(s["nodeId"] == node_id for s in self.steps)


# --- inline stub executors ---------------------------------------------------


def _sensor_fusion(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    # Pass-through: align/forward upstream signals so it can sit mid-graph.
    data = merged_upstream(inputs)
    n = len(inputs)
    return NodeResult(summary=f"aligned {n} stream{'' if n == 1 else 's'}", data=data)


def _output_alert(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    # No-op: alert delivery is a stub (records a step, delivers nothing).
    return NodeResult(summary="alert delivery is a stub (no-op)")


def _telemetry_fallback(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    # Any non-video node type (source.gps, processor.speed_from_gps, ...) is
    # evaluated cloud-side by the TS inline runner, not here. Emit an ok step so
    # a mixed graph never fails in the CV runner.
    return NodeResult(summary="skipped (telemetry, evaluated cloud-side)", data={})


# type -> executor. Any type not listed uses _telemetry_fallback.
EXECUTORS: dict[str, Callable[..., NodeResult]] = {
    "source.video": _decode_sample.source_video,
    "processor.decode_sample": _decode_sample.decode_sample,
    "processor.object_detection": _detect.object_detection,
    "processor.sensor_fusion": _sensor_fusion,
    "logic.threshold": _logic.threshold,
    "logic.composite_rule": _logic.composite_rule,
    "output.event": _events.output_event,
    "output.alert": _output_alert,
}


# --- graph algorithms --------------------------------------------------------


def topo_sort(definition: Definition) -> Optional[list[str]]:
    """Kahn topological sort. Returns None on a cycle."""
    indegree: dict[str, int] = {n.id: 0 for n in definition.nodes}
    adj: dict[str, list[str]] = {n.id: [] for n in definition.nodes}
    for e in definition.edges:
        if e.target not in indegree or e.source not in adj:
            continue  # dangling edge
        indegree[e.target] += 1
        adj[e.source].append(e.target)

    queue = [n.id for n in definition.nodes if indegree[n.id] == 0]
    order: list[str] = []
    while queue:
        nid = queue.pop(0)
        order.append(nid)
        for nxt in adj[nid]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    return order if len(order) == len(definition.nodes) else None


def descendants(definition: Definition, start: str) -> set[str]:
    """All reachable descendants of a node (to mark them skipped on failure)."""
    out: set[str] = set()
    stack = [start]
    while stack:
        nid = stack.pop()
        for e in definition.edges:
            if e.source == nid and e.target not in out:
                out.add(e.target)
                stack.append(e.target)
    return out


# --- execution ---------------------------------------------------------------


def execute(ctx: RunContext, state: RunState) -> None:
    """Run the graph, mutating ``state`` in place. Never raises for a node-level
    failure (those become failed/skipped steps); only RunTimeout propagates, so
    main.py can finalize a timeout uniformly with whatever steps completed."""
    definition = ctx.manifest.definition
    nodes_by_id = {n.id: n for n in definition.nodes}

    predecessors: dict[str, list[str]] = {n.id: [] for n in definition.nodes}
    for e in definition.edges:
        if e.target in predecessors and e.source in nodes_by_id:
            predecessors[e.target].append(e.source)

    order = topo_sort(definition)
    if order is None:
        state.status = "failed"
        state.failed_error = "Workflow graph contains a cycle"
        state.failed_node_id = None
        return

    results: dict[str, NodeResult] = {}
    for node_id in order:
        node = nodes_by_id[node_id]
        state.current_node_id = node_id
        inputs = [results[p] for p in predecessors[node_id] if p in results]
        executor = EXECUTORS.get(node.type, _telemetry_fallback)

        t0 = time.monotonic()
        try:
            result = executor(node, inputs, ctx)
        except RunTimeout:
            raise  # let main.py finalize the timeout
        except Exception as err:  # noqa: BLE001 — node failures are data, not crashes
            dur = int((time.monotonic() - t0) * 1000)
            msg = str(err) or err.__class__.__name__
            state.add_step(node_id, node.label, "failed", msg, dur)
            state.failed_node_id = node_id
            state.failed_error = msg
            state.status = "failed"
            skip = descendants(definition, node_id)
            for sid in order:
                if sid in skip:
                    sn = nodes_by_id[sid]
                    state.add_step(sid, sn.label, "skipped", "—", 0)
            return

        dur = int((time.monotonic() - t0) * 1000)
        results[node_id] = result
        state.events.extend(result.events)
        state.add_step(node_id, node.label, "ok", result.summary, dur)

    state.status = "succeeded"
    state.failed_node_id = None
    state.failed_error = None

"""Shared node primitives: the value passed between executors (``NodeResult``),
the per-run execution context (``RunContext``), and small config/forwarding
helpers. Kept here (the package root) so node modules and graph.py can import
these without a circular dependency — this module imports NO submodules.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:  # avoid importing manifest at module load for the type hints only
    from app.manifest import Manifest, S3Store


@dataclass
class NodeResult:
    """What every executor returns: a human summary, a bag of data forwarded to
    downstream nodes, and any emitted events (only output.event produces these)."""

    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class RunContext:
    """Immutable-ish context handed to every executor. ``metrics`` is a shared
    mutable dict (aliased to RunState.metrics) so executors can accumulate
    framesDecoded / detections / inferenceMsAvg etc. as they run."""

    run_id: str
    manifest: "Manifest"
    s3: "S3Store"
    metrics: dict[str, Any]
    tmp_dir: str


# --- config coercion ---------------------------------------------------------
# Node knobs arrive as untyped JSON (node.data.config). These read a key with a
# typed fallback, tolerating strings ("2" -> 2) the way the TS runner's num() does.


def cfg_num(config: dict[str, Any], key: str, default: float) -> float:
    v = config.get(key)
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return default
    return default


def cfg_str(config: dict[str, Any], key: str, default: str) -> str:
    v = config.get(key)
    return v if isinstance(v, str) and v != "" else default


def cfg_bool(config: dict[str, Any], key: str, default: bool = False) -> bool:
    v = config.get(key)
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("yes", "true", "1", "on")
    if isinstance(v, (int, float)):
        return v != 0
    return default


# --- upstream data forwarding ------------------------------------------------
# The video pipeline threads a handful of keys down the graph (the resolved input
# ref, base-time info, decoded frames, detections, and accumulated logic params).
# Pass-through nodes (sensor_fusion, threshold, composite_rule) forward these so
# they can sit mid-graph without dropping the signal.

_FORWARD_KEYS = ("input", "baseTime", "timebase", "sampleFps", "frames", "detections")


def _is_present(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, (list, dict, str)):
        return len(v) > 0
    return True


def merged_upstream(inputs: list[NodeResult]) -> dict[str, Any]:
    """Union the forwardable keys across inputs (first non-empty wins), and merge
    all upstream ``params`` dicts (later inputs override earlier keys)."""
    out: dict[str, Any] = {}
    for key in _FORWARD_KEYS:
        for inp in inputs:
            v = inp.data.get(key)
            if _is_present(v):
                out[key] = v
                break
    params: dict[str, Any] = {}
    for inp in inputs:
        p = inp.data.get("params")
        if isinstance(p, dict):
            params.update(p)
    if params:
        out["params"] = params
    return out

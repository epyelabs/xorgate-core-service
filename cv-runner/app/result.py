"""Assemble result.json exactly matching the contract the finalize Lambda reads.

    {
      "runId", "status": "succeeded"|"failed", "error", "failedNodeId",
      "steps": [ {seq, nodeId, label, status, output, durationMs} ],
      "events": [ {kind, occurredAt, confidence, payloadSummary, payload, clipKey} ],
      "metrics": {framesDecoded, framesSampled, detections, tracks, inferenceMsAvg, ...}
    }
"""

from __future__ import annotations

from typing import Any

from app.graph import RunState

# Metric keys that must always be present (defaulted to 0), plus any extras the
# executors added are passed through.
_BASE_METRICS = {
    "framesDecoded": 0,
    "framesSampled": 0,
    "detections": 0,
    "tracks": 0,
    "inferenceMsAvg": 0.0,
}


def build_result(run_id: str, state: RunState) -> dict[str, Any]:
    metrics = {**_BASE_METRICS, **(state.metrics or {})}
    return {
        "runId": run_id,
        "status": state.status,
        "error": state.failed_error,
        "failedNodeId": state.failed_node_id,
        "steps": state.steps,
        "events": state.events,
        "metrics": metrics,
    }

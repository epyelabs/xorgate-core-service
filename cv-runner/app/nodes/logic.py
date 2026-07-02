"""logic.threshold, logic.composite_rule, and the dwell/cooldown candidate
selection consumed by output.event.

For video graphs the meaningful thresholding happens in the track/dwell logic
(see select_candidates); the logic nodes here are pragmatic pass-throughs that
forward detections/frames downstream and lift any dwell/cooldown/kind knobs into
the shared ``params`` bag so they reach output.event wherever they're configured.
"""

from __future__ import annotations

from typing import Any

from app.nodes import NodeResult, RunContext, cfg_num, cfg_str, merged_upstream
from app.nodes.track import Track

# Defaults for the event logic (config on the logic OR output node).
DEFAULT_MIN_DWELL_SECONDS = 2.0
DEFAULT_COOLDOWN_SECONDS = 300.0


def _lift_params(config: dict[str, Any]) -> dict[str, Any]:
    """Pull recognized event knobs out of a node's config into params, so they
    survive downstream regardless of which node carries them."""
    params: dict[str, Any] = {}
    if "minDwellSeconds" in config:
        params["minDwellSeconds"] = cfg_num(config, "minDwellSeconds", DEFAULT_MIN_DWELL_SECONDS)
    if "cooldownSeconds" in config:
        params["cooldownSeconds"] = cfg_num(config, "cooldownSeconds", DEFAULT_COOLDOWN_SECONDS)
    if "kind" in config:
        params["kind"] = cfg_str(config, "kind", "")
    return params


def threshold(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    data = merged_upstream(inputs)
    params = {**data.get("params", {}), **_lift_params(node.config)}
    if params:
        data["params"] = params
    det = data.get("detections") or []
    op = cfg_str(node.config, "operator", ">=")
    value = cfg_num(node.config, "value", 0)
    # Generic pass-through: forward the signal with an informational note. The
    # real gating for video is dwell-based, applied later in output.event.
    return NodeResult(
        summary=f"pass-through ({op} {value:g}); {len(det)} detection(s) forwarded",
        data=data,
    )


def composite_rule(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    combine = cfg_str(node.config, "combine", "all")
    # "all" => every input must carry a signal; "any" => forward if any do.
    per_input_has = [bool(i.data.get("detections")) for i in inputs]
    fired = all(per_input_has) if combine == "all" else any(per_input_has)

    data = merged_upstream(inputs)
    params = {**data.get("params", {}), **_lift_params(node.config)}
    if params:
        data["params"] = params
    if not fired:
        data["detections"] = []  # combine failed — suppress the signal
    det = data.get("detections") or []
    return NodeResult(
        summary=f"combine={combine}: {'matched' if fired else 'no match'} ({len(det)} forwarded)",
        data=data,
    )


def select_candidates(
    tracks: list[Track],
    sample_fps: float,
    min_dwell_seconds: float,
    cooldown_seconds: float,
    kind: str,
) -> list[dict[str, Any]]:
    """Emit one candidate per track that dwells >= min_dwell_seconds.

    Distinct tracks are never suppressed against each other (two people => two
    events). The per-kind cooldown only guards the SAME track from re-emitting —
    since our tracker yields one continuous track per subject, that means at most
    one candidate per (kind, trackId), which trivially satisfies the cooldown.
    """
    candidates: list[dict[str, Any]] = []
    last_emit_pts: dict[tuple[str, int], float] = {}
    for t in sorted(tracks, key=lambda t: (t.qualifying_observation(sample_fps, min_dwell_seconds) or (0, 0.0))[1]):
        qual = t.qualifying_observation(sample_fps, min_dwell_seconds)
        if qual is None:
            continue
        _, qpts, qbbox, _ = qual
        key = (kind, t.id)
        prev = last_emit_pts.get(key)
        if prev is not None and (qpts - prev) < cooldown_seconds:
            continue  # same track within cooldown — skip re-emit
        last_emit_pts[key] = qpts
        candidates.append({
            "track": t,
            "qualifyingFrameIdx": qual[0],
            "qualifyingPts": qpts,
            "qualifyingBbox": qbbox,
            "dwellSeconds": round(t.dwell_seconds(sample_fps), 2),
            "peakConf": round(t.peak_conf, 4),
            "meanConf": round(t.mean_conf, 4),
        })
    return candidates

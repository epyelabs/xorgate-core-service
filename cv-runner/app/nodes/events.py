"""output.event — turn tracked/dwelling subjects into event rows.

Orchestrates the tail of the video pipeline: run the greedy tracker over upstream
detections, select dwelling candidates (min-dwell + cooldown), then build event
dicts whose occurredAt = base_time + the track's first-qualifying-frame pts.
Optionally writes an annotated JPEG clip (bbox drawn) per event to S3.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.nodes import NodeResult, RunContext, cfg_bool, cfg_num, cfg_str, merged_upstream
from app.nodes.logic import (
    DEFAULT_COOLDOWN_SECONDS,
    DEFAULT_MIN_DWELL_SECONDS,
    select_candidates,
)
from app.nodes.track import Track, track_detections


def _parse_base(iso: Optional[str]) -> datetime:
    """Parse an ISO8601 base time to an aware UTC datetime; fall back to now."""
    if iso:
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _iso_z(dt: datetime) -> str:
    """Format an aware datetime as ISO8601 UTC with a trailing Z."""
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_clip(
    ctx: RunContext, track: Track, frame, bbox: list[float]
) -> Optional[str]:
    """Draw the bbox on the qualifying frame and PutObject a JPEG. Returns the
    S3 key, or None if clips aren't configured or the frame pixels are gone."""
    prefix = ctx.manifest.output.clip_prefix
    bucket = ctx.manifest.output.bucket
    if not prefix or not bucket or frame is None:
        return None
    import cv2

    annotated = frame.copy()
    x, y, w, h = (int(round(v)) for v in bbox)
    cv2.rectangle(annotated, (x, y), (x + w, y + h), (0, 0, 255), 2)
    label = f"{track.cls} #{track.id}"
    cv2.putText(annotated, label, (x, max(0, y - 6)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", annotated)
    if not ok:
        return None
    key = f"{prefix}track{track.id}.jpg"
    ctx.s3.put_bytes(bucket, key, buf.tobytes(), "image/jpeg")
    return key


def output_event(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    data = merged_upstream(inputs)
    detections = data.get("detections") or []
    frames = data.get("frames") or []
    sample_fps = float(data.get("sampleFps") or ctx.metrics.get("sampleFps") or 2.0)

    # Event knobs: this node's config wins, else an upstream logic node's params,
    # else the defaults.
    params = data.get("params") or {}
    kind = cfg_str(node.config, "kind", "") or params.get("kind") or "person_at_perimeter"
    min_dwell = (
        cfg_num(node.config, "minDwellSeconds", params.get("minDwellSeconds", DEFAULT_MIN_DWELL_SECONDS))
    )
    cooldown = (
        cfg_num(node.config, "cooldownSeconds", params.get("cooldownSeconds", DEFAULT_COOLDOWN_SECONDS))
    )
    want_clip = cfg_bool(node.config, "clip", False)

    base_time = _parse_base(data.get("baseTime"))
    timebase = data.get("timebase") or "wallclock"

    tracks = track_detections(detections, sample_fps)
    ctx.metrics["tracks"] = len(tracks)

    candidates = select_candidates(tracks, sample_fps, min_dwell, cooldown, kind)

    events: list[dict[str, Any]] = []
    for c in candidates:
        track: Track = c["track"]
        occurred_at = _iso_z(base_time + timedelta(seconds=c["qualifyingPts"]))
        bbox = [round(v, 1) for v in c["qualifyingBbox"]]
        dwell = c["dwellSeconds"]

        clip_key: Optional[str] = None
        if want_clip:
            frame = frames[c["qualifyingFrameIdx"]][0] if c["qualifyingFrameIdx"] < len(frames) else None
            clip_key = _write_clip(ctx, track, frame, c["qualifyingBbox"])

        events.append({
            "kind": kind,
            "occurredAt": occurred_at,
            "confidence": c["peakConf"],
            "payloadSummary": f"{track.cls} dwelled {dwell:.1f}s",
            "payload": {
                "bbox": bbox,
                "trackId": track.id,
                "dwellSeconds": dwell,
                "timebase": timebase,
                "class": track.cls,
                "meanConfidence": c["meanConf"],
                "peakConfidence": c["peakConf"],
                "frames": track.dwell_frames,
            },
            "clipKey": clip_key,
        })

    return NodeResult(
        summary=f"emitted {len(events)} event(s) from {len(tracks)} track(s)",
        data={"eventCount": len(events)},
        events=events,
    )

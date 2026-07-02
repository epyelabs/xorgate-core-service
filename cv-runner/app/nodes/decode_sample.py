"""source.video and processor.decode_sample.

source.video resolves the MP4 input for its node, probes it (dimensions + frame
count), works out the event time base, and forwards the reference downstream.

processor.decode_sample downloads the MP4 (if not already local) and streams it
through ffmpeg at a fixed sample rate, yielding (frame_bgr, pts_seconds) pairs.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np

from app.manifest import InputRef
from app.nodes import NodeResult, RunContext, cfg_num


# --- input resolution --------------------------------------------------------


def _resolve_input(node_id: str, ctx: RunContext) -> dict[str, Any]:
    """Pick the MP4 for this node: match manifest.inputs by nodeId, else the
    single input, else synthesize one from triggerContext.s3Key.

    Returns a plain dict (the "input reference") we thread down the graph.
    """
    m = ctx.manifest
    chosen: Optional[InputRef] = None
    if node_id:
        chosen = next((i for i in m.inputs if i.node_id == node_id), None)
    if chosen is None and len(m.inputs) == 1:
        chosen = m.inputs[0]

    if chosen is not None:
        bucket = chosen.s3_bucket or m.output.bucket
        return {
            "bucket": bucket,
            "key": chosen.s3_key,
            "recordingId": chosen.recording_id,
            "recordingStartedAt": chosen.recording_started_at,
            "captureStartedAt": chosen.capture_started_at,
            "streamKey": m.trigger_context.stream_key,
        }

    # Fall back to the trigger context. The core MP4 lives in the same bucket we
    # write results to (media/v1/* and workflows/v1/* share the core bucket).
    tc = m.trigger_context
    if tc.s3_key:
        return {
            "bucket": m.output.bucket,
            "key": tc.s3_key,
            "recordingId": tc.recording_id,
            "recordingStartedAt": tc.recording_started_at,
            "captureStartedAt": tc.capture_started_at,
            "streamKey": tc.stream_key,
        }

    raise ValueError("no video input could be resolved from manifest.inputs or triggerContext")


def _base_time(ref: dict[str, Any]) -> tuple[str, str]:
    """Event base time = captureStartedAt ?? recordingStartedAt ?? now(UTC).

    Returns (iso_base_time, timebase) where timebase is one of
    "capture" | "recording" | "wallclock".
    """
    cap = ref.get("captureStartedAt")
    rec = ref.get("recordingStartedAt")
    if cap:
        return cap, "capture"
    if rec:
        return rec, "recording"
    return datetime.now(timezone.utc).isoformat(), "wallclock"


# --- ffprobe / local file ----------------------------------------------------


def _local_path(ctx: RunContext, ref: dict[str, Any]) -> str:
    key = ref.get("key") or "input.mp4"
    name = os.path.basename(key) or "input.mp4"
    return os.path.join(ctx.tmp_dir, name)


def _ensure_local(ctx: RunContext, ref: dict[str, Any]) -> str:
    """Download the MP4 to /tmp once; reuse if a prior node already fetched it."""
    path = ref.get("localPath")
    if path and os.path.exists(path):
        return path
    if not ref.get("bucket") or not ref.get("key"):
        raise ValueError("input reference is missing an S3 bucket/key")
    dest = _local_path(ctx, ref)
    if not os.path.exists(dest):
        ctx.s3.download_file(ref["bucket"], ref["key"], dest)
    ref["localPath"] = dest
    return dest


def _probe(path: str) -> dict[str, Any]:
    """ffprobe the first video stream for width/height/frame-count/fps."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,duration",
        "-of", "json", path,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    streams = json.loads(out.stdout).get("streams") or []
    if not streams:
        raise ValueError("ffprobe found no video stream")
    s = streams[0]
    width = int(s.get("width") or 0)
    height = int(s.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ValueError("ffprobe returned invalid dimensions")

    # avg_frame_rate is a rational like "30000/1001"; fall back gracefully.
    fps = 0.0
    afr = s.get("avg_frame_rate") or "0/0"
    try:
        n, _, d = afr.partition("/")
        fps = float(n) / float(d) if float(d) else float(n)
    except (ValueError, ZeroDivisionError):
        fps = 0.0

    nb = s.get("nb_frames")
    try:
        frame_count = int(nb) if nb not in (None, "N/A") else 0
    except (TypeError, ValueError):
        frame_count = 0
    if frame_count == 0 and fps > 0:
        try:
            frame_count = int(round(float(s.get("duration") or 0) * fps))
        except (TypeError, ValueError):
            frame_count = 0

    return {"width": width, "height": height, "fps": fps, "frameCount": frame_count}


def _ensure_probed(ctx: RunContext, ref: dict[str, Any]) -> dict[str, Any]:
    """Download + probe if not already carried on the reference."""
    if "width" in ref and "height" in ref:
        return ref
    path = _ensure_local(ctx, ref)
    ref.update(_probe(path))
    return ref


# --- source.video ------------------------------------------------------------


def source_video(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    ref = _resolve_input(node.id, ctx)
    ref = _ensure_probed(ctx, ref)
    base_time, timebase = _base_time(ref)
    w, h, frames = ref["width"], ref["height"], ref.get("frameCount", 0)
    return NodeResult(
        summary=f"{w}x{h}, {frames} frames",
        data={"input": ref, "baseTime": base_time, "timebase": timebase},
    )


# --- processor.decode_sample -------------------------------------------------


def _iter_sampled_frames(path: str, width: int, height: int, fps: float):
    """Stream frames out of ffmpeg at ``fps``, one at a time (never buffers the
    whole decoded video). Each output frame n has pts ~= n / fps seconds.

    Yields (frame_bgr ndarray HxWx3 uint8, pts_seconds).
    """
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", path,
        "-vf", f"fps={fps}",
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-",
    ]
    frame_bytes = width * height * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    idx = 0
    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break  # EOF or a trailing partial frame
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
            yield frame.copy(), idx / fps
            idx += 1
    finally:
        if proc.stdout:
            proc.stdout.close()
        proc.wait()
        if proc.returncode not in (0, None) and idx == 0:
            err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
            raise RuntimeError(f"ffmpeg failed: {err.strip()[:400]}")


# Soft cap on retained sampled frames so a very long recording can't OOM the
# task. Beyond this we keep decoding/detecting but stop holding pixel data (clips
# for late frames are then unavailable). At the default 2 fps this is ~40 min.
_MAX_RETAINED_FRAMES = 5000


def decode_sample(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    from app.nodes import merged_upstream

    up = merged_upstream(inputs)
    ref = up.get("input")
    if not ref:
        # No upstream source.video (unusual): resolve straight from the manifest.
        ref = _resolve_input(node.id, ctx)
    ref = _ensure_probed(ctx, ref)
    path = _ensure_local(ctx, ref)

    fps = max(0.1, cfg_num(node.config, "fps", 2.0))
    width, height = ref["width"], ref["height"]

    frames: list[tuple[Optional[np.ndarray], float]] = []
    for frame, pts in _iter_sampled_frames(path, width, height, fps):
        # Keep pixels while under the cap; past it, keep pts only (frame=None).
        frames.append((frame if len(frames) < _MAX_RETAINED_FRAMES else None, pts))

    ctx.metrics["framesDecoded"] = ref.get("frameCount", 0) or len(frames)
    ctx.metrics["framesSampled"] = len(frames)

    base_time = up.get("baseTime")
    timebase = up.get("timebase")
    if not base_time:
        base_time, timebase = _base_time(ref)

    return NodeResult(
        summary=f"sampled {len(frames)} frames at {fps:g} fps",
        data={
            "input": ref,
            "baseTime": base_time,
            "timebase": timebase,
            "sampleFps": fps,
            "frames": frames,
        },
    )

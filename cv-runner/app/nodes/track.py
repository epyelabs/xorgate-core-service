"""Greedy IoU tracker + per-track dwell.

Deliberately lightweight (no Kalman, no appearance model): match each frame's
detections to the currently-active tracks by IoU >= 0.3, greedily best-first, and
same-class only. Unmatched detections start new tracks with stable integer ids.
A track's dwell is simply the number of frames it was present; dwell seconds =
dwell_frames / sample_fps. Two people => two tracks => two events.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

IOU_MATCH_THRESHOLD = 0.3


def _iou(a: list[float], b: list[float]) -> float:
    """IoU of two [x, y, w, h] boxes."""
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


@dataclass
class Track:
    id: int
    cls: str
    last_frame_idx: int
    last_bbox: list[float]
    # One entry per frame the track was present: (frameIdx, pts, bbox, conf).
    observations: list[tuple[int, float, list[float], float]] = field(default_factory=list)

    @property
    def dwell_frames(self) -> int:
        return len(self.observations)

    def dwell_seconds(self, sample_fps: float) -> float:
        return self.dwell_frames / sample_fps if sample_fps > 0 else 0.0

    @property
    def peak_conf(self) -> float:
        return max((o[3] for o in self.observations), default=0.0)

    @property
    def mean_conf(self) -> float:
        return (sum(o[3] for o in self.observations) / len(self.observations)
                if self.observations else 0.0)

    def qualifying_observation(self, sample_fps: float, min_dwell_seconds: float):
        """The observation at which cumulative dwell first reaches the minimum —
        its pts is the event's occurredAt offset. None if never reached."""
        need = max(1, int(round(min_dwell_seconds * sample_fps)))
        if len(self.observations) < need:
            return None
        return self.observations[need - 1]


def track_detections(
    detections: list[dict[str, Any]],
    sample_fps: float,
    max_gap_frames: int | None = None,
) -> list[Track]:
    """Run the greedy tracker over frame-ordered detections.

    ``max_gap_frames``: retire a track after this many frames without a match
    (defaults to ~1.5s of samples) so distinct people aren't merged across gaps.
    """
    if max_gap_frames is None:
        max_gap_frames = max(2, int(round(sample_fps * 1.5)))

    # Group detections by frame index, in ascending frame order.
    by_frame: dict[int, list[dict[str, Any]]] = {}
    for d in detections:
        by_frame.setdefault(int(d["frameIdx"]), []).append(d)

    active: list[Track] = []
    finished: list[Track] = []
    next_id = 1

    for frame_idx in sorted(by_frame):
        # Retire stale tracks.
        still_active: list[Track] = []
        for t in active:
            if frame_idx - t.last_frame_idx > max_gap_frames:
                finished.append(t)
            else:
                still_active.append(t)
        active = still_active

        dets = by_frame[frame_idx]

        # Build candidate (iou, det_i, track_j) pairs for same-class boxes.
        pairs: list[tuple[float, int, int]] = []
        for di, d in enumerate(dets):
            for tj, t in enumerate(active):
                if t.cls != d["cls"]:
                    continue
                iou = _iou(d["bbox"], t.last_bbox)
                if iou >= IOU_MATCH_THRESHOLD:
                    pairs.append((iou, di, tj))
        pairs.sort(reverse=True)  # best IoU first

        det_taken = [False] * len(dets)
        trk_taken = [False] * len(active)
        for iou, di, tj in pairs:
            if det_taken[di] or trk_taken[tj]:
                continue
            det_taken[di] = trk_taken[tj] = True
            d = dets[di]
            t = active[tj]
            t.last_frame_idx = frame_idx
            t.last_bbox = d["bbox"]
            t.observations.append((frame_idx, float(d["pts"]), d["bbox"], float(d["conf"])))

        # Unmatched detections seed new tracks.
        for di, d in enumerate(dets):
            if det_taken[di]:
                continue
            t = Track(id=next_id, cls=d["cls"], last_frame_idx=frame_idx, last_bbox=d["bbox"])
            t.observations.append((frame_idx, float(d["pts"]), d["bbox"], float(d["conf"])))
            active.append(t)
            next_id += 1

    finished.extend(active)
    finished.sort(key=lambda t: t.id)
    return finished

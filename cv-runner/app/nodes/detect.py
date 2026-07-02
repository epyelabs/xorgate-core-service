"""processor.object_detection — YOLOv8n (ONNX, CPU) over the sampled frames.

Letterboxes each frame to 640x640, runs a single ONNX Runtime CPU session, does
per-class NMS, and keeps person/vehicle detections above a confidence floor.
Output per frame: {frameIdx, pts, bbox[x,y,w,h], cls, conf} in ORIGINAL pixels.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import numpy as np
import onnxruntime as ort

from app.nodes import NodeResult, RunContext, cfg_num, merged_upstream


# The model is baked into the image at build time (see README / Dockerfile).
# config.model may say "yolo-n" / "yolo-s" / "rtdetr", but v1 ALWAYS uses this
# baked yolov8n.onnx regardless — the knob is recorded, not honored.
MODEL_PATH = "/app/models/yolov8n.onnx"

# COCO class ids we care about, mapped to the platform's two labels.
_PERSON = {0}
_VEHICLE = {1, 2, 3, 5, 7}  # bicycle, car, motorcycle, bus, truck
_LABELS = {**{c: "person" for c in _PERSON}, **{c: "vehicle" for c in _VEHICLE}}

_INPUT_SIZE = 640
_NMS_IOU = 0.45

# Lazily-created singleton session (loading the model per frame would be absurd).
_session: Optional[ort.InferenceSession] = None
_input_name: Optional[str] = None


def _get_session() -> tuple[ort.InferenceSession, str]:
    global _session, _input_name
    if _session is None:
        if not os.path.exists(MODEL_PATH):
            raise FileNotFoundError(
                f"model not found at {MODEL_PATH}. The image must be built with "
                f"models/yolov8n.onnx baked in — see cv-runner/README.md for how "
                f"to export/download it before `docker build`."
            )
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("OMP_NUM_THREADS", "2"))
        _session = ort.InferenceSession(
            MODEL_PATH, sess_options=so, providers=["CPUExecutionProvider"]
        )
        _input_name = _session.get_inputs()[0].name
    return _session, _input_name  # type: ignore[return-value]


def _letterbox(frame: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    """Resize keeping aspect ratio onto a 640x640 gray (114) canvas.

    Returns (canvas_rgb_float_NCHW, scale, pad_x, pad_y).
    """
    import cv2

    h, w = frame.shape[:2]
    scale = min(_INPUT_SIZE / w, _INPUT_SIZE / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)

    canvas = np.full((_INPUT_SIZE, _INPUT_SIZE, 3), 114, dtype=np.uint8)
    pad_x = (_INPUT_SIZE - nw) // 2
    pad_y = (_INPUT_SIZE - nh) // 2
    canvas[pad_y : pad_y + nh, pad_x : pad_x + nw] = resized

    # BGR -> RGB, HWC -> CHW, /255, add batch dim.
    rgb = canvas[:, :, ::-1].astype(np.float32) / 255.0
    blob = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None, ...])
    return blob, scale, float(pad_x), float(pad_y)


def _iou_matrix(boxes: np.ndarray) -> np.ndarray:
    """Pairwise IoU for boxes in [x, y, w, h]."""
    x1, y1 = boxes[:, 0], boxes[:, 1]
    x2, y2 = boxes[:, 0] + boxes[:, 2], boxes[:, 1] + boxes[:, 3]
    area = boxes[:, 2] * boxes[:, 3]
    ix1 = np.maximum(x1[:, None], x1[None, :])
    iy1 = np.maximum(y1[:, None], y1[None, :])
    ix2 = np.minimum(x2[:, None], x2[None, :])
    iy2 = np.minimum(y2[:, None], y2[None, :])
    iw = np.clip(ix2 - ix1, 0, None)
    ih = np.clip(iy2 - iy1, 0, None)
    inter = iw * ih
    union = area[:, None] + area[None, :] - inter
    return np.where(union > 0, inter / union, 0.0)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    """Greedy NMS; returns kept indices (highest score first)."""
    if len(boxes) == 0:
        return []
    order = scores.argsort()[::-1]
    ious = _iou_matrix(boxes)
    keep: list[int] = []
    suppressed = np.zeros(len(boxes), dtype=bool)
    for i in order:
        if suppressed[i]:
            continue
        keep.append(int(i))
        suppressed |= ious[i] > iou_thr
        suppressed[i] = True
    return keep


def _postprocess(
    output: np.ndarray, scale: float, pad_x: float, pad_y: float,
    orig_w: int, orig_h: int, min_conf: float,
) -> list[dict[str, Any]]:
    """YOLOv8 head: output (1, 84, 8400) -> (8400, 84) = [cx,cy,w,h, 80 class probs]."""
    preds = output[0].T  # (N, 84)
    boxes_cxcywh = preds[:, :4]
    class_scores = preds[:, 4:]
    class_ids = class_scores.argmax(axis=1)
    confs = class_scores.max(axis=1)

    wanted = np.array([cid in _LABELS for cid in class_ids])
    keep = wanted & (confs >= min_conf)
    if not keep.any():
        return []

    boxes_cxcywh = boxes_cxcywh[keep]
    class_ids = class_ids[keep]
    confs = confs[keep]

    # cxcywh (letterboxed 640 space) -> xywh in original pixels.
    cx, cy, bw, bh = boxes_cxcywh.T
    x = (cx - bw / 2 - pad_x) / scale
    y = (cy - bh / 2 - pad_y) / scale
    w = bw / scale
    h = bh / scale
    x = np.clip(x, 0, orig_w - 1)
    y = np.clip(y, 0, orig_h - 1)
    w = np.clip(w, 1, orig_w - x)
    h = np.clip(h, 1, orig_h - y)
    boxes = np.stack([x, y, w, h], axis=1)

    dets: list[dict[str, Any]] = []
    for cid in np.unique(class_ids):
        m = class_ids == cid
        idxs = _nms(boxes[m], confs[m], _NMS_IOU)
        cls_boxes = boxes[m]
        cls_confs = confs[m]
        for i in idxs:
            b = cls_boxes[i]
            dets.append({
                "bbox": [float(b[0]), float(b[1]), float(b[2]), float(b[3])],
                "cls": _LABELS[int(cid)],
                "conf": float(cls_confs[i]),
            })
    return dets


def object_detection(node, inputs: list[NodeResult], ctx: RunContext) -> NodeResult:
    up = merged_upstream(inputs)
    frames = up.get("frames") or []
    min_conf = max(0.0, min(1.0, cfg_num(node.config, "minConfidence", 0.4)))

    session, input_name = _get_session()

    detections: list[dict[str, Any]] = []
    total_infer_ms = 0.0
    inferred = 0
    for idx, (frame, pts) in enumerate(frames):
        if frame is None:
            continue  # pixels dropped past the retention cap — can't detect
        h, w = frame.shape[:2]
        blob, scale, pad_x, pad_y = _letterbox(frame)
        t0 = time.perf_counter()
        out = session.run(None, {input_name: blob})[0]
        total_infer_ms += (time.perf_counter() - t0) * 1000.0
        inferred += 1
        for d in _postprocess(out, scale, pad_x, pad_y, w, h, min_conf):
            detections.append({
                "frameIdx": idx,
                "pts": pts,
                "bbox": d["bbox"],
                "cls": d["cls"],
                "conf": d["conf"],
            })

    avg_ms = round(total_infer_ms / inferred, 2) if inferred else 0.0
    ctx.metrics["detections"] = ctx.metrics.get("detections", 0) + len(detections)
    ctx.metrics["inferenceMsAvg"] = avg_ms

    out_data = dict(up)
    out_data["detections"] = detections
    return NodeResult(
        summary=f"{len(detections)} detections over {inferred} frames",
        data=out_data,
    )

"""Export a YOLO detection or segmentation model to the S3 model registry layout.

Produces, under --out/<family>/<name>/<version>/:
  model.onnx                exported with ultralytics (opset 12, static 640x640)
  manifest.json             the registry manifest (src/workflows/models/registry.ts)
  fixtures/fixture_0.png    deterministic synthetic parity image
  fixtures/expected_0.json  raw-output stats (+ top head rows) for engine CI

Segmentation names (yolov8n-seg) publish under family "segmentation" with
postprocess kind "yolov8-seg" (detection head + prototype masks; the TS
decoder is src/workflows/engine/vision.ts postprocessYoloV8Seg).

Upload with `aws s3 cp --recursive` (see README.md). Versions are immutable:
bump --version instead of overwriting.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

INPUT_SIZE = 640
NMS_IOU = 0.45

# ultralytics model ids for the pinned registry names.
ULTRALYTICS_IDS = {
    "yolov8n": "yolov8n.pt",
    "yolov8s": "yolov8s.pt",
    "yolov8n-seg": "yolov8n-seg.pt",
    "rtdetr": "rtdetr-l.pt",
}


def family_for(name: str) -> str:
    return "segmentation" if name.endswith("-seg") else "detection"


def postprocess_for(name: str) -> dict:
    if name.endswith("-seg"):
        return {"kind": "yolov8-seg", "nmsIouThreshold": NMS_IOU, "maskThreshold": 0.5}
    if name == "rtdetr":
        return {"kind": "rtdetr", "nmsIouThreshold": NMS_IOU}
    return {"kind": "yolov8", "nmsIouThreshold": NMS_IOU}


def build_manifest(name: str, version: int, class_names: list[str]) -> dict:
    """Mirror of modelManifestSchema in src/workflows/models/registry.ts."""
    return {
        "manifestVersion": 1,
        "family": family_for(name),
        "name": name,
        "version": version,
        "label": name,
        "backend": "cpu-onnx",
        "input": {
            "width": INPUT_SIZE,
            "height": INPUT_SIZE,
            "layout": "nchw",
            "colorSpace": "rgb",
            "normalize": {"scale": 1.0 / 255.0},
            "letterbox": {"enabled": True, "padValue": 114},
        },
        "classNames": class_names,
        "postprocess": postprocess_for(name),
        "quantization": "fp32",
    }


def synthetic_fixture(width: int = 640, height: int = 480) -> np.ndarray:
    """Deterministic RGB test card: gradient background + solid shapes."""
    rng = np.random.default_rng(1234)
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[..., 0] = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
    img[..., 1] = np.linspace(0, 255, height, dtype=np.uint8)[:, None]
    img[..., 2] = 96
    img[80:300, 100:220] = (200, 40, 40)
    img[200:420, 380:560] = (40, 160, 220)
    img += rng.integers(0, 8, img.shape, dtype=np.uint8)
    return img


def letterbox(img: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    from PIL import Image

    h, w = img.shape[:2]
    scale = min(INPUT_SIZE / w, INPUT_SIZE / h)
    nw, nh = round(w * scale), round(h * scale)
    resized = np.asarray(Image.fromarray(img).resize((nw, nh), Image.BILINEAR))
    canvas = np.full((INPUT_SIZE, INPUT_SIZE, 3), 114, dtype=np.uint8)
    pad_x, pad_y = (INPUT_SIZE - nw) // 2, (INPUT_SIZE - nh) // 2
    canvas[pad_y : pad_y + nh, pad_x : pad_x + nw] = resized
    blob = (canvas.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
    return blob, scale, float(pad_x), float(pad_y)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", choices=sorted(ULTRALYTICS_IDS), default="yolov8n")
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--out", type=Path, default=Path("out"))
    args = parser.parse_args()

    from ultralytics import YOLO  # heavy import, keep local

    dest = args.out / family_for(args.name) / args.name / str(args.version)
    fixtures = dest / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)

    model = YOLO(ULTRALYTICS_IDS[args.name])
    class_names = [model.names[i] for i in sorted(model.names)]
    onnx_path = model.export(format="onnx", imgsz=INPUT_SIZE, opset=12, simplify=True)
    Path(onnx_path).replace(dest / "model.onnx")

    manifest = build_manifest(args.name, args.version, class_names)
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # Parity fixture: run the exported ONNX exactly as the manifest describes.
    import onnxruntime as ort
    from PIL import Image

    img = synthetic_fixture()
    Image.fromarray(img).save(fixtures / "fixture_0.png")
    blob, scale, pad_x, pad_y = letterbox(img)
    session = ort.InferenceSession(str(dest / "model.onnx"), providers=["CPUExecutionProvider"])
    outputs = session.run(None, {session.get_inputs()[0].name: blob})
    # Detection exports one output; -seg exports the head + prototype masks.
    head = next(o for o in outputs if o.ndim == 3)

    n_classes = len(class_names)
    preds = head[0].T  # (N, 4 + classes [+ mask coeffs])
    confs = preds[:, 4 : 4 + n_classes].max(axis=1)
    top = preds[confs.argsort()[::-1][:10]]
    expected = {
        "input": {"scale": scale, "padX": pad_x, "padY": pad_y},
        "outputShape": list(head.shape),
        "outputStats": {
            "mean": float(head.mean()),
            "max": float(head.max()),
            "maxClassScore": float(confs.max()),
        },
        # Raw top rows (letterboxed pixels) so the TS decode can be asserted
        # end to end without re-running inference in CI.
        "topRows": [[float(v) for v in row] for row in top],
    }
    proto = next((o for o in outputs if o.ndim == 4), None)
    if proto is not None:
        expected["protoShape"] = list(proto.shape)
        expected["protoStats"] = {"mean": float(proto.mean()), "max": float(proto.max())}
    (fixtures / "expected_0.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"exported {args.name} v{args.version} -> {dest}")


if __name__ == "__main__":
    main()

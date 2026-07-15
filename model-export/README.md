# Model export pipeline (skeleton)

The only first-party Python outside GPU serving containers (open_questions.md Q1).
This directory converts models to ONNX, emits the registry manifest that drives the
TS engine's pre/post-processing, generates parity fixtures, and (manually for now)
publishes to the S3 model registry:

```
s3://<core-bucket>/models/<family>/<name>/<version>/model.onnx
s3://<core-bucket>/models/<family>/<name>/<version>/manifest.json
```

The manifest schema is authoritative in
`src/workflows/models/registry.ts` (zod). Registry names are pinned to the catalog
defaults: `yolov8n` (default), `yolov8s`, `rtdetr` for family `detection`, and
`depth-anything-v2-small` for family `depth` (M4). The TS engine implements the
`yolov8` post-processing head today; `rtdetr` manifests can be published but will be
refused by the executor until its decoder lands.

## Usage

```
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Export yolov8n at registry version 1 into ./out/detection/yolov8n/1/
python export_yolo.py --name yolov8n --version 1 --out ./out

# Publish (dev bucket example)
aws s3 cp --recursive ./out/detection/yolov8n/1/ \
  s3://<core-bucket>/models/detection/yolov8n/1/
```

## Parity fixtures

`export_yolo.py` renders a deterministic synthetic fixture image, runs the exported
ONNX over it with the SAME letterbox/normalize parameters the manifest declares, and
writes `fixtures/fixture_0.png` + `fixtures/expected_0.json` (raw head output stats
plus decoded detections). Engine CI (a later milestone) loads the fixture through
`src/workflows/engine/vision.ts` and asserts the TS pre/post-processing matches
these expectations per model version. Fixtures ship next to the model under the
version prefix; they are small and immutable.

## CI intent

This is a skeleton: run it by hand when publishing a model. The intended CI shape is
a manual-trigger job (model name + version as inputs) that runs the export, uploads
to the registry prefix, and fails if the version already exists (versions are
immutable; publish a new version instead).

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
defaults: `yolov8n` (default), `yolov8s`, `rtdetr` for family `detection`,
`yolov8n-seg` for family `segmentation`, and `depth-anything-v2-small` for family
`depth`. The TS engine implements the `yolov8`, `yolov8-seg`, and `depth-anything`
post-processing today; `rtdetr` manifests can be published but will be refused by
the executor until its decoder lands.

## Usage

```
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Export yolov8n at registry version 1 into ./out/detection/yolov8n/1/
python export_yolo.py --name yolov8n --version 1 --out ./out

# Instance segmentation (family segmentation, postprocess yolov8-seg)
python export_yolo.py --name yolov8n-seg --version 1 --out ./out

# Depth Anything V2 Small (family depth, HF checkpoint via torch.onnx)
python export_depth.py --version 1 --out ./out

# Publish (dev bucket example)
aws s3 cp --recursive ./out/detection/yolov8n/1/ \
  s3://<core-bucket>/models/detection/yolov8n/1/
aws s3 cp --recursive ./out/segmentation/yolov8n-seg/1/ \
  s3://<core-bucket>/models/segmentation/yolov8n-seg/1/
aws s3 cp --recursive ./out/depth/depth-anything-v2-small/1/ \
  s3://<core-bucket>/models/depth/depth-anything-v2-small/1/
```

Metric depth (engine 0.4.0+, postprocess `depth-anything-metric`, output in
metres): export with the engine repo's tool, which also writes the manifest's
`files` checksum block, then publish the same way. Needs a service on engine
0.4.0 or later: older services skip the manifest (unknown postprocess kind).

```bash
# in engines/xorgate-workflow-engine/tools/export
python export_depth.py --variant metric-outdoor --version 1 --out ./out
aws s3 cp --recursive ./out/depth/depth-anything-v2-metric-outdoor-small/1/ \
  s3://<core-bucket>/models/depth/depth-anything-v2-metric-outdoor-small/1/
```

Published to dev on 2026-09-26; prod is pending the engine 0.4.0 rollout.

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

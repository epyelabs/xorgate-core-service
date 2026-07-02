# cv-runner — Xorgate CV workflow runner (Fargate, ARM64)

A self-contained Python container that executes a **video** workflow graph over a
recorded MP4. It reads a manifest from S3, runs object detection + tracking, and
**always** writes a `result.json` back to S3 — even on exception or timeout — so a
run never strands as `running`. The finalize Lambda ingests `result.json` and
does all the SQL. **Python never touches the database and holds no API creds.**

This mirrors the TypeScript inline runner (`src/services/workflow-runner.ts`):
same Kahn topo-sort, same step/`failedNodeId` semantics, same event shape. The
dispatcher routes graphs containing `source.video` / `processor.decode_sample` /
`processor.object_detection` here instead of running them inline.

## Contracts

**Input** — `s3://$MANIFEST_BUCKET/$MANIFEST_KEY` (a `manifest.json`). Env the task
receives: `RUN_ID`, `MANIFEST_BUCKET`, `MANIFEST_KEY`, `AWS_REGION`.

**Output** — `result.json` uploaded to `manifest.output.bucket` /
`manifest.output.resultKey`. Written on every exit path. If the manifest itself
can't be read, the runner falls back to `<MANIFEST_KEY dir>/result.json` in
`MANIFEST_BUCKET` so a result still lands.

The task role grants: `s3:GetObject` on `media/v1/*` + `workflows/v1/*`, and
`s3:PutObject` on `workflows/v1/*` (result + clip JPEGs).

## Layout

```
cv-runner/
  Dockerfile            # python:3.12-slim, ARM64, apt ffmpeg, pip deps, COPY app + models
  requirements.txt      # onnxruntime, numpy, boto3, opencv-python-headless (pinned)
  app/
    main.py             # env -> manifest -> run graph -> ALWAYS upload result.json
    manifest.py         # manifest dataclasses + S3 helpers
    graph.py            # topo sort + executor registry + step timing + failedNodeId
    result.py           # assemble result.json
    nodes/
      __init__.py       # NodeResult / RunContext + config + forwarding helpers
      decode_sample.py  # source.video + processor.decode_sample (ffmpeg fps sampling)
      detect.py         # processor.object_detection (yolov8n.onnx, ORT CPU)
      track.py          # greedy IoU tracker + per-track dwell
      logic.py          # logic.threshold / composite_rule + min-dwell/cooldown selection
      events.py         # output.event: occurredAt = base + pts, payload, optional clip
  models/
    .gitkeep            # models/yolov8n.onnx (~12 MB) is baked at build time, NOT committed
```

## 1. Get the model into `models/yolov8n.onnx`

The model is **not committed** (it's ~12 MB binary). Export or download it into
`cv-runner/models/yolov8n.onnx` before building — the Dockerfile bakes it in and
`detect.py` fails with a clear error if it's missing at runtime.

Option A — export from Ultralytics (recommended, pins the head layout this code expects):

```sh
cd cv-runner
python -m venv .export-venv && . .export-venv/bin/activate
pip install ultralytics
# downloads yolov8n.pt, exports ONNX at 640x640 -> yolov8n.onnx
yolo export model=yolov8n.pt format=onnx imgsz=640 opset=12
mv yolov8n.onnx models/yolov8n.onnx
deactivate && rm -rf .export-venv yolov8n.pt
```

Option B — direct download of a prebuilt ONNX (if you already host one):

```sh
cd cv-runner
curl -L -o models/yolov8n.onnx \
  https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.onnx
# (or your own release/S3 URL for a vetted yolov8n.onnx exported at imgsz=640)
```

The runner expects the standard YOLOv8 detection head: input `1x3x640x640`,
output `1x84x8400` (4 box coords + 80 COCO class scores). It keeps COCO `person`
and vehicle classes (`bicycle`/`car`/`motorcycle`/`bus`/`truck`). `config.model`
values like `yolo-n` / `yolo-s` / `rtdetr` are recorded but always resolve to this
baked `yolov8n.onnx` in v1.

## 2. Build the image (ARM64 / Graviton)

Fargate runs this task on ARM64, so build for `linux/arm64` even from an x86 host
(uses QEMU under `buildx`):

```sh
cd cv-runner
docker buildx build --platform linux/arm64 -t xorgate-cv-runner:latest --load .
```

## 3. Tag + push to ECR

Same out-of-band flow as the recorder image (`cdk deploy` only references the ECR
repo, it does not build). The repo is `xorgate-cv-runner[-dev]`. Replace `<acct>`
and the region as needed (recorder uses `us-east-1`).

```sh
AWS_REGION=us-east-1
ACCT=<acct>
REPO=xorgate-cv-runner-dev      # or xorgate-cv-runner for prod
ECR=$ACCT.dkr.ecr.$AWS_REGION.amazonaws.com

aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ECR

# one-time: create the repo if it doesn't exist yet
aws ecr describe-repositories --repository-names $REPO --region $AWS_REGION >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name $REPO --region $AWS_REGION

docker buildx build --platform linux/arm64 \
  -t $ECR/$REPO:latest --push .
```

If you built locally with `--load` first, you can instead tag + push that image:

```sh
docker tag xorgate-cv-runner:latest $ECR/$REPO:latest
docker push $ECR/$REPO:latest
```

Pushing the image and running/stopping tasks need ECR + ECS + `iam:PassRole`
permissions the base deploy user does not have; grant them separately (same note
as the recorder).

## Node executors (video subset)

| Node type | Behavior |
|-----------|----------|
| `source.video` | Resolve the MP4 from `manifest.inputs` (by nodeId, else the single input, else `triggerContext.s3Key`); probe dimensions/frame count; compute the event time base; forward the reference. |
| `processor.decode_sample` | Download MP4 to `/tmp`; ffmpeg `-vf fps=<config.fps default 2>` streaming `rawvideo bgr24`; collect `(frame, pts)` pairs (pts = n/fps). |
| `processor.object_detection` | ORT CPU over `yolov8n.onnx`; letterbox 640; NMS; keep person/vehicle above `config.minConfidence` (default 0.4). |
| `processor.sensor_fusion` | Pass-through (forwards upstream signal). |
| `logic.threshold` | Pass-through with a note (video gating is dwell-based). |
| `logic.composite_rule` | Combine upstream signals `all`/`any` (forwards). |
| `output.event` | Greedy IoU tracker (IoU ≥ 0.3) + per-track dwell; emit one event per track dwelling ≥ `minDwellSeconds` (default 2.0s) with per-kind `cooldownSeconds` (default 300). `occurredAt` = base + qualifying-frame pts; optional annotated JPEG clip when `config.clip` is truthy. Two people → two tracks → two events. |
| `output.alert` | No-op stub. |
| any other type (telemetry: `source.gps`, `processor.speed_from_gps`, …) | Records an `ok` step "skipped (telemetry, evaluated cloud-side)" so a mixed graph never fails here. |

`occurredAt` base = `captureStartedAt ?? recordingStartedAt ?? now`, with a
`timebase` (`capture`/`recording`/`wallclock`) in each event payload.

## Local smoke test (optional)

You need the model in `models/`, `ffmpeg` on PATH, the pip deps installed, AWS
creds that can read the manifest/MP4 and write the result, and a real manifest in
S3:

```sh
cd cv-runner
pip install -r requirements.txt
RUN_ID=<uuid> AWS_REGION=us-east-1 \
MANIFEST_BUCKET=<core-bucket> MANIFEST_KEY=workflows/v1/runs/<runId>/manifest.json \
  python -m app.main
```

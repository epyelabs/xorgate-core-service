# Xorgate CV runner — a Fargate task (ARM64/Graviton) that runs a workflow graph
# over a recorded MP4 and writes result.json back to S3.
#
# Build for ARM64 explicitly (Fargate runtimePlatform = ARM64). ffmpeg/ffprobe
# come from apt; the ONNX model is baked in from ./models (see README).
FROM --platform=linux/arm64 python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # onnxruntime is CPU-only here; keep it to the vCPUs the task is sized for.
    OMP_NUM_THREADS=2

# ffmpeg brings both `ffmpeg` (decode/sample) and `ffprobe` (dimensions/frames).
# opencv-python-headless needs no system GL, so no extra libs are required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code and the baked model (models/yolov8n.onnx — NOT committed; see README).
COPY app/ /app/app/
COPY models/ /app/models/

# main.py ALWAYS writes result.json and exits 0, so a failed run never strands
# as "running". Do not add a HEALTHCHECK — this is a batch task, not a service.
CMD ["python", "-m", "app.main"]

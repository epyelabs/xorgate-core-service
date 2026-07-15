# Xorgate v2 engine runner — a Fargate task (ARM64/Graviton) that runs a
# workflow graph (the TS streaming engine, src/workflows/engine/) over S3-bound
# media and writes result.json back to S3. Replaces the Python cv-runner at the
# M6 cutover.
#
# The app is TypeScript compiled from the service's src/ tree, so BUILD FROM THE
# SERVICE ROOT (the docker context must include src/):
#
#   docker build --platform linux/arm64 -f engine-runner/Dockerfile .
#
# ffmpeg comes from apt (the executors spawn `ffmpeg`; FFMPEG_PATH is only for
# dev machines). onnxruntime-node installs its prebuilt linux/arm64 binding via
# npm. No model is baked in: models resolve from the S3 registry at run time.
FROM --platform=linux/arm64 node:20-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY engine-runner/tsconfig.json engine-runner/main.ts ./engine-runner/
RUN npx tsc -p engine-runner/tsconfig.json

FROM --platform=linux/arm64 node:20-slim

ENV NODE_ENV=production \
    # onnxruntime is CPU-only here; keep it to the vCPUs the task is sized for.
    OMP_NUM_THREADS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist/runner ./dist

# main.ts ALWAYS writes result.json and exits 0 on run failure (only a failed
# result upload is nonzero), so a failed run never strands as "running". Do not
# add a HEALTHCHECK — this is a batch task, not a service.
CMD ["node", "dist/engine-runner/main.js"]

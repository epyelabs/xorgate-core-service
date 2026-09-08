# Xorgate v2 engine runner — a Fargate task (ARM64/Graviton) that runs a
# workflow graph (@xorgate/workflow-engine over the platform cloud host) over S3-bound
# media and writes result.json back to S3. Replaces the Python cv-runner at the
# M6 cutover.
#
# The app is TypeScript compiled from the service's src/ tree, so BUILD FROM THE
# SERVICE ROOT (the docker context must include src/):
#
#   docker build --platform linux/arm64 -f engine-runner/Dockerfile .
#
# ffmpeg and python3 come from apt (the executors spawn `ffmpeg`; FFMPEG_PATH
# is only for dev machines; function.python nodes spawn `python3` from PATH).
# onnxruntime-node arrives as @xorgate/workflow-engine's optional dependency
# with its prebuilt linux/arm64 binding. No model is baked in: models resolve
# from the S3 registry at run time.
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
    && apt-get install -y --no-install-recommends ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# After the install, drop the ONNX Runtime bindings for the other platforms
# (darwin, win32) and the other Linux architecture; the binding that stays is
# the one `node -p process.arch` names. The x64 binding also ships the CUDA
# and TensorRT execution providers (loaded only when a session asks for
# them); this image is CPU-only, so they go too. Same trim as the engine
# package's own image; a build without the optional dependency has no bin/
# directory and skips it.
RUN npm ci --omit=dev && npm cache clean --force \
    && ORT_BIN=node_modules/onnxruntime-node/bin/napi-v6 \
    && if [ -d "$ORT_BIN" ]; then \
         ARCH="$(node -p 'process.arch')" \
         && find "$ORT_BIN" -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} + \
         && find "$ORT_BIN/linux" -mindepth 1 -maxdepth 1 -type d ! -name "$ARCH" -exec rm -rf {} + \
         && find "$ORT_BIN/linux" -type f \( -name 'libonnxruntime_providers_cuda*' -o -name 'libonnxruntime_providers_tensorrt*' \) -delete \
         && echo "onnxruntime-node binding kept:" && du -sh "$ORT_BIN"/*/* ; \
       fi
COPY --from=build /build/dist/runner ./dist

# main.ts ALWAYS writes result.json and exits 0 on run failure (only a failed
# result upload is nonzero), so a failed run never strands as "running". Do not
# add a HEALTHCHECK — this is a batch task, not a service.
CMD ["node", "dist/engine-runner/main.js"]

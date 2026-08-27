#!/usr/bin/env bash
# Fetch the static linux-arm64 ffmpeg binary the MediaThumbnailFn Lambda layer
# ships (lambda-layers/ffmpeg/bin/ffmpeg -> /opt/bin/ffmpeg at runtime).
#
# The binary is ~50 MB so it is NOT checked in; `cdk synth` fails with a
# pointer here when it is missing. Source is the same project as the
# `ffmpeg-static` devDependency (its GitHub release artifacts), pinned by
# release tag AND sha256 so a moved artifact fails loudly instead of shipping
# something unexpected into the layer.
set -euo pipefail

RELEASE="b6.0"
URL="https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-linux-arm64"
SHA256="237800b37bb65a81ad47871c6c8b7c45c0a3ca62a5b3f9d2a7a9a2dd9a338271"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${DIR}/lambda-layers/ffmpeg/bin/ffmpeg"

if [ -f "${OUT}" ] && echo "${SHA256}  ${OUT}" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "ffmpeg layer binary already present and verified: ${OUT}"
  exit 0
fi

mkdir -p "$(dirname "${OUT}")"
echo "Downloading ffmpeg ${RELEASE} (linux-arm64)..."
curl -sL --fail -o "${OUT}" "${URL}"
echo "${SHA256}  ${OUT}" | shasum -a 256 -c -
chmod +x "${OUT}"
echo "OK: ${OUT}"

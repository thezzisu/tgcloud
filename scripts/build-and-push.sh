#!/usr/bin/env bash
# Build and push tgcloud multi-arch images to the configured registry.
# Usage:
#   ./scripts/build-and-push.sh              # build + push, tag=latest
#   TGCLOUD_VERSION=v1.0.0 ./scripts/build-and-push.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${TGCLOUD_IMAGE_PREFIX:-git.pku.edu.cn/thezzisu}"
TAG="${TGCLOUD_VERSION:-latest}"
PLATFORMS="${TGCLOUD_PLATFORMS:-linux/amd64,linux/arm64}"

PANEL_IMAGE="${PREFIX}/tgcloud-panel:${TAG}"
WECHAT_IMAGE="${PREFIX}/tgcloud-wechat:${TAG}"

echo "==> Building tgcloud-panel (${PLATFORMS}) → ${PANEL_IMAGE}"
docker buildx build \
  --platform "${PLATFORMS}" \
  --tag "${PANEL_IMAGE}" \
  --file "${ROOT}/images/panel/Dockerfile" \
  --push \
  "${ROOT}"

echo "==> Building tgcloud-wechat (${PLATFORMS}) → ${WECHAT_IMAGE}"
docker buildx build \
  --platform "${PLATFORMS}" \
  --tag "${WECHAT_IMAGE}" \
  --file "${ROOT}/images/wechat/Dockerfile" \
  --push \
  "${ROOT}"

echo
echo "Done. Images pushed:"
echo "  ${PANEL_IMAGE}"
echo "  ${WECHAT_IMAGE}"

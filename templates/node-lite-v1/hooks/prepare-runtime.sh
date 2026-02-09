#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PAAS_TEMPLATE_ID:-}" || -z "${PAAS_TEMPLATE_DIR:-}" ]]; then
  echo "PAAS_TEMPLATE_ID and PAAS_TEMPLATE_DIR are required" >&2
  exit 1
fi
if [[ -z "${PAAS_SHARED_DIR:-}" || -z "${PAAS_ROOT:-}" ]]; then
  echo "PAAS_SHARED_DIR and PAAS_ROOT are required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node command is required for template hook" >&2
  exit 1
fi

TEMPLATE_RUNTIME_TOOL="${PAAS_ROOT}/scripts/template-runtime.js"
if [[ ! -f "${TEMPLATE_RUNTIME_TOOL}" ]]; then
  echo "template runtime tool not found: ${TEMPLATE_RUNTIME_TOOL}" >&2
  exit 1
fi

SHARED_TEMPLATE_DIR="${PAAS_SHARED_DIR}/${PAAS_TEMPLATE_ID}"
SHARED_MODULES_DIR="${SHARED_TEMPLATE_DIR}/node_modules"
TEMPLATE_PACKAGE_JSON="${PAAS_TEMPLATE_DIR}/app/package.json"
TEMPLATE_PACKAGE_LOCK_JSON="${PAAS_TEMPLATE_DIR}/app/package-lock.json"

if [[ -d "${SHARED_MODULES_DIR}" ]]; then
  echo "[node-lite] Shared node_modules already prepared: ${SHARED_MODULES_DIR}"
  exit 0
fi

if [[ ! -f "${TEMPLATE_PACKAGE_JSON}" ]]; then
  echo "[node-lite] package.json not found, creating empty shared node_modules"
  mkdir -p "${SHARED_MODULES_DIR}"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command is required for node-lite template hook" >&2
  exit 1
fi

TEMPLATE_IMAGE="$(
  node "${TEMPLATE_RUNTIME_TOOL}" runtime-image \
    --template-dir "${PAAS_TEMPLATE_DIR}"
)"

mkdir -p "${SHARED_TEMPLATE_DIR}"
cp "${TEMPLATE_PACKAGE_JSON}" "${SHARED_TEMPLATE_DIR}/package.json"
if [[ -f "${TEMPLATE_PACKAGE_LOCK_JSON}" ]]; then
  cp "${TEMPLATE_PACKAGE_LOCK_JSON}" "${SHARED_TEMPLATE_DIR}/package-lock.json"
fi

echo "[node-lite] Installing shared node_modules for ${PAAS_TEMPLATE_ID} with image=${TEMPLATE_IMAGE}"
docker run --rm \
  -v "${SHARED_TEMPLATE_DIR}:/work" \
  -w /work \
  "${TEMPLATE_IMAGE}" \
  sh -c "if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi"

echo "[node-lite] Ready: ${SHARED_MODULES_DIR}"

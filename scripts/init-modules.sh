#!/usr/bin/env bash
# =============================================================================
# init-modules.sh - 템플릿별 공유 node_modules 초기화/갱신 스크립트
# =============================================================================
# 역할:
#   템플릿의 package.json 기준으로 node_modules를 한 벌만 설치한다.
#   설치된 모듈은 shared/{templateId}/node_modules 에 위치하며,
#   모든 앱 컨테이너가 이 디렉토리를 read-only로 마운트한다.
#   이를 통해 프로젝트 전체에서 node_modules가 하나만 존재하게 된다.
#
#   create.sh, deploy.sh에서 공유 모듈이 없을 때 자동으로 호출된다.
#   수동으로 실행하여 의존성을 갱신할 수도 있다.
#
# 사용법:
#   init-modules.sh [templateId]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAAS_ROOT_DEFAULT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PAAS_ENV_FILE:-${PAAS_ROOT_DEFAULT}/.env}"

if [[ -z "${PAAS_ENV_FILE:-}" && -f "/paas/.env" ]]; then
  ENV_FILE="/paas/.env"
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

PAAS_ROOT="${PAAS_ROOT:-${PAAS_ROOT_DEFAULT}}"
PAAS_TEMPLATES_DIR="${PAAS_TEMPLATES_DIR:-${PAAS_ROOT}/templates}"
PAAS_SHARED_DIR="${PAAS_SHARED_DIR:-${PAAS_ROOT}/shared}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-node:22-alpine}"
DEFAULT_TEMPLATE_ID="${DEFAULT_TEMPLATE_ID:-${DEFAULT_STARTER_ID:-node-lite-v1}}"

TEMPLATE_ID="${1:-${DEFAULT_TEMPLATE_ID}}"
TEMPLATE_DIR="${PAAS_TEMPLATES_DIR}/${TEMPLATE_ID}"

if [[ ! -d "${TEMPLATE_DIR}/app" ]]; then
  echo "Template not found: ${TEMPLATE_ID}" >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_DIR}/app/package.json" ]]; then
  echo "No package.json in template ${TEMPLATE_ID}, skipping module install." >&2
  mkdir -p "${PAAS_SHARED_DIR}/${TEMPLATE_ID}/node_modules"
  echo "Created empty node_modules for ${TEMPLATE_ID}"
  exit 0
fi

SHARED_TEMPLATE_DIR="${PAAS_SHARED_DIR}/${TEMPLATE_ID}"
mkdir -p "${SHARED_TEMPLATE_DIR}"

cp "${TEMPLATE_DIR}/app/package.json" "${SHARED_TEMPLATE_DIR}/package.json"
if [[ -f "${TEMPLATE_DIR}/app/package-lock.json" ]]; then
  cp "${TEMPLATE_DIR}/app/package-lock.json" "${SHARED_TEMPLATE_DIR}/package-lock.json"
fi

echo "[init-modules] Installing modules for template: ${TEMPLATE_ID}"

docker run --rm \
  -v "${SHARED_TEMPLATE_DIR}:/work" \
  -w /work \
  "${RUNTIME_IMAGE}" \
  sh -c "if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi"

echo "[init-modules] Done. Shared modules at: ${SHARED_TEMPLATE_DIR}/node_modules"

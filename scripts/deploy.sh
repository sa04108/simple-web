#!/usr/bin/env bash
# =============================================================================
# deploy.sh - PaaS 앱 재배포 스크립트
# =============================================================================
# 역할:
#   기존 앱 컨테이너를 내린 뒤 다시 올려서 코드 변경사항을 반영한다.
#   GitHub workflow의 "re-run" 과 유사한 개념이다.
#   1) docker compose down 으로 기존 컨테이너 종료
#   2) docker compose up -d 로 새 컨테이너 기동
#   3) 최대 30초간 running 상태 도달 여부 확인
#   4) 배포 과정을 logs/deploy.log 에 기록
#
# 사용법:
#   deploy.sh <userid> <appname>
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
PAAS_APPS_DIR="${PAAS_APPS_DIR:-${PAAS_ROOT}/apps}"
PAAS_SHARED_DIR="${PAAS_SHARED_DIR:-${PAAS_ROOT}/shared}"
DEFAULT_TEMPLATE_ID="${DEFAULT_TEMPLATE_ID:-node-lite-v1}"

usage() {
  echo "Usage: deploy.sh <userid> <appname>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"

if [[ ! "${USER_ID}" =~ ^[a-z][a-z0-9]{2,19}$ ]]; then
  echo "Invalid userid. Expected /^[a-z][a-z0-9]{2,19}$/" >&2
  exit 1
fi
if [[ ! "${APP_NAME}" =~ ^[a-z][a-z0-9-]{2,29}$ ]]; then
  echo "Invalid appname. Expected /^[a-z][a-z0-9-]{2,29}$/" >&2
  exit 1
fi

APP_DIR="${PAAS_APPS_DIR}/${USER_ID}/${APP_NAME}"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/deploy.log"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "App directory not found: ${APP_DIR}" >&2
  exit 1
fi
if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "docker-compose.yml not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

# 앱의 templateId를 읽어서 공유 node_modules 존재 여부 확인
TEMPLATE_ID="${DEFAULT_TEMPLATE_ID}"
if [[ -f "${APP_DIR}/template.json" ]]; then
  PARSED_ID="$(grep -o '"id"\s*:\s*"[^"]*"' "${APP_DIR}/template.json" | head -1 | sed 's/.*"id"\s*:\s*"\([^"]*\)".*/\1/')"
  if [[ -n "${PARSED_ID}" ]]; then
    TEMPLATE_ID="${PARSED_ID}"
  fi
fi

SHARED_MODULES_DIR="${PAAS_SHARED_DIR}/${TEMPLATE_ID}/node_modules"
if [[ ! -d "${SHARED_MODULES_DIR}" ]]; then
  echo "[deploy] Shared node_modules not found for ${TEMPLATE_ID}, initializing..."
  bash "${SCRIPT_DIR}/init-modules.sh" "${TEMPLATE_ID}"
fi

mkdir -p "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[deploy] app=${USER_ID}/${APP_NAME} started_at=$(date -Is)"
docker compose -f "${COMPOSE_FILE}" down
docker compose -f "${COMPOSE_FILE}" up -d

TARGET_CONTAINER="paas-app-${USER_ID}-${APP_NAME}"
DEADLINE=$((SECONDS + 30))

while (( SECONDS < DEADLINE )); do
  STATUS="$(docker inspect -f '{{.State.Status}}' "${TARGET_CONTAINER}" 2>/dev/null || true)"
  if [[ "${STATUS}" == "running" ]]; then
    echo "[deploy] success status=${STATUS}"
    exit 0
  fi
  sleep 1
done

echo "[deploy] failed to reach running state within 30s"
docker compose -f "${COMPOSE_FILE}" logs --no-color --tail 120 app || true
exit 1

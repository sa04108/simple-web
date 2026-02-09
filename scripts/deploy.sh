#!/usr/bin/env bash
# =============================================================================
# deploy.sh - 템플릿 기반 앱 재배포 스크립트 (공통 오케스트레이터)
# =============================================================================
# 역할:
#   기존 앱 컨테이너를 내린 뒤 다시 올려 코드 변경사항을 반영한다.
#   템플릿 preDeploy hook을 먼저 호출해 템플릿별 준비 로직을 수행한다.
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
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  echo "Usage: deploy.sh <userid> <appname>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"

validate_user_id "${USER_ID}"
validate_app_name "${APP_NAME}"

APP_DIR="$(app_dir_for "${USER_ID}" "${APP_NAME}")"
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

TEMPLATE_ID="$(resolve_app_template_id "${APP_DIR}")"
if [[ -z "${TEMPLATE_ID}" ]]; then
  echo "template id not found in app metadata: ${APP_DIR}" >&2
  exit 1
fi

validate_template_id "${TEMPLATE_ID}"
TEMPLATE_DIR="$(template_dir_for "${TEMPLATE_ID}")"
if [[ ! -f "${TEMPLATE_DIR}/template.json" ]]; then
  echo "Template not found: ${TEMPLATE_ID}" >&2
  exit 1
fi

run_template_hook "${TEMPLATE_ID}" "preDeploy" "${USER_ID}" "${APP_NAME}" "${APP_DIR}"

mkdir -p "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[deploy] app=${USER_ID}/${APP_NAME} template=${TEMPLATE_ID} started_at=$(date -Is)"
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

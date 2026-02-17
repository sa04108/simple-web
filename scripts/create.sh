#!/usr/bin/env bash
# =============================================================================
# create.sh - 템플릿 기반 앱 생성 스크립트 (공통 오케스트레이터)
# =============================================================================
# 역할:
#   1) userid/appname/templateId 유효성 검증
#   2) 템플릿의 app/ 디렉토리를 앱 작업 디렉토리로 복사
#   3) 템플릿 preCreate hook 실행 (템플릿 전용 준비 로직)
#   4) 템플릿 메타 기반 docker-compose.yml 생성
#   5) docker compose up -d 로 컨테이너 기동
#
# 사용법:
#   create.sh <userid> <appname> <templateId>
#
# 컨테이너 네이밍:
#   paas-app-{userid}-{appname} (suffix로 일반 컨테이너와 구분)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  echo "Usage: create.sh <userid> <appname> <templateId>" >&2
}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"
TEMPLATE_ID="$3"

validate_user_id "${USER_ID}"
validate_app_name "${APP_NAME}"
validate_template_id "${TEMPLATE_ID}"

ensure_base_directories
TEMPLATE_DIR="$(template_dir_for "${TEMPLATE_ID}")"
APP_DIR="$(app_dir_for "${USER_ID}" "${APP_NAME}")"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"

if [[ ! -d "${TEMPLATE_DIR}/app" ]]; then
  echo "Template not found: ${TEMPLATE_ID}" >&2
  exit 1
fi
if [[ ! -f "${TEMPLATE_DIR}/template.json" ]]; then
  echo "template.json not found for template: ${TEMPLATE_ID}" >&2
  exit 1
fi
if [[ -e "${APP_DIR}" ]]; then
  echo "App already exists: ${USER_ID}/${APP_NAME}" >&2
  exit 1
fi

mkdir -p "${APP_DIR}/app" "${APP_DIR}/data" "${APP_DIR}/logs"
cp -R "${TEMPLATE_DIR}/app/." "${APP_DIR}/app/"
cp "${TEMPLATE_DIR}/template.json" "${APP_DIR}/template.json"

run_template_hook "${TEMPLATE_ID}" "preCreate" "${USER_ID}" "${APP_NAME}" "${APP_DIR}"

require_node
HOST_APP_DIR="$(to_host_path "${APP_DIR}")"
HOST_SHARED_DIR="$(to_host_path "${PAAS_SHARED_DIR}")"

node "${TEMPLATE_RUNTIME_TOOL}" compose \
  --template-dir "${TEMPLATE_DIR}" \
  --template-id "${TEMPLATE_ID}" \
  --app-dir "${HOST_APP_DIR}" \
  --userid "${USER_ID}" \
  --appname "${APP_NAME}" \
  --domain "${PAAS_DOMAIN}" \
  --network "${APP_NETWORK}" \
  --shared-dir "${HOST_SHARED_DIR}" \
  --mem-limit "${DEFAULT_MEM_LIMIT}" \
  --cpu-limit "${DEFAULT_CPU_LIMIT}" \
  --restart-policy "${DEFAULT_RESTART_POLICY}" \
  > "${COMPOSE_FILE}"

docker compose -f "${COMPOSE_FILE}" up -d
echo "created: ${USER_ID}/${APP_NAME} template=${TEMPLATE_ID}"

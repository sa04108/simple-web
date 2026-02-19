#!/usr/bin/env bash
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${LIB_DIR}/.." && pwd)"
PAAS_ROOT_DEFAULT="$(cd "${SCRIPTS_DIR}/.." && pwd)"
ENV_FILE="${PAAS_ENV_FILE:-${PAAS_ROOT_DEFAULT}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

PAAS_ROOT="${PAAS_ROOT:-${PAAS_ROOT_DEFAULT}}"
PAAS_APPS_DIR="${PAAS_APPS_DIR:-${PAAS_ROOT}/apps}"
APP_NETWORK="${APP_NETWORK:-paas-app}"
APP_CONTAINER_PREFIX="${APP_CONTAINER_PREFIX:-paas-app}"
APP_COMPOSE_FILE="${APP_COMPOSE_FILE:-docker-compose.yml}"
APP_SOURCE_SUBDIR="${APP_SOURCE_SUBDIR:-app}"
APP_DATA_SUBDIR="${APP_DATA_SUBDIR:-data}"
APP_LOGS_SUBDIR="${APP_LOGS_SUBDIR:-logs}"
PAAS_DOMAIN="${PAAS_DOMAIN:-my.domain.com}"
DEFAULT_MEM_LIMIT="${DEFAULT_MEM_LIMIT:-256m}"
DEFAULT_CPU_LIMIT="${DEFAULT_CPU_LIMIT:-0.5}"
DEFAULT_RESTART_POLICY="${DEFAULT_RESTART_POLICY:-unless-stopped}"
DEPLOY_TIMEOUT_SECS="${DEPLOY_TIMEOUT_SECS:-30}"
DEPLOY_LOG_TAIL_LINES="${DEPLOY_LOG_TAIL_LINES:-120}"

DETECT_RUNTIME_TOOL="${SCRIPTS_DIR}/detect-runtime.js"
GENERATE_DOCKERFILE_TOOL="${SCRIPTS_DIR}/generate-dockerfile.js"
GENERATE_COMPOSE_TOOL="${SCRIPTS_DIR}/generate-compose.js"

# 컨테이너 경로(/paas/...)를 호스트 경로로 변환
# PAAS_HOST_ROOT가 설정되어 있으면 PAAS_ROOT 접두사를 PAAS_HOST_ROOT로 치환
# 설정되지 않은 경우(직접 실행 시) 경로를 그대로 반환하여 호환성 유지
to_host_path() {
  local container_path="$1"
  if [[ -n "${PAAS_HOST_ROOT:-}" ]]; then
    echo "${container_path/#${PAAS_ROOT}/${PAAS_HOST_ROOT}}"
  else
    echo "${container_path}"
  fi
}

ensure_base_directories() {
  mkdir -p "${PAAS_APPS_DIR}"
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node command is required" >&2
    return 1
  fi
  if [[ ! -f "${DETECT_RUNTIME_TOOL}" ]]; then
    echo "detect-runtime tool not found: ${DETECT_RUNTIME_TOOL}" >&2
    return 1
  fi
}

validate_user_id() {
  local user_id="$1"
  if [[ ! "${user_id}" =~ ^[a-z][a-z0-9]{2,19}$ ]]; then
    echo "Invalid userid. Expected /^[a-z][a-z0-9]{2,19}$/" >&2
    exit 1
  fi
}

validate_app_name() {
  local app_name="$1"
  if [[ ! "${app_name}" =~ ^[a-z][a-z0-9-]{2,29}$ ]]; then
    echo "Invalid appname. Expected /^[a-z][a-z0-9-]{2,29}$/" >&2
    exit 1
  fi
}

validate_repo_url() {
  local repo_url="$1"
  if [[ ! "${repo_url}" =~ ^https?:// ]]; then
    echo "Invalid repoUrl. Must start with http:// or https://" >&2
    exit 1
  fi
}

app_dir_for() {
  local user_id="$1"
  local app_name="$2"
  echo "${PAAS_APPS_DIR}/${user_id}/${app_name}"
}

app_compose_file_path() {
  local app_dir="$1"
  echo "${app_dir}/${APP_COMPOSE_FILE}"
}

app_log_dir_for() {
  local app_dir="$1"
  echo "${app_dir}/${APP_LOGS_SUBDIR}"
}

app_container_name() {
  local user_id="$1"
  local app_name="$2"
  echo "${APP_CONTAINER_PREFIX}-${user_id}-${app_name}"
}

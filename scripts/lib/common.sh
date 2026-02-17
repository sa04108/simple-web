#!/usr/bin/env bash
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${LIB_DIR}/.." && pwd)"
PAAS_ROOT_DEFAULT="$(cd "${SCRIPTS_DIR}/.." && pwd)"
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
PAAS_TEMPLATES_DIR="${PAAS_TEMPLATES_DIR:-${PAAS_ROOT}/templates}"
PAAS_SHARED_DIR="${PAAS_SHARED_DIR:-${PAAS_ROOT}/shared}"
APP_NETWORK="${APP_NETWORK:-paas-proxy}"
PAAS_DOMAIN="${PAAS_DOMAIN:-my.domain.com}"
DEFAULT_MEM_LIMIT="${DEFAULT_MEM_LIMIT:-256m}"
DEFAULT_CPU_LIMIT="${DEFAULT_CPU_LIMIT:-0.5}"
DEFAULT_RESTART_POLICY="${DEFAULT_RESTART_POLICY:-unless-stopped}"
TEMPLATE_RUNTIME_TOOL="${PAAS_ROOT}/scripts/template-runtime.js"

if [[ ! -f "${TEMPLATE_RUNTIME_TOOL}" ]]; then
  TEMPLATE_RUNTIME_TOOL="${SCRIPTS_DIR}/template-runtime.js"
fi

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
  mkdir -p "${PAAS_APPS_DIR}" "${PAAS_TEMPLATES_DIR}" "${PAAS_SHARED_DIR}"
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node command is required" >&2
    return 1
  fi
  if [[ ! -f "${TEMPLATE_RUNTIME_TOOL}" ]]; then
    echo "template runtime tool not found: ${TEMPLATE_RUNTIME_TOOL}" >&2
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

validate_template_id() {
  local template_id="$1"
  if [[ ! "${template_id}" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]]; then
    echo "Invalid templateId. Expected /^[a-z0-9][a-z0-9-]{1,63}$/" >&2
    exit 1
  fi
}

template_dir_for() {
  local template_id="$1"
  echo "${PAAS_TEMPLATES_DIR}/${template_id}"
}

app_dir_for() {
  local user_id="$1"
  local app_name="$2"
  echo "${PAAS_APPS_DIR}/${user_id}/${app_name}"
}

resolve_template_hook() {
  local template_dir="$1"
  local hook_name="$2"
  require_node
  node "${TEMPLATE_RUNTIME_TOOL}" hook \
    --template-dir "${template_dir}" \
    --name "${hook_name}"
}

resolve_app_template_id() {
  local app_dir="$1"
  require_node
  node "${TEMPLATE_RUNTIME_TOOL}" resolve-template-id \
    --app-dir "${app_dir}"
}

run_template_hook() {
  local template_id="$1"
  local hook_name="$2"
  local user_id="$3"
  local app_name="$4"
  local app_dir="$5"
  local template_dir
  local hook_rel_path
  local hook_path

  template_dir="$(template_dir_for "${template_id}")"
  hook_rel_path="$(resolve_template_hook "${template_dir}" "${hook_name}")"
  if [[ -z "${hook_rel_path}" ]]; then
    return 0
  fi

  if [[ "${hook_rel_path}" == /* ]] || [[ "${hook_rel_path}" == *".."* ]]; then
    echo "Invalid hook path in template ${template_id}: ${hook_rel_path}" >&2
    return 1
  fi

  hook_path="${template_dir}/${hook_rel_path}"
  if [[ ! -f "${hook_path}" ]]; then
    echo "Template hook not found: ${hook_path}" >&2
    return 1
  fi

  PAAS_ROOT="${PAAS_ROOT}" \
  PAAS_HOST_ROOT="${PAAS_HOST_ROOT:-}" \
  PAAS_SHARED_DIR="${PAAS_SHARED_DIR}" \
  PAAS_TEMPLATE_ID="${template_id}" \
  PAAS_TEMPLATE_DIR="${template_dir}" \
  PAAS_APP_DIR="${app_dir}" \
  PAAS_USER_ID="${user_id}" \
  PAAS_APP_NAME="${app_name}" \
  bash "${hook_path}"
}

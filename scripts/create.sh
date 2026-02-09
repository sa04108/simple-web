#!/usr/bin/env bash
# =============================================================================
# create.sh - PaaS 앱 생성 스크립트
# =============================================================================
# 역할:
#   사용자가 요청한 앱을 템플릿 기반으로 생성한다.
#   1) userid/appname 유효성 검증
#   2) 공유 node_modules가 없으면 init-modules.sh를 자동 호출하여 초기화
#   3) 템플릿(node-lite-v1 등)의 app/ 디렉토리를 apps/{userid}/{appname}/app/ 으로 복사
#   4) data/, logs/ 디렉토리 생성 (persistent volume 용도)
#   5) 리소스 제한(mem/cpu)이 적용된 docker-compose.yml 자동 생성
#      (공유 node_modules를 read-only로 마운트)
#   6) docker compose up -d 로 컨테이너 기동
#
# 사용법:
#   create.sh <userid> <appname> [templateId]
#
# 컨테이너 네이밍:
#   paas-app-{userid}-{appname} (suffix로 일반 컨테이너와 구분)
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
PAAS_TEMPLATES_DIR="${PAAS_TEMPLATES_DIR:-${PAAS_ROOT}/templates}"
PAAS_SHARED_DIR="${PAAS_SHARED_DIR:-${PAAS_ROOT}/shared}"
PAAS_NETWORK="${PAAS_NETWORK:-paas-proxy}"
PAAS_DOMAIN="${PAAS_DOMAIN:-my.domain.com}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-node:22-alpine}"
DEFAULT_MEM_LIMIT="${DEFAULT_MEM_LIMIT:-256m}"
DEFAULT_CPU_LIMIT="${DEFAULT_CPU_LIMIT:-0.5}"
DEFAULT_RESTART_POLICY="${DEFAULT_RESTART_POLICY:-unless-stopped}"
DEFAULT_TEMPLATE_ID="${DEFAULT_TEMPLATE_ID:-node-lite-v1}"

usage() {
  echo "Usage: create.sh <userid> <appname> [templateId]" >&2
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"
TEMPLATE_ID="${3:-${DEFAULT_TEMPLATE_ID}}"

if [[ ! "${USER_ID}" =~ ^[a-z][a-z0-9]{2,19}$ ]]; then
  echo "Invalid userid. Expected /^[a-z][a-z0-9]{2,19}$/" >&2
  exit 1
fi
if [[ ! "${APP_NAME}" =~ ^[a-z][a-z0-9-]{2,29}$ ]]; then
  echo "Invalid appname. Expected /^[a-z][a-z0-9-]{2,29}$/" >&2
  exit 1
fi

TEMPLATE_DIR="${PAAS_TEMPLATES_DIR}/${TEMPLATE_ID}"
SHARED_MODULES_DIR="${PAAS_SHARED_DIR}/${TEMPLATE_ID}/node_modules"
APP_DIR="${PAAS_APPS_DIR}/${USER_ID}/${APP_NAME}"

if [[ ! -d "${TEMPLATE_DIR}/app" ]]; then
  echo "Template not found: ${TEMPLATE_ID}" >&2
  exit 1
fi

if [[ ! -d "${SHARED_MODULES_DIR}" ]]; then
  echo "[create] Shared node_modules not found for ${TEMPLATE_ID}, initializing..."
  bash "${SCRIPT_DIR}/init-modules.sh" "${TEMPLATE_ID}"
fi
if [[ -e "${APP_DIR}" ]]; then
  echo "App already exists: ${USER_ID}/${APP_NAME}" >&2
  exit 1
fi

mkdir -p "${APP_DIR}/app" "${APP_DIR}/data" "${APP_DIR}/logs"
cp -R "${TEMPLATE_DIR}/app/." "${APP_DIR}/app/"
if [[ -f "${TEMPLATE_DIR}/template.json" ]]; then
  cp "${TEMPLATE_DIR}/template.json" "${APP_DIR}/template.json"
fi

cat > "${APP_DIR}/docker-compose.yml" <<EOF
services:
  app:
    image: ${RUNTIME_IMAGE}
    container_name: paas-app-${USER_ID}-${APP_NAME}
    restart: ${DEFAULT_RESTART_POLICY}
    working_dir: /app
    command: ["node", "server.js"]
    volumes:
      - ${APP_DIR}/app:/app
      - ${SHARED_MODULES_DIR}:/app/node_modules:ro
      - ${APP_DIR}/data:/data
    environment:
      - NODE_ENV=production
      - APP_ID=${USER_ID}-${APP_NAME}
      - PORT=3000
      - DATA_DIR=/data
    mem_limit: ${DEFAULT_MEM_LIMIT}
    cpus: "${DEFAULT_CPU_LIMIT}"
    networks:
      - paas-proxy
    labels:
      - "paas.type=user-app"
      - "paas.userid=${USER_ID}"
      - "paas.appname=${APP_NAME}"
      - "paas.domain=${USER_ID}-${APP_NAME}.${PAAS_DOMAIN}"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  paas-proxy:
    external: true
    name: ${PAAS_NETWORK}
EOF

docker compose -f "${APP_DIR}/docker-compose.yml" up -d
echo "created: ${USER_ID}/${APP_NAME}"

#!/usr/bin/env bash
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
PAAS_NETWORK="${PAAS_NETWORK:-paas-proxy}"
PAAS_DOMAIN="${PAAS_DOMAIN:-my.domain.com}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-node:20-alpine}"
DEFAULT_MEM_LIMIT="${DEFAULT_MEM_LIMIT:-256m}"
DEFAULT_CPU_LIMIT="${DEFAULT_CPU_LIMIT:-0.5}"
DEFAULT_RESTART_POLICY="${DEFAULT_RESTART_POLICY:-unless-stopped}"
DEFAULT_TEMPLATE_ID="${DEFAULT_TEMPLATE_ID:-${DEFAULT_STARTER_ID:-node-lite-v1}}"

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
APP_DIR="${PAAS_APPS_DIR}/${USER_ID}/${APP_NAME}"

if [[ ! -d "${TEMPLATE_DIR}/app" ]]; then
  echo "Template not found: ${TEMPLATE_ID}" >&2
  exit 1
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
    command: >
      sh -c "if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && node server.js"
    volumes:
      - ${APP_DIR}/app:/app
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

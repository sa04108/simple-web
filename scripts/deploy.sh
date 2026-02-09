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

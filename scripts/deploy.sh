#!/usr/bin/env bash
# =============================================================================
# deploy.sh - repo 기반 앱 재배포 스크립트
# =============================================================================
# 역할:
#   1) git pull 로 최신 코드 반영
#   2) 런타임 재감지 (package.json 변경 대응)
#   3) Dockerfile 재생성
#   4) docker compose down → up -d --build 로 이미지 재빌드 및 재기동
#   5) 최대 30초간 running 상태 도달 여부 확인
#   6) 배포 과정을 logs/deploy.log 에 기록
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
COMPOSE_FILE="$(app_compose_file_path "${APP_DIR}")"
LOG_DIR="$(app_log_dir_for "${APP_DIR}")"
LOG_FILE="${LOG_DIR}/deploy.log"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "App directory not found: ${APP_DIR}" >&2
  exit 1
fi
if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "${APP_COMPOSE_FILE} not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[deploy] app=${USER_ID}/${APP_NAME} started_at=$(date -Is)"

require_node
ensure_railpack

if [[ ! -d "${APP_DIR}/${APP_SOURCE_SUBDIR}" ]]; then
  echo "[deploy] 소스 디렉토리 없음. .paas-meta.json 기반으로 다시 clone 합니다..."
  META_PATH="${APP_DIR}/.paas-meta.json"
  if [[ ! -f "${META_PATH}" ]]; then
    echo "[deploy] 메타데이터 파일 없음: ${META_PATH}" >&2
    exit 1
  fi
  REPO_URL=$(node -p "try { require('${META_PATH}').repoUrl } catch(e) { '' }")
  BRANCH=$(node -p "try { require('${META_PATH}').branch || 'main' } catch(e) { 'main' }")
  
  if [[ -z "${REPO_URL}" || "${REPO_URL}" == "undefined" ]]; then
    echo "[deploy] 메타데이터에 repoUrl 이 없습니다." >&2
    exit 1
  fi
  
  echo "[deploy] repo 복제: ${REPO_URL} (branch: ${BRANCH})"
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}/${APP_SOURCE_SUBDIR}"
else
  echo "[deploy] 최신 코드 반영 중 (git pull)..."
  git -C "${APP_DIR}/${APP_SOURCE_SUBDIR}" pull
fi

echo "[deploy] 런타임 재감지 중..."
RUNTIME_JSON="$(node "${DETECT_RUNTIME_TOOL}" "${APP_DIR}/${APP_SOURCE_SUBDIR}")"
DISPLAY_NAME="$(node -e "console.log(JSON.parse(process.argv[1]).displayName)" "${RUNTIME_JSON}")"
echo "[deploy] 감지된 런타임: ${DISPLAY_NAME}"

echo "[deploy] Dockerfile 재생성 중..."
node "${GENERATE_DOCKERFILE_TOOL}" "${RUNTIME_JSON}" "${APP_DIR}/${APP_SOURCE_SUBDIR}"

echo "[deploy] Railpack Build Plan 재생성 중..."
(cd "${APP_DIR}/${APP_SOURCE_SUBDIR}" && railpack prepare .)

echo "[deploy] 컨테이너 재빌드 및 재기동 중..."
docker compose -f "${COMPOSE_FILE}" down
DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 docker compose -f "${COMPOSE_FILE}" up -d --build

echo "[deploy] 빌드 후 dangling 이미지 정리..."
docker image prune -f || true

TARGET_CONTAINER="$(app_container_name "${USER_ID}" "${APP_NAME}")"
DEADLINE=$((SECONDS + DEPLOY_TIMEOUT_SECS))

while (( SECONDS < DEADLINE )); do
  STATUS="$(docker inspect -f '{{.State.Status}}' "${TARGET_CONTAINER}" 2>/dev/null || true)"
  if [[ "${STATUS}" == "running" ]]; then
    echo "[deploy] success status=${STATUS}"
    exit 0
  fi
  sleep 1
done

echo "[deploy] failed to reach running state within ${DEPLOY_TIMEOUT_SECS}s"
docker compose -f "${COMPOSE_FILE}" logs --no-color --tail "${DEPLOY_LOG_TAIL_LINES}" app || true
exit 1

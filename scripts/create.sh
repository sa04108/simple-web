#!/usr/bin/env bash
# =============================================================================
# create.sh - GitHub repo 기반 앱 생성 스크립트
# =============================================================================
# 역할:
#   1) userid / appname / repoUrl 유효성 검증
#   2) git clone으로 사용자 repo를 앱 디렉토리에 복제
#   3) detect-runtime.js로 런타임 메타데이터 감지 (UI 표시용)
#   4) railpack build (또는 사용자 Dockerfile의 경우 docker build)로 이미지 빌드
#   5) generate-compose.js로 docker-compose.yml 생성
#   6) docker compose up -d 로 컨테이너 기동
#
# 사용법:
#   create.sh <userid> <appname> <repoUrl> [branch]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  echo "Usage: create.sh <userid> <appname> <repoUrl> [branch]" >&2
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage
  exit 1
fi

USER_ID="$1"
APP_NAME="$2"
REPO_URL="$3"
BRANCH="${4:-main}"

validate_user_id "${USER_ID}"
validate_app_name "${APP_NAME}"
validate_repo_url "${REPO_URL}"

ensure_base_directories

APP_DIR="$(app_dir_for "${USER_ID}" "${APP_NAME}")"
COMPOSE_FILE="$(app_compose_file_path "${APP_DIR}")"

if [[ -e "${APP_DIR}" ]]; then
  echo "[create] [info] 앱 경로가 이미 존재합니다. 기존 소스를 덮어씌웁니다: ${USER_ID}/${APP_NAME}"
  rm -rf "${APP_DIR}/${APP_SOURCE_SUBDIR}"
fi

# app 소스 디렉토리 복제 실패 시 정리 (메타데이터 및 기타 구조 보존을 위해 app 폴더 전체 대신 소스코드만 삭제)
cleanup_on_failure() {
  echo "[create] 실패 — 생성 중간 상태 정리 (소스 디렉토리만 삭제): ${APP_DIR}/${APP_SOURCE_SUBDIR}" >&2
  rm -rf "${APP_DIR}/${APP_SOURCE_SUBDIR}"
}
trap cleanup_on_failure ERR

mkdir -p "${APP_DIR}/${APP_DATA_SUBDIR}" "${APP_DIR}/${APP_LOGS_SUBDIR}"

echo "[create] repo 복제: ${REPO_URL} (branch: ${BRANCH})"
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}/${APP_SOURCE_SUBDIR}"

require_node
require_railpack

echo "[create] 런타임 감지 중..."
RUNTIME_JSON="$(node "${DETECT_RUNTIME_TOOL}" "${APP_DIR}/${APP_SOURCE_SUBDIR}")"
DISPLAY_NAME="$(node -e "console.log(JSON.parse(process.argv[1]).displayName)" "${RUNTIME_JSON}")"
echo "[create] 감지된 런타임: ${DISPLAY_NAME}"

APP_IMAGE="paas-app-${USER_ID}-${APP_NAME}:latest"

# 사용자 repo에 Dockerfile이 있으면 docker build, 없으면 railpack build
if [[ -f "${APP_DIR}/${APP_SOURCE_SUBDIR}/Dockerfile" ]]; then
  echo "[create] 사용자 Dockerfile 감지 → docker build 사용"
  docker build \
    -t "${APP_IMAGE}" \
    -f "${APP_DIR}/${APP_SOURCE_SUBDIR}/Dockerfile" \
    "${APP_DIR}/${APP_SOURCE_SUBDIR}"
else
  echo "[create] railpack build 사용"
  (cd "${APP_DIR}/${APP_SOURCE_SUBDIR}" && railpack build . --name "${APP_IMAGE}")
fi

echo "[create] docker-compose.yml 생성 중..."
# node 명령에만 사용할 임시 환경변수 할당
APP_IMAGE="${APP_IMAGE}" node "${GENERATE_COMPOSE_TOOL}" "${USER_ID}" "${APP_NAME}"

echo "[create] 앱 메타데이터 기록..."
REPO_URL="${REPO_URL}" \
BRANCH="${BRANCH}" \
RUNTIME_JSON="${RUNTIME_JSON}" \
META_PATH="${APP_DIR}/.paas-meta.json" \
node -e "
const meta = {
  repoUrl: process.env.REPO_URL,
  branch: process.env.BRANCH,
  createdAt: new Date().toISOString(),
  detectedRuntime: (({ runtime, displayName, icon, dependencies }) => ({ name: runtime, displayName, icon, dependencies }))(JSON.parse(process.env.RUNTIME_JSON))
};
require('fs').writeFileSync(process.env.META_PATH, JSON.stringify(meta, null, 2));
"

# 기동 (이미 빌드된 이미지를 사용)
mkdir -p "$(app_log_dir_for "${APP_DIR}")"
echo "[create] 컨테이너 기동 중..."
docker compose -f "${COMPOSE_FILE}" up -d 2>&1 | tee -a "${APP_DIR}/${APP_LOGS_SUBDIR}/create.log"

# echo "[create] 소스 디렉토리 유지 (deploy 목적)..."
# rm -rf "${APP_DIR}/${APP_SOURCE_SUBDIR}"

# 성공 시 trap 해제
trap - ERR

echo "[create] 완료: ${USER_ID}/${APP_NAME} repo=${REPO_URL} runtime=${DISPLAY_NAME}"

#!/usr/bin/env bash
# =============================================================================
# lib/build.sh - 앱 이미지 빌드 및 compose 생성 공통 함수
# =============================================================================
# create.sh / deploy.sh 양쪽에서 source하여 사용한다.

# app_image_name <userid> <appname>
# → 이미지 태그 문자열을 출력한다.
app_image_name() {
  local user_id="$1"
  local app_name="$2"
  echo "paas-app-${user_id}-${app_name}:latest"
}

# build_app_image <src_dir> <image_name>
# → src_dir에 Dockerfile이 있으면 docker build, 없으면 railpack build.
build_app_image() {
  local src_dir="$1"
  local image_name="$2"

  if [[ -f "${src_dir}/Dockerfile" ]]; then
    echo "[build] 사용자 Dockerfile 감지 → docker build 사용"
    docker build \
      -t "${image_name}" \
      -f "${src_dir}/Dockerfile" \
      "${src_dir}"
  else
    echo "[build] railpack build 사용"
    (cd "${src_dir}" && railpack build . --name "${image_name}")
  fi
}

# generate_app_compose <userid> <appname> <image_name>
# → generate-compose.js를 호출해 docker-compose.yml을 생성한다.
generate_app_compose() {
  local user_id="$1"
  local app_name="$2"
  local image_name="$3"
  APP_IMAGE="${image_name}" node "${GENERATE_COMPOSE_TOOL}" "${user_id}" "${app_name}"
}

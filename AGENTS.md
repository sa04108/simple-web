# Mini PaaS Agent Spec (Node Single Template)

## 1. Goal
- 템플릿 마켓이 아니라, `Node.js 단일 스타터`를 기준으로 사용자가 앱 코드를 직접 구성하고 배포/재시동할 수 있는 미니 PaaS를 제공한다.
- 민감 값은 코드에 직접 쓰지 않고 포털에서 발급한 `앱 접속 키`로 제어한다.
- 초기 MVP는 HTTP 두 가지에 집중한다.
  - `GET`: 앱 상태/정보 조회
  - `POST`: 앱 시동(컨테이너 up)

## 2. Naming Rules
- GitHub 고유 용어와 혼동되는 이름을 사용하지 않는다.
- 권장 용어:
  - template: `node-lite-v1`
  - app key: `client key`
  - app control API: `bridge API`

## 3. Core Stack
- Portal API: Node.js + Express (`portal/server.js`)
- 인증/포털 관리자 키: SQLite + `portal/authService.js`
- 앱 접속 키: SQLite + `portal/appAccessService.js`
- 앱 실행 제어: shell scripts (`scripts/create.sh`, `scripts/deploy.sh`, `scripts/delete.sh`)
- 앱 실행 단위: app별 docker-compose 1개

## 4. Template Policy
- template는 1개만 사용한다: `node-lite-v1`
- template 앱 구성:
  - `server.js`
  - `package.json`
  - `package-lock.json`
- 사용자는 이 파일들을 직접 읽고 수정할 수 있다.

## 5. API Surface (MVP)

### 5-1. Admin-protected (session or admin key)
- `POST /apps` 앱 생성
  - body: `{ appname, templateId }`
  - userid는 로그인 사용자명을 서버에서 자동 사용
  - 내부적으로 template `node-lite-v1` 고정
- `GET /apps` 앱 목록
- `GET /apps/:userid/:appname` 앱 상세
- `POST /apps/:userid/:appname/start` 앱 시동
- `POST /apps/:userid/:appname/stop` 앱 정지
- `POST /apps/:userid/:appname/deploy` 앱 재배포
- `DELETE /apps/:userid/:appname` 앱 삭제
- `GET /apps/:userid/:appname/logs` 로그 조회

### 5-2. App Client Key 관리 (admin-protected)
- `GET /apps/:userid/:appname/client-keys` 키 목록
- `POST /apps/:userid/:appname/client-keys` 키 발급
- `DELETE /apps/:userid/:appname/client-keys/:id` 키 폐기

### 5-3. App Client Key 전용
- 헤더: `X-App-Key: client.<id>.<secret>`
- `GET /bridge/apps/:userid/:appname` 앱 정보 조회
- `POST /bridge/apps/:userid/:appname/activate` 앱 시동

## 6. Security Baseline
- 포털 인증 없는 `/apps` 접근은 차단한다.
- 앱 접속 API(`/bridge/...`)는 `X-App-Key` 없으면 401 반환.
- 앱 접속 키는 scope를 `userid + appname`으로 고정한다.
- 키 원문은 발급 시 1회만 반환한다.

## 7. Runtime and Scripts
- `scripts/create.sh`: 디렉토리 생성, template 복사, compose 생성, `docker compose up -d`
- `scripts/deploy.sh`: `down` + `up -d`, 최대 30초 running 확인
- `scripts/delete.sh`: `down` 후 삭제 (`--keep-data` 지원)

## 8. Next Scope (not in current MVP)
- 포털에서 `package.json`/`package-lock.json` 편집 API
- 앱별 환경 변수 저장/주입 UI
- 자동 프록시 등록

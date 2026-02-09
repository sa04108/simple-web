# Mini PaaS Agent Spec

## 1. Goal
- 템플릿 기반으로 사용자가 앱 코드를 직접 구성하고 배포/재시동할 수 있는 미니 PaaS를 제공한다.
- GitHub Workflow와 유사한 개념이지만, 기능 범위가 작고 용어/구조가 다르다.
  사용자에게 격리된 Node.js 실행 환경을 제공하여 자기가 짠 스크립트를 테스트/운용할 수 있게 한다.
- 민감 값은 코드에 직접 쓰지 않고 포털에서 발급한 `앱 접속 키`(client key)로 제어한다.
- 현재 MVP는 `node-lite-v1` 템플릿만 제공한다.
  추후 Python 실행 환경, 외부 API 연동 템플릿 등을 추가할 예정이다.

## 2. Naming Rules
- GitHub 고유 용어와 혼동되는 이름을 사용하지 않는다.
- 권장 용어:
  - template: `node-lite-v1` (과거 "starter" 용어는 완전히 제거됨)
  - app key: `client key`
  - app control API: `bridge API`
- **`starterId`, `DEFAULT_STARTER_ID` 등 과거 용어는 모두 제거되었다. 절대 사용하지 않는다.**

## 3. Core Stack
- Portal API: Node.js + Express (`portal/server.js`)
- 인증/포털 관리자 키: SQLite + `portal/authService.js`
- 앱 접속 키: SQLite + `portal/appAccessService.js`
- 앱 실행 공통 오케스트레이션: shell scripts (`scripts/create.sh`, `scripts/deploy.sh`, `scripts/delete.sh`)
- 템플릿 메타/compose 변환: `scripts/template-runtime.js`
- 템플릿 전용 런타임 준비: `templates/{templateId}/hooks/*.sh` (`preCreate`, `preDeploy`, `preDelete` 등)
- 앱 실행 단위: app별 docker-compose 1개

## 4. Template & Module Policy

### 4.1 Template
- 현재 template는 1개: `node-lite-v1` (추후 확장 예정)
- template 앱 구성: `server.js`, `package.json`, `package-lock.json`
- 사용자는 이 파일들을 직접 읽고 수정할 수 있다.

### 4.2 공유 node_modules (핵심 원칙)
- **프로젝트 전체에서 node_modules는 템플릿당 하나만 존재해야 한다.**
- 구조: `shared/{templateId}/node_modules` 에 한 벌만 설치
- 각 앱 컨테이너는 이 디렉토리를 `/app/node_modules:ro` (read-only)로 마운트
- 컨테이너 기동 시 `npm install`은 실행하지 않는다 (바로 `node server.js`)
- 공통 스크립트는 template hook(`preCreate`, `preDeploy`)을 호출하고,
  node-lite 템플릿 hook이 공유 모듈 초기화를 수행한다.
- 사용자가 바라보는 `package.json`은 앱마다 다를 수 있으나, 실제 모듈은 공유된다.

## 5. API Surface (MVP)

### 5-1. Admin-protected (session or admin key)
- `POST /apps` 앱 생성
  - body: `{ appname, templateId }`
  - userid는 로그인 사용자명을 서버에서 자동 사용
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
- `scripts/create.sh`: templateId 필수 검증 → 템플릿 복사 → `preCreate` hook 호출 → 템플릿 메타 기반 compose 생성 → `docker compose up -d`
- `scripts/deploy.sh`: 앱의 templateId 확인 → `preDeploy` hook 호출 → `down` + `up -d`, 최대 30초 running 확인
- `scripts/delete.sh`: 필요 시 `preDelete` hook 호출 후 `down` + 삭제 (`--keep-data` 지원)
- `scripts/template-runtime.js`: 템플릿 메타(`template.json`) 파싱, hook 조회, compose 렌더링

## 8. 컨테이너 네이밍
- 앱 컨테이너: `paas-app-{userid}-{appname}` (suffix로 서버의 다른 컨테이너와 구분)
- Docker labels: `paas.type=user-app`, `paas.userid`, `paas.appname`, `paas.domain`

## 9. 저사양 서버 최적화 (Intel Celeron N3150 / DDR3 8GB / SSD 256GB)
이 시스템은 극도로 제한된 자원에서 운용되므로 다음 원칙을 지킨다:
- **공유 node_modules**: 앱 수에 관계없이 템플릿당 모듈 1벌 (디스크 절약)
- **Alpine 기반 이미지**: `node:22-alpine` (이미지 크기 최소화)
- **컨테이너 리소스 제한**: 기본 mem 256m / cpu 0.5 (전체 앱 합산이 서버 용량 초과 방지)
- **앱 수 제한**: 유저당 5개, 전체 20개 (MAX_APPS_PER_USER, MAX_TOTAL_APPS)
- **Docker 상태 캐시**: `listDockerStatuses()` 결과를 5초간 캐시 (docker ps 호출 최소화)
- **last_used_at 쓰로틀**: 세션/API키 사용 시각 갱신을 5분에 1회로 제한 (DB 쓰기 최소화)
- **프론트엔드 폴링**: 30초 간격 자동 갱신 + 수동 새로고침 버튼 제공
- **로그 로테이션**: 컨테이너 로그 max-size 10m, max-file 3

## 10. 디렉토리 구조
```
paas-webapp/
├── portal/                  # 포털 API 서버 + 프론트엔드
│   ├── server.js            # Express 메인 서버
│   ├── authService.js       # 인증/세션/API키 관리
│   ├── appAccessService.js  # 앱 client key 관리
│   └── public/              # 대시보드 UI (index.html, app.js, auth.html, auth.js)
├── scripts/                 # 앱 라이프사이클 셸 스크립트
│   ├── create.sh            # 앱 생성 (공통 오케스트레이터)
│   ├── deploy.sh            # 앱 재배포 (공통 오케스트레이터)
│   ├── delete.sh            # 앱 삭제 (공통 오케스트레이터)
│   ├── template-runtime.js  # 템플릿 메타 파서/compose 렌더러
│   └── lib/common.sh        # 공통 유효성/환경 로더
├── templates/               # 앱 템플릿 (추후 확장)
│   └── node-lite-v1/
│       └── hooks/           # 템플릿 전용 hook 스크립트
├── shared/                  # 템플릿별 공유 node_modules (런타임 생성)
├── apps/                    # 유저별 앱 디렉토리 (런타임 생성)
├── docker-compose.yml       # 포털 서버 컨테이너 정의
└── .env.example             # 환경변수 템플릿
```

## 11. Next Scope (not in current MVP)
- 포털에서 `package.json`/`package-lock.json` 편집 API
- 앱별 환경 변수 저장/주입 UI
- 자동 프록시 등록
- Python 실행 환경 템플릿
- 외부 API 연동 템플릿

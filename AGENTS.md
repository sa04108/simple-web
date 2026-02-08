# 미니 PaaS 구축 — Codex 작업 명세서

---

## 1. Context

- **서버 사양**: Celeron N3150 / DDR3 8GB / SSD 240GB
- **OS**: Ubuntu 24.04 LTS (Docker 설치 완료 전제)
- **목표**: 본격적인 미니 PaaS — 초보 사용자가 "자기 웹"을 만들 수 있는 환경
- **초기 서비스 형태**: 정적 페이지 + (선택) SQLite API
- **사용자(최종 유저)**: Node.js를 모르는 초보

---

## 2. Objective

"일기장 템플릿 1개"를 기반으로, 사용자가 템플릿을 선택하면:

1. 서버가 앱 폴더를 생성하고
2. 컨테이너를 띄우며
3. `{userid}-{appname}.{PAAS_DOMAIN}` 으로 접근 가능하게 만들고
4. 운영에 필요한 기본 정책(리소스/로그/재시작/백업)을 자동 적용한다

---

## 3. Audience

- **1차**: Codex(코드 생성 에이전트) — 구현을 위한 스펙/체크리스트
- **2차**: 운영자(나) — 디버깅/확장 시 기준이 되는 설계 문서

---

## 4. Non-goals (이번 단계에서 하지 않음)

- Kubernetes, 서비스 메시, 복잡한 오케스트레이션
- 앱별 DB 컨테이너(Postgres/MySQL) 자동 생성
- 멀티 노드/수평 확장
- 과도한 권한/계정/결제/플랜 시스템
- NPM Proxy Host 자동 생성 (MVP에서는 **수동 설정**)

---

## 5. 기술 스택 (확정)

| 구성 요소 | 기술 | 비고 |
|---|---|---|
| **Portal (관리 API)** | Node.js + Express | 단일 프로세스, `/paas/portal` |
| **Runner (배포 실행기)** | Shell 스크립트 (`deploy.sh`, `create.sh`, `delete.sh`) | Portal이 child_process로 호출 |
| **Reverse Proxy** | Nginx Proxy Manager (NPM) | Docker로 실행, 수동 설정 |
| **App Runtime** | 공용 Docker 이미지 `my-paas-node-runtime` | Node 20 기반 |
| **데이터** | SQLite | 앱 데이터 + Portal 인증/세션 저장 |
| **컨테이너 관리** | Docker Compose (앱 단위 1파일) | `docker compose` CLI 사용 |

---

## 6. 환경변수 (`.env` 파일)

> **핵심**: 도메인 이름을 포함한 모든 환경 의존 값을 `.env`로 관리한다.

파일 위치: `/paas/.env`

```env
# ── 도메인 ──
PAAS_DOMAIN=my.domain.com
# 앱 접속 URL 패턴: {userid}-{appname}.${PAAS_DOMAIN}

# ── 경로 ──
PAAS_ROOT=/paas
PAAS_APPS_DIR=/paas/apps
PAAS_TEMPLATES_DIR=/paas/templates

# ── Portal ──
PORTAL_PORT=3000
# 레거시/자동화 fallback 키 (선택)
PORTAL_API_KEY=changeme-random-secret
PORTAL_DB_PATH=/paas/portal-data/portal.sqlite3
SESSION_COOKIE_NAME=paas_portal_session
SESSION_TTL_HOURS=168
PORTAL_COOKIE_SECURE=false
BCRYPT_ROUNDS=10

# ── 컨테이너 기본값 ──
DEFAULT_MEM_LIMIT=256m
DEFAULT_CPU_LIMIT=0.5
DEFAULT_RESTART_POLICY=unless-stopped
RUNTIME_IMAGE=my-paas-node-runtime:latest

# ── Docker 네트워크 ──
PAAS_NETWORK=paas-proxy

# ── 앱 제한 ──
MAX_APPS_PER_USER=5
MAX_TOTAL_APPS=20
```

### 환경변수 사용 규칙

- **모든 스크립트와 코드**는 하드코딩 대신 이 `.env`를 참조한다.
- Portal(Express)은 시작 시 `dotenv`로 로드한다.
- Shell 스크립트는 `source /paas/.env` 또는 `--env-file`로 참조한다.
- Docker Compose 템플릿에서는 `${VARIABLE}` 치환을 사용한다.

---

## 7. High-level Architecture

```
[Browser] ──HTTPS──▶ [NPM (Reverse Proxy)]
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   [App Container 1] [App Container 2] [Portal API]
          │               │
     /paas/apps/      /paas/apps/
     alice/diary/     bob/diary/
```

- **NPM**: 와일드카드 `*.${PAAS_DOMAIN}` → 각 앱 컨테이너로 포워딩
- **Portal**: 앱 CRUD API 제공, Runner 스크립트 호출
- **App Container**: 공용 이미지 + 볼륨 마운트

### 7-1. 네트워크 전략

> **핵심**: 기존 관리 서비스용 `proxy` 네트워크와 PaaS 앱용 `paas-proxy` 네트워크를 **분리**한다.

```
호스트 Docker 네트워크 구조
┌─────────────────────────────────────────────────┐
│  proxy (기존)                                    │
│  ├── nginx-proxy-manager                        │
│  ├── portainer                                  │
│  └── filebrowser                                │
├─────────────────────────────────────────────────┤
│  paas-proxy (신규)                               │
│  ├── nginx-proxy-manager  ← 양쪽 모두 연결       │
│  ├── paas-portal                                │
│  ├── paas-app-alice-diary                       │
│  └── paas-app-bob-diary                         │
└─────────────────────────────────────────────────┘
```

- **`proxy`** (기존): NPM + Portainer, Filebrowser 등 관리 서비스 전용
- **`paas-proxy`** (신규): NPM + PaaS Portal + 사용자 앱 컨테이너 전용
- **NPM은 두 네트워크에 동시 연결**: 각 네트워크의 컨테이너를 이름으로 resolve하여 프록시
- 사용자 앱은 `paas-proxy`에만 연결 → Portainer/Filebrowser 등에 직접 접근 불가

#### NPM에 paas-proxy 네트워크 연결 (1회, 수동)

```bash
# paas-proxy 네트워크 생성
docker network create paas-proxy

# 기존 NPM 컨테이너에 추가 연결
docker network connect paas-proxy <npm-container-name>
```

### 7-2. 컨테이너 분류 전략

호스트에서 모든 컨테이너가 flat하게 나열되므로, **네이밍 + 라벨**로 구분한다.

#### 네이밍 컨벤션

| 유형 | 접두사 | 예시 |
|---|---|---|
| 기존 관리 서비스 | (기존 유지) | `npm`, `portainer`, `filebrowser` |
| PaaS 시스템 | `paas-` | `paas-portal` |
| 사용자 앱 | `paas-app-` | `paas-app-alice-diary` |

#### Docker Labels

사용자 앱 컨테이너에 라벨을 부여하여 필터링/관리에 활용:

```yaml
labels:
  - "paas.type=user-app"
  - "paas.userid=${USER_ID}"
  - "paas.appname=${APP_NAME}"
  - "paas.domain=${USER_ID}-${APP_NAME}.${PAAS_DOMAIN}"
```

Portal에서 앱 목록 조회 시: `docker ps --filter label=paas.type=user-app`

### 7-3. Docker 소켓 마운트

Portal 컨테이너가 다른 컨테이너를 생성/관리해야 하므로, 호스트의 Docker 소켓을 마운트한다:

```yaml
# paas-portal의 docker-compose.yml
services:
  portal:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

이는 Portainer가 사용하는 것과 동일한 방식이며, Portal이 호스트 Docker 데몬에 명령을 보내 앱 컨테이너를 호스트 레벨에서 생성한다.

---

## 8. Directory Layout

```
/paas/
├── .env                              # 환경변수 (도메인 포함)
├── portal/                           # Portal Express 앱
│   ├── package.json
│   ├── server.js
│   ├── authService.js                # 인증/세션/API Key 서비스
│   └── public/                       # 대시보드 정적 파일
├── portal-data/                      # Portal 인증 DB
│   └── portal.sqlite3
├── scripts/                          # Runner 스크립트
│   ├── create.sh
│   ├── deploy.sh
│   └── delete.sh
├── runtime/                          # 공용 런타임 이미지
│   └── Dockerfile
├── templates/                        # 템플릿 원본 (읽기 전용)
│   └── diary-v1/
│       ├── app/
│       │   ├── index.html
│       │   └── server.js             # 정적 파일 서빙 + (선택) API
│       └── template.json             # 템플릿 메타데이터
├── apps/                             # 사용자 앱 (런타임 생성)
│   └── {userid}/
│       └── {appname}/
│           ├── app/                  # 코드 (템플릿 복사본)
│           ├── data/                 # 데이터 (SQLite 등)
│           ├── logs/                 # 로그
│           └── docker-compose.yml    # 앱별 compose 파일
└── compose/                          # compose 템플릿
    └── app-compose.template.yml
```

---

## 9. 공용 런타임 이미지

> 파일: `/paas/runtime/Dockerfile`

```dockerfile
FROM node:20-alpine

WORKDIR /app

# 최소 의존성 (express + better-sqlite3)
RUN npm init -y && \
    npm install express better-sqlite3 && \
    npm cache clean --force

# 앱 코드는 볼륨으로 마운트됨
# 진입점: /app/server.js
CMD ["node", "server.js"]
```

### 빌드 (1회)

```bash
cd /paas/runtime
docker build -t my-paas-node-runtime:latest .
```

---

## 10. App Model (MVP)

- 앱은 **정적 페이지**가 기본
- 선택적으로 **SQLite API**를 활성화할 수 있음 (`enableApi: true`)
- 앱별 격리 단위:
  - 앱별 컨테이너 **1개**
  - 앱별 데이터 디렉토리 **1개** (볼륨)
  - 런타임 이미지는 **공용 1개**

### Naming Convention

- `userid`: 영문 소문자 + 숫자, 3~20자, `/^[a-z][a-z0-9]{2,19}$/`
- `appname`: 영문 소문자 + 숫자 + 하이픈, 3~30자, `/^[a-z][a-z0-9-]{2,29}$/`
- 컨테이너 이름: `paas-app-{userid}-{appname}`
- 호스트명: `{userid}-{appname}.${PAAS_DOMAIN}`

### 충돌 처리

- 앱 생성 시 **디렉토리 존재 여부**로 중복 체크
- 중복이면 `409 Conflict` 반환

---

## 11. Docker Compose 템플릿

> 파일: `/paas/compose/app-compose.template.yml`

```yaml
services:
  app:
    image: ${RUNTIME_IMAGE}
    container_name: paas-app-${USER_ID}-${APP_NAME}
    restart: ${DEFAULT_RESTART_POLICY}
    volumes:
      - ${APP_DIR}/app:/app:ro
      - ${APP_DIR}/data:/data
    environment:
      - NODE_ENV=production
      - ENABLE_API=${ENABLE_API}
      - SQLITE_PATH=/data/db.sqlite3
    deploy:
      resources:
        limits:
          memory: ${DEFAULT_MEM_LIMIT}
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
```

### Compose 생성 방식

- Portal이 앱 생성 시, 이 템플릿을 **변수 치환**하여 `/paas/apps/{userid}/{appname}/docker-compose.yml`에 기록한다.
- `envsubst` 또는 Node.js 문자열 치환 사용.

---

## 12. Routing Strategy

### 서브도메인 기반 (확정)

- 패턴: `{userid}-{appname}.${PAAS_DOMAIN}`
- 예시: `alice-diary.my.domain.com`

### DNS 요구사항

- `*.${PAAS_DOMAIN}` 와일드카드 A/CNAME 레코드 설정 (수동, 1회)

### NPM 설정 (MVP: 수동)

- 앱 생성 후, 운영자가 NPM 웹 UI에서 Proxy Host를 수동 추가:
  - Domain: `alice-diary.my.domain.com`
  - Forward: `paas-app-alice-diary:3000`
  - SSL: Let's Encrypt
- **향후** NPM API 자동화는 2단계에서 구현

---

## 13. Default Policies

### 리소스 제한

| 항목 | 기본값 | 환경변수 |
|---|---|---|
| 메모리 | 256MB | `DEFAULT_MEM_LIMIT` |
| CPU | 0.5 core | `DEFAULT_CPU_LIMIT` |
| 사용자당 앱 수 | 5개 | `MAX_APPS_PER_USER` |
| 총 앱 수 | 20개 | `MAX_TOTAL_APPS` |

### 재시작 정책

- `restart: unless-stopped` (환경변수로 제어)

### 로그 정책

- Docker `json-file` 드라이버, 파일당 10MB, 최대 3파일
- Portal에서 `docker logs` 명령으로 조회 가능한 API 제공

### 보안/격리 (최소)

- 앱 코드 볼륨: **read-only** (`:ro`)
- 쓰기 가능: `/data` 볼륨만
- 컨테이너 간 직접 통신 불가 (`paas-proxy` 네트워크만 공유, 관리 서비스의 `proxy` 네트워크와 분리)

---

## 14. 템플릿: diary-v1

### template.json

```json
{
  "id": "diary-v1",
  "name": "일기장",
  "description": "간단한 일기장 웹앱",
  "version": "1.0.0",
  "supportsApi": true,
  "internalPort": 3000
}
```

### server.js (템플릿 내)

- Express로 정적 파일 서빙 (`/app` 디렉토리)
- `ENABLE_API=true`이면 SQLite CRUD 엔드포인트 활성화:
  - `GET /api/entries` — 목록 조회
  - `POST /api/entries` — 작성
  - `GET /api/entries/:id` — 상세 조회
  - `DELETE /api/entries/:id` — 삭제
- 포트: `3000` (고정)
- SQLite: WAL 모드 사용 (`PRAGMA journal_mode=WAL;`)

### index.html (템플릿 내)

- 바닐라 HTML/CSS/JS
- 일기 작성/조회 UI
- API 호출은 `fetch('/api/entries')` 사용

---

## 15. SQLite Strategy

- 앱당 SQLite 파일 **1개**: `/data/db.sqlite3`
- DB는 **호스트 볼륨**에 존재 (컨테이너 삭제해도 보존)
- WAL 모드 강제: `PRAGMA journal_mode=WAL;`
- 백업: 파일 복사 (`cp db.sqlite3 db.sqlite3.bak.{timestamp}`)

---

## 16. API Spec

### Portal API

> Base: `http://localhost:${PORTAL_PORT}`
> 인증:
> 1) 로그인 세션 쿠키 (`SESSION_COOKIE_NAME`)
> 2) `X-API-Key: <발급된 키>` (자동화 호출용)
> 3) `PORTAL_API_KEY`는 레거시 fallback (선택)

#### Auth API

| Method | Path | Body | 동작 |
|---|---|---|---|
| `POST` | `/auth/login` | `{ username, password }` | 로그인 + 세션 쿠키 발급 |
| `GET` | `/auth/me` | — | 현재 로그인 사용자 조회 |
| `POST` | `/auth/logout` | — | 로그아웃 + 세션 무효화 |
| `POST` | `/auth/change-password` | `{ currentPassword, newPassword }` | 비밀번호 변경 |

#### API Key API

| Method | Path | Body | 동작 |
|---|---|---|---|
| `GET` | `/api-keys` | — | 내 API Key 목록 |
| `POST` | `/api-keys` | `{ name? }` | 새 API Key 발급 (원문은 1회만 응답) |
| `DELETE` | `/api-keys/:id` | — | API Key 폐기 |

#### App API

| Method | Path | Body | 동작 |
|---|---|---|---|
| `POST` | `/apps` | `{ userid, appname, templateId, enableApi? }` | 앱 생성 (Runner 호출) |
| `GET` | `/apps` | — | 전체 앱 목록 |
| `GET` | `/apps/:userid/:appname` | — | 앱 상태 조회 |
| `POST` | `/apps/:userid/:appname/start` | — | 컨테이너 start |
| `POST` | `/apps/:userid/:appname/stop` | — | 컨테이너 stop |
| `POST` | `/apps/:userid/:appname/deploy` | — | deploy.sh 실행 |
| `DELETE` | `/apps/:userid/:appname` | `{ keepData?: true }` | 앱 삭제 |
| `GET` | `/apps/:userid/:appname/logs` | `?lines=100` | 로그 조회 |

### 인증 방식

- 기본: `id/pw` 로그인 후 세션 쿠키 인증
- 초기 부트스트랩 계정: `admin / admin` 자동 생성
- `admin` 첫 로그인 시 비밀번호 변경 전까지 `/apps`, `/api-keys`는 `403 Password change required`
- 자동화 호출: 로그인 후 발급한 API Key를 `X-API-Key`로 전달
- `PORTAL_API_KEY`는 하위호환(레거시) 용도로만 사용 가능
- 인증 불일치/누락은 `401 Unauthorized`

### 응답 형식

```json
{
  "ok": true,
  "data": { ... }
}
```

에러:

```json
{
  "ok": false,
  "error": "메시지"
}
```

### 유효성 검증

- `userid`, `appname`: 위 Naming Convention 정규식으로 검증
- `templateId`: `/paas/templates/{templateId}` 존재 여부 확인
- 앱 수 제한: `MAX_APPS_PER_USER`, `MAX_TOTAL_APPS` 초과 시 `429`

---

## 17. Runner 스크립트

### create.sh

```
Usage: create.sh <userid> <appname> <templateId> <enableApi>
```

순서:
1. `/paas/apps/{userid}/{appname}/` 디렉토리 생성 (`app/`, `data/`, `logs/`)
2. 템플릿 복사: `/paas/templates/{templateId}/app/` → `app/`
3. compose 파일 생성: 템플릿 치환 → `docker-compose.yml`
4. `docker compose up -d`
5. 성공/실패 exit code 반환

### deploy.sh

```
Usage: deploy.sh <userid> <appname>
```

순서:
1. 앱 디렉토리 존재 확인
2. (향후: git pull 또는 파일 동기화)
3. `docker compose down && docker compose up -d`
4. 헬스체크: 컨테이너 running 상태 확인 (최대 30초 대기)
5. 실패 시 로그를 `/paas/apps/{userid}/{appname}/logs/deploy.log`에 기록

### delete.sh

```
Usage: delete.sh <userid> <appname> [--keep-data]
```

순서:
1. `docker compose down`
2. `--keep-data` 없으면 전체 삭제, 있으면 `data/` 보존
3. 컨테이너/이미지 정리

### 공통 규칙

- 모든 스크립트는 `source /paas/.env`로 환경변수 로드
- `set -euo pipefail` 사용
- stdout → 결과, stderr → 에러
- exit 0 = 성공, exit 1 = 실패

---

## 18. CI/CD (Webhook)

### MVP 흐름

1. 외부에서 `POST /apps/:userid/:appname/deploy` 호출 (세션 또는 발급 API Key 필요)
2. Portal이 `deploy.sh {userid} {appname}` 실행
3. 결과를 로그에 기록

### 향후 (2단계)

- Git 연동 (push → webhook → deploy)
- 롤백 (이전 버전 보관 + 복원)

---

## 19. Step Plan (Codex 실행 순서)

> 각 단계는 **이전 단계가 완료된 후** 진행한다.

### Step 1: 프로젝트 초기화

- [ ] `/paas/.env` 파일 생성 (Section 6 참조)
- [ ] 디렉토리 구조 생성 (Section 8 참조)
- [ ] Docker 네트워크 생성: `docker network create paas-proxy`
- [ ] NPM 컨테이너에 네트워크 연결: `docker network connect paas-proxy <npm-container-name>`

### Step 2: 공용 런타임 이미지

- [ ] `/paas/runtime/Dockerfile` 작성 (Section 9 참조)
- [ ] 이미지 빌드: `docker build -t my-paas-node-runtime:latest .`

### Step 3: 템플릿 준비

- [ ] `/paas/templates/diary-v1/template.json` 작성
- [ ] `/paas/templates/diary-v1/app/server.js` 작성 (정적 서빙 + 선택적 API)
- [ ] `/paas/templates/diary-v1/app/index.html` 작성 (일기장 UI)

### Step 4: Runner 스크립트

- [ ] `/paas/scripts/create.sh` 작성
- [ ] `/paas/scripts/deploy.sh` 작성
- [ ] `/paas/scripts/delete.sh` 작성
- [ ] 스크립트 단독 테스트: 수동으로 앱 1개 생성/삭제 확인

### Step 5: Portal API

- [ ] `/paas/portal/package.json` 생성 (`express`, `dotenv`, `better-sqlite3`, `bcryptjs` 의존성)
- [ ] `/paas/portal/server.js` 작성 (라우트, 미들웨어, Runner 호출)
- [ ] `/paas/portal/authService.js` 작성 (인증/세션/API Key)
- [ ] 로그인/로그아웃/비밀번호 변경 API 구현
- [ ] API Key 발급/폐기 API 구현
- [ ] `/apps` 보호 미들웨어 (세션 또는 API Key)
- [ ] 초기 `admin/admin` 생성 + 비밀번호 변경 강제
- [ ] 유효성 검증 (naming, 앱 수 제한)
- [ ] 에러 핸들링

### Step 6: 통합 테스트

- [ ] `POST /auth/login` (admin 로그인) 확인
- [ ] 첫 로그인 시 비밀번호 변경 강제 확인
- [ ] `POST /auth/change-password` 동작 확인
- [ ] `POST /api-keys` 발급 + `GET /api-keys` 목록 확인
- [ ] Portal 시작 → `POST /apps` → 앱 생성 확인
- [ ] 컨테이너 running 상태 확인
- [ ] `GET /apps` → 목록 조회 확인
- [ ] `POST .../stop` → `POST .../start` → 동작 확인
- [ ] `DELETE /apps/...` → 정리 확인
- [ ] 로그 조회 확인

### Step 7: NPM 수동 연동

- [ ] NPM에서 Proxy Host 수동 추가 (운영자가 직접)
- [ ] `{userid}-{appname}.${PAAS_DOMAIN}` 접속 테스트

---

## 20. Done Criteria (MVP 성공 기준)

- [ ] `POST /apps`로 앱 생성 → **1분 내 컨테이너 running**
- [ ] NPM 설정 후 `{userid}-{appname}.${PAAS_DOMAIN}` 접속 시 일기장 페이지 표시
- [ ] 앱 컨테이너에 메모리/CPU 제한, 재시작 정책 적용 확인
- [ ] 앱별 `/app` (코드, read-only), `/data` (데이터, writable) 분리
- [ ] 인증 없는 `/apps` 요청이 `401`로 거부됨
- [ ] 초기 `admin` 로그인 후 비밀번호 변경 전 `/apps` 접근이 `403`으로 거부됨
- [ ] 로그인 후 `/api-keys`에서 발급/폐기 동작 확인
- [ ] `POST .../deploy`로 컨테이너 재시작 동작
- [ ] `DELETE /apps/...`로 컨테이너 + 폴더 정리 동작
- [ ] 환경변수(`.env`)만 변경하면 도메인/리소스 설정이 전체 반영됨

---

## 21. 결정 사항 요약 (Open Questions 해소)

| 질문 | MVP 결정 |
|---|---|
| 템플릿 범위 | 정적 + API 모두 포함 (`enableApi` 플래그로 선택) |
| NPM 자동 설정 | MVP에서는 **수동**, 2단계에서 API 자동화 |
| userid/appname 규칙 | 영문 소문자+숫자(+하이픈), 정규식으로 검증 |
| 앱 삭제 시 data | 기본 **보존** (`keepData: true` 기본값) |
| Portal 인증 | 로그인 세션 + 발급 API Key (레거시 `PORTAL_API_KEY` fallback) |
| 포트 할당 | 앱 내부 포트 고정 3000, 외부 노출 없음 (NPM이 컨테이너명으로 접근) |
| 도메인 관리 | `.env`의 `PAAS_DOMAIN`으로 일원 관리 |
| 네트워크 분리 | 기존 `proxy`와 별도로 `paas-proxy` 생성, NPM만 양쪽 연결 |

---

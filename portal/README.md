# Mini PaaS Portal

Express 기반 Portal API + 관리 대시보드입니다.

## 실행

```bash
cd portal
npm install
npm start
```

- 기본 주소: `http://localhost:3000`
- 기본 관리자 계정: `admin / admin` (첫 로그인 후 비밀번호 변경 필수)
- `.env`가 있으면 루트(`../.env`) 값을 우선 로드합니다.
- UI 라우트: `/auth`(로그인), `/`(대시보드, 미로그인 시 `/auth`로 리다이렉트)

## 호스트 분리 + Access List

`admin` 로그인을 퍼블릭 도메인에서 막으려면 아래를 `.env`에 설정하세요.

```env
PORTAL_HOST_SPLIT_ENABLED=true
PORTAL_PUBLIC_HOST=portal.my.domain.com
PORTAL_ADMIN_HOST=portal-admin.my.domain.com
PORTAL_ADMIN_ALLOWED_IPS=10.0.0.12,10.0.0.20
```

- `PORTAL_ADMIN_HOST`로 들어온 요청만 `/apps`, `/api-keys`, `/auth/change-password` 접근 가능
- `admin` 계정 로그인도 `PORTAL_ADMIN_HOST`에서만 허용
- `PORTAL_ADMIN_ALLOWED_IPS`를 채우면 서버에서도 IP allowlist를 추가로 강제

Nginx Proxy Manager 권장 구성:

1. `portal.my.domain.com` Proxy Host 생성 (퍼블릭)
2. `portal-admin.my.domain.com` Proxy Host 생성 (내부 관리용)
3. admin host에 NPM `Access List` 연결 (ID/PW 또는 IP 제한)
4. 두 호스트 모두 동일한 Portal 컨테이너(`paas-portal:3000`)로 포워딩

## 주요 API

- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/change-password`
- `GET /api-keys`
- `POST /api-keys`
- `DELETE /api-keys/:id`
- `POST /apps`
- `GET /apps`
- `GET /apps/:userid/:appname`
- `POST /apps/:userid/:appname/start`
- `POST /apps/:userid/:appname/stop`
- `POST /apps/:userid/:appname/deploy`
- `DELETE /apps/:userid/:appname`
- `GET /apps/:userid/:appname/logs?lines=100`

`/apps` 요청은 로그인 세션(쿠키) 또는 `X-API-Key`(발급 키) 인증이 필요합니다.

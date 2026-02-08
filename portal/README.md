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

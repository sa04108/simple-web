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

## 컨테이너 실행 참고

- Portal을 컨테이너로 띄우는 경우 `bash`와 `docker` CLI가 이미지에 있어야 앱 생성/배포 스크립트가 동작합니다.
- 이 저장소의 `docker-compose.yml`은 `portal/Dockerfile`을 사용해 해당 도구를 함께 설치합니다.

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

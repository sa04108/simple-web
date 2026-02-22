// =============================================================================
// server.js - PaaS 포털 진입점
// =============================================================================
// 역할:
//   Express 앱을 초기화하고, 미들웨어·라우터를 조립한 뒤 서버를 시작한다.
//   비즈니스 로직은 각 모듈로 위임되어 있으므로 이 파일은 '조립'만 담당한다.
//
//   모듈 구성:
//     config.js      — env 로딩 및 설정 상수
//     utils.js       — AppError, sendOk/sendError 등 공통 헬퍼
//     authService.js — 인증/세션/사용자 관리
//     appManager.js  — 앱 파일시스템 및 Docker 관리
//     routes/apps.js — /apps 라우트 핸들러
//     routes/users.js — /users 라우트 핸들러 팩토리
// =============================================================================
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const { createAuthService } = require("./authService");
const { AppError, sendOk, sendError } = require("./utils");
const { config, envFilePath, IS_DEV } = require("./config");
const { ensureBaseDirectories } = require("./appManager");
const appsRouter = require("./routes/apps");
const { executeJob } = require("./routes/apps");
const createUsersRouter = require("./routes/users");
const jobsRouter = require("./routes/jobs");
const jobStore = require("./jobStore");

// ── authService 초기화 ────────────────────────────────────────────────────────

const authService = createAuthService({
  dbPath:            config.PORTAL_DB_PATH,
  sessionCookieName: config.SESSION_COOKIE_NAME,
  sessionTtlHours:   config.SESSION_TTL_HOURS,
  cookieSecure:      config.PORTAL_COOKIE_SECURE,
  bcryptRounds:      config.BCRYPT_ROUNDS,
  isDev:             IS_DEV,
  sendOk,
  sendError,
  AppError,
});

// ── Express 앱 조립 ───────────────────────────────────────────────────────────

const app = express();
const publicDir        = path.join(__dirname, "public");
const dashboardPagePath = path.join(publicDir, "index.html");
const authPagePath      = path.join(publicDir, "auth.html");

app.set("trust proxy", config.PORTAL_TRUST_PROXY);
app.use(express.json({ limit: "1mb" }));

// ── 공개 엔드포인트 ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) =>
  sendOk(res, { service: "portal", status: "ok", now: new Date().toISOString() })
);

app.get("/config", (_req, res) =>
  sendOk(res, {
    domain:      config.PAAS_DOMAIN,
    devMode:     IS_DEV,
    traefikPort: IS_DEV ? config.TRAEFIK_HOST_PORT : null,
    limits: {
      maxAppsPerUser: config.MAX_APPS_PER_USER,
      maxTotalApps:   config.MAX_TOTAL_APPS,
    },
    auth: authService.getPublicConfig(),
  })
);

// ── UI 라우팅 ─────────────────────────────────────────────────────────────────

// 세션이 있으면 대시보드로, 없으면 인증 페이지로 리다이렉트하는 헬퍼
function canAccessDashboardUi(req) {
  return Boolean(authService.resolveSessionAuth(req));
}

const APP_VERSION = Date.now().toString();

function serveHtmlWithVersion(res, filePath) {
  const html = fs.readFileSync(filePath, "utf-8").replace(/__APP_VERSION__/g, APP_VERSION);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
}

// / 와 /index.html 은 동일한 대시보드 페이지를 제공한다.
app.get(["/", "/index.html"], (req, res) => {
  if (!canAccessDashboardUi(req)) return res.redirect("/auth");
  return serveHtmlWithVersion(res, dashboardPagePath);
});

app.get("/auth", (req, res) => {
  if (canAccessDashboardUi(req)) return res.redirect("/");
  return serveHtmlWithVersion(res, authPagePath);
});

// 클라이언트 JS 파일 모듈 URL 캐시 버스팅을 위해 __APP_VERSION__ 치환
app.get("/*.js", (req, res, next) => {
  const filePath = path.join(publicDir, req.path);
  if (!fs.existsSync(filePath)) {
    return next();
  }
  try {
    const jsContent = fs.readFileSync(filePath, "utf-8");
    const versionedJs = jsContent.replace(/__APP_VERSION__/g, APP_VERSION);
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=31536000"); // 1년 캐싱 허용 (URL에 버전이 있으므로 안전함)
    return res.send(versionedJs);
  } catch (error) {
    return next(error);
  }
});

// 정적 파일 서빙 (index: false 로 자동 index.html 서빙 비활성화 — 위 라우트로 처리)
app.use(express.static(publicDir, { index: false }));

// ── 인증 라우트 (/auth/login, /auth/logout, /auth/me, /auth/change-password) ──

authService.attachRoutes(app);

// ── 보호된 라우트 ─────────────────────────────────────────────────────────────

// 미들웨어 체인: 세션 검증 → 비밀번호 변경 여부 확인 → 라우터
app.use(
  "/apps",
  authService.requireSessionAuth,
  authService.requirePasswordUpdated,
  appsRouter
);

// /jobs: 세션 검증 → 비밀번호 변경 여부 확인 → job 라우터
app.use(
  "/jobs",
  authService.requireSessionAuth,
  authService.requirePasswordUpdated,
  jobsRouter
);

// 미들웨어 체인: 세션 검증 → admin 권한 확인 → 비밀번호 변경 여부 확인 → 라우터
app.use(
  "/users",
  authService.requireSessionAuth,
  authService.requirePaasAdmin,
  authService.requirePasswordUpdated,
  createUsersRouter(authService)
);

const { exec } = require("node:child_process");
const { promisify } = require("node:util");
const execAsync = promisify(exec);

// Admin 전용 Portal 로그 조회 엔드포인트
app.get(
  "/admin/portal-logs",
  authService.requireSessionAuth,
  authService.requirePaasAdmin,
  authService.requirePasswordUpdated,
  async (req, res, next) => {
    try {
      const requestedLines = Number.parseInt(String(req.query.lines || "120"), 10);
      const lines = Number.isFinite(requestedLines) ? Math.max(1, Math.min(1000, requestedLines)) : 120;
      
      let logs = "";
      try {
        const { stdout, stderr } = await execAsync(`docker logs paas-portal --tail ${lines}`);
        logs = (stdout || "") + (stderr || "");
      } catch (err) {
        logs = (err.stdout || "") + (err.stderr || "");
        if (!logs) throw err;
      }
      
      return sendOk(res, { lines, logs: logs || "No logs available." });
    } catch (error) {
      return next(error);
    }
  }
);

// 매칭되지 않은 /apps, /users, /admin 하위 경로는 404로 처리한다.
app.use(["/apps", "/users", "/admin"], (_req, res) => sendError(res, 404, "Not found"));

// ── 글로벌 에러 핸들러 ────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof SyntaxError && "body" in err) {
    return sendError(res, 400, "Invalid JSON body");
  }
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.message);
  }

  console.error("[portal] unexpected error:", err);
  return sendError(res, 500, "Internal server error");
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────────

async function start() {
  await ensureBaseDirectories();
  await authService.init();

  // jobStore 초기화 및 서버 재시작 복원
  jobStore.init(config.PORTAL_DB_PATH);
  await jobStore.recoverOnStartup(executeJob);

  app.listen(config.PORTAL_PORT, () => {
    console.log(`[portal] listening on http://localhost:${config.PORTAL_PORT}`);
    console.log(`[portal] env: ${envFilePath}`);
    console.log(`[portal] apps dir: ${config.PAAS_APPS_DIR}`);
    console.log(`[portal] db: ${authService.getDbPath()}`);
  });
}

start().catch((error) => {
  console.error("[portal] failed to start:", error);
  process.exit(1);
});

// =============================================================================
// routes/apps.js - /apps 라우트 핸들러
// =============================================================================
// 역할:
//   앱 생명주기 관련 모든 HTTP 엔드포인트를 제공한다.
//   인증/권한 미들웨어는 server.js에서 이 라우터 앞에 적용된다.
// =============================================================================
"use strict";

const express = require("express");
const { ROLE_ADMIN } = require("../authService");
const { AppError, normalizeBoolean, sendOk } = require("../utils");
const { config, IS_DEV, RUNNER_SCRIPTS } = require("../config");
const {
  getAppDir,
  validateAppParams,
  assertUserId,
  assertAppName,
  pathExists,
  readContainerName,
  buildAppInfo,
  ensureAppExists,
  normalizeStatus,
  listDockerApps,
  getDockerContainerStatus,
  runRunnerScript,
  runDockerCompose,
  patchComposeEnvFile,
  readEnvFile,
  writeEnvFile,
  runContainerExec,
  runContainerComplete,
} = require("../appManager");

const router = express.Router();

// ── 요청 컨텍스트 파싱 ───────────────────────────────────────────────────────

// POST /apps 요청 바디에서 앱 생성에 필요한 필드를 추출하고 검증한다.
function validateCreateBody(body) {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "Request body is required");
  }
  const appname  = String(body.appname  || "").trim();
  const repoUrl  = String(body.repoUrl  || "").trim();
  const branch   = String(body.branch   || "main").trim() || "main";

  assertAppName(appname);

  if (!repoUrl) {
    throw new AppError(400, "repoUrl is required");
  }
  if (!/^https?:\/\//.test(repoUrl)) {
    throw new AppError(400, "repoUrl must start with http:// or https://");
  }

  return { appname, repoUrl, branch };
}

// 로그인된 사용자의 userid를 req.auth에서 추출한다.
// 세션에 username이 없거나 정규식 불일치 시 401 에러를 던진다.
function resolveRequestUserId(req) {
  const userid = String(req.auth?.user?.username || "").trim().toLowerCase();
  if (!userid) throw new AppError(401, "Unauthorized");
  assertUserId(userid);
  return userid;
}

// URL 파라미터(:userid, :appname)를 검증하고, 접근 권한을 확인한 뒤 appDir을 반환한다.
// admin은 모든 앱에 직접 접근할 수 있다(운영 목적).
// 일반 사용자는 본인 앱에만 접근할 수 있다.
// 대시보드 목록(GET /apps)은 별도로 본인 앱만 필터링하므로,
// 이 함수는 단건 접근(start/stop/deploy/delete/logs/exec/env)에만 사용된다.
async function resolveAppRequestContext(req) {
  const userid  = String(req.params?.userid  || "").trim();
  const appname = String(req.params?.appname || "").trim();
  validateAppParams(userid, appname);

  const user = req.auth?.user;
  if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
    throw new AppError(403, "Forbidden");
  }

  const appDir = await ensureAppExists(userid, appname);
  return { userid, appname, appDir };
}

// ── 앱 CRUD ───────────────────────────────────────────────────────────────────

// POST /apps — create.sh를 통해 앱 디렉터리 생성, repo clone, compose 파일 생성
router.post("/", async (req, res, next) => {
  try {
    const userid = resolveRequestUserId(req);
    const { appname, repoUrl, branch } = validateCreateBody(req.body);

    const { apps: existingApps } = await listDockerApps();
    if (existingApps.length >= config.MAX_TOTAL_APPS) {
      throw new AppError(429, `MAX_TOTAL_APPS exceeded (${config.MAX_TOTAL_APPS})`);
    }
    const userAppCount = existingApps.filter((item) => item.userid === userid).length;
    if (userAppCount >= config.MAX_APPS_PER_USER) {
      throw new AppError(429, `MAX_APPS_PER_USER exceeded (${config.MAX_APPS_PER_USER})`);
    }

    const targetAppDir = getAppDir(userid, appname);
    if (await pathExists(targetAppDir)) {
      throw new AppError(409, "App already exists");
    }

    // create.sh 내부에서 .paas-meta.json을 작성하므로 별도 writeAppMeta 불필요
    const scriptResult = await runRunnerScript(RUNNER_SCRIPTS.create, [userid, appname, repoUrl, branch]);
    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(res, { app: appInfo, output: scriptResult.stdout || "created" }, 201);
  } catch (error) {
    return next(error);
  }
});

// GET /apps — 현재 로그인 사용자의 앱 목록 조회 (admin 포함 본인 앱만)
router.get("/", async (req, res, next) => {
  try {
    const { apps: dockerApps, hasLabelErrors } = await listDockerApps();
    const user = req.auth?.user;
    // 모든 사용자(admin 포함)는 본인이 생성한 앱만 대시보드에서 조회한다.
    const visibleApps = dockerApps.filter((item) => String(item.userid).toLowerCase() === String(user?.username || "").toLowerCase());
    const appDetails = await Promise.all(
      visibleApps.map((appItem) => buildAppInfo(appItem.userid, appItem.appname, appItem))
    );

    const apps = appDetails
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        if (aTime !== bTime) return bTime - aTime;
        return `${a.userid}/${a.appname}`.localeCompare(`${b.userid}/${b.appname}`);
      });

    return sendOk(res, { apps, total: apps.length, hasLabelErrors });
  } catch (error) {
    return next(error);
  }
});

// GET /apps/:userid/:appname — 단일 앱 정보 조회
router.get("/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(res, { app: appInfo });
  } catch (error) {
    return next(error);
  }
});

// ── 앱 생명주기 제어 ──────────────────────────────────────────────────────────

// POST /apps/:userid/:appname/start — docker compose up -d
router.post("/:userid/:appname/start", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const result = await runDockerCompose(appDir, ["up", "-d"]);
    const status = await getDockerContainerStatus(appDir);
    return sendOk(res, { status: normalizeStatus(status), output: result.stdout || "started" });
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/stop — docker compose stop
router.post("/:userid/:appname/stop", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const result = await runDockerCompose(appDir, ["stop"]);
    return sendOk(res, { status: "stopped", output: result.stdout || "stopped" });
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/deploy — deploy.sh (git pull + 이미지 재빌드 + 재시작)
router.post("/:userid/:appname/deploy", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const result = await runRunnerScript(RUNNER_SCRIPTS.deploy, [userid, appname]);
    return sendOk(res, { output: result.stdout || "deployed" });
  } catch (error) {
    return next(error);
  }
});

// DELETE /apps/:userid/:appname — delete.sh (컨테이너 제거 + 앱 디렉터리 삭제)
router.delete("/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const keepData = normalizeBoolean(req.body?.keepData, false);
    const args = [userid, appname];
    if (keepData) args.push("--keep-data");

    const result = await runRunnerScript(RUNNER_SCRIPTS.delete, args);
    return sendOk(res, { deleted: true, keepData, output: result.stdout || "deleted" });
  } catch (error) {
    return next(error);
  }
});

// ── 로그 ──────────────────────────────────────────────────────────────────────

// GET /apps/:userid/:appname/logs?lines=N — docker compose logs
router.get("/:userid/:appname/logs", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const requestedLines = Number.parseInt(String(req.query.lines || "120"), 10);
    const lines = Number.isFinite(requestedLines) ? Math.max(1, Math.min(1000, requestedLines)) : 120;

    const result = await runDockerCompose(appDir, ["logs", "--no-color", "--tail", String(lines), "app"]);
    return sendOk(res, { lines, logs: result.stdout || "" });
  } catch (error) {
    return next(error);
  }
});

// ── Exec ──────────────────────────────────────────────────────────────────────

// POST /apps/:userid/:appname/exec — 컨테이너 내부에서 임의 명령 실행
// 30초 타임아웃이 적용되며, 비정상 종료여도 stdout/stderr는 그대로 반환한다.
router.post("/:userid/:appname/exec", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);

    const command = String(req.body?.command || "").trim();
    if (!command) throw new AppError(400, "command is required");
    if (command.length > 2048) throw new AppError(400, "command too long (max 2048 chars)");

    // --workdir 옵션으로 Docker가 프로세스 cwd를 직접 설정한다.
    // shell-level `cd &&` 방식보다 명확하고 신뢰도가 높다.
    const cwd = String(req.body?.cwd || "").trim();

    const containerName = await readContainerName(appDir);
    if (!containerName) throw new AppError(404, "Container not found for this app");

    const { stdout, stderr } = await runContainerExec(containerName, command, cwd);
    return sendOk(res, { command, output: stdout, stderr });
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/exec/complete — 컨테이너 내부 경로 탭 완성
// sh glob을 통해 partial 문자열로 시작하는 파일/디렉터리 목록을 반환한다.
router.post("/:userid/:appname/exec/complete", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);

    const partial = String(req.body?.partial ?? "");
    if (partial.length > 512) throw new AppError(400, "partial too long (max 512 chars)");

    const cwd = String(req.body?.cwd || "").trim();

    const containerName = await readContainerName(appDir);
    if (!containerName) throw new AppError(404, "Container not found for this app");

    const completions = await runContainerComplete(containerName, partial, cwd);
    return sendOk(res, { completions });
  } catch (error) {
    return next(error);
  }
});

// ── 환경변수 ──────────────────────────────────────────────────────────────────

// GET /apps/:userid/:appname/env — .env.paas 파일 내용 조회
router.get("/:userid/:appname/env", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const env = await readEnvFile(appDir);
    return sendOk(res, { env });
  } catch (error) {
    return next(error);
  }
});

// PUT /apps/:userid/:appname/env — .env.paas 파일 저장 후 컨테이너 재시작
// 환경변수 저장 성공/실패와 컨테이너 재시작 성공/실패를 독립적으로 클라이언트에 전달한다.
router.put("/:userid/:appname/env", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const content = String(req.body?.env || "");

    // env_file 항목이 없는 구형 compose 파일에 자동으로 env_file 항목을 추가한다
    await patchComposeEnvFile(appDir);
    await writeEnvFile(appDir, content);

    // 변경된 환경변수를 즉시 반영하기 위해 컨테이너를 재생성·재시작한다
    let restartError = null;
    try {
      await runDockerCompose(appDir, ["up", "-d", "--force-recreate"]);
    } catch (restartErr) {
      restartError = restartErr?.message || "Container restart failed";
    }

    return sendOk(res, { saved: true, restartError });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

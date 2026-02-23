// =============================================================================
// routes/apps.js - /apps 라우트 핸들러
// =============================================================================
// 역할:
//   앱 생명주기 관련 모든 HTTP 엔드포인트를 제공한다.
//   장시간 작업(create/deploy/delete/start/stop)은 즉시 202 + jobId를 반환하고
//   백그라운드에서 비동기 실행한다. 짧은 작업(logs/exec/env 읽기)은 동기 처리한다.
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
  buildAppInfo,
  ensureAppExists,
  findDockerApp,
  normalizeStatus,
  listDockerApps,
  getDockerContainerStatus,
  runRunnerScript,
  runDockerCompose,
  patchComposeEnvFile,
  readEnvFile,
  writeEnvFile,
  getContainerLogs,
  runContainerExec,
  runContainerComplete,
} = require("../appManager");
const jobStore = require("../jobStore");

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
function resolveRequestUserId(req) {
  const userid = String(req.auth?.user?.username || "").trim().toLowerCase();
  if (!userid) throw new AppError(401, "Unauthorized");
  assertUserId(userid);
  return userid;
}

// URL 파라미터(:userid, :appname)를 검증하고 접근 권한을 확인한다.
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

// 비동기 job 생성을 담당하고 즉시 202 응답을 반환하는 공통 헬퍼
function dispatchJob(res, type, meta, userid, extraData = {}) {
  const jobId = jobStore.createJob(type, meta, userid);
  res.status(202).json({ ok: true, data: { jobId, ...extraData } });
  setImmediate(() => executeJob(jobStore.getJob(jobId)));
}

// ── 공용 job 실행 함수 (재시도에도 재사용) ───────────────────────────────────

/**
 * job 객체를 받아 type에 따라 적절한 작업을 실행한다.
 * jobStore.recoverOnStartup() 및 /jobs/:id/retry 엔드포인트에서도 호출된다.
 */
async function executeJob(job) {
  const { id, type, meta } = job;
  const onLog = (line) => jobStore.appendLog(id, line);

  jobStore.startJob(id);
  try {
    switch (type) {
      case "create": {
        const { userid, appname, repoUrl, branch } = meta;
        await runRunnerScript(RUNNER_SCRIPTS.create, [userid, appname, repoUrl, branch], { onLog });
        const appInfo = await buildAppInfo(userid, appname, null);
        jobStore.finishJob(id, JSON.stringify({ app: appInfo }));
        break;
      }
      case "deploy": {
        const { userid, appname } = meta;
        await runRunnerScript(RUNNER_SCRIPTS.deploy, [userid, appname], { onLog });
        if (_onAppDeployedHook) {
          const deployed = await findDockerApp(userid, appname);
          const port = Number(deployed?.port) || 5000;
          _onAppDeployedHook(userid, appname, port);
        }
        jobStore.finishJob(id, "deployed");
        break;
      }
      case "delete": {
        const { userid, appname, keepData } = meta;
        const args = [userid, appname];
        if (keepData) args.push("--keep-data");
        await runRunnerScript(RUNNER_SCRIPTS.delete, args, { onLog });
        if (_onAppDeletedHook) _onAppDeletedHook(userid, appname);
        jobStore.finishJob(id, "deleted");
        break;
      }
      case "start": {
        const { appDir } = meta;
        const result = await runDockerCompose(appDir, ["up", "-d"]);
        const status = await getDockerContainerStatus(appDir);
        jobStore.finishJob(id, JSON.stringify({ status: normalizeStatus(status) }));
        break;
      }
      case "stop": {
        const { appDir } = meta;
        await runDockerCompose(appDir, ["stop"]);
        jobStore.finishJob(id, "stopped");
        break;
      }
      case "env-restart": {
        const { appDir } = meta;
        await runDockerCompose(appDir, ["up", "-d", "--force-recreate"]);
        jobStore.finishJob(id, "restarted");
        break;
      }
      default:
        throw new AppError(500, `Unknown job type: ${type}`);
    }
  } catch (error) {
    const message = error instanceof AppError
      ? error.message
      : (error.message || "Unknown error");
    jobStore.failJob(id, message);
  }
}

// executeJob을 jobs 라우터에 주입 (재시도 기능을 위해)
const jobsRouter = require("./jobs");
jobsRouter.setExecuteJobFn(executeJob);

// ── 앱 이벤트 훅 ─────────────────────────────────────────────────────────────
// server.js에서 domainManager 의존성을 순환 없이 주입하기 위한 훅 패턴
// (jobs.js의 setExecuteJobFn 패턴과 동일)

let _onAppDeletedHook = null;
let _onAppDeployedHook = null;

function setOnAppDeletedHook(fn) { _onAppDeletedHook = fn; }
function setOnAppDeployedHook(fn) { _onAppDeployedHook = fn; }

// ── 앱 CRUD ───────────────────────────────────────────────────────────────────

// POST /apps — 앱 생성 (비동기 job)
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

    dispatchJob(res, "create", { userid, appname, repoUrl, branch }, userid);
  } catch (error) {
    return next(error);
  }
});

// GET /apps — 앱 목록 조회 (기본: 본인 앱, ?all=true & admin: 전체 앱 조회)
router.get("/", async (req, res, next) => {
  try {
    const { apps: dockerApps, hasLabelErrors } = await listDockerApps();
    const user = req.auth?.user;
    const fetchAll = req.query.all === "true" && user?.role === ROLE_ADMIN;
    
    // fetchAll이 true이면 전체 앱을 보이고, 아니면 본인 앱만 필터링한다.
    const visibleApps = fetchAll 
      ? dockerApps 
      : dockerApps.filter((item) => String(item.userid).toLowerCase() === String(user?.username || "").toLowerCase());

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

// POST /apps/:userid/:appname/start — docker compose up -d (비동기 job)
router.post("/:userid/:appname/start", async (req, res, next) => {
  try {
    const { userid, appname, appDir } = await resolveAppRequestContext(req);
    dispatchJob(res, "start", { userid, appname, appDir }, userid);
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/stop — docker compose stop (비동기 job)
router.post("/:userid/:appname/stop", async (req, res, next) => {
  try {
    const { userid, appname, appDir } = await resolveAppRequestContext(req);
    dispatchJob(res, "stop", { userid, appname, appDir }, userid);
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/deploy — deploy.sh (비동기 job)
router.post("/:userid/:appname/deploy", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    dispatchJob(res, "deploy", { userid, appname }, userid);
  } catch (error) {
    return next(error);
  }
});

// DELETE /apps/:userid/:appname — delete.sh (비동기 job)
router.delete("/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const keepData = normalizeBoolean(req.body?.keepData, false);
    dispatchJob(res, "delete", { userid, appname, keepData }, userid);
  } catch (error) {
    return next(error);
  }
});

// ── 로그 ──────────────────────────────────────────────────────────────────────

// GET /apps/:userid/:appname/logs?lines=N — docker logs (동기, compose 파일 불필요)
router.get("/:userid/:appname/logs", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const requestedLines = Number.parseInt(String(req.query.lines || "120"), 10);
    const lines = Number.isFinite(requestedLines) ? Math.max(1, Math.min(1000, requestedLines)) : 120;

    const app = await findDockerApp(userid, appname);
    if (!app?.containerName) throw new AppError(404, "Container not found for this app");

    const logs = await getContainerLogs(app.containerName, lines);
    return sendOk(res, { lines, logs });
  } catch (error) {
    return next(error);
  }
});

// ── Exec ──────────────────────────────────────────────────────────────────────

// POST /apps/:userid/:appname/exec — 컨테이너 내부에서 임의 명령 실행
router.post("/:userid/:appname/exec", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const command = String(req.body?.command || "").trim();
    if (!command) throw new AppError(400, "command is required");
    if (command.length > 2048) throw new AppError(400, "command too long (max 2048 chars)");

    const cwd = String(req.body?.cwd || "").trim();

    const app = await findDockerApp(userid, appname);
    if (!app?.containerName) throw new AppError(404, "Container not found for this app");

    const { stdout, stderr } = await runContainerExec(app.containerName, command, cwd);
    return sendOk(res, { command, output: stdout, stderr });
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/exec/complete — 탭 완성
router.post("/:userid/:appname/exec/complete", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const partial = String(req.body?.partial ?? "");
    if (partial.length > 512) throw new AppError(400, "partial too long (max 512 chars)");

    const cwd = String(req.body?.cwd || "").trim();

    const app = await findDockerApp(userid, appname);
    if (!app?.containerName) throw new AppError(404, "Container not found for this app");

    const completions = await runContainerComplete(app.containerName, partial, cwd);
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

// PUT /apps/:userid/:appname/env — .env.paas 파일 저장 후 컨테이너 재시작 (비동기 job)
router.put("/:userid/:appname/env", async (req, res, next) => {
  try {
    const { userid, appname, appDir } = await resolveAppRequestContext(req);
    const content = String(req.body?.env || "");

    await patchComposeEnvFile(appDir);
    await writeEnvFile(appDir, content);

    dispatchJob(res, "env-restart", { userid, appname, appDir }, userid, { saved: true });
  } catch (error) {
    return next(error);
  }
});

// module.exports = router 이후에도 접근 가능하도록 router 객체에 직접 부착
router.executeJob            = executeJob;
router.setOnAppDeletedHook   = setOnAppDeletedHook;
router.setOnAppDeployedHook  = setOnAppDeployedHook;

module.exports = router;

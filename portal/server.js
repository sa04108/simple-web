// =============================================================================
// server.js - PaaS 포털 메인 API 서버
// =============================================================================
// 역할:
//   미니 PaaS 플랫폼의 중심 서버. 아래 기능을 제공한다.
//   - 사용자 인증 및 세션 관리 (authService 연동)
//   - GitHub repo 기반 앱 생성/배포/시작/중지/삭제 등 라이프사이클 관리
//   - 대시보드 프론트엔드 정적 파일 서빙
//   - 사용자 관리
//
//   셸 스크립트(create.sh, deploy.sh, delete.sh)를 호출하여
//   Docker Compose 기반으로 앱 컨테이너를 제어한다.
// =============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const readline = require("node:readline");

const express = require("express");
const dotenv = require("dotenv");
const { createAuthService, ROLE_ADMIN } = require("./authService");

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..");
const envFilePath = process.env.PAAS_ENV_FILE || path.join(repoRoot, ".env");

dotenv.config({ path: envFilePath });

const paasRoot = process.env.PAAS_ROOT || repoRoot;

// =============================================================================
// 실행 환경 판별 — RUN_MODE 환경변수를 통해 dev/prod를 구분한다.
// =============================================================================
// RUN_MODE=development (docker-compose.dev.yml이 주입):
//   scripts/generate-compose.js → 호스트 포트 직접 노출 (20000-29999 범위)
//                                  로컬 브릿지 네트워크 (external 없음)
// RUN_MODE=production (기본값):
//   scripts/generate-compose.js → 포트 노출 없음, external 네트워크 사용
// .sh 스크립트(create, deploy, delete)는 dev/prod 공통이다.
const config = {
  PAAS_DOMAIN: process.env.PAAS_DOMAIN || "my.domain.com",
  PAAS_APPS_DIR: process.env.PAAS_APPS_DIR || path.join(paasRoot, "apps"),
  PAAS_SCRIPTS_DIR: process.env.PAAS_SCRIPTS_DIR ||
    path.join(paasRoot, "scripts"),
  PORTAL_PORT: toPositiveInt(process.env.PORTAL_PORT, 3000),
  PORTAL_DB_PATH: process.env.PORTAL_DB_PATH || path.join(paasRoot, "portal-data", "portal.sqlite3"),
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || "portal_session",
  SESSION_TTL_HOURS: toPositiveInt(process.env.SESSION_TTL_HOURS, 168),
  PORTAL_COOKIE_SECURE: normalizeBoolean(process.env.PORTAL_COOKIE_SECURE, false),
  BCRYPT_ROUNDS: toPositiveInt(process.env.BCRYPT_ROUNDS, 10),
  MAX_APPS_PER_USER: toPositiveInt(process.env.MAX_APPS_PER_USER, 5),
  MAX_TOTAL_APPS: toPositiveInt(process.env.MAX_TOTAL_APPS, 20),
  PORTAL_TRUST_PROXY: normalizeBoolean(process.env.PORTAL_TRUST_PROXY, true)
};

const USER_ID_REGEX = /^[a-z][a-z0-9]{2,19}$/;
const APP_NAME_REGEX = /^[a-z][a-z0-9-]{2,29}$/;
const APP_META_FILE = ".paas-meta.json";
const APP_COMPOSE_FILE = "docker-compose.yml";

// dev/prod 환경 분기는 scripts/generate-compose.js가 RUN_MODE 환경변수로 처리한다.
// .sh 스크립트는 환경에 무관하게 동일한 scripts/ 루트에 위치한다.
const RUNNER_SCRIPTS = {
  create: 'create.sh',
  deploy: 'deploy.sh',
  delete: 'delete.sh',
};

class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

function toPositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallbackValue;
}

function sendOk(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    ok: true,
    data
  });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({
    ok: false,
    error: message
  });
}

function canAccessDashboardUi(req) {
  const sessionAuth = authService.resolveSessionAuth(req);
  return Boolean(sessionAuth);
}

const authService = createAuthService({
  dbPath: config.PORTAL_DB_PATH,
  sessionCookieName: config.SESSION_COOKIE_NAME,
  sessionTtlHours: config.SESSION_TTL_HOURS,
  cookieSecure: config.PORTAL_COOKIE_SECURE,
  bcryptRounds: config.BCRYPT_ROUNDS,
  sendOk,
  sendError,
  AppError
});

async function readContainerName(appDir) {
  const composePath = path.join(appDir, APP_COMPOSE_FILE);
  try {
    const content = await fs.readFile(composePath, "utf8");
    const match = content.match(/^\s+container_name:\s+"(.+)"\s*$/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function domainName(userid, appname) {
  return `${userid}-${appname}.${config.PAAS_DOMAIN}`;
}

function getAppDir(userid, appname) {
  return path.join(config.PAAS_APPS_DIR, userid, appname);
}

function getRunnerPath(scriptName) {
  return path.join(config.PAAS_SCRIPTS_DIR, scriptName);
}

function summarizeCommandError(error) {
  const combined = [String(error.stderr || ""), String(error.stdout || "")]
    .join("\n")
    .trim();

  const text = combined || error.message || "Unknown command failure";

  // git·docker 진행 메시지(remote: ..., Receiving objects: ...)는 앞쪽에 쌓이고
  // 실제 에러(fatal: ...)는 뒤에 위치한다. 마지막 5줄만 추려 실제 원인을 노출한다.
  const meaningfulLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return meaningfulLines.slice(-5).join("\n");
}

function assertUserId(userid) {
  if (!USER_ID_REGEX.test(userid)) {
    throw new AppError(400, "Invalid userid. Expected /^[a-z][a-z0-9]{2,19}$/");
  }
}

function assertAppName(appname) {
  if (!APP_NAME_REGEX.test(appname)) {
    throw new AppError(400, "Invalid appname. Expected /^[a-z][a-z0-9-]{2,29}$/");
  }
}

function validateAppParams(userid, appname) {
  assertUserId(userid);
  assertAppName(appname);
}

function validateCreateBody(body) {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "Request body is required");
  }
  const appname = String(body.appname || "").trim();
  const repoUrl = String(body.repoUrl || "").trim();
  const branch = String(body.branch || "main").trim() || "main";

  assertAppName(appname);

  if (!repoUrl) {
    throw new AppError(400, "repoUrl is required");
  }
  if (!/^https?:\/\//.test(repoUrl)) {
    throw new AppError(400, "repoUrl must start with http:// or https://");
  }

  return { appname, repoUrl, branch };
}

function resolveRequestUserId(req) {
  const userid = String(req.auth?.user?.username || "").trim().toLowerCase();
  if (!userid) {
    throw new AppError(401, "Unauthorized");
  }
  assertUserId(userid);
  return userid;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureBaseDirectories() {
  await fs.mkdir(config.PAAS_APPS_DIR, { recursive: true });
  await fs.mkdir(config.PAAS_SCRIPTS_DIR, { recursive: true });
}

async function safeReadDir(targetDir) {
  try {
    return await fs.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listFilesystemApps() {
  const userDirs = await safeReadDir(config.PAAS_APPS_DIR);
  const apps = [];

  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) {
      continue;
    }
    const userid = userDir.name;
    if (!USER_ID_REGEX.test(userid)) {
      continue;
    }
    const userPath = path.join(config.PAAS_APPS_DIR, userid);
    const appDirs = await safeReadDir(userPath);

    for (const appDirEntry of appDirs) {
      if (!appDirEntry.isDirectory()) {
        continue;
      }
      const appname = appDirEntry.name;
      if (!APP_NAME_REGEX.test(appname)) {
        continue;
      }
      apps.push({
        userid,
        appname,
        appDir: path.join(userPath, appname)
      });
    }
  }

  return apps;
}

async function readAppMeta(appDir) {
  const metaPath = path.join(appDir, APP_META_FILE);
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[portal] readAppMeta failed:", metaPath, error.message);
    }
    return null;
  }
}

async function runCommand(command, args, options = {}) {
  if (options.stream) {
    return runCommandStreaming(command, args, options);
  }
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });

  return {
    stdout: String(result.stdout || "").trimEnd(),
    stderr: String(result.stderr || "").trimEnd()
  };
}

function runCommandStreaming(command, args, options = {}) {
  const tag = options.logTag || command;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true
    });

    const stdoutLines = [];
    const stderrLines = [];

    readline
      .createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on("line", (line) => {
        stdoutLines.push(line);
        console.log(`[portal][${tag}] ${line}`);
      });

    readline
      .createInterface({ input: child.stderr, crlfDelay: Infinity })
      .on("line", (line) => {
        stderrLines.push(line);
        console.error(`[portal][${tag}] ${line}`);
      });

    child.on("close", (code) => {
      const stdout = stdoutLines.join("\n").trimEnd();
      const stderr = stderrLines.join("\n").trimEnd();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = Object.assign(
          new Error(`Command failed with exit code ${code}`),
          { stdout, stderr }
        );
        reject(error);
      }
    });

    child.on("error", reject);
  });
}

async function runRunnerScript(scriptName, args) {
  const safeScriptName = path.basename(String(scriptName || "").trim());
  if (!safeScriptName || safeScriptName !== scriptName) {
    throw new AppError(500, `Invalid runner script name: ${scriptName}`);
  }

  const scriptPath = getRunnerPath(safeScriptName);
  if (!(await pathExists(scriptPath))) {
    throw new AppError(503, `Runner script not found: ${safeScriptName}`);
  }

  console.log(`[portal] running ${safeScriptName} args=[${args.join(", ")}]`);
  try {
    const result = await runCommand("bash", [`./${safeScriptName}`, ...args], {
      cwd: config.PAAS_SCRIPTS_DIR,
      stream: true,
      logTag: safeScriptName
    });
    dockerStatusCache.ts = 0;
    console.log(`[portal] ${safeScriptName} completed`);
    return result;
  } catch (error) {
    dockerStatusCache.ts = 0;
    console.error(`[portal] ${safeScriptName} failed`);
    if (error.code === "ENOENT") {
      throw new AppError(503, "bash command is not available");
    }
    throw new AppError(500, `${safeScriptName} failed: ${summarizeCommandError(error)}`);
  }
}

async function runDockerCompose(appDir, args) {
  const composePath = path.join(appDir, APP_COMPOSE_FILE);
  if (!(await pathExists(composePath))) {
    throw new AppError(404, `${APP_COMPOSE_FILE} not found for this app`);
  }

  try {
    const result = await runCommand("docker", ["compose", "-f", APP_COMPOSE_FILE, ...args], {
      cwd: appDir
    });
    dockerStatusCache.ts = 0;
    return result;
  } catch (error) {
    dockerStatusCache.ts = 0;
    if (error.code === "ENOENT") {
      throw new AppError(503, "docker command is not available");
    }
    throw new AppError(502, `docker compose failed: ${summarizeCommandError(error)}`);
  }
}

async function getDockerContainerStatus(appDir, containerName = null) {
  const targetContainer = containerName ?? await readContainerName(appDir);
  if (!targetContainer) {
    return "not-found";
  }
  try {
    const { stdout } = await runCommand("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^/${targetContainer}$`,
      "--format",
      "{{.Status}}"
    ]);
    const firstLine = stdout.split(/\r?\n/).filter(Boolean)[0];
    return firstLine || "not-found";
  } catch (error) {
    if (error.code === "ENOENT") {
      return "docker-unavailable";
    }
    return "unknown";
  }
}

const dockerStatusCache = { map: new Map(), ts: 0, TTL: 5000 };

async function listDockerStatuses() {
  const now = Date.now();
  if (now - dockerStatusCache.ts < dockerStatusCache.TTL) {
    return dockerStatusCache.map;
  }

  const statusMap = new Map();
  try {
    const { stdout } = await runCommand("docker", [
      "ps",
      "-a",
      "--filter",
      "label=paas.type=user-app",
      "--format",
      "{{.Names}}\t{{.Status}}"
    ]);
    if (!stdout) {
      dockerStatusCache.map = statusMap;
      dockerStatusCache.ts = now;
      return statusMap;
    }

    const lines = stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const [name, ...statusParts] = line.split("\t");
      const status = statusParts.join("\t").trim();
      if (name) {
        statusMap.set(name.trim(), status || "unknown");
      }
    }
    dockerStatusCache.map = statusMap;
    dockerStatusCache.ts = now;
    return statusMap;
  } catch {
    return statusMap;
  }
}

function normalizeStatus(statusText) {
  const raw = String(statusText || "").trim();
  const normalized = raw.toLowerCase();
  if (!raw) {
    return "unknown";
  }
  if (normalized === "docker-unavailable") {
    return "docker-unavailable";
  }
  if (normalized.includes("up")) {
    return "running";
  }
  if (normalized.includes("restarting")) {
    return "restarting";
  }
  if (normalized.includes("created")) {
    return "created";
  }
  if (normalized.includes("exited") || normalized.includes("dead")) {
    return "stopped";
  }
  if (normalized.includes("not-found")) {
    return "not-found";
  }
  return raw;
}

async function buildAppInfo(userid, appname, statusMap) {
  const appDir = getAppDir(userid, appname);
  const exists = await pathExists(appDir);
  if (!exists) {
    return null;
  }

  const metadata = await readAppMeta(appDir);
  const appContainerName = await readContainerName(appDir);
  const rawStatus =
    appContainerName && statusMap instanceof Map && statusMap.has(appContainerName)
      ? statusMap.get(appContainerName)
      : await getDockerContainerStatus(appDir, appContainerName);

  return {
    userid,
    appname,
    domain: domainName(userid, appname),
    containerName: appContainerName,
    status: normalizeStatus(rawStatus),
    rawStatus,
    repoUrl: metadata?.repoUrl || null,
    branch: metadata?.branch || null,
    detectedRuntime: metadata?.detectedRuntime || null,
    createdAt: metadata?.createdAt || null,
    appDir
  };
}

async function ensureAppExists(userid, appname) {
  const appDir = getAppDir(userid, appname);
  if (!(await pathExists(appDir))) {
    throw new AppError(404, "App not found");
  }
  return appDir;
}

async function resolveAppRequestContext(req) {
  const userid = String(req.params?.userid || "").trim();
  const appname = String(req.params?.appname || "").trim();
  validateAppParams(userid, appname);

  const user = req.auth?.user;
  if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
    throw new AppError(403, "Forbidden");
  }

  const appDir = await ensureAppExists(userid, appname);
  return { userid, appname, appDir };
}

const app = express();
const publicDir = path.join(__dirname, "public");
const dashboardPagePath = path.join(publicDir, "index.html");
const authPagePath = path.join(publicDir, "auth.html");

app.set("trust proxy", config.PORTAL_TRUST_PROXY);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  return sendOk(res, {
    service: "portal",
    status: "ok",
    now: new Date().toISOString()
  });
});

app.get("/config", (_req, res) => {
  return sendOk(res, {
    domain: config.PAAS_DOMAIN,
    limits: {
      maxAppsPerUser: config.MAX_APPS_PER_USER,
      maxTotalApps: config.MAX_TOTAL_APPS
    },
    auth: authService.getPublicConfig()
  });
});

app.get("/", (req, res) => {
  if (!canAccessDashboardUi(req)) {
    return res.redirect("/auth");
  }
  return res.sendFile(dashboardPagePath);
});

app.get("/index.html", (req, res) => {
  if (!canAccessDashboardUi(req)) {
    return res.redirect("/auth");
  }
  return res.sendFile(dashboardPagePath);
});

app.get("/auth", (req, res) => {
  if (canAccessDashboardUi(req)) {
    return res.redirect("/");
  }
  return res.sendFile(authPagePath);
});

app.use(express.static(publicDir, { index: false }));

authService.attachRoutes(app);
app.use(
  "/apps",
  authService.requireSessionAuth,
  authService.requirePasswordUpdated
);
app.use(
  "/users",
  authService.requireSessionAuth,
  authService.requirePaasAdmin,
  authService.requirePasswordUpdated
);

app.post("/apps", async (req, res, next) => {
  try {
    const userid = resolveRequestUserId(req);
    const { appname, repoUrl, branch } = validateCreateBody(req.body);

    const existingApps = await listFilesystemApps();
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

    // create.sh이 내부에서 .paas-meta.json을 작성하므로 별도 writeAppMeta 불필요
    const scriptResult = await runRunnerScript(RUNNER_SCRIPTS.create, [
      userid,
      appname,
      repoUrl,
      branch
    ]);

    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(
      res,
      {
        app: appInfo,
        output: scriptResult.stdout || "created"
      },
      201
    );
  } catch (error) {
    return next(error);
  }
});

app.get("/apps", async (req, res, next) => {
  try {
    const fsApps = await listFilesystemApps();
    const user = req.auth?.user;
    const visibleApps = user?.role === ROLE_ADMIN
      ? fsApps
      : fsApps.filter((item) => item.userid === user?.username);
    const dockerStatuses = await listDockerStatuses();
    const appDetails = await Promise.all(
      visibleApps.map((appItem) => buildAppInfo(appItem.userid, appItem.appname, dockerStatuses))
    );

    const apps = appDetails
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        if (aTime !== bTime) {
          return bTime - aTime;
        }
        return `${a.userid}/${a.appname}`.localeCompare(`${b.userid}/${b.appname}`);
      });

    return sendOk(res, {
      apps,
      total: apps.length
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/apps/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(res, { app: appInfo });
  } catch (error) {
    return next(error);
  }
});

app.post("/apps/:userid/:appname/start", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);

    const result = await runDockerCompose(appDir, ["up", "-d"]);
    const status = await getDockerContainerStatus(appDir);
    return sendOk(res, {
      status: normalizeStatus(status),
      output: result.stdout || "started"
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/apps/:userid/:appname/stop", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);

    const result = await runDockerCompose(appDir, ["stop"]);
    return sendOk(res, {
      status: "stopped",
      output: result.stdout || "stopped"
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/apps/:userid/:appname/deploy", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const result = await runRunnerScript(RUNNER_SCRIPTS.deploy, [userid, appname]);
    return sendOk(res, {
      output: result.stdout || "deployed"
    });
  } catch (error) {
    return next(error);
  }
});

app.delete("/apps/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const keepData = normalizeBoolean(req.body?.keepData, false);
    const args = [userid, appname];
    if (keepData) {
      args.push("--keep-data");
    }

    const result = await runRunnerScript(RUNNER_SCRIPTS.delete, args);
    return sendOk(res, {
      deleted: true,
      keepData,
      output: result.stdout || "deleted"
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/apps/:userid/:appname/logs", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);

    const requestedLines = Number.parseInt(String(req.query.lines || "120"), 10);
    const lines = Number.isFinite(requestedLines)
      ? Math.max(1, Math.min(1000, requestedLines))
      : 120;

    const result = await runDockerCompose(appDir, [
      "logs",
      "--no-color",
      "--tail",
      String(lines),
      "app"
    ]);
    return sendOk(res, {
      lines,
      logs: result.stdout || ""
    });
  } catch (error) {
    return next(error);
  }
});

app.use("/apps", (_req, res) => {
  return sendError(res, 404, "Not found");
});

app.get("/users", (_req, res, next) => {
  try {
    const users = authService.listUsers();
    return sendOk(res, {
      users,
      total: users.length
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/users", (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const isAdmin = normalizeBoolean(req.body?.isAdmin, false);
    const user = authService.createUser({
      username,
      password,
      isAdmin
    });
    return sendOk(res, { user }, 201);
  } catch (error) {
    return next(error);
  }
});

app.delete("/users/:id", (req, res, next) => {
  try {
    const targetUserId = Number.parseInt(String(req.params.id || ""), 10);
    const currentPassword = String(req.body?.currentPassword || "");
    const deletedUser = authService.deleteUser({
      actorUserId: req.auth?.user?.id,
      targetUserId,
      currentPassword
    });
    return sendOk(res, {
      user: deletedUser
    });
  } catch (error) {
    return next(error);
  }
});

app.use("/users", (_req, res) => {
  return sendError(res, 404, "Not found");
});

app.use((err, _req, res, _next) => {
  if (res.headersSent) {
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    return sendError(res, 400, "Invalid JSON body");
  }
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.message);
  }

  console.error("[portal] unexpected error:", err);
  return sendError(res, 500, "Internal server error");
});

async function start() {
  await ensureBaseDirectories();
  await authService.init();
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

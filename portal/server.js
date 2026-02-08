"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const express = require("express");
const dotenv = require("dotenv");
const { createAuthService } = require("./authService");

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..");
const envFilePath = process.env.PAAS_ENV_FILE || path.join(repoRoot, ".env");

dotenv.config({ path: envFilePath });

const paasRoot = process.env.PAAS_ROOT || repoRoot;
const config = {
  PAAS_ROOT: paasRoot,
  PAAS_DOMAIN: process.env.PAAS_DOMAIN || "my.domain.com",
  PAAS_APPS_DIR: process.env.PAAS_APPS_DIR || path.join(paasRoot, "apps"),
  PAAS_TEMPLATES_DIR: process.env.PAAS_TEMPLATES_DIR || path.join(paasRoot, "templates"),
  PAAS_SCRIPTS_DIR: process.env.PAAS_SCRIPTS_DIR || path.join(paasRoot, "scripts"),
  PORTAL_PORT: toPositiveInt(process.env.PORTAL_PORT, 3000),
  PORTAL_API_KEY: process.env.PORTAL_API_KEY || "changeme-random-secret",
  PORTAL_DB_PATH: process.env.PORTAL_DB_PATH || path.join(paasRoot, "portal-data", "portal.sqlite3"),
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || "paas_portal_session",
  SESSION_TTL_HOURS: toPositiveInt(process.env.SESSION_TTL_HOURS, 168),
  PORTAL_COOKIE_SECURE: normalizeBoolean(process.env.PORTAL_COOKIE_SECURE, false),
  BCRYPT_ROUNDS: toPositiveInt(process.env.BCRYPT_ROUNDS, 10),
  MAX_APPS_PER_USER: toPositiveInt(process.env.MAX_APPS_PER_USER, 5),
  MAX_TOTAL_APPS: toPositiveInt(process.env.MAX_TOTAL_APPS, 20),
  PORTAL_TRUST_PROXY: normalizeBoolean(process.env.PORTAL_TRUST_PROXY, true),
  PORTAL_HOST_SPLIT_ENABLED: normalizeBoolean(process.env.PORTAL_HOST_SPLIT_ENABLED, false),
  PORTAL_PUBLIC_HOST: normalizeHost(process.env.PORTAL_PUBLIC_HOST || ""),
  PORTAL_ADMIN_HOST: normalizeHost(process.env.PORTAL_ADMIN_HOST || ""),
  PORTAL_ADMIN_ALLOWED_IPS: parseCsvList(process.env.PORTAL_ADMIN_ALLOWED_IPS || "").map(
    normalizeIp
  )
};

const USER_ID_REGEX = /^[a-z][a-z0-9]{2,19}$/;
const APP_NAME_REGEX = /^[a-z][a-z0-9-]{2,29}$/;
const TEMPLATE_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;
const APP_META_FILE = ".paas-meta.json";

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

function parseCsvList(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    )
  );
}

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }

  let host = raw.replace(/^https?:\/\//, "").split("/")[0];
  if (host.startsWith("[")) {
    const endBracket = host.indexOf("]");
    if (endBracket !== -1) {
      host = host.slice(1, endBracket);
      return host;
    }
  }

  const colonIndex = host.indexOf(":");
  if (colonIndex !== -1) {
    host = host.slice(0, colonIndex);
  }
  return host;
}

function normalizeIp(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }
  return raw;
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

function getRequestHost(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const directHost = String(req.headers.host || "").trim();
  return normalizeHost(forwardedHost || directHost || req.hostname || "");
}

function getClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return normalizeIp(forwardedFor || req.ip || req.socket?.remoteAddress || "");
}

function isAdminIpAllowed(clientIp) {
  if (!config.PORTAL_ADMIN_ALLOWED_IPS.length) {
    return true;
  }
  return config.PORTAL_ADMIN_ALLOWED_IPS.includes(normalizeIp(clientIp));
}

function getAdminAccessContext(req) {
  const requestHost = getRequestHost(req);
  const clientIp = getClientIp(req);

  if (!config.PORTAL_HOST_SPLIT_ENABLED) {
    return {
      hostSplitEnabled: false,
      requestHost,
      clientIp,
      isAdminHost: true,
      ipAllowed: true,
      allowed: true,
      reason: null
    };
  }

  if (!config.PORTAL_ADMIN_HOST) {
    return {
      hostSplitEnabled: true,
      requestHost,
      clientIp,
      isAdminHost: false,
      ipAllowed: false,
      allowed: false,
      reason: "admin-host-not-configured"
    };
  }

  const isAdminHost = requestHost === config.PORTAL_ADMIN_HOST;
  const ipAllowed = isAdminIpAllowed(clientIp);
  const allowed = isAdminHost && ipAllowed;

  let reason = null;
  if (!isAdminHost) {
    reason = "wrong-host";
  } else if (!ipAllowed) {
    reason = "ip-not-allowed";
  }

  return {
    hostSplitEnabled: true,
    requestHost,
    clientIp,
    isAdminHost,
    ipAllowed,
    allowed,
    reason
  };
}

function getHostType(req) {
  const requestHost = getRequestHost(req);
  if (!requestHost) {
    return "unknown";
  }
  if (config.PORTAL_ADMIN_HOST && requestHost === config.PORTAL_ADMIN_HOST) {
    return "admin";
  }
  if (config.PORTAL_PUBLIC_HOST && requestHost === config.PORTAL_PUBLIC_HOST) {
    return "public";
  }
  if (config.PORTAL_ADMIN_HOST && requestHost !== config.PORTAL_ADMIN_HOST) {
    return "public";
  }
  return "unknown";
}

function canAccessDashboardUi(req) {
  const sessionAuth = authService.resolveSessionAuth(req);
  if (!sessionAuth) {
    return false;
  }
  if (!config.PORTAL_HOST_SPLIT_ENABLED) {
    return true;
  }
  return getAdminAccessContext(req).allowed;
}

function requireAdminHostAccess(req, _res, next) {
  if (!config.PORTAL_HOST_SPLIT_ENABLED) {
    return next();
  }

  const access = getAdminAccessContext(req);
  if (access.allowed) {
    return next();
  }

  if (access.reason === "wrong-host") {
    return next(
      new AppError(
        403,
        `Admin access is only available via ${config.PORTAL_ADMIN_HOST}`
      )
    );
  }
  if (access.reason === "ip-not-allowed") {
    return next(new AppError(403, "Access denied by admin allowlist"));
  }
  return next(
    new AppError(
      500,
      "Admin host split is enabled but PORTAL_ADMIN_HOST is not configured"
    )
  );
}

function blockAdminLoginFromPublicHost(req, _res, next) {
  if (!config.PORTAL_HOST_SPLIT_ENABLED) {
    return next();
  }
  const username = String(req.body?.username || "")
    .trim()
    .toLowerCase();
  if (username !== "admin") {
    return next();
  }

  const access = getAdminAccessContext(req);
  if (access.allowed) {
    return next();
  }

  if (access.reason === "wrong-host") {
    return next(
      new AppError(
        403,
        `admin login is only available via ${config.PORTAL_ADMIN_HOST}`
      )
    );
  }
  if (access.reason === "ip-not-allowed") {
    return next(new AppError(403, "admin login denied by admin allowlist"));
  }
  return next(
    new AppError(
      500,
      "Admin host split is enabled but PORTAL_ADMIN_HOST is not configured"
    )
  );
}

function validateHostAccessConfig() {
  if (!config.PORTAL_HOST_SPLIT_ENABLED) {
    return;
  }
  if (!config.PORTAL_ADMIN_HOST) {
    throw new Error("PORTAL_ADMIN_HOST is required when PORTAL_HOST_SPLIT_ENABLED=true");
  }
  if (config.PORTAL_PUBLIC_HOST && config.PORTAL_PUBLIC_HOST === config.PORTAL_ADMIN_HOST) {
    throw new Error("PORTAL_PUBLIC_HOST and PORTAL_ADMIN_HOST must be different");
  }
}

const authService = createAuthService({
  dbPath: config.PORTAL_DB_PATH,
  sessionCookieName: config.SESSION_COOKIE_NAME,
  sessionTtlHours: config.SESSION_TTL_HOURS,
  cookieSecure: config.PORTAL_COOKIE_SECURE,
  bcryptRounds: config.BCRYPT_ROUNDS,
  legacyApiKey: config.PORTAL_API_KEY,
  sendOk,
  sendError,
  AppError
});

function containerName(userid, appname) {
  return `paas-app-${userid}-${appname}`;
}

function domainName(userid, appname) {
  return `${userid}-${appname}.${config.PAAS_DOMAIN}`;
}

function getAppDir(userid, appname) {
  return path.join(config.PAAS_APPS_DIR, userid, appname);
}

function getTemplateDir(templateId) {
  return path.join(config.PAAS_TEMPLATES_DIR, templateId);
}

function getRunnerPath(scriptName) {
  return path.join(config.PAAS_SCRIPTS_DIR, scriptName);
}

function summarizeCommandError(error) {
  const stderr = String(error.stderr || "").trim();
  const stdout = String(error.stdout || "").trim();
  if (stderr) {
    return stderr;
  }
  if (stdout) {
    return stdout;
  }
  return error.message || "Unknown command failure";
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

function assertTemplateId(templateId) {
  if (!TEMPLATE_ID_REGEX.test(templateId)) {
    throw new AppError(400, "Invalid templateId format");
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
  const userid = String(body.userid || "").trim();
  const appname = String(body.appname || "").trim();
  const templateId = String(body.templateId || "").trim();
  const enableApi = normalizeBoolean(body.enableApi, false);

  validateAppParams(userid, appname);
  assertTemplateId(templateId);

  return {
    userid,
    appname,
    templateId,
    enableApi
  };
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
  await fs.mkdir(config.PAAS_TEMPLATES_DIR, { recursive: true });
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
    if (error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writeAppMeta(appDir, metaPayload) {
  const metaPath = path.join(appDir, APP_META_FILE);
  const content = JSON.stringify(metaPayload, null, 2);
  await fs.writeFile(metaPath, content, "utf8");
}

async function runCommand(command, args, options = {}) {
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

async function runRunnerScript(scriptName, args) {
  const scriptPath = getRunnerPath(scriptName);
  if (!(await pathExists(scriptPath))) {
    throw new AppError(503, `Runner script not found: ${scriptName}`);
  }

  try {
    return await runCommand("bash", [scriptPath, ...args]);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AppError(503, "bash command is not available");
    }
    throw new AppError(500, `${scriptName} failed: ${summarizeCommandError(error)}`);
  }
}

async function runDockerCompose(appDir, args) {
  const composePath = path.join(appDir, "docker-compose.yml");
  if (!(await pathExists(composePath))) {
    throw new AppError(404, "docker-compose.yml not found for this app");
  }

  try {
    return await runCommand("docker", ["compose", "-f", composePath, ...args], {
      cwd: appDir
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AppError(503, "docker command is not available");
    }
    throw new AppError(502, `docker compose failed: ${summarizeCommandError(error)}`);
  }
}

async function getDockerContainerStatus(userid, appname) {
  const targetContainer = containerName(userid, appname);
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

async function listDockerStatuses() {
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
    return statusMap;
  } catch (error) {
    if (error.code === "ENOENT") {
      return statusMap;
    }
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
  const appContainerName = containerName(userid, appname);
  const rawStatus =
    statusMap instanceof Map && statusMap.has(appContainerName)
      ? statusMap.get(appContainerName)
      : await getDockerContainerStatus(userid, appname);

  return {
    userid,
    appname,
    domain: domainName(userid, appname),
    containerName: appContainerName,
    status: normalizeStatus(rawStatus),
    rawStatus,
    templateId: metadata?.templateId || null,
    enableApi: normalizeBoolean(metadata?.enableApi, false),
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

const app = express();
const publicDir = path.join(__dirname, "public");
const dashboardPagePath = path.join(publicDir, "index.html");
const authPagePath = path.join(publicDir, "auth.html");

app.set("trust proxy", config.PORTAL_TRUST_PROXY);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  return sendOk(res, {
    service: "paas-portal",
    status: "ok",
    now: new Date().toISOString()
  });
});

app.get("/config", (req, res) => {
  const access = getAdminAccessContext(req);
  return sendOk(res, {
    domain: config.PAAS_DOMAIN,
    limits: {
      maxAppsPerUser: config.MAX_APPS_PER_USER,
      maxTotalApps: config.MAX_TOTAL_APPS
    },
    defaults: {
      templateId: "diary-v1",
      adminId: "admin"
    },
    auth: authService.getPublicConfig(),
    security: {
      hostSplitEnabled: config.PORTAL_HOST_SPLIT_ENABLED,
      publicHost: config.PORTAL_PUBLIC_HOST || null,
      adminHost: config.PORTAL_ADMIN_HOST || null,
      adminAccessListEnabled: config.PORTAL_ADMIN_ALLOWED_IPS.length > 0,
      currentHost: getRequestHost(req) || null,
      currentHostType: getHostType(req),
      adminAccessAllowedForRequest: access.allowed
    }
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

app.use("/auth/login", blockAdminLoginFromPublicHost);
app.use("/auth/change-password", requireAdminHostAccess);
app.use("/api-keys", requireAdminHostAccess);
authService.attachRoutes(app);
app.use(
  "/apps",
  requireAdminHostAccess,
  authService.requireAnyAuth,
  authService.requirePaasAdmin,
  authService.requirePasswordUpdated
);
app.use(
  "/users",
  requireAdminHostAccess,
  authService.requireSessionAuth,
  authService.requirePaasAdmin,
  authService.requirePasswordUpdated
);

app.post("/apps", async (req, res, next) => {
  try {
    const { userid, appname, templateId, enableApi } = validateCreateBody(req.body);

    const templateDir = getTemplateDir(templateId);
    if (!(await pathExists(templateDir))) {
      throw new AppError(400, `Template not found: ${templateId}`);
    }

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

    const scriptResult = await runRunnerScript("create.sh", [
      userid,
      appname,
      templateId,
      String(enableApi)
    ]);

    const createdAt = new Date().toISOString();
    let metadataWarning = null;
    try {
      await writeAppMeta(targetAppDir, {
        userid,
        appname,
        templateId,
        enableApi,
        createdAt
      });
    } catch (error) {
      metadataWarning = `metadata write skipped: ${error.message}`;
    }

    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(
      res,
      {
        app: appInfo,
        output: scriptResult.stdout || "created",
        warning: metadataWarning
      },
      201
    );
  } catch (error) {
    return next(error);
  }
});

app.get("/apps", async (_req, res, next) => {
  try {
    const fsApps = await listFilesystemApps();
    const dockerStatuses = await listDockerStatuses();
    const appDetails = await Promise.all(
      fsApps.map((appItem) => buildAppInfo(appItem.userid, appItem.appname, dockerStatuses))
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
    const { userid, appname } = req.params;
    validateAppParams(userid, appname);
    await ensureAppExists(userid, appname);

    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(res, { app: appInfo });
  } catch (error) {
    return next(error);
  }
});

app.post("/apps/:userid/:appname/start", async (req, res, next) => {
  try {
    const { userid, appname } = req.params;
    validateAppParams(userid, appname);
    const appDir = await ensureAppExists(userid, appname);

    const result = await runDockerCompose(appDir, ["up", "-d"]);
    const status = await getDockerContainerStatus(userid, appname);
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
    const { userid, appname } = req.params;
    validateAppParams(userid, appname);
    const appDir = await ensureAppExists(userid, appname);

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
    const { userid, appname } = req.params;
    validateAppParams(userid, appname);
    await ensureAppExists(userid, appname);

    const result = await runRunnerScript("deploy.sh", [userid, appname]);
    return sendOk(res, {
      output: result.stdout || "deployed"
    });
  } catch (error) {
    return next(error);
  }
});

app.delete("/apps/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = req.params;
    validateAppParams(userid, appname);
    await ensureAppExists(userid, appname);

    const keepData = normalizeBoolean(req.body?.keepData, true);
    const args = [userid, appname];
    if (keepData) {
      args.push("--keep-data");
    }

    const result = await runRunnerScript("delete.sh", args);
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
    const { userid, appname } = req.params;
    validateAppParams(userid, appname);
    const appDir = await ensureAppExists(userid, appname);

    const requestedLines = Number.parseInt(String(req.query.lines || "100"), 10);
    const lines = Number.isFinite(requestedLines)
      ? Math.max(1, Math.min(1000, requestedLines))
      : 100;

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
  validateHostAccessConfig();
  await ensureBaseDirectories();
  await authService.init();
  app.listen(config.PORTAL_PORT, () => {
    console.log(`[portal] listening on http://localhost:${config.PORTAL_PORT}`);
    console.log(`[portal] env: ${envFilePath}`);
    console.log(`[portal] apps dir: ${config.PAAS_APPS_DIR}`);
    console.log(`[portal] db: ${authService.getDbPath()}`);
    if (config.PORTAL_HOST_SPLIT_ENABLED) {
      console.log(
        `[portal] host split enabled: admin=${config.PORTAL_ADMIN_HOST}, public=${config.PORTAL_PUBLIC_HOST || "(not set)"}`
      );
      if (config.PORTAL_ADMIN_ALLOWED_IPS.length) {
        console.log(
          `[portal] admin allowlist: ${config.PORTAL_ADMIN_ALLOWED_IPS.join(", ")}`
        );
      }
    }
    if (authService.isLegacyApiKeyEnabled()) {
      console.log("[portal] legacy X-API-Key is enabled from PORTAL_API_KEY");
    }
  });
}

start().catch((error) => {
  console.error("[portal] failed to start:", error);
  process.exit(1);
});

// =============================================================================
// appManager.js - 앱 생명주기 및 Docker/파일시스템 관리
// =============================================================================
// 역할:
//   PaaS 앱의 파일시스템 구조와 Docker 컨테이너를 다루는 모든 도메인 로직을 제공한다.
//   라우트 핸들러에서 직접 호출되며, Express나 HTTP와는 독립적이다.
// =============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const readline = require("node:readline");

const { AppError } = require("./utils");
const {
  config,
  RUNNER_SCRIPTS,
  USER_ID_REGEX,
  APP_NAME_REGEX,
  APP_META_FILE,
  APP_COMPOSE_FILE,
} = require("./config");

const execFileAsync = promisify(execFile);

// .env.paas — 앱별 사용자 정의 환경변수 파일.
// generate-compose.js가 생성하는 docker-compose.yml에 env_file로 주입된다.
const ENV_PAAS_FILE = ".env.paas";

// ── 경로 헬퍼 ─────────────────────────────────────────────────────────────────

function getAppDir(userid, appname) {
  return path.join(config.PAAS_APPS_DIR, userid, appname);
}

function getRunnerPath(scriptName) {
  return path.join(config.PAAS_SCRIPTS_DIR, scriptName);
}

function domainName(userid, appname) {
  return `${userid}-${appname}.${config.PAAS_DOMAIN}`;
}

// ── 입력값 검증 ───────────────────────────────────────────────────────────────

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

// ── 파일시스템 헬퍼 ───────────────────────────────────────────────────────────

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

// ENOENT(디렉터리 없음)는 빈 배열로 처리하고, 그 외 오류는 그대로 던진다.
async function safeReadDir(targetDir) {
  try {
    return await fs.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// ── 앱 목록/메타데이터 ────────────────────────────────────────────────────────

// PAAS_APPS_DIR 하위 디렉터리를 순회하여 유효한 userid/appname 쌍을 반환한다.
// 디렉터리명이 정규식을 통과해야만 유효한 앱으로 인정된다.
async function listFilesystemApps() {
  const userDirs = await safeReadDir(config.PAAS_APPS_DIR);
  const apps = [];

  for (const userDir of userDirs) {
    if (!userDir.isDirectory() || !USER_ID_REGEX.test(userDir.name)) continue;
    const userid = userDir.name;
    const userPath = path.join(config.PAAS_APPS_DIR, userid);
    const appDirs = await safeReadDir(userPath);

    for (const appDirEntry of appDirs) {
      if (!appDirEntry.isDirectory() || !APP_NAME_REGEX.test(appDirEntry.name)) continue;
      apps.push({
        userid,
        appname: appDirEntry.name,
        appDir: path.join(userPath, appDirEntry.name),
      });
    }
  }

  return apps;
}

// .paas-meta.json을 읽어 반환한다. 파일 없음 또는 파싱 실패 시 null을 반환한다.
async function readAppMeta(appDir) {
  const metaPath = path.join(appDir, APP_META_FILE);
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[portal] readAppMeta failed:", metaPath, error.message);
    }
    return null;
  }
}

// docker-compose.yml에서 container_name 값을 추출한다.
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

// ── 앱 정보 조회 ──────────────────────────────────────────────────────────────

// Docker 상태 문자열을 정규화된 키워드로 변환한다.
// docker ps의 Status 컬럼은 "Up 2 hours", "Exited (1) 5 minutes ago" 같은
// 자유 형식이므로, 포함 여부로 판단한다.
function normalizeStatus(statusText) {
  const raw = String(statusText || "").trim();
  const normalized = raw.toLowerCase();
  if (!raw)                                             return "unknown";
  if (normalized === "docker-unavailable")              return "docker-unavailable";
  if (normalized.includes("up"))                        return "running";
  if (normalized.includes("restarting"))                return "restarting";
  if (normalized.includes("created"))                   return "created";
  if (normalized.includes("exited") ||
      normalized.includes("dead"))                      return "stopped";
  if (normalized.includes("not-found"))                 return "not-found";
  return raw;
}

// 앱 하나의 완전한 정보 객체를 빌드한다.
// dockerAppItem이 제공되면 파싱된 값을 사용하고, 없으면 파일시스템/docker ps로 직접 조회한다.
async function buildAppInfo(userid, appname, dockerAppItem = null) {
  const appDir = getAppDir(userid, appname);
  const metadata = await readAppMeta(appDir); // 디렉토리가 없어도 안전하게 null 반환

  let appContainerName = dockerAppItem?.containerName;
  let rawStatus = dockerAppItem?.rawStatus;
  let createdAtStr = dockerAppItem?.createdAt;
  let domainStr = dockerAppItem?.domain;

  if (!dockerAppItem) {
    appContainerName = await readContainerName(appDir);
    rawStatus = await getDockerContainerStatus(appDir, appContainerName);
  }

  return {
    userid,
    appname,
    domain: domainStr || domainName(userid, appname),
    containerName: appContainerName || null,
    status: normalizeStatus(rawStatus),
    rawStatus: rawStatus || "unknown",
    repoUrl: metadata?.repoUrl || null,
    branch: metadata?.branch || null,
    detectedRuntime: metadata?.detectedRuntime || null,
    createdAt: metadata?.createdAt || createdAtStr || null,
    appDir,
  };
}

async function ensureAppExists(userid, appname) {
  const appDir = getAppDir(userid, appname);
  if (!(await pathExists(appDir))) {
    throw new AppError(404, "App not found");
  }
  return appDir;
}

// ── 커맨드 실행 ───────────────────────────────────────────────────────────────

// stderr/stdout 에서 실제 오류 메시지를 추출한다.
// git·docker 진행 메시지(remote: ..., Receiving objects: ...)는 앞에 쌓이고
// 실제 에러(fatal: ...)는 뒤에 위치하므로, 마지막 5줄만 추려 노출한다.
function summarizeCommandError(error) {
  const combined = [String(error.stderr || ""), String(error.stdout || "")]
    .join("\n")
    .trim();

  const text = combined || error.message || "Unknown command failure";
  const meaningfulLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return meaningfulLines.slice(-5).join("\n");
}

// 일반 커맨드 실행 — stream 옵션이 있으면 실시간 로그 출력 모드로 전환한다.
async function runCommand(command, args, options = {}) {
  if (options.stream) {
    return runCommandStreaming(command, args, options);
  }
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout || "").trimEnd(),
    stderr: String(result.stderr || "").trimEnd(),
  };
}

// 실행 중 각 라인을 console에 실시간으로 출력하는 스트리밍 모드.
// create.sh / deploy.sh 같이 오래 걸리는 작업의 진행 상황을 서버 로그로 확인할 수 있다.
function runCommandStreaming(command, args, options = {}) {
  const tag = options.logTag || command;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
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

// .sh 러너 스크립트를 bash로 실행한다.
// 경로 트래버설 방지를 위해 scriptName을 basename으로 검증한다.
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
      logTag: safeScriptName,
    });
    dockerAppsCache.ts = 0; // 실행 후 Docker 갱신을 위해 캐시 무효화
    console.log(`[portal] ${safeScriptName} completed`);
    return result;
  } catch (error) {
    dockerAppsCache.ts = 0;
    console.error(`[portal] ${safeScriptName} failed`);
    if (error.code === "ENOENT") {
      throw new AppError(503, "bash command is not available");
    }
    throw new AppError(500, `${safeScriptName} failed: ${summarizeCommandError(error)}`);
  }
}

// ── Docker 헬퍼 ───────────────────────────────────────────────────────────────

// docker compose 명령을 앱 디렉터리 기준으로 실행한다.
async function runDockerCompose(appDir, args) {
  const composePath = path.join(appDir, APP_COMPOSE_FILE);
  if (!(await pathExists(composePath))) {
    throw new AppError(404, `${APP_COMPOSE_FILE} not found for this app`);
  }

  try {
    const result = await runCommand("docker", ["compose", "-f", APP_COMPOSE_FILE, ...args], {
      cwd: appDir,
    });
    dockerAppsCache.ts = 0; // 실행 후 Docker 상태 캐시를 무효화
    return result;
  } catch (error) {
    dockerAppsCache.ts = 0;
    if (error.code === "ENOENT") {
      throw new AppError(503, "docker command is not available");
    }
    throw new AppError(502, `docker compose failed: ${summarizeCommandError(error)}`);
  }
}

// 특정 컨테이너 하나의 상태를 docker ps로 직접 조회한다.
// listDockerStatuses()의 캐시가 없는 상황에서 단건 조회 시 사용한다.
async function getDockerContainerStatus(appDir, containerName = null) {
  const targetContainer = containerName ?? await readContainerName(appDir);
  if (!targetContainer) return "not-found";
  try {
    const { stdout } = await runCommand("docker", [
      "ps", "-a",
      "--filter", `name=^/${targetContainer}$`,
      "--format", "{{.Status}}",
    ]);
    const firstLine = stdout.split(/\r?\n/).filter(Boolean)[0];
    return firstLine || "not-found";
  } catch (error) {
    if (error.code === "ENOENT") return "docker-unavailable";
    return "unknown";
  }
}

// paas.type=user-app 레이블을 가진 모든 컨테이너 정보를 추출한다.
// TTL(5초) 이내 재요청은 캐시를 반환하여 docker ps 호출 횟수를 줄인다.
const dockerAppsCache = { data: null, ts: 0, TTL: 5000 };

async function listDockerApps() {
  const now = Date.now();
  if (dockerAppsCache.data && now - dockerAppsCache.ts < dockerAppsCache.TTL) {
    return dockerAppsCache.data;
  }

  const result = { apps: [], hasLabelErrors: false };
  try {
    const { stdout } = await runCommand("docker", [
      "ps", "-a",
      "--filter", "label=paas.type=user-app",
      "--format", "{{.Label \"paas.userid\"}}\t{{.Label \"paas.appname\"}}\t{{.Names}}\t{{.Status}}\t{{.Label \"paas.domain\"}}\t{{.CreatedAt}}",
    ]);

    if (stdout) {
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const parts = line.split("\t");
        const uid = parts[0]?.trim();
        const appn = parts[1]?.trim();
        const containerName = parts[2]?.trim();
        const rawStatus = parts[3]?.trim() || "unknown";
        const domain = parts[4]?.trim() || "";
        const createdAt = parts[5]?.trim() || "";

        if (!uid || !appn) {
          result.hasLabelErrors = true;
          continue;
        }

        result.apps.push({
          userid: uid,
          appname: appn,
          containerName,
          rawStatus,
          domain,
          createdAt,
        });
      }
    }

    dockerAppsCache.data = result;
    dockerAppsCache.ts = now;
  } catch {
    // docker 데몬 오류 시 빈 데이터 캐싱
  }

  return result;
}

// ── 환경변수 파일 관리 ────────────────────────────────────────────────────────

// 구형 compose 파일(env_file 항목 없음)에 .env.paas 참조를 자동으로 주입한다.
// generate-compose.js가 생성하는 포맷은 결정적이므로 단순 문자열 치환으로 처리한다.
async function patchComposeEnvFile(appDir) {
  const composePath = path.join(appDir, APP_COMPOSE_FILE);
  let content;
  try {
    content = await fs.readFile(composePath, "utf8");
  } catch {
    return;
  }
  if (content.includes("env_file:")) return;

  const patched = content.replace(
    /^(\s+environment:)/m,
    `    env_file:\n      - ".env.paas"\n$1`
  );
  if (patched !== content) {
    await fs.writeFile(composePath, patched, "utf8");
  }
}

async function readEnvFile(appDir) {
  const envPath = path.join(appDir, ENV_PAAS_FILE);
  try {
    return await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

async function writeEnvFile(appDir, content) {
  const envPath = path.join(appDir, ENV_PAAS_FILE);
  await fs.writeFile(envPath, content, "utf8");
}

// ── 컨테이너 Exec ─────────────────────────────────────────────────────────────

// 컨테이너 내부에서 sh를 통해 임의 명령을 실행하고 { stdout, stderr }를 반환한다.
// cwd가 주어지면 --workdir 옵션으로 Docker가 프로세스 cwd를 직접 설정한다.
// 명령이 비정상 종료여도 stdout/stderr가 있으면 그대로 반환한다.
// 출력이 전혀 없을 때만 합성 에러 메시지를 stderr에 담는다.
async function runContainerExec(containerName, command, cwd) {
  const shellArgs = cwd
    ? ["exec", "--workdir", cwd, containerName, "sh", "-c", command]
    : ["exec", containerName, "sh", "-c", command];

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      "docker",
      shellArgs,
      { timeout: 30000, maxBuffer: 1 * 1024 * 1024, windowsHide: true }
    );
    stdout = String(result.stdout || "").trimEnd();
    stderr = String(result.stderr || "").trimEnd();
  } catch (execError) {
    stdout = String(execError.stdout || "").trimEnd();
    stderr = String(execError.stderr || "").trimEnd();
    if (!stdout && !stderr) {
      if (execError.code === "ENOENT") {
        throw new AppError(503, "docker command is not available");
      }
      stderr = execError.signal === "SIGTERM"
        ? "Command timed out after 30 seconds"
        : execError.message || "Command failed";
    }
  }

  return { stdout, stderr };
}

// 컨테이너 내부에서 POSIX sh glob으로 탭 완성 후보 목록을 반환한다.
// partial을 $1으로 전달하여 셸 인젝션을 방지한다.
// alpine(ash), debian(dash) 등 모든 Unix 컨테이너에서 동작한다.
// cwd가 주어지면 --workdir 옵션으로 탭 완성 기준 경로를 설정한다.
async function runContainerComplete(containerName, partial, cwd) {
  const execArgs = cwd
    ? ["exec", "--workdir", cwd, containerName]
    : ["exec", containerName];

  try {
    const result = await execFileAsync(
      "docker",
      [
        ...execArgs,
        "sh", "-c",
        'for f in "$1"*; do [ -e "$f" ] && printf "%s\\n" "$f"; done',
        "--", partial,
      ],
      { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }
    );
    return String(result.stdout || "")
      .split("\n")
      .map((s) => s.trimEnd())
      .filter(Boolean);
  } catch {
    // sh glob이 엣지 케이스에서 비정상 종료되면 빈 목록을 반환한다.
    return [];
  }
}

module.exports = {
  // 경로
  getAppDir,
  domainName,
  // 검증
  assertUserId,
  assertAppName,
  validateAppParams,
  // 파일시스템
  pathExists,
  ensureBaseDirectories,
  listFilesystemApps,
  readAppMeta,
  readContainerName,
  // 앱 정보
  buildAppInfo,
  ensureAppExists,
  normalizeStatus,
  // 커맨드 실행
  runCommand,
  runRunnerScript,
  runDockerCompose,
  // Docker
  getDockerContainerStatus,
  listDockerApps,
  dockerAppsCache,
  // 환경변수
  patchComposeEnvFile,
  readEnvFile,
  writeEnvFile,
  // 컨테이너 Exec
  runContainerExec,
  runContainerComplete,
};

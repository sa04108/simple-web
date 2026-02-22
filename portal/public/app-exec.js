// =============================================================================
// app-exec.js - Exec 터미널 (명령 실행 · 히스토리 · 탭 완성 · cwd 추적)
// =============================================================================
// 역할:
//   앱 관리 화면의 Exec 탭에서 컨테이너 내부 명령 실행을 처리한다.
//   - 명령 히스토리 (↑/↓ 키 네비게이션)
//   - 탭 완성 (서버 측 sh glob 기반)
//   - cwd 추적 (cd 명령 감지 후 서버 응답에서 새 경로 추출)
//
//   apiFetch는 setExecApiHandlers(...)로 주입받는다.
// =============================================================================

// ── 명령 히스토리 ─────────────────────────────────────────────────────────────

// IIFE로 히스토리 상태를 캡슐화한다.
// 외부에서 직접 stack/cursor에 접근하지 못하게 하여 오염을 방지한다.
import { el, state } from "./app-state.js";
import { normalizeErrorMessage } from "./app-utils.js";

let execApiFetch = null;

function setExecApiHandlers(handlers = {}) {
  if (typeof handlers.apiFetch === "function") {
    execApiFetch = handlers.apiFetch;
  }
}

function requireApiFetch() {
  if (!execApiFetch) {
    throw new Error("Exec API handlers are not configured.");
  }
  return execApiFetch;
}

const execHistory = (() => {
  const MAX   = 200;  // 최대 보존 개수
  const stack = [];
  let cursor  = -1;   // -1 = 히스토리 탐색 중이 아님; 0 = 가장 최근 항목
  let draft   = "";   // 히스토리 탐색 중 사용자가 입력 중이던 텍스트를 임시 보존

  return {
    push(cmd) {
      // 연속 중복 명령은 저장하지 않는다.
      if (stack.at(-1) !== cmd) {
        stack.push(cmd);
        if (stack.length > MAX) stack.shift();
      }
      cursor = -1;
      draft  = "";
    },
    // ↑ 키: 이전 명령으로 이동. 탐색 시작 시 현재 입력을 draft에 보존한다.
    back(current) {
      if (!stack.length) return current;
      if (cursor === -1) draft = current;
      cursor = Math.min(cursor + 1, stack.length - 1);
      return stack[stack.length - 1 - cursor];
    },
    // ↓ 키: 다음 명령으로 이동. 가장 앞으로 돌아오면 draft를 복원한다.
    forward() {
      if (cursor === -1) return null;
      cursor -= 1;
      return cursor === -1 ? draft : stack[stack.length - 1 - cursor];
    },
  };
})();

// ── cwd 추적 ──────────────────────────────────────────────────────────────────

// 컨테이너 내부의 현재 작업 디렉터리. 앱 전환 시 "" 로 초기화된다.
// cd 명령 실행 결과에서 추출하여 갱신하며, exec 요청 시 --workdir 옵션으로 전달한다.
let execCwd = "";

// ── 탭 완성 ───────────────────────────────────────────────────────────────────

// 현재 탭 완성 상태 — 하나의 탭 완성 세션(fetch → cycling)을 추적한다.
let tabState = { base: "", partial: "", matches: [], index: -1, loading: false };

// 탭 완성 요청의 세대 번호 — 숫자가 바뀌면 이전 in-flight 응답을 무시한다.
// 사용자가 Tab 외 키를 누르거나 새 fetch가 시작되면 증가한다.
let tabCompletionGen = 0;

// "cat /etc/pa" → { base: "cat ", partial: "/etc/pa" }
// base: 완성 대상이 아닌 앞부분, partial: 탭 완성을 적용할 마지막 토큰
function splitInputToken(input) {
  const lastSpace = input.lastIndexOf(" ");
  return lastSpace === -1
    ? { base: "", partial: input }
    : { base: input.slice(0, lastSpace + 1), partial: input.slice(lastSpace + 1) };
}

// 탭 완성을 처리한다.
// 이미 결과를 가져온 상태라면 목록을 순환(cycling)하고,
// 새 입력이 들어왔다면 서버에 완성 후보를 요청한다.
async function handleTabCompletion() {
  if (tabState.loading) return;

  const fullInput = el.detailExecInput.value;

  // 이미 완성 결과를 가지고 있고, 현재 입력이 마지막 완성 결과와 일치하면 다음 후보로 순환
  if (
    tabState.matches.length > 0 &&
    tabState.index !== -1 &&
    fullInput === tabState.base + tabState.matches[tabState.index]
  ) {
    tabState.index = (tabState.index + 1) % tabState.matches.length;
    const completed = tabState.base + tabState.matches[tabState.index];
    el.detailExecInput.value = completed;
    el.detailExecInput.setSelectionRange(completed.length, completed.length);
    return;
  }

  if (!state.selectedApp) return;
  const { base, partial } = splitInputToken(fullInput);
  const { userid, appname } = state.selectedApp;

  // 세대 번호를 증가시켜 이전 in-flight 응답이 반환되더라도 무시하도록 한다.
  const gen = ++tabCompletionGen;
  tabState = { base, partial, matches: [], index: -1, loading: true };

  try {
    const data = await requireApiFetch()(`/apps/${userid}/${appname}/exec/complete`, {
      method: "POST",
      body: JSON.stringify({ partial, cwd: execCwd }),
    });
    if (gen !== tabCompletionGen) return; // 더 새로운 요청으로 대체됨
    tabState.matches = data.completions;
  } catch {
    if (gen !== tabCompletionGen) return;
  } finally {
    if (gen === tabCompletionGen) tabState.loading = false;
  }

  if (!tabState.matches.length) return;
  tabState.index = 0;
  const completed = tabState.base + tabState.matches[0];
  el.detailExecInput.value = completed;
  el.detailExecInput.setSelectionRange(completed.length, completed.length);
}

// ── 프롬프트 ──────────────────────────────────────────────────────────────────

// 긴 경로를 "…/dir1/dir2" 형태로 축약하여 프롬프트가 지나치게 길어지지 않게 한다.
function formatCwdDisplay(cwd) {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

function updateExecPrompt() {
  el.detailExecPromptCwd.textContent = formatCwdDisplay(execCwd);
}

// ── cd 감지 ───────────────────────────────────────────────────────────────────

// cd는 셸 내장 명령이라 docker exec의 각 서브셸에서 실행해도 다음 exec에 영향을 주지 않는다.
// 클라이언트에서 cd 명령을 감지하여 `&& pwd`를 붙인 후 새 절대경로를 추출,
// 이후 모든 exec 요청에 --workdir로 전달하는 방식으로 cwd를 에뮬레이션한다.
//
// "cd" → args: ""  (bare cd → HOME으로 이동)
// "cd /tmp" → args: "/tmp"
// "cat foo" → null (cd 아님)
function parseCdArgs(command) {
  const m = command.match(/^cd(?:\s+(.*\S))?$/);
  return m ? (m[1] ?? "") : null;
}

// Exec 탭 진입 시 컨테이너의 실제 초기 cwd를 조회하여 프롬프트에 반영한다.
// 실패해도 조용히 무시하고 프롬프트는 빈 상태로 유지한다.
async function initExecCwd() {
  if (!state.selectedApp || execCwd !== "") return;
  const { userid, appname } = state.selectedApp;
  try {
    const data = await requireApiFetch()(`/apps/${userid}/${appname}/exec`, {
      method: "POST",
      body: JSON.stringify({ command: "pwd", cwd: "" }),
    });
    const cwd = data.output?.trim();
    if (cwd?.startsWith("/")) {
      execCwd = cwd;
      updateExecPrompt();
    }
  } catch {
    // Silent fail — 프롬프트는 bare "$" 상태 유지
  }
}

// ── 명령 출력 ─────────────────────────────────────────────────────────────────

// 출력 터미널에 한 줄을 추가하고 자동 스크롤한다.
function appendExecLine(text, className = "") {
  const line = document.createElement("span");
  if (className) line.className = className;
  line.textContent = text + "\n";
  el.detailExecOutput.appendChild(line);
  el.detailExecOutput.scrollTop = el.detailExecOutput.scrollHeight;
}

// ── 명령 실행 ─────────────────────────────────────────────────────────────────

async function runExecCommand() {
  if (!state.selectedApp) return;
  const command = el.detailExecInput.value.trim();
  if (!command) return;

  execHistory.push(command);
  el.detailExecInput.value = "";

  // "clear"는 클라이언트에서 처리한다. 서버 왕복 없이 즉시 처리.
  if (command === "clear") {
    el.detailExecOutput.innerHTML = "";
    return;
  }

  const { userid, appname } = state.selectedApp;
  el.detailExecRunBtn.disabled = true;
  el.detailExecInput.disabled  = true;
  appendExecLine(`$ ${command}`, "exec-cmd");

  // cd 명령 감지: `cd [path] && pwd` 형태로 실제 이동된 경로를 응답에서 추출한다.
  // pwd 출력(마지막 줄)을 새 cwd로 저장하고, 그 외 출력(rare)은 화면에 표시한다.
  const cdArgs = parseCdArgs(command);
  const isCd   = cdArgs !== null;
  const effectiveCommand = isCd ? `${command} && pwd` : command;

  try {
    const data = await requireApiFetch()(`/apps/${userid}/${appname}/exec`, {
      method: "POST",
      body: JSON.stringify({ command: effectiveCommand, cwd: execCwd }),
    });

    if (isCd) {
      if (data.output) {
        const lines  = data.output.trimEnd().split("\n");
        const newCwd = lines.at(-1);
        if (newCwd?.startsWith("/")) {
          execCwd = newCwd;
          updateExecPrompt();
        }
        // pwd 앞에 cd 자체의 출력이 있는 경우 (극히 드물지만) 화면에 표시한다.
        const extraOutput = lines.slice(0, -1).join("\n").trimEnd();
        if (extraOutput) appendExecLine(extraOutput, "exec-stdout");
      }
      if (data.stderr) appendExecLine(data.stderr, "exec-stderr");
    } else {
      if (data.output) appendExecLine(data.output, "exec-stdout");
      if (data.stderr) appendExecLine(data.stderr, "exec-stderr");
    }
  } catch (error) {
    appendExecLine(normalizeErrorMessage(error, "Exec 요청 중 오류가 발생했습니다."), "exec-stderr");
  } finally {
    el.detailExecRunBtn.disabled = false;
    el.detailExecInput.disabled  = false;
    el.detailExecInput.focus();
  }
}

function resetTabCompletionState() {
  tabCompletionGen += 1;
  tabState = { base: "", partial: "", matches: [], index: -1, loading: false };
}

function resetExecForApp() {
  execCwd = "";
  updateExecPrompt();
  resetTabCompletionState();
}

function historyBack(current) {
  return execHistory.back(current);
}

function historyForward() {
  return execHistory.forward();
}

export {
  handleTabCompletion,
  historyBack,
  historyForward,
  initExecCwd,
  resetExecForApp,
  resetTabCompletionState,
  runExecCommand,
  setExecApiHandlers,
  updateExecPrompt,
};

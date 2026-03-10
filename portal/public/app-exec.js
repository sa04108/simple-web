// =============================================================================
// app-exec.js - Exec 터미널 (명령 실행 · 히스토리 · 탭 완성 · cwd 추적)
// =============================================================================
// 역할:
//   앱 관리 화면의 Exec 탭에서 컨테이너 내부 명령 실행을 처리한다.
//   - 명령 히스토리 (↑/↓ 키 네비게이션)
// 모든 통신은 WebSocket(openExecSocket)을 통해 이루어지며 REST API 의존이 없다.
//
// =============================================================================

// ── 명령 히스토리 ─────────────────────────────────────────────────────────────

import { el, state } from "./app-state.js";
import { normalizeErrorMessage } from "./app-utils.js";

const execHistory = (() => {
  const MAX = 200;  // 최대 보존 개수
  const stack = [];
  let cursor = -1;   // -1 = 히스토리 탐색 중이 아님; 0 = 가장 최근 항목
  let draft = "";   // 히스토리 탐색 중 사용자가 입력 중이던 텍스트를 임시 보존

  return {
    push(cmd) {
      // 연속 중복 명령은 저장하지 않는다.
      if (stack.at(-1) !== cmd) {
        stack.push(cmd);
        if (stack.length > MAX) stack.shift();
      }
      cursor = -1;
      draft = "";
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
let execCwd = "";

// ── WebSocket 세션 ────────────────────────────────────────────────────────────

// 현재 열려 있는 exec WS 소켓. Exec 탭 진입 시 열리고, 이탈 시 닫힌다.
let execWs = null;

// 현재 명령이 실행 중인지 여부. done 메시지 수신 시 false 로 전환된다.
let execRunning = false;

// cd 명령 처리를 위해 실행 중인 명령의 isCd 여부를 저장한다.
let execPendingIsCd = false;
// WS를 통한 탭 완성 응답을 기다리는 pending 상태.
// 새 완성 요청이 오면 덮어쓴다 (이전 요청은 자동 무효화).
let pendingCompletion = null; // { gen, resolve }
let completionGen = 0;


// 스트리밍 stdout 버퍼 — cd 응답에서 마지막 줄(pwd 결과)을 추출하기 위해 누적한다.
let execStdoutBuf = "";

/**
 * 현재 앱에 대한 exec WS 연결을 연다.
 * 이미 열려 있다면 먼저 닫는다.
 */
function openExecSocket() {
  closeExecSocket();
  if (!state.selectedApp) return;

  const { userid, appname } = state.selectedApp;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/apps/${userid}/${appname}/exec/ws`;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    // WebSocket 생성 자체가 실패하는 경우(잘못된 URL 등) — 조용히 무시
    console.error("[exec-ws] open failed:", err);
    return;
  }

  execWs = ws;

  ws.onopen = () => {
    console.log("[exec-ws] connected");
    // 연결 직후 초기 cwd 를 조회한다.
    _sendExecCommand("pwd", "");
    execPendingIsCd = false; // pwd는 cd 처리 없이 cwd 초기화에만 사용
    execPendingIsCd = true;  // pwd 결과를 cwd 로 사용하기 위해 isCd 플래그 활용
    // ── 주의: isCd=true 이면 done 수신 시 마지막 줄을 execCwd 로 저장한다. ──
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    _handleWsMessage(msg);
  };

  ws.onclose = () => {
    if (execWs === ws) execWs = null;
    _resetRunningState();
    console.log("[exec-ws] closed");
  };

  ws.onerror = () => {
    // onerror 는 항상 onclose 로 이어지므로 별도 처리 불필요
    console.error("[exec-ws] socket error");
  };
}

/**
 * 현재 exec WS 연결을 닫는다. 이미 닫혀 있으면 no-op.
 */
function closeExecSocket() {
  if (execWs) {
    execWs.onclose = null; // 닫기 이벤트 핸들러 제거 (중복 처리 방지)
    execWs.close();
    execWs = null;
  }
  _resetRunningState();
}

function _resetRunningState() {
  execRunning = false;
  execPendingIsCd = false;
  execStdoutBuf = "";
  // 버튼/입력창 활성화 (연결 끊김 등 비정상 종료 시에도 복구)
  if (el.detailExecRunBtn) el.detailExecRunBtn.disabled = false;
  if (el.detailExecInput) el.detailExecInput.disabled = false;
}

/**
 * WS를 통해 서버에 명령을 전송한다.
 * 연결이 없거나 OPEN 상태가 아니면 false 를 반환한다.
 */
function _sendExecCommand(command, cwd) {
  if (!execWs || execWs.readyState !== WebSocket.OPEN) return false;
  execWs.send(JSON.stringify({ type: "exec", command, cwd }));
  return true;
}

/**
 * 서버에서 수신한 WS 메시지를 처리한다.
 */
function _handleWsMessage(msg) {
  const { type, data, exitCode, message, completions } = msg;

  if (type === "stdout") {
    if (!data) return;
    if (execPendingIsCd) {
      // cd 처리 중: 전체 stdout 을 버퍼에 누적한다.
      execStdoutBuf += data;
    } else {
      appendExecLine(data, "exec-stdout");
    }
    return;
  }

  if (type === "stderr") {
    if (data) appendExecLine(data, "exec-stderr");
    return;
  }

  if (type === "completions") {
    if (pendingCompletion) {
      const { resolve } = pendingCompletion;
      pendingCompletion = null;
      resolve(completions ?? []);
    }
    return;
  }

  if (type === "done") {
    if (execPendingIsCd) {
      // 버퍼에서 cwd 추출
      const lines = execStdoutBuf.trimEnd().split("\n");
      const newCwd = lines.at(-1)?.trim();
      if (newCwd?.startsWith("/")) {
        execCwd = newCwd;
        updateExecPrompt();
      }
      // pwd 외에 출력이 있으면 표시
      const extra = lines.slice(0, -1).join("\n").trimEnd();
      if (extra) appendExecLine(extra, "exec-stdout");
      execPendingIsCd = false;
      execStdoutBuf = "";
    }

    _resetRunningState();
    el.detailExecInput?.focus();
    return;
  }

  if (type === "error") {
    appendExecLine(message || "알 수 없는 오류", "exec-stderr");
    _resetRunningState();
    el.detailExecInput?.focus();
    return;
  }
}

// ── 탭 완성 ───────────────────────────────────────────────────────────────────

// 현재 탭 완성 상태 — 하나의 탭 완성 세션(fetch → cycling)을 추적한다.
let tabState = { base: "", partial: "", matches: [], index: -1, loading: false };

// "cat /etc/pa" → { base: "cat ", partial: "/etc/pa" }
function splitInputToken(input) {
  const lastSpace = input.lastIndexOf(" ");
  return lastSpace === -1
    ? { base: "", partial: input }
    : { base: input.slice(0, lastSpace + 1), partial: input.slice(lastSpace + 1) };
}

/**
 * WS를 통해 탭 완성 후보를 요청한다.
 * 응답이 올 때까지 Promise로 대기하고, WS가 없으면 빈 배열을 즉시 반환한다.
 */
function requestCompletionsViaWs(partial, cwd) {
  if (!execWs || execWs.readyState !== WebSocket.OPEN) {
    return Promise.resolve([]);
  }
  const gen = ++completionGen;
  return new Promise((resolve) => {
    // 이전 pending 요청은 빈 배열로 조기 종료
    if (pendingCompletion) pendingCompletion.resolve([]);
    pendingCompletion = { gen, resolve };
    execWs.send(JSON.stringify({ type: "complete", partial, cwd }));
    // 타임아웃: 3초 내 응답이 없으면 빈 배열 반환
    setTimeout(() => {
      if (pendingCompletion?.gen === gen) {
        pendingCompletion = null;
        resolve([]);
      }
    }, 3000);
  });
}

async function handleTabCompletion() {
  if (tabState.loading) return;

  const fullInput = el.detailExecInput.value;

  // 이미 완성 결과를 가지고 있고 현재 입력이 마지막 완성 결과와 일치하면 다음 후보로 순환
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

  tabState = { base, partial, matches: [], index: -1, loading: true };

  try {
    const completions = await requestCompletionsViaWs(partial, execCwd);
    tabState.matches = completions;
  } finally {
    tabState.loading = false;
  }

  if (!tabState.matches.length) return;
  tabState.index = 0;
  const completed = tabState.base + tabState.matches[0];
  el.detailExecInput.value = completed;
  el.detailExecInput.setSelectionRange(completed.length, completed.length);
}

// ── 프롬프트 ──────────────────────────────────────────────────────────────────

function formatCwdDisplay(cwd) {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

function updateExecPrompt() {
  el.detailExecPromptCwd.textContent = formatCwdDisplay(execCwd);
}

// ── cd 감지 ───────────────────────────────────────────────────────────────────

function parseCdArgs(command) {
  const m = command.match(/^cd(?:\s+(.*\S))?$/);
  return m ? (m[1] ?? "") : null;
}

// ── 초기 cwd 조회 ─────────────────────────────────────────────────────────────

// WS onopen 에서 pwd 명령을 전송함으로써 초기화한다.
// 소켓이 아직 연결 중이면 openExecSocket() 이 onopen 에서 처리한다.
async function initExecCwd() {
  // WS 방식에서는 openExecSocket() 의 onopen 핸들러가 pwd 를 전송한다.
  // 소켓이 이미 OPEN 상태이면 여기서 명시적으로 호출한다.
  if (execCwd !== "") return;
  if (execWs?.readyState === WebSocket.OPEN) {
    execPendingIsCd = true;
    execStdoutBuf = "";
    _sendExecCommand("pwd", "");
  }
  // 소켓이 아직 연결 중(CONNECTING)이면 onopen 핸들러가 처리한다.
}

// ── 명령 출력 ─────────────────────────────────────────────────────────────────

function appendExecLine(text, className = "") {
  const line = document.createElement("span");
  if (className) line.className = className;
  line.textContent = text.endsWith("\n") ? text : text + "\n";
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

  if (command === "clear") {
    el.detailExecOutput.innerHTML = "";
    return;
  }

  // WS 연결이 없거나 닫혀 있으면 자동 재연결 시도
  if (!execWs || execWs.readyState !== WebSocket.OPEN) {
    appendExecLine("연결 중... 잠시 후 다시 시도하세요.", "exec-stderr");
    openExecSocket();
    return;
  }

  // 이미 실행 중이면 무시 (서버는 한 번에 하나의 명령만 처리)
  if (execRunning) return;

  el.detailExecRunBtn.disabled = true;
  el.detailExecInput.disabled = true;
  appendExecLine(`$ ${command}`, "exec-cmd");

  const cdArgs = parseCdArgs(command);
  const isCd = cdArgs !== null;
  // cd 는 `cd [path] && pwd` 로 실행하여 이동된 경로를 확인한다.
  const effectiveCommand = isCd ? `${command} && pwd` : command;

  execRunning = true;
  execPendingIsCd = isCd;
  execStdoutBuf = "";

  const sent = _sendExecCommand(effectiveCommand, execCwd);
  if (!sent) {
    appendExecLine("서버와의 연결이 끊어졌습니다. 페이지를 새로고침하거나 Exec 탭을 다시 열어주세요.", "exec-stderr");
    _resetRunningState();
  }
}

function resetTabCompletionState() {
  // 진행 중인 WS 완성 요청이 있으면 빈 배열로 조기 종료
  if (pendingCompletion) {
    pendingCompletion.resolve([]);
    pendingCompletion = null;
  }
  completionGen += 1;
  tabState = { base: "", partial: "", matches: [], index: -1, loading: false };
}

function resetExecForApp() {
  execCwd = "";
  updateExecPrompt();
  resetTabCompletionState();
  // 소켓은 앱 전환 시 app.js에서 closeExecSocket() / openExecSocket() 을 호출한다.
}

function historyBack(current) {
  return execHistory.back(current);
}

function historyForward() {
  return execHistory.forward();
}

export {
  closeExecSocket,
  handleTabCompletion,
  historyBack,
  historyForward,
  initExecCwd,
  openExecSocket,
  resetExecForApp,
  resetTabCompletionState,
  runExecCommand,
  updateExecPrompt,
};

// =============================================================================
// app-exec.js - Exec 터미널 (xterm.js ↔ dockerode TTY exec WebSocket relay)
// =============================================================================
// 역할:
//   xterm.js Terminal 인스턴스를 생성하고, WebSocket을 통해 서버의
//   dockerode TTY exec 스트림과 I/O를 relay한다.
//   명령 파싱, 히스토리, 탭 완성, cwd 추적은 모두 컨테이너 내부 shell이
//   직접 처리하므로 이 모듈은 순수한 전송 계층으로만 동작한다.
//
//   Terminal 인스턴스는 최초 openExecSocket() 호출 시 한 번만 생성한다.
//   앱 전환 시 reset()으로 화면을 비우고 소켓만 재연결한다.
// =============================================================================

import { el, state } from "./app-state.js";

// xterm.js Terminal / FitAddon 은 index.html의 CDN 스크립트로 전역에 로드된다.
// (window.Terminal, window.FitAddon)

let execWs = null;
let term = null;
let fitAddon = null;

// ── Terminal 초기화 ───────────────────────────────────────────────────────────

/**
 * Terminal을 최초 1회만 생성하여 DOM에 마운트한다.
 * 이후 호출은 no-op.
 */
function _ensureTerminal() {
  if (term) return;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"IBM Plex Mono", "Fira Code", monospace',
    theme: { background: "#0a1622" },
    scrollback: 5000,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(el.detailExecTerminal);
  fitAddon.fit();

  // 키보드 입력 → WS (terminal.onData는 한 번만 등록)
  term.onData((data) => {
    if (execWs?.readyState === WebSocket.OPEN) execWs.send(data);
  });

  // 컨테이너 크기 변화 감지 → FitAddon 재계산 → 서버에 resize 통보
  const ro = new ResizeObserver(() => {
    fitAddon.fit();
    _sendResize();
  });
  ro.observe(el.detailExecTerminal);
}

function _sendResize() {
  if (execWs?.readyState === WebSocket.OPEN && term) {
    execWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function openExecSocket() {
  closeExecSocket();
  if (!state.selectedApp) return;

  _ensureTerminal();

  const { userid, appname } = state.selectedApp;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/apps/${userid}/${appname}/exec/ws`;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("[exec-ws] open failed:", err);
    return;
  }

  execWs = ws;

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("[exec-ws] connected");
    fitAddon.fit();
    _sendResize();
    term.focus();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      term.write(event.data);
    } else {
      term.write(new Uint8Array(event.data));
    }
  };

  ws.onclose = () => {
    if (execWs === ws) execWs = null;
    console.log("[exec-ws] closed");
  };

  ws.onerror = () => console.error("[exec-ws] socket error");
}

function closeExecSocket() {
  if (execWs) {
    execWs.onclose = null;
    execWs.close();
    execWs = null;
  }
}

// ── 외부 인터페이스 ───────────────────────────────────────────────────────────

/** Clear 버튼: 스크롤백을 포함한 화면 초기화 */
function clearExecTerminal() {
  term?.clear();
}

/** 앱 전환 시 호출: 터미널 상태 초기화 (소켓 정리는 app.js에서 별도 수행) */
function resetExecForApp() {
  term?.reset();
}

export { openExecSocket, closeExecSocket, clearExecTerminal, resetExecForApp };

// =============================================================================
// routes/exec-ws.js - Exec WebSocket 핸들러
// =============================================================================
// 역할:
//   WebSocket 연결 하나를 컨테이너 내부의 interactive shell 세션으로 연결한다.
//   dockerode container.exec({ Tty: true })로 컨테이너 내부에만 PTY를 생성하고,
//   raw stream I/O를 WebSocket에 relay한다.
//
//   클라이언트 → 서버:
//     raw Buffer  — 키보드 입력 (container PTY stdin으로 직접 전달)
//     JSON text   — { type: "resize", cols, rows }
//
//   서버 → 클라이언트:
//     raw Buffer  — PTY 출력 (ANSI escape 포함, xterm.js가 렌더링)
//
//   WS 업그레이드 및 1차 세션 인증은 server.js의 upgrade 핸들러에서 수행한다.
//   이 핸들러는 req._wsAuth로 전달된 auth를 재사용하고,
//   앱 소유권(userid 일치 여부) 검사만 추가로 수행한다.
// =============================================================================
"use strict";

const { ROLE_ADMIN } = require("../authService");

const EXEC_WS_PATH = /^\/apps\/([^/]+)\/([^/]+)\/exec\/ws$/;
const HEARTBEAT_MS = 30_000;

/**
 * WS 업그레이드 요청에서 userid/appname 을 파싱한다.
 * 매칭 실패 시 null 반환.
 */
function parseExecWsUrl(url) {
    const m = (url || "").split("?")[0].match(EXEC_WS_PATH);
    if (!m) return null;
    return { userid: m[1], appname: m[2] };
}

/**
 * WS 서버에 등록할 connection 이벤트 핸들러를 생성한다.
 *
 * @param {object} deps
 * @param {Function} deps.resolveSessionAuth   - (req) => auth | null  (fallback용)
 * @param {Function} deps.findDockerApp        - (userid, appname) => Promise<app|null>
 * @param {Function} deps.getDockerContainer   - (containerName) => dockerode Container
 */
function createExecWsHandler({ resolveSessionAuth, findDockerApp, getDockerContainer }) {

    return async function handleExecWs(ws, req) {
        // ── 파라미터 추출 ──────────────────────────────────────────────────────
        const params = parseExecWsUrl(req.url);
        if (!params) {
            ws.close(1008, "Invalid URL");
            return;
        }

        const { userid, appname } = params;

        // ── 인증 확인 ──────────────────────────────────────────────────────────
        // server.js upgrade 핸들러가 req._wsAuth에 검증된 auth를 첨부한다.
        // 직접 호출되는 경우를 대비해 resolveSessionAuth fallback을 유지한다.
        const auth = req._wsAuth ?? resolveSessionAuth(req);
        if (!auth) {
            ws.close(1008, "Unauthorized");
            return;
        }
        const user = auth.user;
        if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
            ws.close(1008, "Forbidden");
            return;
        }

        // ── 컨테이너 조회 ──────────────────────────────────────────────────────
        let app;
        try {
            app = await findDockerApp(userid, appname);
        } catch (err) {
            ws.close(1011, err.message || "Failed to find app");
            return;
        }
        if (!app?.containerName) {
            ws.close(1011, "Container not found");
            return;
        }

        // ── dockerode TTY exec ─────────────────────────────────────────────────
        // Tty: true  → 컨테이너 내부에 PTY 생성, hijack: true → raw duplex stream
        // bash --norc: readline 활성 (방향키·Tab 완성), bash 없으면 sh fallback
        // PS1=$USER:$PWD# : POSIX 표준 변수 사용 → bash/sh 모두에서 동작
        let exec, stream;
        try {
            const container = getDockerContainer(app.containerName);
            exec = await container.exec({
                Cmd: ["sh", "-c", "exec bash --norc || exec sh"],
                User: "root",
                Env: [
                    "TERM=xterm-256color",  // readline이 키 시퀀스를 알 수 있도록
                    "PS1=$USER:$PWD# ",     // POSIX 표준 — bash/sh 모두에서 경로 표시
                ],
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                Tty: true,
            });
            stream = await new Promise((resolve, reject) => {
                exec.start({ hijack: true, stdin: true }, (err, s) =>
                    err ? reject(err) : resolve(s)
                );
            });
        } catch (err) {
            ws.close(1011, "Exec failed: " + err.message);
            return;
        }

        console.log(`[exec-ws] connected: ${userid}/${appname}`);

        // Container PTY 출력 → WS (Tty: true이면 demux 없이 raw relay)
        stream.on("data", (chunk) => {
            if (ws.readyState === ws.constructor.OPEN) ws.send(chunk);
        });

        stream.on("end", () => {
            if (ws.readyState === ws.constructor.OPEN) ws.close(1000, "Shell exited");
        });

        stream.on("error", (err) => {
            console.error(`[exec-ws] stream error: ${userid}/${appname}`, err.message);
            if (ws.readyState === ws.constructor.OPEN) ws.close(1011, "Stream error");
        });

        // ── Heartbeat ──────────────────────────────────────────────────────────
        // 네트워크 단절로 WS close 이벤트가 늦거나 안 오는 경우를 대비한다.
        // pong 응답이 없으면 연결을 강제 종료하고 stream을 정리한다.
        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });
        const heartbeat = setInterval(() => {
            if (!ws.isAlive) {
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            ws.ping();
        }, HEARTBEAT_MS);

        // ── WS → Container PTY stdin ──────────────────────────────────────────
        // { type: "resize", cols, rows } JSON이면 PTY 크기 조정,
        // 그 외는 raw Buffer를 그대로 stream.write — string 변환 없이 전달해야
        // 멀티바이트 문자 및 특수 키 시퀀스의 encoding 손실이 없다.
        ws.on("message", (raw) => {
            const text = raw.toString();
            if (text.charCodeAt(0) === 0x7b /* { */) {
                try {
                    const msg = JSON.parse(text);
                    if (msg.type === "resize") {
                        exec.resize({
                            h: Math.max(1, Math.min(msg.rows | 0, 256)),
                            w: Math.max(1, Math.min(msg.cols | 0, 512)),
                        }).catch(() => { /* 리사이즈 실패는 무시 */ });
                        return;
                    }
                } catch { /* JSON 파싱 실패 → raw 입력으로 처리 */ }
            }
            stream.write(raw);
        });

        // ── 정리 ──────────────────────────────────────────────────────────────
        function cleanup() {
            clearInterval(heartbeat);
            try { stream.destroy(); } catch { /* ignore */ }
        }

        ws.on("close", () => {
            cleanup();
            console.log(`[exec-ws] disconnected: ${userid}/${appname}`);
        });

        ws.on("error", (err) => {
            cleanup();
            console.error(`[exec-ws] error: ${userid}/${appname}`, err.message);
        });
    };
}

module.exports = { createExecWsHandler, parseExecWsUrl };

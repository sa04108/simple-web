// =============================================================================
// routes/exec-ws.js - Exec WebSocket 핸들러
// =============================================================================
// 역할:
//   WebSocket 연결 하나를 Exec 세션으로 관리한다.
//
//   클라이언트 → 서버 메시지:
//     { type: "exec",     command, cwd }   — 명령 실행 (stdout/stderr 스트리밍)
//     { type: "complete", partial, cwd }   — 탭 완성 후보 요청
//
//   서버 → 클라이언트 메시지:
//     { type: "stdout",      data }         — stdout 청크
//     { type: "stderr",      data }         — stderr 청크
//     { type: "done",        exitCode }     — 명령 완료
//     { type: "completions", completions } — 탭 완성 결과
//     { type: "error",       message }     — 오류
//
//   WS 업그레이드 인증 및 URL 파싱은 server.js의 upgrade 핸들러에서 처리하고,
//   유효한 연결만 이 핸들러로 전달된다.
// =============================================================================
"use strict";

const { ROLE_ADMIN } = require("../authService");
const { validateAppParams } = require("../appManager");
const { AppError } = require("../utils");

// URL 패턴: /apps/:userid/:appname/exec/ws
const EXEC_WS_PATH = /^\/apps\/([^/]+)\/([^/]+)\/exec\/ws$/;

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
 * @param {Function} deps.resolveSessionAuth  - (req) => auth | null
 * @param {Function} deps.findDockerApp       - (userid, appname) => Promise<app|null>
 * @param {Function} deps.runContainerExecStream
 */
function createExecWsHandler({ resolveSessionAuth, findDockerApp, runContainerExecStream, runContainerComplete }) {

    return function handleExecWs(ws, req) {
        // ── 파라미터 추출 (upgrade 핸들러에서 이미 검증된 값을 재사용) ─────────
        const params = parseExecWsUrl(req.url);
        if (!params) {
            ws.close(1008, "Invalid URL");
            return;
        }

        const { userid, appname } = params;

        // auth는 upgrade 단계에서 검증됐으나, role 기반 권한은 여기서도 확인
        const auth = resolveSessionAuth(req);
        if (!auth) {
            ws.close(1008, "Unauthorized");
            return;
        }
        const user = auth.user;
        if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
            ws.close(1008, "Forbidden");
            return;
        }

        // 현재 실행 중인 exec handle (도중 연결 끊김 시 정리용)
        let currentExec = null;

        // ── 헬퍼 ──────────────────────────────────────────────────────────────────

        function send(obj) {
            if (ws.readyState === ws.constructor.OPEN) {
                ws.send(JSON.stringify(obj));
            }
        }

        function sendError(message) {
            send({ type: "error", message });
        }

        function destroyCurrentExec() {
            if (currentExec) {
                currentExec.destroy();
                currentExec = null;
            }
        }

        // ── 명령 실행 ─────────────────────────────────────────────────────────────

        async function handleCommand(command, cwd) {
            // 이전 실행이 아직 살아있으면 중단
            destroyCurrentExec();

            let containerName;
            try {
                const app = await findDockerApp(userid, appname);
                if (!app?.containerName) {
                    sendError("Container not found for this app");
                    return;
                }
                containerName = app.containerName;
            } catch (err) {
                sendError(err.message || "Failed to find app");
                return;
            }

            currentExec = runContainerExecStream(containerName, command, cwd, {
                onStdout(chunk) {
                    send({ type: "stdout", data: chunk.toString() });
                },
                onStderr(chunk) {
                    send({ type: "stderr", data: chunk.toString() });
                },
                onDone(exitCode) {
                    currentExec = null;
                    send({ type: "done", exitCode });
                },
                onError(err) {
                    currentExec = null;
                    // statusCode 404/409 는 컨테이너 없음/정지 상태
                    if (err?.statusCode === 404) {
                        sendError("Container not found");
                    } else if (err?.statusCode === 409) {
                        sendError("Container is not running");
                    } else {
                        sendError(err?.message || "Exec failed");
                    }
                    send({ type: "done", exitCode: null });
                },
            });
        }

        // ── 탭 완성 ───────────────────────────────────────────────────────────────

        async function handleComplete(partial, cwd) {
            let containerName;
            try {
                const app = await findDockerApp(userid, appname);
                if (!app?.containerName) {
                    send({ type: "completions", completions: [] });
                    return;
                }
                containerName = app.containerName;
            } catch {
                send({ type: "completions", completions: [] });
                return;
            }

            try {
                const completions = await runContainerComplete(containerName, partial, cwd);
                send({ type: "completions", completions });
            } catch {
                send({ type: "completions", completions: [] });
            }
        }

        // ── WS 이벤트 ─────────────────────────────────────────────────────────────

        ws.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                sendError("Invalid JSON");
                return;
            }

            const type = String(msg?.type || "exec");
            const cwd = String(msg?.cwd || "").trim();

            if (type === "complete") {
                const partial = String(msg?.partial ?? "");
                if (partial.length > 512) {
                    send({ type: "completions", completions: [] });
                    return;
                }
                handleComplete(partial, cwd).catch(() => send({ type: "completions", completions: [] }));
                return;
            }

            // type === "exec" (또는 미지정)
            const command = String(msg?.command || "").trim();
            if (!command) {
                sendError("command is required");
                return;
            }
            if (command.length > 2048) {
                sendError("command too long (max 2048 chars)");
                return;
            }

            handleCommand(command, cwd).catch((err) => {
                sendError(err?.message || "Unexpected error");
            });
        });

        ws.on("close", () => {
            destroyCurrentExec();
            console.log(`[exec-ws] disconnected: ${userid}/${appname}`);
        });

        ws.on("error", (err) => {
            destroyCurrentExec();
            console.error(`[exec-ws] error: ${userid}/${appname}`, err.message);
        });

        console.log(`[exec-ws] connected: ${userid}/${appname}`);
    };
}

module.exports = { createExecWsHandler, parseExecWsUrl };

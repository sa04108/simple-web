// =============================================================================
// jobStore.js - 백그라운드 Job 상태 관리 (In-memory + SQLite 영속화)
// =============================================================================
// 설계 원칙:
//   - Job 메타데이터(status, error 등)는 SQLite에 ACID 보장으로 저장
//   - 실시간 로그 라인은 in-memory Map에만 유지 (휘발성, SSE 팬아웃용)
//   - 서버 재시작 시 recoverOnStartup()으로 상태 복원
//
// Job 상태 머신:
//   pending → running → done
//                    ↘ failed
//   서버 재시작 시:
//     pending     → 자동 재실행 (executeJob 콜백)
//     running     → interrupted (스크립트 kill됨)
//     interrupted → UI에서 사용자 수동 재시도
//     failed      → UI에서 사용자 수동 재시도
// =============================================================================
"use strict";

const { randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");

// Job 상태 상수
const JOB_STATUS = {
  PENDING:     "pending",
  RUNNING:     "running",
  DONE:        "done",
  FAILED:      "failed",
  INTERRUPTED: "interrupted",
};

const TERMINAL_STATUSES = new Set([JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.INTERRUPTED]);
const RETRYABLE_STATUSES = new Set([JOB_STATUS.FAILED, JOB_STATUS.INTERRUPTED]);
const CANCELABLE_STATUSES = new Set([JOB_STATUS.FAILED, JOB_STATUS.INTERRUPTED]);

// 완료된 job 보존 기간 (24시간)
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

// ── 내부 상태 ─────────────────────────────────────────────────────────────────

let _db = null; // better-sqlite3 인스턴스 (server.js에서 주입)

// 실시간 로그 버퍼: Map<jobId, string[]>
const _logBuffers = new Map();

// SSE 구독자: Map<jobId, Set<res>>
const _sseSubscribers = new Map();

// ── 초기화 ────────────────────────────────────────────────────────────────────

/**
 * DB 파일 경로를 받아 better-sqlite3 연결을 열고 jobs 테이블을 생성한다.
 * authService와 동일한 SQLite 파일을 공유한다 (WAL 모드에서 다중 연결 안전).
 * server.js 시작 시 authService.init() 이후에 호출한다.
 * @param {string} dbPath
 */
function init(dbPath) {
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      userid       TEXT NOT NULL,
      meta         TEXT NOT NULL DEFAULT '{}',
      output       TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_userid   ON jobs(userid);
    CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at);
  `);
}

// ── Job CRUD ──────────────────────────────────────────────────────────────────

/**
 * 새 job을 생성하고 DB에 저장한다.
 * @param {string} type  - 'create' | 'deploy' | 'delete' | 'start' | 'stop' | 'env-restart'
 * @param {object} meta  - 작업 식별에 필요한 추가 정보 (userid, appname 등)
 * @param {string} userid - 요청한 사용자 ID
 * @returns {string} jobId
 */
function createJob(type, meta, userid) {
  const id = randomUUID();
  const now = Date.now();
  _db.prepare(`
    INSERT INTO jobs (id, type, status, userid, meta, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?)
  `).run(id, type, userid, JSON.stringify(meta), now);

  _logBuffers.set(id, []);
  return id;
}

/**
 * job을 running 상태로 전환한다.
 */
function startJob(jobId) {
  _db.prepare(`
    UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?
  `).run(Date.now(), jobId);
}

/**
 * job을 done 상태로 전환하고 output을 저장한다.
 */
function finishJob(jobId, output = "") {
  const now = Date.now();
  _db.prepare(`
    UPDATE jobs SET status = 'done', output = ?, finished_at = ? WHERE id = ?
  `).run(output, now, jobId);
  _closeSseSubscribers(jobId, "done");
}

/**
 * job을 failed 상태로 전환하고 에러 메시지를 저장한다.
 */
function failJob(jobId, errorMessage = "Unknown error") {
  const now = Date.now();
  _db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?
  `).run(errorMessage, now, jobId);
  _closeSseSubscribers(jobId, "failed");
}

/**
 * running 상태를 interrupted로 전환한다 (서버 재시작 복원 시 사용).
 */
function interruptJob(jobId) {
  _db.prepare(`
    UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE id = ?
  `).run(Date.now(), jobId);
}

/**
 * interrupted/failed job을 pending으로 되돌려 재시도 가능 상태로 만든다.
 * 실제 재실행은 호출자가 담당한다.
 */
function requeueJob(jobId) {
  _db.prepare(`
    UPDATE jobs
    SET status = '${JOB_STATUS.PENDING}', started_at = NULL, finished_at = NULL, error = NULL, output = NULL
    WHERE id = ? AND status IN ('${JOB_STATUS.INTERRUPTED}', '${JOB_STATUS.FAILED}')
  `).run(jobId);
  if (!_logBuffers.has(jobId)) _logBuffers.set(jobId, []);
}

/**
 * job을 DB에서 완전히 삭제한다 (취소/복구용).
 */
function deleteJob(jobId) {
  _db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  _logBuffers.delete(jobId);
  _closeSseSubscribers(jobId, "done");
}

// ── 조회 ──────────────────────────────────────────────────────────────────────

/**
 * job 단건 조회. 없으면 null 반환.
 */
function getJob(jobId) {
  const row = _db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  return row ? _deserialize(row) : null;
}

/**
 * 특정 사용자의 job 목록 조회.
 * active job(pending/running/interrupted) + 최근 TTL 이내 완료 job을 반환한다.
 */
function listJobsByUser(userid) {
  const cutoff = Date.now() - JOB_TTL_MS;
  const rows = _db.prepare(`
    SELECT * FROM jobs
    WHERE userid = ?
      AND (
        status IN ('pending', 'running', 'interrupted')
        OR finished_at > ?
      )
    ORDER BY created_at DESC
    LIMIT 100
  `).all(userid, cutoff);
  return rows.map(_deserialize);
}

/**
 * 전체 active job 목록 (admin 용).
 */
function listActiveJobs() {
  const rows = _db.prepare(`
    SELECT * FROM jobs WHERE status IN ('pending', 'running', 'interrupted')
    ORDER BY created_at DESC
  `).all();
  return rows.map(_deserialize);
}

// ── 로그 / SSE ────────────────────────────────────────────────────────────────

/**
 * 로그 라인을 in-memory 버퍼에 추가하고 SSE 구독자에게 push한다.
 * SQLite에는 저장하지 않는다 (휘발성 허용).
 */
function appendLog(jobId, line) {
  const buf = _logBuffers.get(jobId);
  if (buf) buf.push(line);

  const subscribers = _sseSubscribers.get(jobId);
  if (subscribers?.size) {
    const data = JSON.stringify({ type: "log", line });
    for (const res of subscribers) {
      try { res.write(`data: ${data}\n\n`); } catch { /* 연결 끊김 */ }
    }
  }
}

/**
 * 현재까지 쌓인 로그 라인 배열을 반환한다 (새로 연결된 SSE 클라이언트에게 리플레이용).
 */
function getLogs(jobId) {
  return _logBuffers.get(jobId) ?? [];
}

/**
 * SSE 구독 등록. res가 닫히면 자동으로 제거된다.
 */
function subscribeSse(jobId, res) {
  if (!_sseSubscribers.has(jobId)) _sseSubscribers.set(jobId, new Set());
  _sseSubscribers.get(jobId).add(res);
  res.on("close", () => _sseSubscribers.get(jobId)?.delete(res));
}

// ── 서버 재시작 복원 ──────────────────────────────────────────────────────────

/**
 * 서버 시작 시 호출한다.
 * - running → interrupted (스크립트가 kill됨, 자동 재실행 불가)
 * - pending → executeJobFn(job) 으로 자동 재실행
 *
 * @param {(job: object) => Promise<void>} executeJobFn
 */
async function recoverOnStartup(executeJobFn) {
  // 1. running → interrupted
  const runningRows = _db.prepare(
    "SELECT * FROM jobs WHERE status = 'running'"
  ).all();

  for (const row of runningRows) {
    interruptJob(row.id);
    console.log(`[jobStore] interrupted stale running job: ${row.id} (${row.type})`);
  }

  // 2. pending → 자동 재실행
  const pendingRows = _db.prepare(
    "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();

  for (const row of pendingRows) {
    const job = _deserialize(row);
    console.log(`[jobStore] re-queuing pending job: ${job.id} (${job.type})`);
    _logBuffers.set(job.id, []);
    // 비동기로 실행 (서버 start()를 블로킹하지 않음)
    setImmediate(() =>
      executeJobFn(job).catch((err) =>
        console.error(`[jobStore] recovery execution failed for ${job.id}:`, err)
      )
    );
  }

  // 3. 만료된 job cleanup
  _cleanupExpired();
}

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

function _deserialize(row) {
  return {
    id:          row.id,
    type:        row.type,
    status:      row.status,
    userid:      row.userid,
    meta:        JSON.parse(row.meta || "{}"),
    output:      row.output ?? null,
    error:       row.error ?? null,
    createdAt:   row.created_at,
    startedAt:   row.started_at ?? null,
    finishedAt:  row.finished_at ?? null,
    logs:        _logBuffers.get(row.id) ?? [],
  };
}

function _closeSseSubscribers(jobId, finalStatus) {
  const subscribers = _sseSubscribers.get(jobId);
  if (!subscribers?.size) return;
  const data = JSON.stringify({ type: "status", status: finalStatus });
  for (const res of subscribers) {
    try {
      res.write(`data: ${data}\n\n`);
      res.end();
    } catch { /* 이미 닫힘 */ }
  }
  _sseSubscribers.delete(jobId);
}

function _cleanupExpired() {
  const cutoff = Date.now() - JOB_TTL_MS;
  const result = _db.prepare(`
    DELETE FROM jobs
    WHERE status IN ('done', 'failed', 'interrupted')
      AND finished_at IS NOT NULL
      AND finished_at < ?
  `).run(cutoff);
  if (result.changes > 0) {
    console.log(`[jobStore] cleaned up ${result.changes} expired job(s)`);
  }
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  JOB_STATUS,
  TERMINAL_STATUSES,
  RETRYABLE_STATUSES,
  CANCELABLE_STATUSES,
  init,
  createJob,
  startJob,
  finishJob,
  failJob,
  interruptJob,
  requeueJob,
  deleteJob,
  getJob,
  listJobsByUser,
  listActiveJobs,
  appendLog,
  getLogs,
  subscribeSse,
  recoverOnStartup,
};

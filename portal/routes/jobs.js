// =============================================================================
// routes/jobs.js - /jobs 라우트 핸들러
// =============================================================================
// 역할:
//   백그라운드 job 상태 조회, SSE 스트리밍, 재시도 엔드포인트를 제공한다.
//   인증 미들웨어는 server.js에서 이 라우터 앞에 적용된다.
// =============================================================================
"use strict";

const express = require("express");
const { ROLE_ADMIN } = require("../authService");
const { AppError, sendOk, sendError } = require("../utils");
const { RUNNER_SCRIPTS } = require("../config");
const { runRunnerScript } = require("../appManager");
const jobStore = require("../jobStore");

const router = express.Router();

// ── 접근 제어 헬퍼 ────────────────────────────────────────────────────────────

// job 소유자 또는 admin만 접근 가능
function assertJobAccess(req, job) {
  const user = req.auth?.user;
  if (!user) throw new AppError(401, "Unauthorized");
  if (user.role === ROLE_ADMIN) return; // admin은 전체 접근
  if (job.userid !== user.username) throw new AppError(403, "Forbidden");
}

// 공통 middleware: job을 조회하고 접근 권한을 확인하여 req.job에 주입한다.
function resolveJob(req, res, next) {
  try {
    const job = jobStore.getJob(req.params.id);
    if (!job) throw new AppError(404, "Job not found");
    assertJobAccess(req, job);
    req.job = job;
    next();
  } catch (error) {
    next(error);
  }
}

// ── GET /jobs ─────────────────────────────────────────────────────────────────

// 현재 사용자의 job 목록 반환 (active + 최근 24h 완료)
// admin은 전체 active job 목록도 포함
router.get("/", (req, res, next) => {
  try {
    const user = req.auth?.user;
    if (!user) return next(new AppError(401, "Unauthorized"));

    const jobs = jobStore.listJobsByUser(user.username);
    return sendOk(res, { jobs });
  } catch (error) {
    return next(error);
  }
});

// ── GET /jobs/:id ─────────────────────────────────────────────────────────────

router.get("/:id", resolveJob, (req, res, next) => {
  try {
    return sendOk(res, { job: req.job });
  } catch (error) {
    return next(error);
  }
});

// ── GET /jobs/:id/stream — SSE 실시간 로그 스트리밍 ──────────────────────────

router.get("/:id/stream", resolveJob, (req, res, next) => {
  try {
    const job = req.job;

    // 이미 완료된 job은 SSE가 필요 없음 — 즉시 상태 전송 후 종료
    if (jobStore.TERMINAL_STATUSES.has(job.status)) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // 기존 로그 리플레이
      for (const line of job.logs) {
        res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "status", status: job.status })}\n\n`);
      res.end();
      return;
    }

    // 진행중 job: SSE 헤더 설정 후 구독 등록
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // 연결 시점까지 쌓인 로그 리플레이
    for (const line of jobStore.getLogs(req.params.id)) {
      res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
    }

    // 이후 로그는 구독을 통해 실시간 수신
    jobStore.subscribeSse(req.params.id, res);

    // keepalive: 30초 간격 comment 전송
    const keepalive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
    }, 30000);
    res.on("close", () => clearInterval(keepalive));
  } catch (error) {
    return next(error);
  }
});

// ── POST /jobs/:id/retry ──────────────────────────────────────────────────────

// interrupted 또는 failed 상태의 job을 재시도한다.
// 실행 함수는 server.js에서 setExecuteJobFn()으로 주입받는다.
let _executeJobFn = null;

function setExecuteJobFn(fn) {
  _executeJobFn = fn;
}

router.post("/:id/retry", resolveJob, async (req, res, next) => {
  try {
    if (!_executeJobFn) throw new AppError(500, "Job executor not initialized");

    const job = req.job;

    if (!jobStore.RETRYABLE_STATUSES.has(job.status)) {
      throw new AppError(409, `Job is in '${job.status}' status and cannot be retried`);
    }

    // pending으로 되돌리고 재실행
    jobStore.requeueJob(job.id);
    const updatedJob = jobStore.getJob(job.id);

    setImmediate(() =>
      _executeJobFn(updatedJob).catch((err) =>
        console.error(`[jobs] retry execution failed for ${job.id}:`, err)
      )
    );

    return sendOk(res, { jobId: job.id, status: "pending" });
  } catch (error) {
    return next(error);
  }
});

// ── POST /jobs/:id/cancel ─────────────────────────────────────────────────────

// interrupted 또는 failed 상태의 job을 취소하고 DB에서 완전히 제거한다.
// create 작업의 경우 생성 중이던 잔류 파일과 컨테이너를 함께 정리(delete.sh)한다.
router.post("/:id/cancel", resolveJob, async (req, res, next) => {
  try {
    const job = req.job;

    if (!jobStore.CANCELABLE_STATUSES.has(job.status)) {
      throw new AppError(409, `Job is in '${job.status}' status and cannot be canceled`);
    }

    if (job.type === "create") {
      const { userid, appname } = job.meta;
      try {
        await runRunnerScript(RUNNER_SCRIPTS.delete, [userid, appname]);
      } catch (err) {
        console.error(`[jobs] cleanup failed during cancel for ${job.id}:`, err);
        // 클린업 중 오류가 발생해도 job 삭제는 진행한다.
      }
    }

    jobStore.deleteJob(job.id);
    return sendOk(res, { jobId: job.id, status: "canceled" });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.setExecuteJobFn = setExecuteJobFn;

// =============================================================================
// app-api.js - API 통신 · 데이터 로딩 · 앱 액션
// =============================================================================
// 역할:
//   서버 API 호출과 데이터 로딩/자동갱신, 앱 액션(start/stop/deploy/delete)을 담당한다.
//   장시간 작업은 202 비동기 응답 + jobId 폴링 패턴으로 처리한다.
// =============================================================================

// ── 기본 API 통신 ─────────────────────────────────────────────────────────────

import { AUTO_REFRESH_MS, el, state } from "./app-state.js";
import { renderApps, renderUsers, renderAdminApps, renderDomains } from "./app-render.js";
import { navigateToApp, switchView, updateAuthUi, renderJobIndicator } from "./app-ui.js";
import {
  canManageApps,
  canManageUsers,
  formatJobAction,
  formatJobTarget,
  normalizeErrorMessage,
  redirectToAuth,
  setBanner,
  setEnvError,
  setSettingsError,
  showToast,
  syncDomainPreview,
  validateCreateForm,
} from "./app-utils.js";

// 모든 API 호출의 기반 함수. 응답이 ok: false이거나 HTTP 오류면 예외를 던진다.
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

// ── 데이터 로딩 ───────────────────────────────────────────────────────────────

async function loadConfig() {
  const data = await apiFetch("/config");
  state.domain      = data.domain  || "my.domain.com";
  state.devMode     = Boolean(data.devMode);
  state.traefikPort = data.traefikPort || null;
  el.domainChip.textContent = state.domain;
  el.limitChip.textContent  = `${data.limits.maxAppsPerUser}/${data.limits.maxTotalApps}`;
  el.devModeBadge.hidden = !state.devMode;
  syncDomainPreview();
}

async function loadSession() {
  try {
    const data = await apiFetch("/auth/me");
    state.user = data.user || null;
    updateAuthUi();
    syncDomainPreview();
    return true;
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      updateAuthUi();
      syncDomainPreview();
      return false;
    }
    throw error;
  }
}

async function loadApps() {
  if (!canManageApps()) {
    state.apps = [];
    renderApps([]);
    return;
  }
  const data = await apiFetch("/apps");
  state.apps = data.apps || [];
  renderApps(state.apps);
  if (data.hasLabelErrors) {
    setBanner("컨테이너 중 일부의 라벨이 누락되어 대시보드에서 제외되었습니다. 관리자에게 문의하세요.", "error");
  }
}

async function loadUsers() {
  if (!canManageUsers()) {
    state.users = [];
    renderUsers([]);
    return;
  }
  const data = await apiFetch("/users");
  state.users = data.users || [];
  renderUsers(state.users);
}

async function refreshDashboardData() {
  await loadApps();
  await loadUsers();
  if (state.user?.role === "admin") {
    await loadAdminApps();
  }
}

// ── Admin 전용 로딩 ──────────────────────────────────────────────────────────

async function loadAdminApps() {
  if (!canManageApps() || state.user?.role !== "admin") return;
  const data = await apiFetch("/apps?all=true");
  state.adminApps = data.apps || [];
  renderAdminApps(state.adminApps);
}

async function loadPortalLogs() {
  if (!canManageApps() || state.user?.role !== "admin") return;
  const rawLines = Number.parseInt(el.adminPortalLogLinesInput.value, 10);
  const lines    = Number.isFinite(rawLines) ? Math.max(1, Math.min(1000, rawLines)) : 120;
  
  try {
    const data = await apiFetch(`/admin/portal-logs?lines=${lines}`);
    el.adminPortalLogsOutput.textContent = data.logs || "(empty)";
  } catch (error) {
    el.adminPortalLogsOutput.textContent = "포털 로그를 불러오지 못했습니다.";
  }
}

// ── 로그 패널 자동 갱신 (per-panel) ────────────────────────────────────────────────────
//
// 타이머 시작/중지만 담당한다.
// 버튼 UI 상태 동기화는 호출측(app.js)의 역할.

/** App Detail Logs 타이머 시작. 이미 실행 중이면 no-op. */
function startDetailLogsAutoRefresh() {
  if (state.detailLogsTimer) return;
  state.detailLogsTimer = setInterval(async () => {
    if (state.activeView !== "app-detail" || state.activeDetailTab !== "logs") return;
    await loadDetailLogs().catch(() => {});
  }, AUTO_REFRESH_MS);
}

/** App Detail Logs 타이머 중지. 이미 중지된 상태면 no-op. */
function stopDetailLogsAutoRefresh() {
  clearInterval(state.detailLogsTimer);
  state.detailLogsTimer = null;
}

/** Admin Portal Logs 타이머 시작. 이미 실행 중이면 no-op. */
function startAdminLogsAutoRefresh() {
  if (state.adminLogsTimer) return;
  state.adminLogsTimer = setInterval(async () => {
    if (state.activeView !== "admin-dashboard") return;
    await loadPortalLogs().catch(() => {});
  }, AUTO_REFRESH_MS);
}

/** Admin Portal Logs 타이머 중지. 이미 중지된 상태면 no-op. */
function stopAdminLogsAutoRefresh() {
  clearInterval(state.adminLogsTimer);
  state.adminLogsTimer = null;
}

// ── Job 폴링 ─────────────────────────────────────────────────────────────────
//
// 새로고침 이후에도 진행중 job 상태를 복원하는 핵심 메커니즘.
// 부트스트랩 시 /jobs를 조회하여 active job을 감지하고 자동으로 폴링을 시작한다.

const JOB_POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

/**
 * job 상태를 주기적으로 조회하고 완료/실패 시 UI를 업데이트한다.
 *
 * @param {string}   jobId
 * @param {object}   options
 * @param {string}   options.actionLabel - 오버라이드할 작업 이름 (예: "앱 생성")
 * @param {string}   options.appLabel    - 오버라이드할 대상 이름 (예: "user/app")
 * @param {Function} options.onDone      - status='done' 추가 콜백
 * @param {Function} options.onFail      - status='failed'|'interrupted' 추가 콜백
 */
function pollJob(jobId, options = {}) {
  const { actionLabel, appLabel, onDone, onFail } = options;

  if (state.jobPollers.has(jobId)) return; // 이미 폴링 중

  const intervalId = setInterval(async () => {
    try {
      const data = await apiFetch(`/jobs/${jobId}`);
      const job = data.job;

      // state.jobs 업데이트
      const idx = state.jobs.findIndex((j) => j.id === jobId);
      if (idx >= 0) state.jobs[idx] = job;
      else state.jobs.unshift(job);

      renderJobIndicator(state.jobs);

      if (TERMINAL_STATUSES.has(job.status)) {
        clearInterval(intervalId);
        state.jobPollers.delete(jobId);

        const action = actionLabel || formatJobAction(job);
        const target = appLabel || formatJobTarget(job) || job.id;

        if (job.status === "done") {
          showToast(`✅ ${action} 완료: ${target}`, "success");
          onDone?.(job);
        } else {
          const reason = job.status === "interrupted"
            ? "서버 재시작으로 중단됨"
            : (job.error || "오류 발생");
          showToast(`❌ ${action} 실패: ${target} — ${reason}`, "error", 8000);
          onFail?.(job);
        }
        // 앱 목록 갱신 (job 완료 후 상태 반영 — 어드민 목록 포함)
        await refreshDashboardData().catch(() => {});
      }
    } catch (error) {
      if (error.status === 401) {
        clearInterval(intervalId);
        state.jobPollers.delete(jobId);
      }
      // 그 외 네트워크 오류는 다음 interval에서 재시도
    }
  }, JOB_POLL_INTERVAL_MS);

  state.jobPollers.set(jobId, intervalId);
}

/**
 * 서버의 /jobs 엔드포인트를 조회하여 진행중인 job을 복원한다.
 * 부트스트랩(페이지 로드/새로고침) 시 호출한다.
 */
async function loadAndRecoverJobs() {
  if (!canManageApps()) return;
  try {
    const data = await apiFetch("/jobs");
    state.jobs = data.jobs || [];
    renderJobIndicator(state.jobs);

    // active 상태인 job에 대해 폴링 재개
    for (const job of state.jobs) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        pollJob(job.id);
      }
    }
  } catch {
    // /jobs 자체 오류는 무시 (앱 기능에 영향 없음)
  }
}

/**
 * 202 응답으로 jobId를 받아 즉시 폴링을 시작하는 헬퍼.
 */
function startJobPolling(jobId, appLabel, actionLabel) {
  showToast(`${actionLabel} 시작: ${appLabel} — 진행 중...`, "info", 3000);

  // state.jobs에 낙관적으로 pending job 추가
  state.jobs.unshift({
    id: jobId, status: "pending",
    type: "unknown", userid: state.user?.username,
    meta: {}, createdAt: Date.now(),
  });
  renderJobIndicator(state.jobs);

  pollJob(jobId, { actionLabel, appLabel });
}

/**
 * jobId로 job 상태 객체에서 레이블을 추출하거나, 없으면 jobId를 반환한다.
 */
function _getJobTargetLabel(jobId) {
  const job = state.jobs.find((j) => j.id === jobId);
  return job ? (formatJobTarget(job) || job.id) : jobId;
}

/**
 * interrupted/failed job을 서버에 재시도 요청한다.
 */
async function retryJob(jobId) {
  const data = await apiFetch(`/jobs/${jobId}/retry`, { method: "POST" });
  const label = _getJobTargetLabel(jobId);

  pollJob(jobId, { actionLabel: "재시도" });
  showToast(`재시도 요청됨: ${label}`, "info");
  return data;
}

/**
 * interrupted/failed job을 서버에 취소(복구) 요청한다.
 */
async function cancelJob(jobId) {
  const data = await apiFetch(`/jobs/${jobId}/cancel`, { method: "POST" });
  const label = _getJobTargetLabel(jobId);
  showToast(`✅ 작업 취소 완료: ${label}`, "success");

  // 상태 배열에서 직접 제거
  state.jobs = state.jobs.filter((j) => j.id !== jobId);
  renderJobIndicator(state.jobs);
  await refreshDashboardData().catch(() => {});
  return data;
}

// ── 공통 에러 처리 ────────────────────────────────────────────────────────────

async function handleRequestError(error) {
  if (error?.status === 401) {
    state.user  = null;
    state.apps  = [];
    state.users = [];
    renderApps([]);
    renderUsers([]);
    updateAuthUi();
    stopAutoRefresh();
    setBanner("세션이 만료되었습니다. 로그인 페이지로 이동합니다.", "error");
    redirectToAuth();
    return;
  }
  setBanner(normalizeErrorMessage(error), "error");
}

async function handleSettingsModalError(error) {
  const message = normalizeErrorMessage(error, "설정 변경 중 오류가 발생했습니다.");
  const isCurrentPasswordMismatch =
    error?.status === 401 && /^current password is incorrect$/i.test(message);
  if (error?.status === 401 && !isCurrentPasswordMismatch) {
    await handleRequestError(error);
    return;
  }
  setSettingsError(message);
}

// ── 앱 카드 액션 ─────────────────────────────────────────────────────────────

function getActionTarget(button) {
  const appCard = button.closest(".app-card");
  if (!appCard) return null;
  return {
    userid:  appCard.dataset.userid,
    appname: appCard.dataset.appname,
    action:  button.dataset.action,
  };
}

async function performAction(target) {
  if (!canManageApps()) {
    throw new Error("앱 관리를 위해 로그인 상태와 비밀번호 변경 상태를 확인하세요.");
  }

  const { userid, appname, action } = target;
  const appLabel = `${userid}/${appname}`;

  if (action === "manage") {
    await navigateToApp(userid, appname);
    return;
  }

  if (action === "delete") {
    const keepData    = el.keepDataInput?.checked ?? false;
    const shouldDelete = window.confirm(`${appLabel} 앱을 삭제합니다.`);
    if (!shouldDelete) return;

    const data = await apiFetch(`/apps/${userid}/${appname}`, {
      method: "DELETE",
      body: JSON.stringify({ keepData }),
    });
    startJobPolling(data.jobId, appLabel, "삭제");

    if (state.selectedApp?.userid === userid && state.selectedApp?.appname === appname) {
      state.selectedApp = null;
      switchView("dashboard");
    }
    return;
  }

  const validActions = ["start", "stop", "deploy"];
  if (!validActions.includes(action)) return;

  const actionLabels = { start: "시작", stop: "중지", deploy: "재배포" };
  const data = await apiFetch(`/apps/${userid}/${appname}/${action}`, { method: "POST" });
  startJobPolling(data.jobId, appLabel, actionLabels[action] || action);
}

// ── 앱 관리 > Logs ────────────────────────────────────────────────────────────

async function loadDetailLogs() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const rawLines = Number.parseInt(el.detailLogLinesInput.value, 10);
  const lines = Number.isFinite(rawLines)
    ? Math.max(1, Math.min(1000, rawLines))
    : 120;
  el.detailLogsTitle.textContent = `${userid}/${appname} Fetching logs...`;
  const data = await apiFetch(`/apps/${userid}/${appname}/logs?lines=${lines}`);
  el.detailLogsTitle.textContent = `${userid}/${appname} (${lines} lines)`;
  el.detailLogsOutput.textContent = data.logs || "(empty)";
}

// ── 앱 관리 > Settings (env vars) ────────────────────────────────────────────

async function loadDetailEnv() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const data = await apiFetch(`/apps/${userid}/${appname}/env`);
  el.detailEnvTextarea.value = data.env || "";
}

async function saveDetailEnv() {
  if (!state.selectedApp) return;
  setEnvError("");
  const { userid, appname } = state.selectedApp;
  const envContent = el.detailEnvTextarea.value;
  el.detailEnvSaveBtn.disabled = true;
  el.detailEnvSaveBtn.textContent = "저장 중...";
  try {
    const result = await apiFetch(`/apps/${userid}/${appname}/env`, {
      method: "PUT",
      body: JSON.stringify({ env: envContent }),
    });
    if (result.jobId) {
      startJobPolling(result.jobId, `${userid}/${appname}`, "환경변수 재시작");
    }
    showToast(`환경변수 저장 완료: ${userid}/${appname}`, "success");
  } catch (error) {
    setEnvError(normalizeErrorMessage(error, "환경변수 저장 중 오류가 발생했습니다."));
  } finally {
    el.detailEnvSaveBtn.disabled = false;
    el.detailEnvSaveBtn.textContent = "저장 및 재시작";
  }
}

// ── 앱 생성 ───────────────────────────────────────────────────────────────────

async function handleCreate(event) {
  event.preventDefault();
  if (!canManageApps()) {
    throw new Error("로그인 후 비밀번호 변경을 완료해야 앱을 관리할 수 있습니다.");
  }

  const repoUrl = el.repoUrlInput.value.trim();
  const branch  = el.repoBranchInput.value.trim() || "main";
  const body    = {
    appname: el.appnameInput.value.trim(),
    repoUrl,
    branch,
  };

  if (!validateCreateForm()) {
    throw new Error("appname, repo URL을 입력하세요.");
  }

  const submitBtn = el.createSubmitBtn;
  submitBtn.disabled = true;
  submitBtn.textContent = "요청 중...";
  try {
    const data = await apiFetch("/apps", { method: "POST", body: JSON.stringify(body) });
    startJobPolling(data.jobId, `${body.appname}`, "앱 생성");
    el.createForm.reset();
    el.repoBranchInput.value = "main";
    syncDomainPreview();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create App";
  }
}

// ── 커스텀 도메인 ─────────────────────────────────────────────────────────────

async function loadDetailDomains() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const data = await apiFetch(`/apps/${userid}/${appname}/domains`);
  renderDomains(data.domains || []);
}

async function addCustomDomain(domain) {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const data = await apiFetch(`/apps/${userid}/${appname}/domains`, {
    method: "POST",
    body: JSON.stringify({ domain }),
  });
  return data.domain;
}

async function removeCustomDomain(id) {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  await apiFetch(`/apps/${userid}/${appname}/domains/${id}`, { method: "DELETE" });
}

async function verifyCustomDomain(id) {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const data = await apiFetch(`/apps/${userid}/${appname}/domains/${id}/verify`, {
    method: "POST",
  });
  return data.domain;
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  stopDetailLogsAutoRefresh();
  stopAdminLogsAutoRefresh();
}

export {
  addCustomDomain,
  apiFetch,
  cancelJob,
  getActionTarget,
  handleCreate,
  handleRequestError,
  handleSettingsModalError,
  loadApps,
  loadAdminApps,
  loadDetailDomains,
  loadPortalLogs,
  loadAndRecoverJobs,
  loadConfig,
  loadDetailEnv,
  loadDetailLogs,
  loadSession,
  loadUsers,
  performAction,
  refreshDashboardData,
  removeCustomDomain,
  retryJob,
  saveDetailEnv,
  startDetailLogsAutoRefresh,
  stopDetailLogsAutoRefresh,
  startAdminLogsAutoRefresh,
  stopAdminLogsAutoRefresh,
  stopAutoRefresh,
  verifyCustomDomain,
};


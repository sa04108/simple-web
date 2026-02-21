// =============================================================================
// app-api.js - API 통신 · 데이터 로딩 · 앱 액션
// =============================================================================
// 역할:
//   서버 API 호출과 데이터 로딩/자동갱신, 앱 액션(start/stop/deploy/delete)을 담당한다.
//   모듈 import를 통해 render/ui/utils/state에 명시적으로 의존한다.
// =============================================================================

// ── 기본 API 통신 ─────────────────────────────────────────────────────────────

// 모든 API 호출의 기반 함수. 응답이 ok: false이거나 HTTP 오류면 예외를 던진다.
import { AUTO_REFRESH_MS, el, state } from "./app-state.js";
import { renderApps, renderUsers } from "./app-render.js";
import { navigateToApp, switchView, updateAuthUi } from "./app-ui.js";
import {
  canManageApps,
  canManageUsers,
  normalizeErrorMessage,
  redirectToAuth,
  setBanner,
  setEnvError,
  setSettingsError,
  showToast,
  syncDomainPreview,
  validateCreateForm,
} from "./app-utils.js";

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
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
  if (canManageApps()) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

// ── 자동 갱신 ─────────────────────────────────────────────────────────────────

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!canManageApps()) return;
  state.refreshTimer = setInterval(async () => {
    try {
      await loadApps();
      await loadUsers();
    } catch (error) {
      await handleRequestError(error);
    }
  }, AUTO_REFRESH_MS);
}

// ── 공통 에러 처리 ────────────────────────────────────────────────────────────

// 401 응답은 세션 만료로 처리하여 인증 페이지로 리다이렉트한다.
// 그 외는 배너에 에러 메시지를 표시한다.
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

// 설정 모달(비밀번호 변경) 전용 에러 처리.
// 현재 비밀번호 오류(401)는 모달 내 인라인으로 표시하고,
// 다른 401(세션 만료)은 공통 핸들러로 위임한다.
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

// 클릭된 버튼이 속한 앱 카드에서 userid/appname/action을 추출한다.
function getActionTarget(button) {
  const appCard = button.closest(".app-card");
  if (!appCard) return null;
  return {
    userid:  appCard.dataset.userid,
    appname: appCard.dataset.appname,
    action:  button.dataset.action,
  };
}

// 앱 카드의 버튼 액션을 처리한다.
// manage → navigateToApp, delete → DELETE API, start/stop/deploy → POST API
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
    showToast(`삭제 요청 중: ${appLabel}`, "info");
    await apiFetch(`/apps/${userid}/${appname}`, {
      method: "DELETE",
      body: JSON.stringify({ keepData }),
    });
    if (state.selectedApp?.userid === userid && state.selectedApp?.appname === appname) {
      state.selectedApp = null;
      switchView("dashboard");
    }
    showToast(`삭제 완료: ${appLabel}`, "success");
    await loadApps();
    return;
  }

  const validActions = ["start", "stop", "deploy"];
  if (!validActions.includes(action)) return;

  if (action === "deploy") {
    showToast(`${appLabel} 재배포 중 (git pull + 이미지 재빌드, 시간이 걸릴 수 있습니다)...`, "info", 8000);
  } else {
    showToast(`${action} 요청 중: ${appLabel}`, "info");
  }
  await apiFetch(`/apps/${userid}/${appname}/${action}`, { method: "POST" });
  showToast(`${action} 완료: ${appLabel}`, "success");
  await loadApps();
}

// ── 앱 관리 > Logs ────────────────────────────────────────────────────────────

async function loadDetailLogs() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const rawLines = Number.parseInt(el.detailLogLinesInput.value, 10);
  const lines    = Number.isFinite(rawLines) ? Math.max(1, Math.min(1000, rawLines)) : 120;
  el.detailLogsTitle.textContent = `${userid}/${appname} 로그 조회 중...`;
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

// 환경변수를 저장하고 컨테이너를 재시작한다.
// 재시작 실패는 저장 성공과 분리하여 클라이언트에 개별 전달한다.
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
    if (result.restartError) {
      showToast(`환경변수 저장 완료, 컨테이너 재시작 실패: ${result.restartError}`, "error", 6000);
    } else {
      showToast(`환경변수 저장 및 재시작 완료: ${userid}/${appname}`, "success");
    }
    await loadApps();
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
  submitBtn.textContent = "생성 중...";
  try {
    showToast("앱 생성 중 (repo clone 및 빌드 포함, 시간이 걸릴 수 있습니다)...", "info", 8000);
    const data = await apiFetch("/apps", { method: "POST", body: JSON.stringify(body) });
    showToast(`앱 생성 완료: ${data.app.domain}`, "success");
    el.createForm.reset();
    el.repoBranchInput.value = "main";
    syncDomainPreview();
    await loadApps();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create App";
  }
}

export {
  apiFetch,
  getActionTarget,
  handleCreate,
  handleRequestError,
  handleSettingsModalError,
  loadApps,
  loadConfig,
  loadDetailEnv,
  loadDetailLogs,
  loadSession,
  loadUsers,
  performAction,
  refreshDashboardData,
  saveDetailEnv,
  startAutoRefresh,
  stopAutoRefresh,
};

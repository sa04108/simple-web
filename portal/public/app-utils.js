// =============================================================================
// app-utils.js - 순수 헬퍼 함수
// =============================================================================
// 역할:
//   부수효과가 최소화된 순수 유틸리티 함수를 제공한다.
//   app-state.js 이후 로드되어 el, state, createValidationTimers에 접근한다.
// =============================================================================

import {
  AVAILABLE_VIEWS,
  CREATE_FIELD_INVALID_CLASS,
  CREATE_FIELD_SEQUENCE_GAP_MS,
  CREATE_FIELD_SHAKE_CLASS,
  CREATE_FIELD_SHAKE_DURATION_MS,
  UI_STATE_STORAGE_KEY,
  createValidationTimers,
  el,
  state,
} from "./app-state.js";

// ── Toast 알림 ───────────────────────────────────────────────────────────────

// 우하단에 자동 소멸하는 토스트를 표시한다.
// durationMs 이후 페이드 아웃되며, 클릭 시 즉시 닫힌다.
function showToast(message, type = "info", durationMs = 4000) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  const dismiss = () => {
    if (!toast.isConnected) return;
    toast.style.animation = "none"; // forwards fill이 transition을 덮는 것을 방지
    toast.classList.add("dismissing");
    // transitionend가 발화되지 않는 경우(reduced-motion, 빠른 제거 등)를 대비한 fallback
    const fallback = window.setTimeout(() => toast.remove(), 400);
    toast.addEventListener("transitionend", () => {
      window.clearTimeout(fallback);
      toast.remove();
    }, { once: true });
  };

  const timer = window.setTimeout(dismiss, durationMs);
  toast.addEventListener("click", () => {
    window.clearTimeout(timer);
    dismiss();
  });
}

// ── 배너 · 인라인 에러 ───────────────────────────────────────────────────────

function setBanner(message, type = "info") {
  el.statusBanner.className = `status-banner ${type}`;
  el.statusBanner.textContent = message;
  el.statusBanner.hidden = !message;
}

// API 에러 객체의 메시지를 UI 표시용 문자열로 정규화한다.
// "AppError: ..." 접두사를 제거하고 빈 메시지는 fallback으로 대체한다.
function normalizeErrorMessage(error, fallback = "요청 중 오류가 발생했습니다.") {
  const raw = String(error?.message || "").trim();
  if (!raw) return fallback;
  return raw.replace(/^AppError:\s*/i, "");
}

// 인라인 에러 요소를 표시하거나 숨긴다. (message가 비면 숨김)
function setInlineError(targetEl, message = "") {
  const normalized = String(message || "").trim();
  targetEl.hidden = !normalized;
  targetEl.textContent = normalized;
}

// 각 모달별 인라인 에러 표시 단축 함수
function setSettingsError(message = "")    { setInlineError(el.settingsError,    message); }
function setCreateUserError(message = "")  { setInlineError(el.createUserError,  message); }
function setDeleteUserError(message = "")  { setInlineError(el.deleteUserError,  message); }
function setPromoteAdminError(message = "") { setInlineError(el.promoteAdminError, message); }
function setEnvError(message = "")         { setInlineError(el.detailEnvError,    message); }

// ── 앱 생성 폼 필드 유효성 시각화 ────────────────────────────────────────────

function queueCreateValidationTimer(callback, delayMs) {
  const timerId = window.setTimeout(callback, delayMs);
  createValidationTimers.push(timerId);
}

// 예약된 shake 타이머를 모두 취소한다 (submit 재시도 시 이전 애니메이션 중단)
function clearCreateValidationTimers() {
  while (createValidationTimers.length) {
    window.clearTimeout(createValidationTimers.pop());
  }
}

function clearCreateFieldFeedback(field) {
  if (!field) return;
  field.classList.remove(CREATE_FIELD_INVALID_CLASS, CREATE_FIELD_SHAKE_CLASS);
  field.removeAttribute("aria-invalid");
}

// 필드에 오류 표시를 추가하고 CSS shake 애니메이션을 트리거한다.
// void field.offsetWidth — reflow를 강제하여 같은 클래스를 지웠다가 다시 추가할 때
// 브라우저가 애니메이션을 재시작하도록 한다.
function highlightCreateField(field) {
  if (!field) return;
  field.classList.add(CREATE_FIELD_INVALID_CLASS);
  field.setAttribute("aria-invalid", "true");
  field.classList.remove(CREATE_FIELD_SHAKE_CLASS);
  void field.offsetWidth; // force reflow
  field.classList.add(CREATE_FIELD_SHAKE_CLASS);
  queueCreateValidationTimer(
    () => field.classList.remove(CREATE_FIELD_SHAKE_CLASS),
    CREATE_FIELD_SHAKE_DURATION_MS
  );
}

// 필수 필드 중 비어있는 필드를 순차적으로 shake 처리하고 첫 번째 필드에 포커스한다.
// 필드 간 딜레이(CREATE_FIELD_SEQUENCE_GAP_MS)를 줘서 시각적으로 구분한다.
function validateCreateForm() {
  const requiredFields = [
    { field: el.appnameInput, isMissing: () => !el.appnameInput.value.trim() },
    { field: el.repoUrlInput, isMissing: () => !el.repoUrlInput.value.trim() },
  ];
  clearCreateValidationTimers();
  requiredFields.forEach((item) => clearCreateFieldFeedback(item.field));

  const missingFields = requiredFields.filter((item) => item.isMissing());
  if (!missingFields.length) return true;

  missingFields.forEach((item, index) => {
    queueCreateValidationTimer(() => {
      if (item.isMissing()) highlightCreateField(item.field);
    }, index * CREATE_FIELD_SEQUENCE_GAP_MS);
  });

  if (missingFields[0]?.field) missingFields[0].field.focus();
  return false;
}

// ── 문자열 · 포맷 헬퍼 ───────────────────────────────────────────────────────

// innerHTML에 사용자 입력을 삽입할 때 XSS를 방지하기 위해 HTML 특수문자를 이스케이프한다.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// "YYYY-MM-DD HH:mm" 형식으로 날짜를 포맷한다. 유효하지 않으면 원본 문자열을 반환한다.
function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return (
    `${date.getFullYear()}-` +
    `${String(date.getMonth() + 1).padStart(2, "0")}-` +
    `${String(date.getDate()).padStart(2, "0")} ` +
    `${String(date.getHours()).padStart(2, "0")}:` +
    `${String(date.getMinutes()).padStart(2, "0")}`
  );
}

// 사용자 입력을 양의 정수로 변환한다. 파싱 불가 시 null을 반환한다.
function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

// Docker 상태 문자열을 CSS 클래스명으로 변환한다. ("running" → "status-running")
function statusClass(status) {
  const normalized = String(status || "unknown").trim().toLowerCase().replaceAll(" ", "-");
  return `status-${normalized}`;
}

// ── Job 문자열 포맷 ────────────────────────────────────────────────────────────

// Job 객체에서 앱 식별자(userid/appname)를 추출한다. 없으면 빈 문자열을 반환한다.
function formatJobTarget(job) {
  return job.meta?.appname ? `${job.meta.userid}/${job.meta.appname}` : "";
}

// Job 객체에서 표시용 작업 이름(한글)을 추출한다.
function formatJobAction(job) {
  const typeMap = {
    create: "앱 생성",
    deploy: "재배포",
    delete: "앱 삭제",
    start:  "시작",
    stop:   "중지",
    "env-restart": "환경변수 재시작",
  };
  return typeMap[job.type] || String(job.type || "작업");
}

// ── 인증 상태 확인 ────────────────────────────────────────────────────────────

function isLoggedIn()       { return Boolean(state.user); }
function isAdminUser()      { return String(state.user?.role || "") === "admin"; }
function isPasswordLocked() { return Boolean(state.user?.mustChangePassword); }
function canManageApps()    { return isLoggedIn() && !isPasswordLocked(); }
function canManageUsers()   { return canManageApps() && isAdminUser(); }
function redirectToAuth()   { window.location.replace("/auth"); }

// ── UI 상태 영속성 (sessionStorage) ──────────────────────────────────────────

// 탭/새로고침 시 마지막 뷰를 복원하기 위해 sessionStorage에 현재 뷰를 저장한다.
function readPersistedUiState() {
  try {
    const raw = window.sessionStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const view = AVAILABLE_VIEWS.includes(parsed?.view) ? parsed.view : undefined;
    return { view };
  } catch {
    return {};
  }
}

function persistUiState() {
  try {
    window.sessionStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify({ view: state.activeView })
    );
  } catch {
    // 시크릿 모드 등 스토리지 쓰기 불가 환경에서는 조용히 무시한다.
  }
}

// ── 도메인 프리뷰 ─────────────────────────────────────────────────────────────

// 앱 생성 폼의 appname 입력에 따라 예상 도메인 주소를 실시간으로 업데이트한다.
function syncDomainPreview() {
  const userid  = String(state.user?.username || "").trim() || "owner";
  const appname = el.appnameInput.value.trim() || "appname";
  el.domainPreview.textContent = `${userid}-${appname}.${state.domain}`;
}

// ── 런타임 뱃지 HTML 생성 ────────────────────────────────────────────────────

// 서버가 내려보내는 icon 클래스와 displayName으로 단일 뱃지 HTML을 생성한다.
function badgeForRuntime(iconKey, displayName) {
  const safeClass = escapeHtml(String(iconKey ?? ""));
  const safeLabel = escapeHtml(String(displayName ?? iconKey));
  return `<span class="runtime-badge ${safeClass}">${safeLabel}</span>`;
}

// detectedRuntime 메타데이터를 기반으로 기술 스택 뱃지 HTML을 생성한다.
// dependencies 배열이 있으면 각 항목을 개별 뱃지로, 없으면 단일 뱃지로 렌더링한다.
function runtimeBadgeHtml(detectedRuntime) {
  if (!detectedRuntime) return "";

  if (Array.isArray(detectedRuntime.dependencies) && detectedRuntime.dependencies.length > 0) {
    return detectedRuntime.dependencies
      .map(dep => badgeForRuntime(dep.icon ?? dep.name, dep.displayName ?? dep.name))
      .join("");
  }

  if (!detectedRuntime.name) return "";
  return badgeForRuntime(
    detectedRuntime.icon ?? detectedRuntime.name,
    detectedRuntime.displayName ?? detectedRuntime.name,
  );
}

// ── 접근 상태 적용 ────────────────────────────────────────────────────────────

// 로그인/비밀번호 변경 상태에 따라 인터랙티브 요소의 disabled 상태를 동기화한다.
function applyAccessState() {
  const enabled = canManageApps();
  Array.from(el.createForm.elements).forEach((node) => { node.disabled = !enabled; });
  el.refreshBtn.disabled = !enabled;
  if (el.keepDataInput)      el.keepDataInput.disabled      = !enabled;
  if (el.detailLogLinesInput) el.detailLogLinesInput.disabled = !enabled;
  if (el.detailEnvSaveBtn)   el.detailEnvSaveBtn.disabled   = !enabled;
  if (el.detailExecRunBtn)   el.detailExecRunBtn.disabled   = !enabled;
  if (el.detailExecInput)    el.detailExecInput.disabled    = !enabled;
}

export {
  applyAccessState,
  canManageApps,
  canManageUsers,
  clearCreateFieldFeedback,
  escapeHtml,
  formatDate,
  formatJobAction,
  formatJobTarget,
  isAdminUser,
  isLoggedIn,
  isPasswordLocked,
  normalizeErrorMessage,
  parsePositiveInt,
  persistUiState,
  readPersistedUiState,
  redirectToAuth,
  runtimeBadgeHtml,
  setBanner,
  setCreateUserError,
  setDeleteUserError,
  setEnvError,
  setPromoteAdminError,
  setSettingsError,
  showToast,
  statusClass,
  syncDomainPreview,
  validateCreateForm,
};

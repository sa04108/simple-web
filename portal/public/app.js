// =============================================================================
// app.js - 포털 대시보드 프론트엔드 컨트롤러
// =============================================================================
// 역할:
//   포털 웹 UI의 메인 로직을 담당한다.
//   - 대시보드: 앱 목록 조회 및 상태 표시 (30초 자동 갱신)
//   - 앱 생성: GitHub repo URL 입력 후 앱 생성 요청
//   - 앱 관리(per-app): Logs / Exec / Settings 서브탭
//   - 사용자 관리: 계정 생성/삭제/admin 승격 (admin 전용)
//   - 세션 상태(현재 뷰)를 sessionStorage에 유지
// =============================================================================
const AUTO_REFRESH_MS = 30000;
const UI_STATE_STORAGE_KEY = "portal.uiState";
const AVAILABLE_VIEWS = ["dashboard", "create", "app-detail", "users"];
const AVAILABLE_DETAIL_TABS = ["logs", "exec", "settings"];
const DEFAULT_VIEW = "dashboard";
const DEFAULT_DETAIL_TAB = "logs";
const CREATE_FIELD_INVALID_CLASS = "field-invalid";
const CREATE_FIELD_SHAKE_CLASS = "field-shake";
const CREATE_FIELD_SEQUENCE_GAP_MS = 120;
const CREATE_FIELD_SHAKE_DURATION_MS = 320;

const state = {
  domain: "my.domain.com",
  devMode: false,
  apps: [],
  users: [],
  pendingDeleteUser: null,
  pendingPromoteUser: null,
  user: null,
  refreshTimer: null,
  activeView: DEFAULT_VIEW,
  activeDetailTab: DEFAULT_DETAIL_TAB,
  selectedApp: null, // { userid, appname }
};

const el = {
  devModeBadge: document.getElementById("dev-mode-badge"),
  gnbBrand: document.querySelector(".gnb-brand"),
  gnbNav: document.querySelector(".gnb-nav"),
  gnbOverlay: document.getElementById("gnb-mobile-overlay"),
  gnbItems: Array.from(document.querySelectorAll(".gnb-item")),
  gnbUsersBtn: document.getElementById("gnb-users-btn"),
  mobileMenuBtn: document.getElementById("mobile-menu-btn"),
  viewDashboard: document.getElementById("view-dashboard"),
  viewCreate: document.getElementById("view-create"),
  viewAppDetail: document.getElementById("view-app-detail"),
  viewUsers: document.getElementById("view-users"),
  statusBanner: document.getElementById("status-banner"),
  authState: document.getElementById("auth-state"),
  logoutBtn: document.getElementById("logout-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsModal: document.getElementById("settings-modal"),
  settingsError: document.getElementById("settings-error"),
  closeSettingsBtn: document.getElementById("close-settings-btn"),
  passwordForm: document.getElementById("password-form"),
  currentPasswordInput: document.getElementById("current-password-input"),
  newPasswordInput: document.getElementById("new-password-input"),
  newPasswordConfirmInput: document.getElementById("new-password-confirm-input"),
  createForm: document.getElementById("create-form"),
  appnameInput: document.getElementById("appname-input"),
  repoUrlInput: document.getElementById("repo-url-input"),
  repoBranchInput: document.getElementById("repo-branch-input"),
  domainPreview: document.getElementById("domain-preview"),
  domainChip: document.getElementById("domain-chip"),
  limitChip: document.getElementById("limit-chip"),
  appCountChip: document.getElementById("app-count-chip"),
  refreshBtn: document.getElementById("refresh-btn"),
  emptyState: document.getElementById("empty-state"),
  appsContainer: document.getElementById("apps-container"),
  // App detail sub-GNB
  appDetailBackBtn: document.getElementById("app-detail-back-btn"),
  appDetailAppname: document.getElementById("app-detail-appname"),
  detailTabBtns: Array.from(document.querySelectorAll(".detail-tab-btn")),
  // App detail panels
  detailPanelLogs: document.getElementById("detail-panel-logs"),
  detailPanelExec: document.getElementById("detail-panel-exec"),
  detailPanelSettings: document.getElementById("detail-panel-settings"),
  // Logs
  detailLogLinesInput: document.getElementById("detail-log-lines-input"),
  detailRefreshLogsBtn: document.getElementById("detail-refresh-logs-btn"),
  detailLogsTitle: document.getElementById("detail-logs-title"),
  detailLogsOutput: document.getElementById("detail-logs-output"),
  // Exec
  detailExecClearBtn: document.getElementById("detail-exec-clear-btn"),
  detailExecOutput: document.getElementById("detail-exec-output"),
  detailExecInput: document.getElementById("detail-exec-input"),
  detailExecRunBtn: document.getElementById("detail-exec-run-btn"),
  detailExecPromptCwd: document.getElementById("detail-exec-prompt-cwd"),
  // Settings
  detailEnvTextarea: document.getElementById("detail-env-textarea"),
  detailEnvError: document.getElementById("detail-env-error"),
  detailEnvSaveBtn: document.getElementById("detail-env-save-btn"),
  keepDataInput: document.getElementById("keep-data-input"),
  // Users
  usersCount: document.getElementById("users-count"),
  usersEmptyState: document.getElementById("users-empty-state"),
  usersTableBody: document.getElementById("users-table-body"),
  openCreateUserBtn: document.getElementById("open-create-user-btn"),
  createUserModal: document.getElementById("create-user-modal"),
  closeCreateUserBtn: document.getElementById("close-create-user-btn"),
  cancelCreateUserBtn: document.getElementById("cancel-create-user-btn"),
  createUserForm: document.getElementById("create-user-form"),
  createUserError: document.getElementById("create-user-error"),
  createUsernameInput: document.getElementById("create-username-input"),
  createPasswordInput: document.getElementById("create-password-input"),
  createPasswordConfirmInput: document.getElementById("create-password-confirm-input"),
  createUserRoleInput: document.getElementById("create-user-role-input"),
  deleteUserModal: document.getElementById("delete-user-modal"),
  closeDeleteUserBtn: document.getElementById("close-delete-user-btn"),
  cancelDeleteUserBtn: document.getElementById("cancel-delete-user-btn"),
  deleteUserForm: document.getElementById("delete-user-form"),
  deleteUserTarget: document.getElementById("delete-user-target"),
  deleteUserError: document.getElementById("delete-user-error"),
  deleteUserPasswordInput: document.getElementById("delete-user-password-input"),
  promoteAdminModal: document.getElementById("promote-admin-modal"),
  closePromoteAdminBtn: document.getElementById("close-promote-admin-btn"),
  cancelPromoteAdminBtn: document.getElementById("cancel-promote-admin-btn"),
  submitPromoteAdminBtn: document.getElementById("submit-promote-admin-btn"),
  promoteAdminTarget: document.getElementById("promote-admin-target"),
  promoteAdminError: document.getElementById("promote-admin-error"),
};

const modalBackdropState = {
  settings: false,
  createUser: false,
  deleteUser: false,
  promoteAdmin: false,
};

const createValidationTimers = [];

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function setBanner(message, type = "info") {
  el.statusBanner.className = `status-banner ${type}`;
  el.statusBanner.textContent = message;
}

function normalizeErrorMessage(error, fallback = "요청 중 오류가 발생했습니다.") {
  const raw = String(error?.message || "").trim();
  if (!raw) return fallback;
  return raw.replace(/^AppError:\s*/i, "");
}

function setInlineError(targetEl, message = "") {
  const normalized = String(message || "").trim();
  targetEl.hidden = !normalized;
  targetEl.textContent = normalized;
}

function setSettingsError(message = "") { setInlineError(el.settingsError, message); }
function setCreateUserError(message = "") { setInlineError(el.createUserError, message); }
function setDeleteUserError(message = "") { setInlineError(el.deleteUserError, message); }
function setPromoteAdminError(message = "") { setInlineError(el.promoteAdminError, message); }
function setEnvError(message = "") { setInlineError(el.detailEnvError, message); }

function queueCreateValidationTimer(callback, delayMs) {
  const timerId = window.setTimeout(callback, delayMs);
  createValidationTimers.push(timerId);
}

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

function highlightCreateField(field) {
  if (!field) return;
  field.classList.add(CREATE_FIELD_INVALID_CLASS);
  field.setAttribute("aria-invalid", "true");
  field.classList.remove(CREATE_FIELD_SHAKE_CLASS);
  void field.offsetWidth;
  field.classList.add(CREATE_FIELD_SHAKE_CLASS);
  queueCreateValidationTimer(() => {
    field.classList.remove(CREATE_FIELD_SHAKE_CLASS);
  }, CREATE_FIELD_SHAKE_DURATION_MS);
}

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isLoggedIn() { return Boolean(state.user); }
function isAdminUser() { return String(state.user?.role || "") === "admin"; }
function isPasswordLocked() { return Boolean(state.user?.mustChangePassword); }
function canManageApps() { return isLoggedIn() && !isPasswordLocked(); }
function canManageUsers() { return canManageApps() && isAdminUser(); }
function redirectToAuth() { window.location.replace("/auth"); }

// ── UI 상태 영속성 ──────────────────────────────────────────────────────────

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
    // Ignore storage write errors.
  }
}

// ── 도메인 프리뷰 ────────────────────────────────────────────────────────────

function syncDomainPreview() {
  const userid = String(state.user?.username || "").trim() || "owner";
  const appname = el.appnameInput.value.trim() || "appname";
  el.domainPreview.textContent = `${userid}-${appname}.${state.domain}`;
}

// ── 런타임 뱃지 ─────────────────────────────────────────────────────────────

function runtimeBadgeHtml(detectedRuntime) {
  if (!detectedRuntime) return "";
  if (Array.isArray(detectedRuntime.dependencies) && detectedRuntime.dependencies.length > 0) {
    return detectedRuntime.dependencies.map(dep => {
      const safeIcon = escapeHtml(dep.icon || dep.name);
      const safeName = escapeHtml(dep.displayName || dep.name);
      return `<span class="runtime-badge ${safeIcon}">${safeName}</span>`;
    }).join("");
  }
  if (!detectedRuntime.name) return "";
  const safeIcon = escapeHtml(detectedRuntime.icon || detectedRuntime.name);
  const safeName = escapeHtml(detectedRuntime.displayName || detectedRuntime.name);
  return `<span class="runtime-badge ${safeIcon}">${safeName}</span>`;
}

// ── 뷰 전환 ─────────────────────────────────────────────────────────────────

function switchView(viewName, { persist = true } = {}) {
  const nextView = AVAILABLE_VIEWS.includes(viewName) ? viewName : DEFAULT_VIEW;
  state.activeView = nextView;

  el.viewDashboard.hidden = nextView !== "dashboard";
  el.viewCreate.hidden = nextView !== "create";
  el.viewAppDetail.hidden = nextView !== "app-detail";
  el.viewUsers.hidden = nextView !== "users";

  el.gnbItems.forEach((item) => {
    // app-detail은 별도 GNB 항목이 없으므로 dashboard를 active로 표시하지 않는다
    const viewKey = nextView === "app-detail" ? "dashboard" : nextView;
    item.classList.toggle("active", item.dataset.view === viewKey);
  });

  if (persist) persistUiState();
  closeMobileMenu();
}

function closeMobileMenu() {
  el.gnbNav.classList.remove("open");
  el.gnbOverlay.classList.remove("open");
}

function toggleMobileMenu() {
  el.gnbNav.classList.toggle("open");
  el.gnbOverlay.classList.toggle("open");
}

// ── 앱 관리 화면 ─────────────────────────────────────────────────────────────

function switchDetailTab(tabName) {
  const nextTab = AVAILABLE_DETAIL_TABS.includes(tabName) ? tabName : DEFAULT_DETAIL_TAB;
  state.activeDetailTab = nextTab;

  el.detailTabBtns.forEach((btn) => {
    const isActive = btn.dataset.detailTab === nextTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });

  el.detailPanelLogs.hidden = nextTab !== "logs";
  el.detailPanelExec.hidden = nextTab !== "exec";
  el.detailPanelSettings.hidden = nextTab !== "settings";
}

async function navigateToApp(userid, appname) {
  state.selectedApp = { userid, appname };
  execCwd = "";
  updateExecPrompt();
  el.appDetailAppname.textContent = `${userid} / ${appname}`;
  switchDetailTab(DEFAULT_DETAIL_TAB);
  switchView("app-detail");
  // 앱 관리 화면 진입 시 로그를 자동으로 조회한다
  try {
    await loadDetailLogs();
  } catch (error) {
    await handleRequestError(error);
  }
  // Settings 탭에도 env 데이터를 미리 로드한다
  loadDetailEnv().catch(() => {});
}

// ── 상태 날짜 포맷 ─────────────────────────────────────────────────────────

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function statusClass(status) {
  const normalized = String(status || "unknown").trim().toLowerCase().replaceAll(" ", "-");
  return `status-${normalized}`;
}

// ── 접근 상태 적용 ──────────────────────────────────────────────────────────

function applyAccessState() {
  const enabled = canManageApps();
  Array.from(el.createForm.elements).forEach((node) => { node.disabled = !enabled; });
  el.refreshBtn.disabled = !enabled;
  if (el.keepDataInput) el.keepDataInput.disabled = !enabled;
  if (el.detailLogLinesInput) el.detailLogLinesInput.disabled = !enabled;
  if (el.detailEnvSaveBtn) el.detailEnvSaveBtn.disabled = !enabled;
  if (el.detailExecRunBtn) el.detailExecRunBtn.disabled = !enabled;
  if (el.detailExecInput) el.detailExecInput.disabled = !enabled;
}

// ── 앱 렌더링 ────────────────────────────────────────────────────────────────

function renderApps(apps) {
  el.appCountChip.textContent = String(apps.length);
  if (!apps.length) {
    el.emptyState.style.display = "block";
    if (!isLoggedIn()) {
      el.emptyState.textContent = "로그인하면 앱 목록을 조회할 수 있습니다.";
    } else if (isPasswordLocked()) {
      el.emptyState.textContent = "비밀번호를 변경한 뒤 앱 목록을 조회할 수 있습니다.";
    } else {
      el.emptyState.textContent = "앱이 없습니다. 먼저 앱을 생성하세요.";
    }
    el.appsContainer.innerHTML = "";
    return;
  }

  const actionsDisabled = canManageApps() ? "" : "disabled";
  el.emptyState.style.display = "none";
  el.appsContainer.innerHTML = apps.map((appItem) => {
    const safeUser = escapeHtml(appItem.userid);
    const safeApp = escapeHtml(appItem.appname);
    const safeRepoUrl = escapeHtml(appItem.repoUrl || "-");
    const safeBranch = escapeHtml(appItem.branch || "main");
    const rawStatus = appItem.status || "unknown";
    const safeStatus = escapeHtml(rawStatus);
    const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));
    const badgeHtml = runtimeBadgeHtml(appItem.detectedRuntime);

    let domainHtml;
    if (state.devMode && appItem.devPort) {
      const url = `http://localhost:${appItem.devPort}`;
      const safeUrl = escapeHtml(url);
      domainHtml = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
    } else {
      domainHtml = escapeHtml(appItem.domain || "-");
    }

    return `
      <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
        <div class="app-card-head">
          <button class="app-name-btn" data-action="manage" type="button" ${actionsDisabled}>${safeUser} / ${safeApp}</button>
          <div class="app-card-head-right">
            <div class="app-card-badges">
              ${badgeHtml}
              <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
            </div>
            <button class="action-btn app-manage-btn" data-action="manage" type="button" ${actionsDisabled}>관리</button>
          </div>
        </div>
        <p class="app-domain">${domainHtml}</p>
        <p class="app-meta">repo: ${safeRepoUrl} | branch: ${safeBranch} | created: ${safeCreatedAt}</p>
        <div class="app-actions">
          <button class="action-btn" data-action="start" type="button" ${actionsDisabled}>Start</button>
          <button class="action-btn" data-action="stop" type="button" ${actionsDisabled}>Stop</button>
          <button class="action-btn" data-action="deploy" type="button" ${actionsDisabled}>Deploy</button>
          <button class="action-btn danger" data-action="delete" type="button" ${actionsDisabled}>Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

// ── 사용자 렌더링 ─────────────────────────────────────────────────────────────

function renderUsers(users) {
  if (!canManageUsers()) {
    el.usersCount.textContent = "0명";
    el.usersTableBody.innerHTML = "";
    el.usersEmptyState.hidden = false;
    el.openCreateUserBtn.disabled = true;
    if (!isLoggedIn()) {
      el.usersEmptyState.textContent = "로그인하면 사용자 목록을 조회할 수 있습니다.";
    } else if (isPasswordLocked()) {
      el.usersEmptyState.textContent = "비밀번호를 변경한 뒤 사용자 목록을 조회할 수 있습니다.";
    } else {
      el.usersEmptyState.textContent = "관리자 계정에서만 사용자 목록을 조회할 수 있습니다.";
    }
    return;
  }

  el.openCreateUserBtn.disabled = false;
  el.usersCount.textContent = `${users.length}명`;
  if (!users.length) {
    el.usersTableBody.innerHTML = "";
    el.usersEmptyState.hidden = false;
    el.usersEmptyState.textContent = "등록된 사용자가 없습니다.";
    return;
  }

  el.usersEmptyState.hidden = true;
  el.usersTableBody.innerHTML = users.map((item) => {
    const safeUsername = escapeHtml(item.username || "-");
    const isAdmin = item.isAdmin;
    const safeRole = isAdmin ? "Admin" : "User";
    const safeCreatedAt = escapeHtml(formatDate(item.createdAt));
    const safeLastAccessAt = escapeHtml(formatDate(item.lastAccessAt));

    let actionCell;
    if (isAdmin) {
      actionCell = `<span class="users-protected">보호됨</span>`;
    } else {
      actionCell = `
        <div class="users-action-group">
          <button
            class="action-btn users-promote-btn"
            data-action="promote-user"
            data-id="${item.id}"
            data-username="${safeUsername}"
            type="button"
          >Admin 승격</button>
          <button
            class="action-btn danger users-remove-btn"
            data-action="remove-user"
            data-id="${item.id}"
            data-username="${safeUsername}"
            type="button"
          >제거</button>
        </div>`;
    }

    return `
      <tr>
        <td>${safeUsername}</td>
        <td><span class="role-badge ${isAdmin ? "role-admin" : "role-user"}">${safeRole}</span></td>
        <td>${safeCreatedAt}</td>
        <td>${safeLastAccessAt}</td>
        <td>${actionCell}</td>
      </tr>
    `;
  }).join("");
}

// ── Auth UI 동기화 ───────────────────────────────────────────────────────────

function syncModalOpenState() {
  const hasOpenModal =
    !el.settingsModal.hidden ||
    !el.createUserModal.hidden ||
    !el.deleteUserModal.hidden ||
    !el.promoteAdminModal.hidden;
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function updateAuthUi() {
  if (!isLoggedIn()) {
    el.authState.textContent = "인증 필요";
    el.logoutBtn.hidden = true;
    el.settingsBtn.hidden = true;
    el.gnbUsersBtn.hidden = true;
    state.users = [];
    renderUsers([]);
    if (state.activeView === "users" && DEFAULT_VIEW !== "users") {
      switchView(DEFAULT_VIEW);
    }
    applyAccessState();
    closeSettingsModal();
    closeCreateUserModal({ resetForm: true });
    closeDeleteUserModal({ resetForm: true });
    closePromoteAdminModal();
    return;
  }

  const suffix = isPasswordLocked() ? " | 비밀번호 변경 필요" : "";
  el.authState.textContent = `${state.user.username} (${state.user.role})${suffix}`;
  el.logoutBtn.hidden = false;
  el.settingsBtn.hidden = false;
  el.gnbUsersBtn.hidden = !canManageUsers();

  if (el.gnbUsersBtn.hidden && state.activeView === "users") {
    switchView(DEFAULT_VIEW);
  }
  if (!canManageUsers()) {
    closeCreateUserModal({ resetForm: true });
    closeDeleteUserModal({ resetForm: true });
    closePromoteAdminModal();
  }
  applyAccessState();
}

// ── 모달 ─────────────────────────────────────────────────────────────────────

function bindBackdropClose(modalElement, stateKey, onClose) {
  modalElement.addEventListener("mousedown", (event) => {
    modalBackdropState[stateKey] = event.target === modalElement;
  });
  modalElement.addEventListener("click", (event) => {
    if (event.target === modalElement && modalBackdropState[stateKey]) onClose();
    modalBackdropState[stateKey] = false;
  });
}

function openSettingsModal() {
  if (!isLoggedIn()) return;
  modalBackdropState.settings = false;
  setSettingsError("");
  el.settingsModal.hidden = false;
  syncModalOpenState();
  el.currentPasswordInput.focus();
}

function closeSettingsModal() {
  modalBackdropState.settings = false;
  el.settingsModal.hidden = true;
  syncModalOpenState();
  setSettingsError("");
  el.passwordForm.reset();
}

function openCreateUserModal() {
  if (!canManageUsers()) return;
  modalBackdropState.createUser = false;
  setCreateUserError("");
  el.createUserModal.hidden = false;
  syncModalOpenState();
  el.createUsernameInput.focus();
}

function closeCreateUserModal({ resetForm = false } = {}) {
  modalBackdropState.createUser = false;
  el.createUserModal.hidden = true;
  setCreateUserError("");
  if (resetForm) {
    el.createUserForm.reset();
    el.createUserRoleInput.value = "user";
  }
  syncModalOpenState();
}

function openDeleteUserModal(targetUser) {
  if (!canManageUsers()) return;
  state.pendingDeleteUser = targetUser || null;
  if (!state.pendingDeleteUser) return;
  modalBackdropState.deleteUser = false;
  setDeleteUserError("");
  el.deleteUserPasswordInput.value = "";
  el.deleteUserTarget.textContent = `'${state.pendingDeleteUser.username}' 사용자를 제거합니다.`;
  el.deleteUserModal.hidden = false;
  syncModalOpenState();
  el.deleteUserPasswordInput.focus();
}

function closeDeleteUserModal({ resetForm = false } = {}) {
  modalBackdropState.deleteUser = false;
  el.deleteUserModal.hidden = true;
  setDeleteUserError("");
  if (resetForm) {
    state.pendingDeleteUser = null;
    el.deleteUserPasswordInput.value = "";
    el.deleteUserTarget.textContent = "삭제할 사용자를 확인하세요.";
  }
  syncModalOpenState();
}

function openPromoteAdminModal(targetUser) {
  if (!canManageUsers()) return;
  state.pendingPromoteUser = targetUser || null;
  if (!state.pendingPromoteUser) return;
  modalBackdropState.promoteAdmin = false;
  setPromoteAdminError("");
  el.promoteAdminTarget.textContent =
    `'${state.pendingPromoteUser.username}' 사용자를 Admin으로 승격합니다.`;
  el.promoteAdminModal.hidden = false;
  syncModalOpenState();
  el.submitPromoteAdminBtn.focus();
}

function closePromoteAdminModal() {
  modalBackdropState.promoteAdmin = false;
  el.promoteAdminModal.hidden = true;
  state.pendingPromoteUser = null;
  setPromoteAdminError("");
  syncModalOpenState();
}

// ── API ──────────────────────────────────────────────────────────────────────

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

// ── 데이터 로드 ──────────────────────────────────────────────────────────────

async function loadConfig() {
  const data = await apiFetch("/config");
  state.domain = data.domain || "my.domain.com";
  state.devMode = Boolean(data.devMode);
  el.domainChip.textContent = state.domain;
  el.limitChip.textContent = `${data.limits.maxAppsPerUser}/${data.limits.maxTotalApps}`;
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

// ── 자동 갱신 ────────────────────────────────────────────────────────────────

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

// ── 오류 처리 ────────────────────────────────────────────────────────────────

async function handleRequestError(error) {
  if (error?.status === 401) {
    state.user = null;
    state.apps = [];
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

// ── 앱 액션 ──────────────────────────────────────────────────────────────────

function getActionTarget(button) {
  const appCard = button.closest(".app-card");
  if (!appCard) return null;
  return {
    userid: appCard.dataset.userid,
    appname: appCard.dataset.appname,
    action: button.dataset.action,
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
    const keepData = el.keepDataInput?.checked ?? false;
    const shouldDelete = window.confirm(`${appLabel} 앱을 삭제합니다.`);
    if (!shouldDelete) return;
    setBanner(`삭제 요청 중: ${appLabel}`, "info");
    await apiFetch(`/apps/${userid}/${appname}`, {
      method: "DELETE",
      body: JSON.stringify({ keepData }),
    });
    if (state.selectedApp?.userid === userid && state.selectedApp?.appname === appname) {
      state.selectedApp = null;
      switchView("dashboard");
    }
    setBanner(`삭제 완료: ${appLabel}`, "success");
    await loadApps();
    return;
  }

  const validActions = ["start", "stop", "deploy"];
  if (!validActions.includes(action)) return;

  if (action === "deploy") {
    setBanner(`${appLabel} 재배포 중 (git pull + 이미지 재빌드, 시간이 걸릴 수 있습니다)...`, "info");
  } else {
    setBanner(`${action} 요청 중: ${appLabel}`, "info");
  }
  await apiFetch(`/apps/${userid}/${appname}/${action}`, { method: "POST" });
  setBanner(`${action} 완료: ${appLabel}`, "success");
  await loadApps();
}

// ── 앱 관리 > Logs ────────────────────────────────────────────────────────────

async function loadDetailLogs() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const rawLines = Number.parseInt(el.detailLogLinesInput.value, 10);
  const lines = Number.isFinite(rawLines) ? Math.max(1, Math.min(1000, rawLines)) : 120;
  el.detailLogsTitle.textContent = `${userid}/${appname} 로그 조회 중...`;
  const data = await apiFetch(`/apps/${userid}/${appname}/logs?lines=${lines}`);
  el.detailLogsTitle.textContent = `${userid}/${appname} (${lines} lines)`;
  el.detailLogsOutput.textContent = data.logs || "(empty)";
}

// ── 앱 관리 > Exec ────────────────────────────────────────────────────────────

// Command history — supports keyboard navigation (↑ back, ↓ forward)
const execHistory = (() => {
  const MAX = 200;
  const stack = [];
  let cursor = -1; // -1 = not navigating; 0 = most-recent entry
  let draft = "";  // preserves in-progress text while navigating

  return {
    push(cmd) {
      if (stack.at(-1) !== cmd) { // suppress consecutive duplicates
        stack.push(cmd);
        if (stack.length > MAX) stack.shift();
      }
      cursor = -1;
      draft = "";
    },
    back(current) {
      if (!stack.length) return current;
      if (cursor === -1) draft = current;
      cursor = Math.min(cursor + 1, stack.length - 1);
      return stack[stack.length - 1 - cursor];
    },
    forward() {
      if (cursor === -1) return null;
      cursor -= 1;
      return cursor === -1 ? draft : stack[stack.length - 1 - cursor];
    },
  };
})();

// Tracks the current working directory inside the container.
// Reset to "" on app switch; updated by `cd` commands and on exec tab open.
let execCwd = "";

// Tab-completion — backed by server-side compgen inside the container
let tabState = { base: "", partial: "", matches: [], index: -1, loading: false };
let tabCompletionGen = 0; // bumped on reset to discard stale in-flight responses

// Splits "cat /etc/pa" → { base: "cat ", partial: "/etc/pa" }
function splitInputToken(input) {
  const lastSpace = input.lastIndexOf(" ");
  return lastSpace === -1
    ? { base: "", partial: input }
    : { base: input.slice(0, lastSpace + 1), partial: input.slice(lastSpace + 1) };
}

async function handleTabCompletion() {
  if (tabState.loading) return;

  const fullInput = el.detailExecInput.value;

  // Already cycling through a fetched result set — just advance
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

  const gen = ++tabCompletionGen;
  tabState = { base, partial, matches: [], index: -1, loading: true };

  try {
    const data = await apiFetch(`/apps/${userid}/${appname}/exec/complete`, {
      method: "POST",
      body: JSON.stringify({ partial, cwd: execCwd }),
    });
    if (gen !== tabCompletionGen) return; // superseded by a newer request or reset
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

function formatCwdDisplay(cwd) {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  // Show at most the last two path components to keep the prompt compact
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

function updateExecPrompt() {
  el.detailExecPromptCwd.textContent = formatCwdDisplay(execCwd);
}

// Detects `cd [args]` as a shell built-in that must be tracked client-side.
// Returns the args string (may be empty for bare `cd`) or null if not a cd command.
function parseCdArgs(command) {
  const m = command.match(/^cd(?:\s+(.*\S))?$/);
  return m ? (m[1] ?? "") : null;
}

// Silently fetches the container's initial working directory to populate the prompt.
async function initExecCwd() {
  if (!state.selectedApp || execCwd !== "") return;
  const { userid, appname } = state.selectedApp;
  try {
    const data = await apiFetch(`/apps/${userid}/${appname}/exec`, {
      method: "POST",
      body: JSON.stringify({ command: "pwd", cwd: "" }),
    });
    const cwd = data.output?.trim();
    if (cwd?.startsWith("/")) {
      execCwd = cwd;
      updateExecPrompt();
    }
  } catch {
    // Silent fail — prompt stays at bare "$"
  }
}

function appendExecLine(text, className = "") {
  const line = document.createElement("span");
  if (className) line.className = className;
  line.textContent = text + "\n";
  el.detailExecOutput.appendChild(line);
  el.detailExecOutput.scrollTop = el.detailExecOutput.scrollHeight;
}

async function runExecCommand() {
  if (!state.selectedApp) return;
  const command = el.detailExecInput.value.trim();
  if (!command) return;

  execHistory.push(command);
  el.detailExecInput.value = "";

  // Built-in: clear — handle client-side, no round-trip needed
  if (command === "clear") {
    el.detailExecOutput.innerHTML = "";
    return;
  }

  const { userid, appname } = state.selectedApp;
  el.detailExecRunBtn.disabled = true;
  el.detailExecInput.disabled = true;
  appendExecLine(`$ ${command}`, "exec-cmd");

  // cd is a shell built-in — each exec runs in a fresh subshell, so cd has no
  // persistent effect. We detect it, append `&& pwd` to resolve the new absolute
  // path, then carry that path forward as the cwd prefix for all future commands.
  const cdArgs = parseCdArgs(command);
  const isCd = cdArgs !== null;
  const effectiveCommand = isCd ? `${command} && pwd` : command;

  try {
    const data = await apiFetch(`/apps/${userid}/${appname}/exec`, {
      method: "POST",
      body: JSON.stringify({ command: effectiveCommand, cwd: execCwd }),
    });

    if (isCd) {
      if (data.output) {
        const lines = data.output.trimEnd().split("\n");
        const newCwd = lines.at(-1);
        if (newCwd?.startsWith("/")) {
          execCwd = newCwd;
          updateExecPrompt();
        }
        // Any lines before the final `pwd` output are cd's own messages (rare but possible)
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
    el.detailExecInput.disabled = false;
    el.detailExecInput.focus();
  }
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
    if (result.restartError) {
      setBanner(
        `환경변수 저장 완료, 컨테이너 재시작 실패: ${result.restartError}`,
        "error"
      );
    } else {
      setBanner(`환경변수 저장 및 재시작 완료: ${userid}/${appname}`, "success");
    }
    await loadApps();
  } catch (error) {
    setEnvError(normalizeErrorMessage(error, "환경변수 저장 중 오류가 발생했습니다."));
  } finally {
    el.detailEnvSaveBtn.disabled = false;
    el.detailEnvSaveBtn.textContent = "저장 및 재시작";
  }
}

// ── 앱 생성 ──────────────────────────────────────────────────────────────────

async function handleCreate(event) {
  event.preventDefault();
  if (!canManageApps()) {
    throw new Error("로그인 후 비밀번호 변경을 완료해야 앱을 관리할 수 있습니다.");
  }

  const repoUrl = el.repoUrlInput.value.trim();
  const branch = el.repoBranchInput.value.trim() || "main";
  const body = {
    appname: el.appnameInput.value.trim(),
    repoUrl,
    branch,
  };

  if (!validateCreateForm()) {
    throw new Error("appname, repo URL을 입력하세요.");
  }

  setBanner("앱 생성 중 (repo clone 및 빌드 포함, 시간이 걸릴 수 있습니다)...", "info");
  const data = await apiFetch("/apps", { method: "POST", body: JSON.stringify(body) });
  setBanner(`앱 생성 완료: ${data.app.domain}`, "success");
  el.createForm.reset();
  el.repoBranchInput.value = "main";
  syncDomainPreview();
  await loadApps();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  const persistedUiState = readPersistedUiState();
  switchView(DEFAULT_VIEW, { persist: false });
  updateAuthUi();
  await loadConfig();
  syncDomainPreview();

  const loggedIn = await loadSession();
  if (!loggedIn) {
    redirectToAuth();
    return;
  }

  // app-detail 뷰는 세션 복원 대상에서 제외한다 (앱 선택 상태가 없으므로)
  const restoredView = persistedUiState.view === "app-detail"
    ? DEFAULT_VIEW
    : persistedUiState.view;
  switchView(restoredView || DEFAULT_VIEW, { persist: false });
  updateAuthUi();
  persistUiState();

  await refreshDashboardData();
  if (isPasswordLocked()) {
    setBanner("초기 비밀번호를 우상단 설정에서 변경하세요.", "error");
    return;
  }
  setBanner("로그인 상태가 확인되었습니다.", "success");
}

// ── 이벤트 바인딩 ────────────────────────────────────────────────────────────

el.appnameInput.addEventListener("input", () => {
  clearCreateFieldFeedback(el.appnameInput);
  syncDomainPreview();
});
el.repoUrlInput.addEventListener("input", () => clearCreateFieldFeedback(el.repoUrlInput));

el.gnbItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

if (el.gnbBrand) {
  el.gnbBrand.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchView(DEFAULT_VIEW);
  });
}

el.mobileMenuBtn.addEventListener("click", toggleMobileMenu);
el.gnbOverlay.addEventListener("click", closeMobileMenu);

// 앱 관리 서브 GNB
el.appDetailBackBtn.addEventListener("click", () => switchView("dashboard"));

el.detailTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.detailTab;
    switchDetailTab(tab);
    if (tab === "logs" && state.selectedApp) {
      loadDetailLogs().catch(handleRequestError);
    }
    if (tab === "exec" && state.selectedApp) {
      initExecCwd().catch(() => {});
    }
    if (tab === "settings" && state.selectedApp) {
      loadDetailEnv().catch(handleRequestError);
    }
  });
});

// Logs
el.detailRefreshLogsBtn.addEventListener("click", async () => {
  try {
    await loadDetailLogs();
    setBanner("로그 새로고침 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

// Exec
el.detailExecRunBtn.addEventListener("click", async () => {
  try { await runExecCommand(); } catch (error) { await handleRequestError(error); }
});

el.detailExecInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Tab") {
    tabCompletionGen++; // invalidate any in-flight completion request
    tabState = { base: "", partial: "", matches: [], index: -1, loading: false };
  }

  switch (event.key) {
    case "Enter":
      event.preventDefault();
      try { await runExecCommand(); } catch (err) { await handleRequestError(err); }
      break;
    case "ArrowUp":
      event.preventDefault();
      el.detailExecInput.value = execHistory.back(el.detailExecInput.value);
      break;
    case "ArrowDown": {
      event.preventDefault();
      const next = execHistory.forward();
      el.detailExecInput.value = next ?? "";
      break;
    }
    case "Tab":
      event.preventDefault();
      await handleTabCompletion();
      break;
  }
});

el.detailExecClearBtn.addEventListener("click", () => {
  el.detailExecOutput.innerHTML = "";
});

// Settings (env)
el.detailEnvSaveBtn.addEventListener("click", async () => {
  try {
    await saveDetailEnv();
  } catch (error) {
    await handleRequestError(error);
  }
});

// Settings modal
el.settingsBtn.addEventListener("click", openSettingsModal);

el.closeSettingsBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSettingsModal();
});

bindBackdropClose(el.settingsModal, "settings", closeSettingsModal);

// Logout
el.logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Ignore transport errors and redirect anyway.
  }
  stopAutoRefresh();
  redirectToAuth();
});

// 앱 컨테이너 클릭 (manage, start, stop, deploy, delete)
el.appsContainer.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const target = getActionTarget(button);
  if (!target) return;
  try {
    await performAction(target);
  } catch (error) {
    await handleRequestError(error);
  }
});

// 대시보드 새로고침
el.refreshBtn.addEventListener("click", async () => {
  try {
    await loadApps();
    await loadUsers();
    setBanner("데이터 갱신 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

// 앱 생성 폼
el.createForm.addEventListener("submit", async (event) => {
  try {
    await handleCreate(event);
  } catch (error) {
    await handleRequestError(error);
  }
});

// 비밀번호 변경
el.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSettingsError("");
  try {
    const currentPassword = el.currentPasswordInput.value;
    const newPassword = el.newPasswordInput.value;
    const newPasswordConfirm = el.newPasswordConfirmInput.value;
    if (newPassword !== newPasswordConfirm) {
      setSettingsError("새 비밀번호와 비밀번호 확인이 일치하지 않습니다.");
      el.newPasswordConfirmInput.focus();
      return;
    }
    const data = await apiFetch("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    state.user = data.user || null;
    el.currentPasswordInput.value = "";
    el.newPasswordInput.value = "";
    el.newPasswordConfirmInput.value = "";
    updateAuthUi();
    closeSettingsModal();
    await refreshDashboardData();
    setBanner("비밀번호 변경이 완료되었습니다.", "success");
  } catch (error) {
    await handleSettingsModalError(error);
  }
});

// 유저 추가
el.openCreateUserBtn.addEventListener("click", openCreateUserModal);

el.closeCreateUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeCreateUserModal({ resetForm: true });
});
el.cancelCreateUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeCreateUserModal({ resetForm: true });
});
bindBackdropClose(el.createUserModal, "createUser", () => closeCreateUserModal({ resetForm: true }));

el.createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setCreateUserError("");
  if (!canManageUsers()) {
    setCreateUserError("관리자 계정에서만 사용자 추가가 가능합니다.");
    return;
  }
  const username = el.createUsernameInput.value.trim();
  const password = el.createPasswordInput.value;
  const passwordConfirm = el.createPasswordConfirmInput.value;
  const roleValue = el.createUserRoleInput.value;
  if (!username || !password || !passwordConfirm) {
    setCreateUserError("username, password, password confirm을 입력하세요.");
    return;
  }
  if (password !== passwordConfirm) {
    setCreateUserError("password와 password confirm이 일치하지 않습니다.");
    return;
  }
  if (password.length < 8) {
    setCreateUserError("password는 8자 이상이어야 합니다.");
    return;
  }
  try {
    const isAdmin = roleValue === "admin";
    const data = await apiFetch("/users", {
      method: "POST",
      body: JSON.stringify({ username, password, isAdmin }),
    });
    closeCreateUserModal({ resetForm: true });
    await loadUsers();
    setBanner(`사용자 생성 완료: ${data.user.username}`, "success");
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await handleRequestError(error);
      return;
    }
    setCreateUserError(normalizeErrorMessage(error, "사용자 생성 중 오류가 발생했습니다."));
  }
});

// 유저 삭제
el.closeDeleteUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeDeleteUserModal({ resetForm: true });
});
el.cancelDeleteUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeDeleteUserModal({ resetForm: true });
});
bindBackdropClose(el.deleteUserModal, "deleteUser", () => closeDeleteUserModal({ resetForm: true }));

el.deleteUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setDeleteUserError("");
  if (!canManageUsers()) {
    setDeleteUserError("관리자 계정에서만 사용자 제거가 가능합니다.");
    return;
  }
  if (!state.pendingDeleteUser?.id) {
    setDeleteUserError("제거할 사용자를 다시 선택하세요.");
    return;
  }
  const currentPassword = el.deleteUserPasswordInput.value;
  if (!currentPassword) {
    setDeleteUserError("현재 admin 비밀번호를 입력하세요.");
    return;
  }
  try {
    const targetUser = state.pendingDeleteUser;
    await apiFetch(`/users/${targetUser.id}`, {
      method: "DELETE",
      body: JSON.stringify({ currentPassword }),
    });
    closeDeleteUserModal({ resetForm: true });
    await loadUsers();
    setBanner(`사용자 제거 완료: ${targetUser.username}`, "success");
  } catch (error) {
    const message = normalizeErrorMessage(error, "사용자 제거 중 오류가 발생했습니다.");
    const isCurrentPasswordMismatch =
      error?.status === 401 && /^current password is incorrect$/i.test(message);
    if (error?.status === 401 && !isCurrentPasswordMismatch) {
      await handleRequestError(error);
      return;
    }
    setDeleteUserError(message);
  }
});

// Admin 승격 모달
el.closePromoteAdminBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closePromoteAdminModal();
});
el.cancelPromoteAdminBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closePromoteAdminModal();
});
bindBackdropClose(el.promoteAdminModal, "promoteAdmin", closePromoteAdminModal);

el.submitPromoteAdminBtn.addEventListener("click", async () => {
  setPromoteAdminError("");
  if (!canManageUsers()) {
    setPromoteAdminError("관리자 계정에서만 권한을 변경할 수 있습니다.");
    return;
  }
  if (!state.pendingPromoteUser?.id) {
    setPromoteAdminError("대상 사용자를 다시 선택하세요.");
    return;
  }
  el.submitPromoteAdminBtn.disabled = true;
  try {
    const targetUser = state.pendingPromoteUser;
    const data = await apiFetch(`/users/${targetUser.id}/role`, { method: "PATCH" });
    closePromoteAdminModal();
    await loadUsers();
    setBanner(`${data.user.username} 사용자가 Admin으로 승격되었습니다.`, "success");
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await handleRequestError(error);
      return;
    }
    setPromoteAdminError(normalizeErrorMessage(error, "권한 변경 중 오류가 발생했습니다."));
  } finally {
    el.submitPromoteAdminBtn.disabled = false;
  }
});

// 유저 테이블 클릭 (삭제 / 승격)
el.usersTableBody.addEventListener("click", (event) => {
  if (!canManageUsers()) return;

  const removeBtn = event.target.closest("button[data-action='remove-user']");
  if (removeBtn) {
    const id = parsePositiveInt(removeBtn.dataset.id);
    if (!id) return;
    const username = String(removeBtn.dataset.username || "").trim() || `user-${id}`;
    openDeleteUserModal({ id, username });
    return;
  }

  const promoteBtn = event.target.closest("button[data-action='promote-user']");
  if (promoteBtn) {
    const id = parsePositiveInt(promoteBtn.dataset.id);
    if (!id) return;
    const username = String(promoteBtn.dataset.username || "").trim() || `user-${id}`;
    openPromoteAdminModal({ id, username });
  }
});

// ESC 키 모달 닫기
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" && event.key !== "Esc") return;
  if (!el.promoteAdminModal.hidden) { closePromoteAdminModal(); return; }
  if (!el.deleteUserModal.hidden) { closeDeleteUserModal({ resetForm: true }); return; }
  if (!el.createUserModal.hidden) { closeCreateUserModal({ resetForm: true }); return; }
  if (!el.settingsModal.hidden) { closeSettingsModal(); }
});

bootstrap().catch((error) => {
  handleRequestError(error);
});

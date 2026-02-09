const AUTO_REFRESH_MS = 15000;
const EMPTY_NEW_API_KEY_TEXT = "(없음)";
const UI_STATE_STORAGE_KEY = "paas.portal.uiState";
const AVAILABLE_VIEWS = ["dashboard", "create", "ops", "users"];
const AVAILABLE_OPS_TABS = ["ops", "logs"];
const DEFAULT_VIEW = AVAILABLE_VIEWS[0] || "dashboard";
const DEFAULT_OPS_TAB = AVAILABLE_OPS_TABS[0] || "ops";

const state = {
  domain: "my.domain.com",
  templates: [],
  apps: [],
  apiKeys: [],
  users: [],
  pendingDeleteUser: null,
  user: null,
  refreshTimer: null,
  activeView: DEFAULT_VIEW,
  activeTab: DEFAULT_OPS_TAB,
  security: {
    hostSplitEnabled: false,
    publicHost: null,
    adminHost: null,
    adminAccessAllowedForRequest: true,
  },
};

const el = {
  gnbBrand: document.querySelector(".gnb-brand"),
  gnbNav: document.querySelector(".gnb-nav"),
  gnbOverlay: document.getElementById("gnb-mobile-overlay"),
  gnbItems: Array.from(document.querySelectorAll(".gnb-item")),
  gnbUsersBtn: document.getElementById("gnb-users-btn"),
  mobileMenuBtn: document.getElementById("mobile-menu-btn"),
  viewDashboard: document.getElementById("view-dashboard"),
  viewCreate: document.getElementById("view-create"),
  viewOps: document.getElementById("view-ops"),
  viewUsers: document.getElementById("view-users"),
  statusBanner: document.getElementById("status-banner"),
  authState: document.getElementById("auth-state"),
  logoutBtn: document.getElementById("logout-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  openSettingsBtn: document.getElementById("open-settings-btn"),
  closeSettingsBtn: document.getElementById("close-settings-btn"),
  settingsModal: document.getElementById("settings-modal"),
  settingsError: document.getElementById("settings-error"),
  createForm: document.getElementById("create-form"),
  appnameInput: document.getElementById("appname-input"),
  templateSelect: document.getElementById("template-select"),
  domainPreview: document.getElementById("domain-preview"),
  domainChip: document.getElementById("domain-chip"),
  limitChip: document.getElementById("limit-chip"),
  appCountChip: document.getElementById("app-count-chip"),
  refreshBtn: document.getElementById("refresh-btn"),
  emptyState: document.getElementById("empty-state"),
  appsContainer: document.getElementById("apps-container"),
  keepDataInput: document.getElementById("keep-data-input"),
  logLinesInput: document.getElementById("log-lines-input"),
  tabBtnOps: document.getElementById("tab-btn-ops"),
  tabBtnLogs: document.getElementById("tab-btn-logs"),
  tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
  tabOps: document.getElementById("tab-ops"),
  tabLogs: document.getElementById("tab-logs"),
  logsTitle: document.getElementById("logs-title"),
  logsOutput: document.getElementById("logs-output"),
  passwordRequiredNote: document.getElementById("password-required-note"),
  passwordForm: document.getElementById("password-form"),
  currentPasswordInput: document.getElementById("current-password-input"),
  newPasswordInput: document.getElementById("new-password-input"),
  apiKeysPanel: document.getElementById("api-keys-panel"),
  createApiKeyForm: document.getElementById("create-api-key-form"),
  apiKeyNameInput: document.getElementById("api-key-name-input"),
  newApiKey: document.getElementById("new-api-key"),
  copyNewApiKeyBtn: document.getElementById("copy-new-api-key-btn"),
  newApiKeyWarning: document.getElementById("new-api-key-warning"),
  apiKeyList: document.getElementById("api-key-list"),
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
  createPasswordConfirmInput: document.getElementById(
    "create-password-confirm-input",
  ),
  createUserRoleInput: document.getElementById("create-user-role-input"),
  deleteUserModal: document.getElementById("delete-user-modal"),
  closeDeleteUserBtn: document.getElementById("close-delete-user-btn"),
  cancelDeleteUserBtn: document.getElementById("cancel-delete-user-btn"),
  deleteUserForm: document.getElementById("delete-user-form"),
  deleteUserTarget: document.getElementById("delete-user-target"),
  deleteUserError: document.getElementById("delete-user-error"),
  deleteUserPasswordInput: document.getElementById("delete-user-password-input"),
};

const modalBackdropState = {
  settings: false,
  createUser: false,
  deleteUser: false,
};

function setBanner(message, type = "info") {
  el.statusBanner.className = `status-banner ${type}`;
  el.statusBanner.textContent = message;
}

function normalizeErrorMessage(
  error,
  fallback = "요청 중 오류가 발생했습니다.",
) {
  const raw = String(error?.message || "").trim();
  if (!raw) {
    return fallback;
  }
  return raw.replace(/^AppError:\s*/i, "");
}

function setInlineError(targetEl, message = "") {
  const normalized = String(message || "").trim();
  targetEl.hidden = !normalized;
  targetEl.textContent = normalized;
}

function setSettingsError(message = "") {
  setInlineError(el.settingsError, message);
}

function setCreateUserError(message = "") {
  setInlineError(el.createUserError, message);
}

function setDeleteUserError(message = "") {
  setInlineError(el.deleteUserError, message);
}

function readPersistedUiState() {
  try {
    const raw = window.sessionStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    const view = AVAILABLE_VIEWS.includes(parsed?.view) ? parsed.view : undefined;
    const tab = AVAILABLE_OPS_TABS.includes(parsed?.tab) ? parsed.tab : undefined;
    return { view, tab };
  } catch {
    return {};
  }
}

function persistUiState() {
  try {
    window.sessionStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify({
        view: state.activeView,
        tab: state.activeTab,
      }),
    );
  } catch {
    // Ignore storage write errors.
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isLoggedIn() {
  return Boolean(state.user);
}

function isAdminUser() {
  return String(state.user?.role || "") === "paas-admin";
}

function isPasswordLocked() {
  return Boolean(state.user?.mustChangePassword);
}

function canManageApps() {
  return isLoggedIn() && !isPasswordLocked();
}

function canManageUsers() {
  return canManageApps() && isAdminUser();
}

function getAdminAccessHint() {
  if (
    !state.security.hostSplitEnabled ||
    state.security.adminAccessAllowedForRequest
  ) {
    return "";
  }
  const adminHost = state.security.adminHost || "admin host";
  return `현재 호스트에서는 admin 관리 기능을 사용할 수 없습니다. ${adminHost}로 접속하세요.`;
}

function redirectToAuth() {
  window.location.replace("/auth");
}

function syncDomainPreview() {
  const userid = String(state.user?.username || "").trim() || "owner";
  const appname = el.appnameInput.value.trim() || "appname";
  el.domainPreview.textContent = `${userid}-${appname}.${state.domain}`;
}

function renderTemplateOptions(selectedTemplateId) {
  if (!el.templateSelect) {
    return;
  }

  const templates = Array.isArray(state.templates) ? state.templates : [];
  const fallbackTemplateId = selectedTemplateId || "node-lite-v1";
  const resolvedItems = templates.length
    ? templates
    : [
        {
          id: fallbackTemplateId,
          name: fallbackTemplateId,
          description: "",
        },
      ];

  el.templateSelect.innerHTML = resolvedItems
    .map((item) => {
      const id = escapeHtml(item.id || "");
      const name = escapeHtml(item.name || item.id || "");
      const description = String(item.description || "").trim();
      const label = description ? `${name} - ${escapeHtml(description)}` : name;
      return `<option value="${id}">${label}</option>`;
    })
    .join("");

  const preferredTemplateId =
    String(selectedTemplateId || "").trim().toLowerCase() || resolvedItems[0].id;
  const hasPreferredTemplate = resolvedItems.some(
    (item) => String(item.id || "").toLowerCase() === preferredTemplateId,
  );
  el.templateSelect.value = hasPreferredTemplate
    ? preferredTemplateId
    : String(resolvedItems[0].id || "").toLowerCase();
}

function getVisibleNewApiKey() {
  const raw = String(el.newApiKey.textContent || "").trim();
  if (!raw || raw === EMPTY_NEW_API_KEY_TEXT) {
    return "";
  }
  return raw;
}

function updateNewApiKeyControls() {
  const hasVisibleKey = Boolean(getVisibleNewApiKey());
  if (el.copyNewApiKeyBtn) {
    el.copyNewApiKeyBtn.disabled = !hasVisibleKey || !canManageApps();
  }
  if (el.newApiKeyWarning) {
    el.newApiKeyWarning.hidden = !hasVisibleKey;
  }
}

function setNewApiKeyValue(rawApiKey) {
  const normalized = String(rawApiKey || "").trim();
  el.newApiKey.textContent = normalized || EMPTY_NEW_API_KEY_TEXT;
  updateNewApiKeyControls();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fallback to legacy copy below.
    }
  }

  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "true");
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  temp.style.left = "-9999px";
  document.body.append(temp);
  temp.focus();
  temp.select();
  const copied = document.execCommand("copy");
  temp.remove();
  if (!copied) {
    throw new Error("Failed to copy API key");
  }
}

function switchView(viewName, { persist = true } = {}) {
  const nextView = AVAILABLE_VIEWS.includes(viewName) ? viewName : DEFAULT_VIEW;
  state.activeView = nextView;

  el.viewDashboard.hidden = nextView !== "dashboard";
  el.viewCreate.hidden = nextView !== "create";
  el.viewOps.hidden = nextView !== "ops";
  el.viewUsers.hidden = nextView !== "users";

  el.gnbItems.forEach((item) => {
    const isActive = item.dataset.view === nextView;
    item.classList.toggle("active", isActive);
  });

  if (persist) {
    persistUiState();
  }
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

function syncModalOpenState() {
  const hasOpenModal =
    !el.settingsModal.hidden ||
    !el.createUserModal.hidden ||
    !el.deleteUserModal.hidden;
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function switchTab(tabName, { persist = true } = {}) {
  const nextTab = AVAILABLE_OPS_TABS.includes(tabName)
    ? tabName
    : DEFAULT_OPS_TAB;
  state.activeTab = nextTab;

  const opsSelected = nextTab === "ops";
  el.tabBtnOps.classList.toggle("active", opsSelected);
  el.tabBtnOps.setAttribute("aria-selected", String(opsSelected));
  el.tabBtnLogs.classList.toggle("active", !opsSelected);
  el.tabBtnLogs.setAttribute("aria-selected", String(!opsSelected));
  el.tabOps.hidden = !opsSelected;
  el.tabLogs.hidden = opsSelected;
  if (persist) {
    persistUiState();
  }
}

function bindBackdropClose(modalElement, stateKey, onClose) {
  modalElement.addEventListener("mousedown", (event) => {
    modalBackdropState[stateKey] = event.target === modalElement;
  });

  modalElement.addEventListener("click", (event) => {
    if (event.target === modalElement && modalBackdropState[stateKey]) {
      onClose();
    }
    modalBackdropState[stateKey] = false;
  });
}

function openSettingsModal() {
  if (!isLoggedIn()) {
    return;
  }
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
}

function openCreateUserModal() {
  if (!canManageUsers()) {
    return;
  }
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
  if (!canManageUsers()) {
    return;
  }
  state.pendingDeleteUser = targetUser || null;
  if (!state.pendingDeleteUser) {
    return;
  }
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
    const error = new Error(
      payload.error || `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function statusClass(status) {
  const normalized = String(status || "unknown")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-");
  return `status-${normalized}`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function resetLogs() {
  el.logsTitle.textContent = "앱을 선택하면 로그가 표시됩니다.";
  el.logsOutput.textContent = "No logs yet.";
}

function applyAccessState() {
  const enabled = canManageApps();

  Array.from(el.createForm.elements).forEach((node) => {
    node.disabled = !enabled;
  });
  Array.from(el.createApiKeyForm.elements).forEach((node) => {
    node.disabled = !enabled;
  });

  el.refreshBtn.disabled = !enabled;
  el.keepDataInput.disabled = !enabled;
  el.logLinesInput.disabled = !enabled;
  updateNewApiKeyControls();
}

function renderApps(apps) {
  el.appCountChip.textContent = String(apps.length);
  if (!apps.length) {
    el.emptyState.style.display = "block";
    if (!isLoggedIn()) {
      el.emptyState.textContent = "로그인하면 앱 목록을 조회할 수 있습니다.";
    } else if (isPasswordLocked()) {
      el.emptyState.textContent =
        "비밀번호를 변경한 뒤 앱 목록을 조회할 수 있습니다.";
    } else {
      el.emptyState.textContent = "앱이 없습니다. 먼저 앱을 생성하세요.";
    }
    el.appsContainer.innerHTML = "";
    return;
  }

  const actionsDisabled = canManageApps() ? "" : "disabled";
  el.emptyState.style.display = "none";
  el.appsContainer.innerHTML = apps
    .map((appItem) => {
      const safeUser = escapeHtml(appItem.userid);
      const safeApp = escapeHtml(appItem.appname);
      const safeDomain = escapeHtml(appItem.domain || "-");
      const safeTemplate = escapeHtml(appItem.templateId || appItem.starterId || "-");
      const rawStatus = appItem.status || "unknown";
      const safeStatus = escapeHtml(rawStatus);
      const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));

      return `
        <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
          <div class="app-card-head">
            <h3 class="app-name">${safeUser} / ${safeApp}</h3>
            <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
          </div>
          <p class="app-domain">${safeDomain}</p>
          <p class="app-meta">template: ${safeTemplate} | created: ${safeCreatedAt}</p>
          <div class="app-actions">
            <button class="action-btn" data-action="logs" type="button" ${actionsDisabled}>Logs</button>
            <button class="action-btn" data-action="start" type="button" ${actionsDisabled}>Start</button>
            <button class="action-btn" data-action="stop" type="button" ${actionsDisabled}>Stop</button>
            <button class="action-btn" data-action="deploy" type="button" ${actionsDisabled}>Deploy</button>
            <button class="action-btn danger" data-action="delete" type="button" ${actionsDisabled}>Delete</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderApiKeys() {
  if (!canManageApps()) {
    el.apiKeyList.innerHTML = "";
    return;
  }
  if (!state.apiKeys.length) {
    el.apiKeyList.innerHTML =
      '<p class="empty-state">발급된 API Key가 없습니다.</p>';
    return;
  }

  el.apiKeyList.innerHTML = state.apiKeys
    .map((item) => {
      const id = Number(item.id);
      const safeName = escapeHtml(item.name || `key-${id}`);
      const safePreview = escapeHtml(item.keyPreview || "-");
      const safeCreatedAt = escapeHtml(formatDate(item.createdAt));
      const safeLastUsed = escapeHtml(formatDate(item.lastUsedAt));
      return `
        <article class="api-key-item" data-id="${id}">
          <div class="api-key-row">
            <p class="api-key-name">${safeName}</p>
            <button class="action-btn danger" data-action="revoke-api-key" type="button">폐기</button>
          </div>
          <p class="api-key-meta">${safePreview}</p>
          <p class="api-key-meta">created: ${safeCreatedAt} | last used: ${safeLastUsed}</p>
        </article>
      `;
    })
    .join("");
}

function renderUsers(users) {
  if (!canManageUsers()) {
    el.usersCount.textContent = "0명";
    el.usersTableBody.innerHTML = "";
    el.usersEmptyState.hidden = false;
    el.openCreateUserBtn.disabled = true;
    if (!isLoggedIn()) {
      el.usersEmptyState.textContent = "로그인하면 사용자 목록을 조회할 수 있습니다.";
    } else if (isPasswordLocked()) {
      el.usersEmptyState.textContent =
        "비밀번호를 변경한 뒤 사용자 목록을 조회할 수 있습니다.";
    } else {
      el.usersEmptyState.textContent =
        "관리자 계정에서만 사용자 목록을 조회할 수 있습니다.";
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
  el.usersTableBody.innerHTML = users
    .map((item) => {
      const safeUsername = escapeHtml(item.username || "-");
      const safeAdmin = escapeHtml(item.isAdmin ? "예" : "아니오");
      const safeCreatedAt = escapeHtml(formatDate(item.createdAt));
      const safeLastAccessAt = escapeHtml(formatDate(item.lastAccessAt));
      const canRemove = !item.isAdmin;
      const removeButton = canRemove
        ? `<button class="action-btn danger users-remove-btn" data-action="remove-user" data-id="${item.id}" data-username="${safeUsername}" type="button">제거</button>`
        : `<span class="users-protected">-</span>`;
      return `
        <tr>
          <td>${safeUsername}</td>
          <td>${safeAdmin}</td>
          <td>${safeCreatedAt}</td>
          <td>${safeLastAccessAt}</td>
          <td>${removeButton}</td>
        </tr>
      `;
    })
    .join("");
}

function updateAuthUi() {
  if (!isLoggedIn()) {
    el.authState.textContent = "인증 필요";
    el.logoutBtn.hidden = true;
    el.settingsBtn.hidden = true;
    el.gnbUsersBtn.hidden = true;
    el.passwordRequiredNote.hidden = true;
    el.apiKeysPanel.hidden = true;
    state.users = [];
    renderUsers([]);
    setNewApiKeyValue("");
    if (state.activeView === "users" && DEFAULT_VIEW !== "users") {
      switchView(DEFAULT_VIEW);
    }
    applyAccessState();
    closeSettingsModal();
    closeCreateUserModal({ resetForm: true });
    closeDeleteUserModal({ resetForm: true });
    return;
  }

  const suffix = isPasswordLocked() ? " | 비밀번호 변경 필요" : "";
  el.authState.textContent = `${state.user.username} (${state.user.role})${suffix}`;
  el.logoutBtn.hidden = false;
  el.settingsBtn.hidden = false;
  el.gnbUsersBtn.hidden = !canManageUsers();
  el.passwordRequiredNote.hidden = !isPasswordLocked();
  el.apiKeysPanel.hidden = isPasswordLocked();
  if (isPasswordLocked()) {
    setNewApiKeyValue("");
  }
  if (el.gnbUsersBtn.hidden && state.activeView === "users" && DEFAULT_VIEW !== "users") {
    switchView(DEFAULT_VIEW);
  }
  if (!canManageUsers()) {
    closeCreateUserModal({ resetForm: true });
    closeDeleteUserModal({ resetForm: true });
  }
  applyAccessState();
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!canManageApps()) {
    return;
  }
  state.refreshTimer = setInterval(async () => {
    try {
      await loadApps();
      await loadUsers();
    } catch (error) {
      await handleRequestError(error);
    }
  }, AUTO_REFRESH_MS);
}

async function handleRequestError(error) {
  if (error?.status === 401) {
    state.user = null;
    state.apps = [];
    state.apiKeys = [];
    state.users = [];
    renderApps([]);
    renderApiKeys();
    renderUsers([]);
    updateAuthUi();
    stopAutoRefresh();
    setBanner("세션이 만료되었습니다. 로그인 페이지로 이동합니다.", "error");
    redirectToAuth();
    return;
  }
  if (error?.status === 403 && isPasswordLocked()) {
    switchTab("ops");
    setBanner("초기 비밀번호를 설정에서 변경하세요.", "error");
    return;
  }
  setBanner(normalizeErrorMessage(error), "error");
}

async function handleSettingsModalError(error) {
  const message = normalizeErrorMessage(
    error,
    "설정 변경 중 오류가 발생했습니다.",
  );
  const isCurrentPasswordMismatch =
    error?.status === 401 && /^current password is incorrect$/i.test(message);
  if (error?.status === 401 && !isCurrentPasswordMismatch) {
    await handleRequestError(error);
    return;
  }
  setSettingsError(message);
}

async function loadConfig() {
  const data = await apiFetch("/config");
  state.domain = data.domain || "my.domain.com";
  state.templates = Array.isArray(data.templates)
    ? data.templates
    : Array.isArray(data.starters)
      ? data.starters
      : [];
  state.security = {
    hostSplitEnabled: Boolean(data.security?.hostSplitEnabled),
    publicHost: data.security?.publicHost || null,
    adminHost: data.security?.adminHost || null,
    adminAccessAllowedForRequest: Boolean(
      data.security?.adminAccessAllowedForRequest,
    ),
  };
  el.domainChip.textContent = state.domain;
  el.limitChip.textContent = `${data.limits.maxAppsPerUser}/${data.limits.maxTotalApps}`;
  renderTemplateOptions(
    data.defaults?.templateId ||
      data.defaults?.starterId ||
      state.templates[0]?.id ||
      "node-lite-v1",
  );
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

async function loadApiKeys() {
  if (!canManageApps()) {
    state.apiKeys = [];
    renderApiKeys();
    return;
  }
  const data = await apiFetch("/api-keys");
  state.apiKeys = data.apiKeys || [];
  renderApiKeys();
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
  await loadApiKeys();
  await loadUsers();
  if (canManageApps()) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

async function handleCreate(event) {
  event.preventDefault();
  if (!canManageApps()) {
    throw new Error(
      "로그인 후 비밀번호 변경을 완료해야 앱을 관리할 수 있습니다.",
    );
  }

  const body = {
    appname: el.appnameInput.value.trim(),
    templateId: el.templateSelect.value.trim(),
  };

  if (!body.appname || !body.templateId) {
    throw new Error("appname, template를 입력하세요.");
  }

  setBanner("앱 생성 요청 중...", "info");
  const data = await apiFetch("/apps", {
    method: "POST",
    body: JSON.stringify(body),
  });
  setBanner(`앱 생성 완료: ${data.app.domain}`, "success");
  await loadApps();
}

function getActionTarget(button) {
  const appCard = button.closest(".app-card");
  if (!appCard) {
    return null;
  }
  return {
    userid: appCard.dataset.userid,
    appname: appCard.dataset.appname,
    action: button.dataset.action,
  };
}

async function requestLogs(userid, appname) {
  const rawLines = Number.parseInt(el.logLinesInput.value, 10);
  const lines = Number.isFinite(rawLines)
    ? Math.max(1, Math.min(1000, rawLines))
    : 120;
  const data = await apiFetch(`/apps/${userid}/${appname}/logs?lines=${lines}`);
  el.logsTitle.textContent = `${userid}/${appname} (${lines} lines)`;
  el.logsOutput.textContent = data.logs || "(empty)";
}

async function performAction(target) {
  if (!canManageApps()) {
    throw new Error(
      "앱 관리를 위해 로그인 상태와 비밀번호 변경 상태를 확인하세요.",
    );
  }

  const { userid, appname, action } = target;
  const appLabel = `${userid}/${appname}`;

  if (action === "logs") {
    switchView("ops");
    switchTab("logs");
    setBanner(`로그 조회 중: ${appLabel}`, "info");
    await requestLogs(userid, appname);
    setBanner(`로그 조회 완료: ${appLabel}`, "success");
    return;
  }

  if (action === "delete") {
    const keepData = el.keepDataInput.checked;
    const shouldDelete = window.confirm(
      `${appLabel} 앱을 삭제합니다. keepData=${keepData ? "true" : "false"}`,
    );
    if (!shouldDelete) {
      return;
    }
    setBanner(`삭제 요청 중: ${appLabel}`, "info");
    await apiFetch(`/apps/${userid}/${appname}`, {
      method: "DELETE",
      body: JSON.stringify({ keepData }),
    });
    resetLogs();
    setBanner(`삭제 완료: ${appLabel}`, "success");
    await loadApps();
    return;
  }

  const validActions = ["start", "stop", "deploy"];
  if (!validActions.includes(action)) {
    return;
  }

  setBanner(`${action} 요청 중: ${appLabel}`, "info");
  await apiFetch(`/apps/${userid}/${appname}/${action}`, { method: "POST" });
  setBanner(`${action} 완료: ${appLabel}`, "success");
  await loadApps();
}

async function bootstrap() {
  const persistedUiState = readPersistedUiState();
  switchView(DEFAULT_VIEW, { persist: false });
  switchTab(persistedUiState.tab || DEFAULT_OPS_TAB, { persist: false });
  updateAuthUi();
  setNewApiKeyValue("");
  await loadConfig();
  syncDomainPreview();

  const loggedIn = await loadSession();
  if (!loggedIn) {
    redirectToAuth();
    return;
  }

  switchView(persistedUiState.view || DEFAULT_VIEW, { persist: false });
  switchTab(persistedUiState.tab || DEFAULT_OPS_TAB, { persist: false });
  updateAuthUi();
  persistUiState();

  await refreshDashboardData();
  const hint = getAdminAccessHint();
  if (isPasswordLocked()) {
    setBanner(hint || "초기 비밀번호를 우상단 설정에서 변경하세요.", "error");
    return;
  }
  setBanner(hint || "로그인 상태가 확인되었습니다.", hint ? "info" : "success");
}

el.appnameInput.addEventListener("input", syncDomainPreview);

el.gnbItems.forEach((item) => {
  item.addEventListener("click", () => {
    switchView(item.dataset.view);
  });
});

if (el.gnbBrand) {
  el.gnbBrand.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    switchView(DEFAULT_VIEW);
  });
}

el.mobileMenuBtn.addEventListener("click", toggleMobileMenu);
el.gnbOverlay.addEventListener("click", closeMobileMenu);

el.tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    switchTab(button.dataset.tabTarget);
  });
});

el.logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Ignore transport errors and redirect anyway.
  }
  stopAutoRefresh();
  redirectToAuth();
});

el.settingsBtn.addEventListener("click", openSettingsModal);
el.openSettingsBtn.addEventListener("click", openSettingsModal);
el.openCreateUserBtn.addEventListener("click", openCreateUserModal);

el.closeSettingsBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSettingsModal();
});

el.closeCreateUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeCreateUserModal({ resetForm: true });
});

el.cancelCreateUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeCreateUserModal({ resetForm: true });
});

el.closeDeleteUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeDeleteUserModal({ resetForm: true });
});

el.cancelDeleteUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeDeleteUserModal({ resetForm: true });
});

bindBackdropClose(el.settingsModal, "settings", closeSettingsModal);
bindBackdropClose(el.createUserModal, "createUser", () => {
  closeCreateUserModal({ resetForm: true });
});
bindBackdropClose(el.deleteUserModal, "deleteUser", () => {
  closeDeleteUserModal({ resetForm: true });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Esc") {
    if (!el.deleteUserModal.hidden) {
      closeDeleteUserModal({ resetForm: true });
      return;
    }
    if (!el.createUserModal.hidden) {
      closeCreateUserModal({ resetForm: true });
      return;
    }
    if (!el.settingsModal.hidden) {
      closeSettingsModal();
    }
  }
});

el.usersTableBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='remove-user']");
  if (!button) {
    return;
  }
  if (!canManageUsers()) {
    return;
  }
  const id = parsePositiveInt(button.dataset.id);
  if (!id) {
    return;
  }
  const username = String(button.dataset.username || "").trim() || `user-${id}`;
  openDeleteUserModal({ id, username });
});

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
      body: JSON.stringify({
        username,
        password,
        isAdmin,
      }),
    });
    closeCreateUserModal({ resetForm: true });
    await loadUsers();
    setBanner(`사용자 생성 완료: ${data.user.username}`, "success");
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await handleRequestError(error);
      return;
    }
    setCreateUserError(
      normalizeErrorMessage(error, "사용자 생성 중 오류가 발생했습니다."),
    );
  }
});

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
      body: JSON.stringify({
        currentPassword,
      }),
    });
    closeDeleteUserModal({ resetForm: true });
    await loadUsers();
    setBanner(`사용자 제거 완료: ${targetUser.username}`, "success");
  } catch (error) {
    const message = normalizeErrorMessage(
      error,
      "사용자 제거 중 오류가 발생했습니다.",
    );
    const isCurrentPasswordMismatch =
      error?.status === 401 && /^current password is incorrect$/i.test(message);
    if (error?.status === 401 && !isCurrentPasswordMismatch) {
      await handleRequestError(error);
      return;
    }
    if (error?.status === 403 && isPasswordLocked()) {
      await handleRequestError(error);
      return;
    }
    setDeleteUserError(message);
  }
});

el.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSettingsError("");
  try {
    const currentPassword = el.currentPasswordInput.value;
    const newPassword = el.newPasswordInput.value;
    const data = await apiFetch("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    state.user = data.user || null;
    el.currentPasswordInput.value = "";
    el.newPasswordInput.value = "";
    updateAuthUi();
    closeSettingsModal();
    await refreshDashboardData();
    setBanner("비밀번호 변경이 완료되었습니다.", "success");
  } catch (error) {
    await handleSettingsModalError(error);
  }
});

el.createApiKeyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = el.apiKeyNameInput.value.trim();
    const data = await apiFetch("/api-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setNewApiKeyValue(data.apiKey || "");
    el.apiKeyNameInput.value = "";
    await loadApiKeys();
    setBanner("새 API Key가 발급되었습니다. 지금 복사해 두세요.", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

el.copyNewApiKeyBtn.addEventListener("click", async () => {
  const apiKey = getVisibleNewApiKey();
  if (!apiKey) {
    setBanner("복사할 새 API Key가 없습니다.", "error");
    return;
  }
  try {
    await copyTextToClipboard(apiKey);
    setBanner("새 API Key를 클립보드에 복사했습니다.", "success");
  } catch {
    setBanner("클립보드 복사에 실패했습니다. 키를 직접 복사하세요.", "error");
  }
});

el.apiKeyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='revoke-api-key']");
  if (!button) {
    return;
  }
  const card = button.closest(".api-key-item");
  if (!card) {
    return;
  }
  const id = parsePositiveInt(card.dataset.id);
  if (!id) {
    return;
  }

  const shouldRevoke = window.confirm(`API Key #${id}를 폐기합니다.`);
  if (!shouldRevoke) {
    return;
  }

  try {
    await apiFetch(`/api-keys/${id}`, { method: "DELETE" });
    await loadApiKeys();
    setBanner(`API Key #${id} 폐기 완료`, "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

el.refreshBtn.addEventListener("click", async () => {
  try {
    await loadApps();
    await loadUsers();
    setBanner("데이터 갱신 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

el.createForm.addEventListener("submit", async (event) => {
  try {
    await handleCreate(event);
  } catch (error) {
    await handleRequestError(error);
  }
});

el.appsContainer.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const target = getActionTarget(button);
  if (!target) {
    return;
  }
  try {
    await performAction(target);
  } catch (error) {
    await handleRequestError(error);
  }
});

bootstrap().catch((error) => {
  handleRequestError(error);
});

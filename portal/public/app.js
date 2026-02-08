const AUTO_REFRESH_MS = 15000;

const state = {
  domain: "my.domain.com",
  apps: [],
  apiKeys: [],
  user: null,
  refreshTimer: null
};

const el = {
  statusBanner: document.getElementById("status-banner"),
  authState: document.getElementById("auth-state"),
  loginForm: document.getElementById("login-form"),
  loginUsernameInput: document.getElementById("login-username-input"),
  loginPasswordInput: document.getElementById("login-password-input"),
  sessionPanel: document.getElementById("session-panel"),
  sessionUsername: document.getElementById("session-username"),
  sessionRole: document.getElementById("session-role"),
  logoutBtn: document.getElementById("logout-btn"),
  createForm: document.getElementById("create-form"),
  useridInput: document.getElementById("userid-input"),
  appnameInput: document.getElementById("appname-input"),
  templateInput: document.getElementById("template-input"),
  enableApiInput: document.getElementById("enable-api-input"),
  domainPreview: document.getElementById("domain-preview"),
  domainChip: document.getElementById("domain-chip"),
  limitChip: document.getElementById("limit-chip"),
  appCountChip: document.getElementById("app-count-chip"),
  refreshBtn: document.getElementById("refresh-btn"),
  emptyState: document.getElementById("empty-state"),
  appsContainer: document.getElementById("apps-container"),
  keepDataInput: document.getElementById("keep-data-input"),
  logLinesInput: document.getElementById("log-lines-input"),
  logsTitle: document.getElementById("logs-title"),
  logsOutput: document.getElementById("logs-output"),
  passwordPanel: document.getElementById("password-panel"),
  passwordForm: document.getElementById("password-form"),
  currentPasswordInput: document.getElementById("current-password-input"),
  newPasswordInput: document.getElementById("new-password-input"),
  apiKeysPanel: document.getElementById("api-keys-panel"),
  createApiKeyForm: document.getElementById("create-api-key-form"),
  apiKeyNameInput: document.getElementById("api-key-name-input"),
  newApiKey: document.getElementById("new-api-key"),
  apiKeyList: document.getElementById("api-key-list")
};

function setBanner(message, type = "info") {
  el.statusBanner.className = `status-banner ${type}`;
  el.statusBanner.textContent = message;
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

function isPasswordLocked() {
  return Boolean(state.user?.mustChangePassword);
}

function canManageApps() {
  return isLoggedIn() && !isPasswordLocked();
}

function syncDomainPreview() {
  const userid = el.useridInput.value.trim() || "userid";
  const appname = el.appnameInput.value.trim() || "appname";
  el.domainPreview.textContent = `${userid}-${appname}.${state.domain}`;
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
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
    date.getDate()
  ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
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
  el.refreshBtn.disabled = !enabled;
  el.keepDataInput.disabled = !enabled;
  el.logLinesInput.disabled = !enabled;
}

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
  el.appsContainer.innerHTML = apps
    .map((appItem) => {
      const safeUser = escapeHtml(appItem.userid);
      const safeApp = escapeHtml(appItem.appname);
      const safeDomain = escapeHtml(appItem.domain || "-");
      const safeTemplate = escapeHtml(appItem.templateId || "-");
      const rawStatus = appItem.status || "unknown";
      const safeStatus = escapeHtml(rawStatus);
      const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));
      const apiEnabled = appItem.enableApi ? "on" : "off";

      return `
        <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
          <div class="app-card-head">
            <h3 class="app-name">${safeUser} / ${safeApp}</h3>
            <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
          </div>
          <p class="app-domain">${safeDomain}</p>
          <p class="app-meta">template: ${safeTemplate} | api: ${apiEnabled} | created: ${safeCreatedAt}</p>
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
  if (!isLoggedIn() || isPasswordLocked()) {
    el.apiKeyList.innerHTML = "";
    return;
  }
  if (!state.apiKeys.length) {
    el.apiKeyList.innerHTML = '<p class="empty-state">발급된 API Key가 없습니다.</p>';
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

function updateAuthUi() {
  if (!isLoggedIn()) {
    el.authState.textContent = "로그아웃 상태";
    el.loginForm.hidden = false;
    el.sessionPanel.hidden = true;
    el.passwordPanel.hidden = true;
    el.apiKeysPanel.hidden = true;
    applyAccessState();
    return;
  }

  el.authState.textContent = isPasswordLocked()
    ? "로그인됨 (초기 비밀번호 변경 필요)"
    : "로그인됨";
  el.loginForm.hidden = true;
  el.sessionPanel.hidden = false;
  el.sessionUsername.textContent = state.user.username;
  el.sessionRole.textContent = state.user.role;
  el.passwordPanel.hidden = !isPasswordLocked();
  el.apiKeysPanel.hidden = isPasswordLocked();
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
    renderApps([]);
    renderApiKeys();
    updateAuthUi();
    stopAutoRefresh();
    setBanner("세션이 만료되었습니다. 다시 로그인하세요.", "error");
    return;
  }
  if (error?.status === 403 && isPasswordLocked()) {
    setBanner("초기 비밀번호를 먼저 변경하세요.", "error");
    return;
  }
  setBanner(error.message || "요청 중 오류가 발생했습니다.", "error");
}

async function loadConfig() {
  const data = await apiFetch("/config");
  state.domain = data.domain || "my.domain.com";
  el.domainChip.textContent = state.domain;
  el.limitChip.textContent = `${data.limits.maxAppsPerUser}/${data.limits.maxTotalApps}`;
  if (!el.templateInput.value) {
    el.templateInput.value = data.defaults.templateId || "diary-v1";
  }
  syncDomainPreview();
}

async function loadSession() {
  try {
    const data = await apiFetch("/auth/me");
    state.user = data.user || null;
    updateAuthUi();
    return true;
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      updateAuthUi();
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
  if (!isLoggedIn() || isPasswordLocked()) {
    state.apiKeys = [];
    renderApiKeys();
    return;
  }
  const data = await apiFetch("/api-keys");
  state.apiKeys = data.apiKeys || [];
  renderApiKeys();
}

async function handleCreate(event) {
  event.preventDefault();
  if (!canManageApps()) {
    throw new Error("로그인 후 비밀번호 변경을 완료해야 앱을 관리할 수 있습니다.");
  }

  const body = {
    userid: el.useridInput.value.trim(),
    appname: el.appnameInput.value.trim(),
    templateId: el.templateInput.value.trim(),
    enableApi: el.enableApiInput.checked
  };

  if (!body.userid || !body.appname || !body.templateId) {
    throw new Error("userid, appname, templateId를 입력하세요.");
  }

  setBanner("앱 생성 요청 중...", "info");
  const data = await apiFetch("/apps", {
    method: "POST",
    body: JSON.stringify(body)
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
    action: button.dataset.action
  };
}

async function requestLogs(userid, appname) {
  const rawLines = Number.parseInt(el.logLinesInput.value, 10);
  const lines = Number.isFinite(rawLines) ? Math.max(1, Math.min(1000, rawLines)) : 120;
  const data = await apiFetch(`/apps/${userid}/${appname}/logs?lines=${lines}`);
  el.logsTitle.textContent = `${userid}/${appname} (${lines} lines)`;
  el.logsOutput.textContent = data.logs || "(empty)";
}

async function performAction(target) {
  if (!canManageApps()) {
    throw new Error("앱 관리를 위해 로그인 상태와 비밀번호 변경 상태를 확인하세요.");
  }

  const { userid, appname, action } = target;
  const appLabel = `${userid}/${appname}`;

  if (action === "logs") {
    setBanner(`로그 조회 중: ${appLabel}`, "info");
    await requestLogs(userid, appname);
    setBanner(`로그 조회 완료: ${appLabel}`, "success");
    return;
  }

  if (action === "delete") {
    const keepData = el.keepDataInput.checked;
    const shouldDelete = window.confirm(
      `${appLabel} 앱을 삭제합니다. keepData=${keepData ? "true" : "false"}`
    );
    if (!shouldDelete) {
      return;
    }
    setBanner(`삭제 요청 중: ${appLabel}`, "info");
    await apiFetch(`/apps/${userid}/${appname}`, {
      method: "DELETE",
      body: JSON.stringify({ keepData })
    });
    resetLogs();
    setBanner(`삭제 완료: ${appLabel}`, "success");
    await loadApps();
    return;
  }

  const endpointMap = {
    start: "start",
    stop: "stop",
    deploy: "deploy"
  };
  const endpoint = endpointMap[action];
  if (!endpoint) {
    return;
  }

  setBanner(`${action} 요청 중: ${appLabel}`, "info");
  await apiFetch(`/apps/${userid}/${appname}/${endpoint}`, {
    method: "POST"
  });
  setBanner(`${action} 완료: ${appLabel}`, "success");
  await loadApps();
}

async function bootstrap() {
  await loadConfig();
  syncDomainPreview();
  const loggedIn = await loadSession();
  if (!loggedIn) {
    renderApps([]);
    renderApiKeys();
    setBanner("로그인 후 Portal을 사용할 수 있습니다.", "info");
    return;
  }

  if (isPasswordLocked()) {
    renderApps([]);
    renderApiKeys();
    setBanner("초기 비밀번호를 변경해야 앱 관리가 활성화됩니다.", "info");
    return;
  }

  await loadApps();
  await loadApiKeys();
  startAutoRefresh();
  setBanner("로그인 상태가 확인되었습니다.", "success");
}

el.useridInput.addEventListener("input", syncDomainPreview);
el.appnameInput.addEventListener("input", syncDomainPreview);

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const username = el.loginUsernameInput.value.trim();
    const password = el.loginPasswordInput.value;
    if (!username || !password) {
      throw new Error("로그인 ID와 비밀번호를 입력하세요.");
    }
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    state.user = data.user || null;
    updateAuthUi();
    el.loginPasswordInput.value = "";
    resetLogs();

    if (isPasswordLocked()) {
      renderApps([]);
      renderApiKeys();
      stopAutoRefresh();
      setBanner("초기 비밀번호를 먼저 변경하세요.", "info");
      return;
    }

    await loadApps();
    await loadApiKeys();
    startAutoRefresh();
    setBanner("로그인 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

el.logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Ignore logout transport errors and reset client state anyway.
  }
  state.user = null;
  state.apps = [];
  state.apiKeys = [];
  renderApps([]);
  renderApiKeys();
  updateAuthUi();
  stopAutoRefresh();
  el.newApiKey.textContent = "(없음)";
  resetLogs();
  setBanner("로그아웃되었습니다.", "info");
});

el.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const currentPassword = el.currentPasswordInput.value;
    const newPassword = el.newPasswordInput.value;
    const data = await apiFetch("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    });
    state.user = data.user || null;
    el.currentPasswordInput.value = "";
    el.newPasswordInput.value = "";
    updateAuthUi();
    await loadApps();
    await loadApiKeys();
    startAutoRefresh();
    setBanner("비밀번호 변경이 완료되었습니다.", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

el.createApiKeyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = el.apiKeyNameInput.value.trim();
    const data = await apiFetch("/api-keys", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    el.newApiKey.textContent = data.apiKey || "(없음)";
    el.apiKeyNameInput.value = "";
    await loadApiKeys();
    setBanner("새 API Key가 발급되었습니다. 지금 복사해 두세요.", "success");
  } catch (error) {
    await handleRequestError(error);
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
  const id = Number.parseInt(card.dataset.id || "", 10);
  if (!Number.isInteger(id) || id <= 0) {
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
    setBanner("앱 목록 갱신 완료", "success");
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

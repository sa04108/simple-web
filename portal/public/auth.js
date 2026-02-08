const state = {
  security: {
    hostSplitEnabled: false,
    adminHost: null,
    currentHostType: "unknown",
    adminAccessAllowedForRequest: true
  }
};

const el = {
  statusBanner: document.getElementById("status-banner"),
  hostHint: document.getElementById("auth-host-hint"),
  loginForm: document.getElementById("login-form"),
  loginUsernameInput: document.getElementById("login-username-input"),
  loginPasswordInput: document.getElementById("login-password-input")
};

function setBanner(message, type = "info") {
  el.statusBanner.className = `status-banner ${type}`;
  el.statusBanner.textContent = message;
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

function renderHostHint() {
  if (state.security.hostSplitEnabled && !state.security.adminAccessAllowedForRequest) {
    const adminHost = state.security.adminHost || "admin host";
    el.hostHint.hidden = false;
    el.hostHint.textContent = `현재 호스트에서는 admin 로그인이 제한됩니다. ${adminHost}로 접속하세요.`;
    return;
  }
  el.hostHint.hidden = true;
  el.hostHint.textContent = "";
}

async function loadConfig() {
  const data = await apiFetch("/config");
  state.security = {
    hostSplitEnabled: Boolean(data.security?.hostSplitEnabled),
    adminHost: data.security?.adminHost || null,
    currentHostType: data.security?.currentHostType || "unknown",
    adminAccessAllowedForRequest: Boolean(data.security?.adminAccessAllowedForRequest)
  };
  renderHostHint();
}

async function redirectIfLoggedIn() {
  if (state.security.hostSplitEnabled && !state.security.adminAccessAllowedForRequest) {
    return false;
  }
  try {
    await apiFetch("/auth/me");
    window.location.replace("/");
    return true;
  } catch (error) {
    if (error.status === 401) {
      return false;
    }
    throw error;
  }
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const username = el.loginUsernameInput.value.trim();
    const password = el.loginPasswordInput.value;
    if (!username || !password) {
      throw new Error("로그인 ID와 비밀번호를 입력하세요.");
    }

    setBanner("로그인 중...", "info");
    await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    window.location.replace("/");
  } catch (error) {
    setBanner(error.message || "로그인에 실패했습니다.", "error");
  }
});

async function bootstrap() {
  await loadConfig();
  const loggedIn = await redirectIfLoggedIn();
  if (!loggedIn) {
    el.loginUsernameInput.focus();
  }
}

bootstrap().catch((error) => {
  setBanner(error.message || "초기화 중 오류가 발생했습니다.", "error");
});

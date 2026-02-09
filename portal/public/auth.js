// =============================================================================
// auth.js - PaaS 포털 로그인 페이지 컨트롤러
// =============================================================================
// 역할:
//   로그인 폼 처리 및 인증 흐름을 담당한다.
//   - 사용자명/비밀번호 기반 로그인 (POST /auth/login)
//   - 이미 로그인된 경우 대시보드로 자동 리다이렉트
// =============================================================================
const el = {
  statusBanner: document.getElementById("status-banner"),
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

async function redirectIfLoggedIn() {
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
  const loggedIn = await redirectIfLoggedIn();
  if (!loggedIn) {
    el.loginUsernameInput.focus();
  }
}

bootstrap().catch((error) => {
  setBanner(error.message || "초기화 중 오류가 발생했습니다.", "error");
});

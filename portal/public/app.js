// =============================================================================
// app.js - 이벤트 바인딩 · 부트스트랩
// =============================================================================
// 역할:
//   모든 DOM 이벤트 리스너를 등록하고 앱을 시작한다.
//   비즈니스 로직은 각 모듈 파일로 위임되며, 이 파일은 '연결'만 담당한다.
//
//   로드 방식:
//     - index.html은 app.js(type="module")만 로드한다.
//     - app.js가 나머지 app-*.js를 import해 의존 관계를 구성한다.
// =============================================================================

// ── 모듈 연결 ─────────────────────────────────────────────────────────────────

import { DEFAULT_VIEW, el, state } from "./app-state.js";
import {
  canManageUsers,
  clearCreateFieldFeedback,
  isPasswordLocked,
  normalizeErrorMessage,
  parsePositiveInt,
  persistUiState,
  readPersistedUiState,
  redirectToAuth,
  setBanner,
  setCreateUserError,
  setDeleteUserError,
  setPromoteAdminError,
  setSettingsError,
  showToast,
  syncDomainPreview,
} from "./app-utils.js";
import {
  bindBackdropClose,
  closeCreateUserModal,
  closeDeleteUserModal,
  closeMobileMenu,
  closePromoteAdminModal,
  closeSettingsModal,
  configureUiHandlers,
  openCreateUserModal,
  openDeleteUserModal,
  openPromoteAdminModal,
  openSettingsModal,
  switchDetailTab,
  switchView,
  toggleMobileMenu,
  updateAuthUi,
} from "./app-ui.js";
import {
  handleTabCompletion,
  historyBack,
  historyForward,
  initExecCwd,
  resetExecForApp,
  resetTabCompletionState,
  runExecCommand,
  setExecApiHandlers,
} from "./app-exec.js";
import {
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
  stopAutoRefresh,
} from "./app-api.js";

setExecApiHandlers({ apiFetch });
configureUiHandlers({
  handleRequestError,
  loadDetailEnv,
  loadDetailLogs,
  resetExecForApp,
});

el.appnameInput.addEventListener("input", () => {
  clearCreateFieldFeedback(el.appnameInput);
  syncDomainPreview();
});
el.repoUrlInput.addEventListener("input", () => clearCreateFieldFeedback(el.repoUrlInput));

el.createForm.addEventListener("submit", async (event) => {
  try {
    await handleCreate(event);
  } catch (error) {
    await handleRequestError(error);
  }
});

// ── GNB ───────────────────────────────────────────────────────────────────────

el.gnbItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

if (el.gnbBrand) {
  el.gnbBrand.addEventListener("click", (event) => {
    // 수정자 키 또는 보조 버튼 클릭은 기본 동작(링크 이동)으로 처리한다.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchView(DEFAULT_VIEW);
  });
}

el.mobileMenuBtn.addEventListener("click", toggleMobileMenu);
el.gnbOverlay.addEventListener("click", closeMobileMenu);

// ── 앱 관리 서브 GNB ─────────────────────────────────────────────────────────

el.appDetailBackBtn.addEventListener("click", () => switchView("dashboard"));

el.detailTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.detailTab;
    switchDetailTab(tab);
    if (tab === "logs"     && state.selectedApp) loadDetailLogs().catch(handleRequestError);
    if (tab === "exec"     && state.selectedApp) initExecCwd().catch(() => {});
    if (tab === "settings" && state.selectedApp) loadDetailEnv().catch(handleRequestError);
  });
});

// ── 로그 ──────────────────────────────────────────────────────────────────────

el.detailRefreshLogsBtn.addEventListener("click", async () => {
  try {
    await loadDetailLogs();
    setBanner("로그 새로고침 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

// ── Exec ──────────────────────────────────────────────────────────────────────

el.detailExecRunBtn.addEventListener("click", async () => {
  try {
    await runExecCommand();
  } catch (error) {
    await handleRequestError(error);
  }
});

el.detailExecInput.addEventListener("keydown", async (event) => {
  // Tab 외 키 입력 시 탭 완성 상태를 리셋한다.
  if (event.key !== "Tab") {
    resetTabCompletionState();
  }

  switch (event.key) {
    case "Enter":
      event.preventDefault();
      try { await runExecCommand(); } catch (err) { await handleRequestError(err); }
      break;
    case "ArrowUp":
      event.preventDefault();
      el.detailExecInput.value = historyBack(el.detailExecInput.value);
      break;
    case "ArrowDown": {
      event.preventDefault();
      const next = historyForward();
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

// ── Settings (env) ────────────────────────────────────────────────────────────

el.detailEnvSaveBtn.addEventListener("click", async () => {
  try {
    await saveDetailEnv();
  } catch (error) {
    await handleRequestError(error);
  }
});

// ── 설정 모달 (비밀번호 변경) ─────────────────────────────────────────────────

el.settingsBtn.addEventListener("click", openSettingsModal);

el.closeSettingsBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSettingsModal();
});

bindBackdropClose(el.settingsModal, "settings", closeSettingsModal);

el.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSettingsError("");
  try {
    const currentPassword    = el.currentPasswordInput.value;
    const newPassword        = el.newPasswordInput.value;
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
    el.currentPasswordInput.value    = "";
    el.newPasswordInput.value        = "";
    el.newPasswordConfirmInput.value = "";
    updateAuthUi();
    closeSettingsModal();
    await refreshDashboardData();
    showToast("비밀번호 변경이 완료되었습니다.", "success");
  } catch (error) {
    await handleSettingsModalError(error);
  }
});

// ── 로그아웃 ──────────────────────────────────────────────────────────────────

el.logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // 전송 오류는 무시하고 리다이렉트로 진행한다.
  }
  stopAutoRefresh();
  redirectToAuth();
});

// ── 대시보드 ──────────────────────────────────────────────────────────────────

el.refreshBtn.addEventListener("click", async () => {
  try {
    await loadApps();
    await loadUsers();
    setBanner("데이터 갱신 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

// 앱 카드 클릭 — 이벤트 위임 방식으로 [data-action] 버튼을 처리한다.
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

// ── 사용자 생성 모달 ──────────────────────────────────────────────────────────

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
  const username        = el.createUsernameInput.value.trim();
  const password        = el.createPasswordInput.value;
  const passwordConfirm = el.createPasswordConfirmInput.value;
  const roleValue       = el.createUserRoleInput.value;
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
    showToast(`사용자 생성 완료: ${data.user.username}`, "success");
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await handleRequestError(error);
      return;
    }
    setCreateUserError(normalizeErrorMessage(error, "사용자 생성 중 오류가 발생했습니다."));
  }
});

// ── 사용자 삭제 모달 ──────────────────────────────────────────────────────────

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
    showToast(`사용자 제거 완료: ${targetUser.username}`, "success");
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

// ── Admin 승격 모달 ───────────────────────────────────────────────────────────

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
    showToast(`${data.user.username} 사용자가 Admin으로 승격되었습니다.`, "success");
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

// ── 사용자 테이블 클릭 (이벤트 위임) ─────────────────────────────────────────

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

// ── ESC 키 모달 닫기 ──────────────────────────────────────────────────────────

// 열린 모달 중 우선순위(promoteAdmin > deleteUser > createUser > settings) 순서로 닫는다.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" && event.key !== "Esc") return;
  if (!el.promoteAdminModal.hidden) { closePromoteAdminModal();                  return; }
  if (!el.deleteUserModal.hidden)   { closeDeleteUserModal({ resetForm: true }); return; }
  if (!el.createUserModal.hidden)   { closeCreateUserModal({ resetForm: true }); return; }
  if (!el.settingsModal.hidden)     { closeSettingsModal(); }
});

// ── 부트스트랩 ────────────────────────────────────────────────────────────────

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

  // app-detail 뷰는 세션 복원 대상에서 제외한다 (선택된 앱 정보가 없으므로).
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

bootstrap().catch((error) => {
  handleRequestError(error);
});

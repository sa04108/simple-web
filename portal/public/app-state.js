// =============================================================================
// app-state.js - 전역 상수 · 상태 · DOM 참조
// =============================================================================
// 역할:
//   app.js와 다른 모듈 전체에서 공유되는 상수, 상태 객체, DOM 요소 참조를 제공한다.
//   ES Modules 전환 후 index.html은 app.js(type="module")만 로드한다.
//   이 파일은 import 없이 shared primitive만 export한다.
// =============================================================================

// ── 자동 갱신 주기 · 뷰 상수 ────────────────────────────────────────────────

export const AUTO_REFRESH_MS = 30000;
export const UI_STATE_STORAGE_KEY = "portal.uiState";
export const AVAILABLE_VIEWS = ["dashboard", "create", "app-detail", "users"];
export const AVAILABLE_DETAIL_TABS = ["logs", "exec", "settings"];
export const DEFAULT_VIEW = "dashboard";
export const DEFAULT_DETAIL_TAB = "logs";

// 앱 생성 폼 필드 오류 표시용 CSS 클래스
export const CREATE_FIELD_INVALID_CLASS = "field-invalid";
export const CREATE_FIELD_SHAKE_CLASS = "field-shake";
export const CREATE_FIELD_SEQUENCE_GAP_MS = 120; // 필드 간 shake 시작 딜레이 (ms)
export const CREATE_FIELD_SHAKE_DURATION_MS = 320; // shake 애니메이션 지속 시간 (ms)

// ── 앱 런타임 상태 ────────────────────────────────────────────────────────────

export const state = {
  domain:      "my.domain.com",
  devMode:     false,
  traefikPort: null,
  apps:    [],
  users:   [],
  jobs:    [],           // 진행중 / 최근 완료 job 목록
  jobPollers: new Map(), // Map<jobId, intervalId> — 폴링 핸들 추적
  pendingDeleteUser:  null,
  pendingPromoteUser: null,
  user:    null,
  refreshTimer:    null,
  activeView:      DEFAULT_VIEW,
  activeDetailTab: DEFAULT_DETAIL_TAB,
  selectedApp:     null,
};

// ── DOM 요소 참조 캐시 ────────────────────────────────────────────────────────
// DOMContentLoaded 이후 스크립트가 실행되므로 여기서 바로 참조해도 안전하다.

export const el = {
  // GNB
  devModeBadge:  document.getElementById("dev-mode-badge"),
  gnbBrand:      document.querySelector(".gnb-brand"),
  gnbNav:        document.querySelector(".gnb-nav"),
  gnbOverlay:    document.getElementById("gnb-mobile-overlay"),
  gnbItems:      Array.from(document.querySelectorAll(".gnb-item")),
  gnbUsersBtn:   document.getElementById("gnb-users-btn"),
  mobileMenuBtn: document.getElementById("mobile-menu-btn"),

  // 뷰 패널
  viewDashboard: document.getElementById("view-dashboard"),
  viewCreate:    document.getElementById("view-create"),
  viewAppDetail: document.getElementById("view-app-detail"),
  viewUsers:     document.getElementById("view-users"),

  // 공통 UI
  statusBanner: document.getElementById("status-banner"),
  authState:    document.getElementById("auth-state"),
  logoutBtn:    document.getElementById("logout-btn"),

  // 설정 모달 (비밀번호 변경)
  settingsBtn:              document.getElementById("settings-btn"),
  settingsModal:            document.getElementById("settings-modal"),
  settingsError:            document.getElementById("settings-error"),
  closeSettingsBtn:         document.getElementById("close-settings-btn"),
  passwordForm:             document.getElementById("password-form"),
  passwordUsernameInput:    document.getElementById("password-username-input"),
  currentPasswordInput:     document.getElementById("current-password-input"),
  newPasswordInput:         document.getElementById("new-password-input"),
  newPasswordConfirmInput:  document.getElementById("new-password-confirm-input"),

  // 앱 생성 폼
  createForm:       document.getElementById("create-form"),
  createSubmitBtn:  document.getElementById("create-submit-btn"),
  appnameInput:     document.getElementById("appname-input"),
  repoUrlInput:     document.getElementById("repo-url-input"),
  repoBranchInput:  document.getElementById("repo-branch-input"),
  domainPreview:    document.getElementById("domain-preview"),
  domainChip:       document.getElementById("domain-chip"),
  limitChip:        document.getElementById("limit-chip"),
  appCountChip:     document.getElementById("app-count-chip"),
  refreshBtn:       document.getElementById("refresh-btn"),
  emptyState:       document.getElementById("empty-state"),
  appsContainer:    document.getElementById("apps-container"),

  // 앱 관리 서브 GNB
  appDetailBackBtn:  document.getElementById("app-detail-back-btn"),
  appDetailAppname:  document.getElementById("app-detail-appname"),
  detailTabBtns:     Array.from(document.querySelectorAll(".detail-tab-btn")),

  // 앱 관리 패널
  detailPanelLogs:     document.getElementById("detail-panel-logs"),
  detailPanelExec:     document.getElementById("detail-panel-exec"),
  detailPanelSettings: document.getElementById("detail-panel-settings"),

  // Logs 탭
  detailLogLinesInput:    document.getElementById("detail-log-lines-input"),
  detailRefreshLogsBtn:   document.getElementById("detail-refresh-logs-btn"),
  detailLogsTitle:        document.getElementById("detail-logs-title"),
  detailLogsOutput:       document.getElementById("detail-logs-output"),

  // Exec 탭
  detailExecClearBtn:    document.getElementById("detail-exec-clear-btn"),
  detailExecOutput:      document.getElementById("detail-exec-output"),
  detailExecInput:       document.getElementById("detail-exec-input"),
  detailExecRunBtn:      document.getElementById("detail-exec-run-btn"),
  detailExecPromptCwd:   document.getElementById("detail-exec-prompt-cwd"),

  // Settings 탭 (환경변수)
  detailEnvTextarea:  document.getElementById("detail-env-textarea"),
  detailEnvError:     document.getElementById("detail-env-error"),
  detailEnvSaveBtn:   document.getElementById("detail-env-save-btn"),
  keepDataInput:      document.getElementById("keep-data-input"),

  // 사용자 관리 뷰
  usersCount:               document.getElementById("users-count"),
  usersEmptyState:          document.getElementById("users-empty-state"),
  usersTableBody:           document.getElementById("users-table-body"),
  openCreateUserBtn:        document.getElementById("open-create-user-btn"),
  createUserModal:          document.getElementById("create-user-modal"),
  closeCreateUserBtn:       document.getElementById("close-create-user-btn"),
  cancelCreateUserBtn:      document.getElementById("cancel-create-user-btn"),
  createUserForm:           document.getElementById("create-user-form"),
  createUserError:          document.getElementById("create-user-error"),
  createUsernameInput:      document.getElementById("create-username-input"),
  createPasswordInput:      document.getElementById("create-password-input"),
  createPasswordConfirmInput: document.getElementById("create-password-confirm-input"),
  createUserRoleInput:      document.getElementById("create-user-role-input"),

  // 사용자 삭제 모달
  deleteUserModal:          document.getElementById("delete-user-modal"),
  closeDeleteUserBtn:       document.getElementById("close-delete-user-btn"),
  cancelDeleteUserBtn:      document.getElementById("cancel-delete-user-btn"),
  deleteUserForm:           document.getElementById("delete-user-form"),
  deleteUserTarget:         document.getElementById("delete-user-target"),
  deleteUserError:          document.getElementById("delete-user-error"),
  deleteUserUsernameInput:  document.getElementById("delete-username-input"),
  deleteUserPasswordInput:  document.getElementById("delete-user-password-input"),

  // Admin 승격 모달
  promoteAdminModal:      document.getElementById("promote-admin-modal"),
  closePromoteAdminBtn:   document.getElementById("close-promote-admin-btn"),
  cancelPromoteAdminBtn:  document.getElementById("cancel-promote-admin-btn"),
  submitPromoteAdminBtn:  document.getElementById("submit-promote-admin-btn"),
  promoteAdminTarget:     document.getElementById("promote-admin-target"),
  promoteAdminError:      document.getElementById("promote-admin-error"),

  // 작업 목록 모달
  jobListBtn:             document.getElementById("job-list-btn"),
  jobListModal:           document.getElementById("job-list-modal"),
  closeJobListBtn:        document.getElementById("close-job-list-btn"),
  jobListTbody:           document.getElementById("job-list-tbody"),
  jobListEmpty:           document.getElementById("job-list-empty"),
};

// 각 모달의 백드롭 클릭 시작 여부를 추적한다.
// mousedown 이벤트에서 기록하고 click 이벤트에서 확인하여,
// 모달 내부에서 드래그 후 백드롭에서 버튼을 놓는 오동작을 방지한다.
export const modalBackdropState = {
  settings:    false,
  createUser:  false,
  deleteUser:  false,
  promoteAdmin: false,
  jobList:     false,
};

// 앱 생성 폼의 shake 애니메이션 타이머 ID 목록 (clearCreateValidationTimers로 일괄 취소)
export const createValidationTimers = [];

// =============================================================================
// app-render.js - 앱 목록 · 사용자 목록 렌더링
// =============================================================================
// 역할:
//   state.apps, state.users 데이터를 DOM으로 변환한다.
//   app-utils.js(escapeHtml, statusClass 등)에 의존한다.
// =============================================================================

import { el, state } from "./app-state.js?v=__APP_VERSION__";
import {
  canManageApps,
  canManageUsers,
  escapeHtml,
  formatDate,
  formatJobAction,
  formatJobTarget,
  isLoggedIn,
  isPasswordLocked,
  runtimeBadgeHtml,
  statusClass,
} from "./app-utils.js?v=__APP_VERSION__";

// ── 앱 카드 목록 렌더링 ───────────────────────────────────────────────────────

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
    const safeUser      = escapeHtml(appItem.userid);
    const safeApp       = escapeHtml(appItem.appname);
    const safeRepoUrl   = escapeHtml(appItem.repoUrl || "-");
    const safeBranch    = escapeHtml(appItem.branch || "main");
    const rawStatus     = appItem.status || "unknown";
    const safeStatus    = escapeHtml(rawStatus);
    const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));
    const badgeHtml     = runtimeBadgeHtml(appItem.detectedRuntime);

    // dev 모드에서는 http + Traefik 호스트 포트를 붙인다 (*.localhost 자동 해석).
    // prod 모드에서는 https (NPM이 443 처리).
    let domainHtml;
    if (appItem.domain) {
      const url = state.devMode && state.traefikPort
        ? `http://${appItem.domain}:${state.traefikPort}`
        : `https://${appItem.domain}`;
      domainHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(appItem.domain)}</a>`;
    } else {
      domainHtml = "-";
    }

    return `
      <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
        <div class="app-card-head">
          <div class="app-card-title-row">
            <button class="app-name-btn" data-action="manage" type="button" ${actionsDisabled}>${safeUser} / ${safeApp}</button>
            <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
            <button class="action-btn app-manage-btn" data-action="manage" type="button" ${actionsDisabled}>관리</button>
          </div>
          <div class="app-card-badges">
            ${badgeHtml}
          </div>
        </div>
        <p class="app-domain">${domainHtml}</p>
        <p class="app-meta">repo: ${safeRepoUrl} | branch: ${safeBranch} | created: ${safeCreatedAt}</p>
        <div class="app-actions">
          <button class="action-btn" data-action="start"  type="button" ${actionsDisabled}>Start</button>
          <button class="action-btn" data-action="stop"   type="button" ${actionsDisabled}>Stop</button>
          <button class="action-btn" data-action="deploy" type="button" ${actionsDisabled}>Deploy</button>
          <button class="action-btn danger" data-action="delete" type="button" ${actionsDisabled}>Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

// ── 전체 앱 목록 렌더링 (Admin 전용) ──────────────────────────────────────────

function renderAdminApps(apps) {
  if (!apps.length) {
    el.adminEmptyState.style.display = "block";
    el.adminEmptyState.textContent = "조회된 앱이 없습니다.";
    el.adminAppsContainer.innerHTML = "";
    return;
  }

  el.adminEmptyState.style.display = "none";
  el.adminAppsContainer.innerHTML = apps.map((appItem) => {
    const safeUser      = escapeHtml(appItem.userid);
    const safeApp       = escapeHtml(appItem.appname);
    const safeRepoUrl   = escapeHtml(appItem.repoUrl || "-");
    const safeBranch    = escapeHtml(appItem.branch || "main");
    const rawStatus     = appItem.status || "unknown";
    const safeStatus    = escapeHtml(rawStatus);
    const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));
    const badgeHtml     = runtimeBadgeHtml(appItem.detectedRuntime);

    let domainHtml;
    if (appItem.domain) {
      const url = state.devMode && state.traefikPort
        ? `http://${appItem.domain}:${state.traefikPort}`
        : `https://${appItem.domain}`;
      domainHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(appItem.domain)}</a>`;
    } else {
      domainHtml = "-";
    }

    return `
      <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
        <div class="app-card-head">
          <div class="app-card-title-row">
            <button class="app-name-btn" data-action="manage" type="button">${safeUser} / ${safeApp}</button>
            <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
            <button class="action-btn app-manage-btn" data-action="manage" type="button">관리</button>
          </div>
          <div class="app-card-badges">
            ${badgeHtml}
          </div>
        </div>
        <p class="app-domain">${domainHtml}</p>
        <p class="app-meta">repo: ${safeRepoUrl} | branch: ${safeBranch} | created: ${safeCreatedAt}</p>
        <div class="app-actions">
          <button class="action-btn" data-action="start"  type="button">Start</button>
          <button class="action-btn" data-action="stop"   type="button">Stop</button>
          <button class="action-btn" data-action="deploy" type="button">Deploy</button>
          <button class="action-btn danger" data-action="delete" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

// ── 사용자 테이블 렌더링 ──────────────────────────────────────────────────────

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
    const safeUsername    = escapeHtml(item.username || "-");
    const isAdmin         = item.isAdmin;
    const safeRole        = isAdmin ? "Admin" : "User";
    const safeCreatedAt   = escapeHtml(formatDate(item.createdAt));
    const safeLastAccessAt = escapeHtml(formatDate(item.lastAccessAt));

    // admin 계정은 삭제/승격 불가 — 보호됨 표시
    const actionCell = isAdmin
      ? `<span class="users-protected">보호됨</span>`
      : `<div class="users-action-group">
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

// ── 작업 목록 테이블 렌더링 ──────────────────────────────────────────────────────

function renderJobList(jobs) {
  const activeStatuses = new Set(["pending", "running", "interrupted", "failed"]);
  const activeJobs = jobs.filter((j) => activeStatuses.has(j.status));

  const table = document.getElementById("job-list-table");
  if (!activeJobs.length) {
    el.jobListTbody.innerHTML = "";
    el.jobListEmpty.hidden = false;
    table.hidden = true;
    return;
  }

  el.jobListEmpty.hidden = true;
  table.hidden = false;

  el.jobListTbody.innerHTML = activeJobs.map((job) => {
    const jobName = escapeHtml(formatJobAction(job));
    const appPart = escapeHtml(formatJobTarget(job) || "-");
    const rawStatus = job.status;
    const safeStatus = escapeHtml(rawStatus);
    
    let errorReason = "-";
    if (rawStatus === "failed" && job.error) {
       errorReason = `<span class="job-error-text" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</span>`;
    } else if (rawStatus === "interrupted") {
       errorReason = `<span class="ink-subtle">서버 재시작으로 중단됨</span>`;
    }

    let actions = `<span class="ink-subtle">-</span>`;
    if (rawStatus === "interrupted" || rawStatus === "failed") {
      actions = `
        <div class="users-action-group">
          <button class="action-btn" data-action="retry-job" data-id="${job.id}" type="button">재시도</button>
          <button class="action-btn danger" data-action="cancel-job" data-id="${job.id}" type="button">취소</button>
        </div>
      `;
    }

    return `
      <tr>
        <td>${jobName}</td>
        <td>${appPart}</td>
        <td><span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span></td>
        <td class="job-error-cell">${errorReason}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join("");
}

export {
  renderApps,
  renderAdminApps,
  renderUsers,
  renderJobList,
};

// =============================================================================
// domainManager.js - 커스텀 도메인 관리
// =============================================================================
// 역할:
//   사용자 커스텀 도메인의 CRUD, DNS 검증, Traefik 파일 프로바이더 YAML 생성을 담당한다.
//   - 도메인 추가 시 고유 CNAME 타겟 발급
//   - dns.promises.resolveCname 으로 소유권 검증
//   - 검증된 도메인만 portal-data/traefik-dynamic/custom-domains.yml 에 반영
//   - 파일은 원자적으로(tmp → rename) 덮어써 Traefik 핫 리로드를 안전하게 트리거
// =============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;

const { AppError } = require("./utils");
const { config } = require("./config");

// FQDN 기본 검증 정규식
const FQDN_REGEX =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

const DYNAMIC_CONFIG_DIR = path.join(
  path.dirname(config.PORTAL_DB_PATH), // portal-data/
  "traefik-dynamic",
);
const DYNAMIC_CONFIG_FILE = path.join(DYNAMIC_CONFIG_DIR, "custom-domains.yml");

function nowIso() {
  return new Date().toISOString();
}

function generateCnameTarget(appname) {
  const hash = crypto.randomBytes(4).toString("hex"); // 8자 hex
  return `${appname}-${hash}.${config.PAAS_DOMAIN}`;
}

// ── Traefik YAML 생성 ─────────────────────────────────────────────────────────

async function rebuildTraefikConfig(statements) {
  await fs.mkdir(DYNAMIC_CONFIG_DIR, { recursive: true });

  const activeDomains = statements.listAllActiveCustomDomains.all();

  if (activeDomains.length === 0) {
    // Traefik v3 file provider는 `http: {}` 를 허용하지 않는다.
    // 빈 YAML 객체 `{}` 는 유효하며 "설정 없음"으로 해석된다.
    await fs.writeFile(DYNAMIC_CONFIG_FILE, "{}\n", "utf8");
    return;
  }

  const containerPrefix = process.env.APP_CONTAINER_PREFIX || "paas-app";

  const routerLines = [];
  const serviceLines = [];
  const middlewareLines = [];

  for (const row of activeDomains) {
    const containerName = `${containerPrefix}-${row.userid}-${row.appname}`;
    const routerKey = `custom-${row.id}`;

    routerLines.push(
      `    ${routerKey}:`,
      `      rule: "Host(\`${row.domain}\`)"`,
      `      entryPoints:`,
      `        - web`,
      `      service: ${routerKey}-svc`,
      `      middlewares:`,
      `        - ${routerKey}-rewrite-host`,
    );

    serviceLines.push(
      `    ${routerKey}-svc:`,
      `      loadBalancer:`,
      `        servers:`,
      `          - url: "http://${containerName}:${row.port}"`,
    );

    middlewareLines.push(
      `    ${routerKey}-rewrite-host:`,
      `      headers:`,
      `        customRequestHeaders:`,
      `          Host: "localhost"`,
    );
  }

  const yaml = [
    "# managed by portal — do not edit manually",
    "http:",
    "  routers:",
    ...routerLines,
    "  services:",
    ...serviceLines,
    "  middlewares:",
    ...middlewareLines,
    "",
  ].join("\n");

  // 원자적 쓰기: tmp 파일에 먼저 쓴 뒤 rename
  const tmpPath = `${DYNAMIC_CONFIG_FILE}.tmp`;
  await fs.writeFile(tmpPath, yaml, "utf8");
  await fs.rename(tmpPath, DYNAMIC_CONFIG_FILE);
}

// ── 팩토리 ───────────────────────────────────────────────────────────────────

function createDomainManager({ statements }) {
  async function init() {
    await fs.mkdir(DYNAMIC_CONFIG_DIR, { recursive: true });
    // 시작 시 현재 active 도메인으로 YAML 재빌드 (재시작 후 상태 복구)
    await rebuildTraefikConfig(statements);
  }

  function listDomains(userid, appname) {
    return statements.selectCustomDomainsByApp.all(userid, appname);
  }

  function addDomain(userid, appname, domain, port) {
    // FQDN 검증
    if (!FQDN_REGEX.test(domain)) {
      throw new AppError(400, "유효하지 않은 도메인 형식입니다.");
    }

    // 플랫폼 도메인 등록 차단
    if (domain.endsWith(`.${config.PAAS_DOMAIN}`)) {
      throw new AppError(400, "플랫폼 기본 도메인은 등록할 수 없습니다.");
    }

    // 전역 중복 확인
    const existing = statements.selectCustomDomainByDomain.get(domain);
    if (existing) {
      if (existing.userid === userid && existing.appname === appname) {
        throw new AppError(409, "이미 이 앱에 등록된 도메인입니다.");
      }
      throw new AppError(409, "다른 앱에 이미 등록된 도메인입니다.");
    }

    const cnameTarget = generateCnameTarget(appname);
    const now = nowIso();
    statements.insertCustomDomain.run(
      userid,
      appname,
      domain,
      cnameTarget,
      port ?? 5000,
      now,
      now,
    );

    return statements.selectCustomDomainByDomain.get(domain);
  }

  function removeDomain(id, userid, appname) {
    const row = statements.selectCustomDomainById.get(id);
    if (!row || row.userid !== userid || row.appname !== appname) {
      throw new AppError(404, "도메인을 찾을 수 없습니다.");
    }
    statements.deleteCustomDomainById.run(id);

    // fire-and-forget — 실패해도 도메인 삭제 자체는 성공으로 처리
    rebuildTraefikConfig(statements).catch((err) =>
      console.error("[domainManager] rebuildTraefikConfig 실패:", err),
    );
  }

  async function verifyDomain(id, userid, appname) {
    const row = statements.selectCustomDomainById.get(id);
    if (!row || row.userid !== userid || row.appname !== appname) {
      throw new AppError(404, "도메인을 찾을 수 없습니다.");
    }

    const now = nowIso();
    let resolved = null;

    try {
      const results = await dns.resolveCname(row.domain);
      resolved = results[0] ?? null;
    } catch {
      // ENOTFOUND, ENODATA 등 — DNS 미설정 상태로 간주
    }

    // 일부 리졸버가 trailing dot 포함 반환
    const normalised = resolved ? resolved.replace(/\.$/, "") : null;
    const isVerified = normalised === row.cnameTarget;

    statements.updateCustomDomainStatus.run(
      isVerified ? "active" : "error",
      isVerified ? now : null,
      now,
      id,
    );

    const updated = statements.selectCustomDomainById.get(id);

    if (isVerified) {
      await rebuildTraefikConfig(statements);
    }

    return updated;
  }

  // 재배포 완료 후 포트가 변경된 경우 갱신
  async function refreshAppPort(userid, appname, port) {
    statements.updateCustomDomainPort.run(port, nowIso(), userid, appname);
    await rebuildTraefikConfig(statements);
  }

  // 앱 삭제 시 해당 앱의 모든 커스텀 도메인 정리
  function removeAppDomains(userid, appname) {
    statements.deleteCustomDomainsByApp.run(userid, appname);
    rebuildTraefikConfig(statements).catch((err) =>
      console.error(
        "[domainManager] removeAppDomains 후 rebuildTraefikConfig 실패:",
        err,
      ),
    );
  }

  return {
    init,
    listDomains,
    addDomain,
    removeDomain,
    verifyDomain,
    refreshAppPort,
    removeAppDomains,
  };
}

module.exports = { createDomainManager };

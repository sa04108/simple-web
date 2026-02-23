// =============================================================================
// routes/domains.js - /apps/:userid/:appname/domains 라우트 핸들러
// =============================================================================
// 역할:
//   커스텀 도메인 CRUD 및 DNS 검증 엔드포인트를 제공한다.
//   도메인 비즈니스 로직은 domainManager에 위임한다.
// =============================================================================
"use strict";

const express = require("express");
const { ROLE_ADMIN } = require("../authService");
const { AppError, sendOk } = require("../utils");
const {
  validateAppParams,
  ensureAppExists,
  findDockerApp,
} = require("../appManager");

function createDomainsRouter(domainManager) {
  const router = express.Router({ mergeParams: true });

  // URL 파라미터(:userid, :appname) 검증 + 권한 확인
  async function resolveAppContext(req) {
    const userid  = String(req.params?.userid  || "").trim();
    const appname = String(req.params?.appname || "").trim();
    validateAppParams(userid, appname);

    const user = req.auth?.user;
    if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
      throw new AppError(403, "Forbidden");
    }

    await ensureAppExists(userid, appname);
    return { userid, appname };
  }

  // GET /apps/:userid/:appname/domains — 커스텀 도메인 목록 조회
  router.get("/", async (req, res, next) => {
    try {
      const { userid, appname } = await resolveAppContext(req);
      const domains = domainManager.listDomains(userid, appname);
      return sendOk(res, { domains });
    } catch (e) {
      next(e);
    }
  });

  // POST /apps/:userid/:appname/domains — 커스텀 도메인 추가
  router.post("/", async (req, res, next) => {
    try {
      const { userid, appname } = await resolveAppContext(req);

      const domain = String(req.body?.domain || "").trim().toLowerCase();
      if (!domain) throw new AppError(400, "domain은 필수 입력값입니다.");

      // 현재 실행 중인 컨테이너에서 포트 정보 조회
      const dockerApp = await findDockerApp(userid, appname);
      const port = Number(dockerApp?.port) || 5000;

      const created = domainManager.addDomain(userid, appname, domain, port);
      return res.status(201).json({ ok: true, data: { domain: created } });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /apps/:userid/:appname/domains/:id — 커스텀 도메인 제거
  router.delete("/:id", async (req, res, next) => {
    try {
      const { userid, appname } = await resolveAppContext(req);
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) throw new AppError(400, "유효하지 않은 도메인 ID입니다.");

      domainManager.removeDomain(id, userid, appname);
      return sendOk(res, { deleted: true });
    } catch (e) {
      next(e);
    }
  });

  // POST /apps/:userid/:appname/domains/:id/verify — DNS 검증
  router.post("/:id/verify", async (req, res, next) => {
    try {
      const { userid, appname } = await resolveAppContext(req);
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) throw new AppError(400, "유효하지 않은 도메인 ID입니다.");

      const updated = await domainManager.verifyDomain(id, userid, appname);
      return sendOk(res, { domain: updated });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = createDomainsRouter;

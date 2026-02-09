// =============================================================================
// authService.js - 포털 인증 및 세션 관리 서비스
// =============================================================================
// 역할:
//   PaaS 포털의 사용자 인증 전반을 담당한다.
//   - 사용자 계정(paas-admin / paas-user) CRUD
//   - bcrypt 기반 비밀번호 해싱 및 검증
//   - 세션 토큰 발급/검증/만료 관리 (httpOnly 쿠키)
//   - 포털 API 키 발급/검증/폐기
//   - SQLite(better-sqlite3)로 users, sessions, api_keys 테이블 관리
//   - 최초 실행 시 bootstrap admin 계정 자동 생성 (admin/admin)
// =============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const ROLE_PAAS_ADMIN = "paas-admin";
const ROLE_PAAS_USER = "paas-user";
const USERNAME_REGEX = /^[a-z][a-z0-9]{2,19}$/;
const SESSION_TOKEN_PREFIX = "sess";
const API_KEY_TOKEN_PREFIX = "paas";

function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallbackValue;
}

function safeEqual(left, right) {
  const leftBuf = Buffer.from(String(left), "utf8");
  const rightBuf = Buffer.from(String(right), "utf8");
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function parseStructuredToken(value, prefix) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) {
    return null;
  }

  const id = Number.parseInt(parts[1], 10);
  const secret = parts[2];
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(secret)) {
    return null;
  }
  return { id, secret };
}

function nowIso() {
  return new Date().toISOString();
}

function parseCookieValue(req, cookieName) {
  const cookieHeader = String(req.headers.cookie || "");
  if (!cookieHeader) {
    return null;
  }
  const chunks = cookieHeader.split(";");
  for (const chunk of chunks) {
    const [key, ...valueParts] = chunk.trim().split("=");
    if (!key || !valueParts.length || key !== cookieName) {
      continue;
    }
    const rawValue = valueParts.join("=");
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function createAuthService(options) {
  const config = {
    dbPath: options.dbPath,
    sessionCookieName: options.sessionCookieName || "paas_portal_session",
    sessionTtlHours: Number(options.sessionTtlHours) > 0 ? Number(options.sessionTtlHours) : 168,
    cookieSecure: Boolean(options.cookieSecure),
    bcryptRounds: Number(options.bcryptRounds) > 0 ? Number(options.bcryptRounds) : 10,
    legacyApiKey: String(options.legacyApiKey || "").trim()
  };

  const sendOk = options.sendOk;
  const sendError = options.sendError;
  const AppError = options.AppError;

  if (!config.dbPath) {
    throw new Error("dbPath is required for createAuthService()");
  }

  let db = null;
  const statements = {};

  function toPublicUser(row) {
    return {
      id: Number(row.id),
      username: String(row.username),
      role: String(row.role || ROLE_PAAS_ADMIN),
      mustChangePassword: normalizeBoolean(row.mustChangePassword, false)
    };
  }

  function normalizeApiKeyRow(row) {
    return {
      id: Number(row.id),
      name: String(row.name || ""),
      keyPreview: `${API_KEY_TOKEN_PREFIX}.${row.id}.${row.keyPrefix}...`,
      createdAt: row.createdAt || null,
      lastUsedAt: row.lastUsedAt || null,
      revokedAt: row.revokedAt || null
    };
  }

  function normalizeUserRow(row) {
    const role = String(row.role || "");
    return {
      id: Number(row.id),
      username: String(row.username || ""),
      role,
      isAdmin: role === ROLE_PAAS_ADMIN,
      createdAt: row.createdAt || null,
      lastAccessAt: row.lastAccessAt || null
    };
  }

  function setSessionCookie(res, sessionToken, expiresAt) {
    res.cookie(config.sessionCookieName, sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      expires: new Date(expiresAt)
    });
  }

  function clearSessionCookie(res) {
    res.clearCookie(config.sessionCookieName, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/"
    });
  }

  function issueSession(userId) {
    const secret = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashSecret(secret);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000).toISOString();
    const result = statements.insertSession.run(Number(userId), tokenHash, createdAt, expiresAt);
    const sessionId = Number(result.lastInsertRowid);
    return {
      token: `${SESSION_TOKEN_PREFIX}.${sessionId}.${secret}`,
      sessionId,
      expiresAt
    };
  }

  const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
  const touchTimestamps = new Map();

  function throttledTouch(prefix, id, statement) {
    const key = `${prefix}:${id}`;
    const now = Date.now();
    const lastTouch = touchTimestamps.get(key) || 0;
    if (now - lastTouch < TOUCH_THROTTLE_MS) {
      return;
    }
    touchTimestamps.set(key, now);
    statement.run(nowIso(), id);
  }

  function authenticateSession(rawToken) {
    const parsed = parseStructuredToken(rawToken, SESSION_TOKEN_PREFIX);
    if (!parsed) {
      return null;
    }

    const row = statements.selectSessionWithUserById.get(parsed.id);
    if (!row || row.revokedAt) {
      return null;
    }
    const expiresAtMs = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      statements.revokeSessionById.run(nowIso(), parsed.id);
      return null;
    }
    if (!safeEqual(hashSecret(parsed.secret), row.tokenHash)) {
      return null;
    }

    throttledTouch("sess", parsed.id, statements.touchSessionLastUsed);
    return {
      method: "session",
      user: toPublicUser(row),
      sessionId: parsed.id,
      sessionExpiresAt: row.expiresAt
    };
  }

  function authenticateApiKey(rawApiKey) {
    const parsed = parseStructuredToken(rawApiKey, API_KEY_TOKEN_PREFIX);
    if (!parsed) {
      return null;
    }
    const row = statements.selectApiKeyWithUserById.get(parsed.id);
    if (!row || row.revokedAt) {
      return null;
    }
    if (!safeEqual(hashSecret(parsed.secret), row.secretHash)) {
      return null;
    }
    throttledTouch("apikey", parsed.id, statements.touchApiKeyLastUsed);
    return {
      method: "api-key",
      apiKeyId: parsed.id,
      user: toPublicUser(row)
    };
  }

  function authenticateLegacyApiKey(rawApiKey) {
    if (!config.legacyApiKey) {
      return null;
    }
    if (!safeEqual(rawApiKey, config.legacyApiKey)) {
      return null;
    }
    const adminUser = statements.selectUserByUsername.get("admin");
    if (!adminUser) {
      return null;
    }
    return {
      method: "legacy-api-key",
      apiKeyId: null,
      user: toPublicUser(adminUser)
    };
  }

  function resolveAnyAuth(req) {
    const sessionToken = parseCookieValue(req, config.sessionCookieName);
    if (sessionToken) {
      const sessionAuth = authenticateSession(sessionToken);
      if (sessionAuth) {
        return sessionAuth;
      }
    }

    const apiKey = String(req.get("X-API-Key") || "").trim();
    if (apiKey) {
      return authenticateApiKey(apiKey) || authenticateLegacyApiKey(apiKey);
    }
    return null;
  }

  function resolveSessionAuth(req) {
    const sessionToken = parseCookieValue(req, config.sessionCookieName);
    if (!sessionToken) {
      return null;
    }
    return authenticateSession(sessionToken);
  }

  function requireAnyAuth(req, res, next) {
    const auth = resolveAnyAuth(req);
    if (!auth) {
      return sendError(res, 401, "Unauthorized");
    }
    req.auth = auth;
    return next();
  }

  function requireSessionAuth(req, res, next) {
    const auth = resolveSessionAuth(req);
    if (!auth) {
      clearSessionCookie(res);
      return sendError(res, 401, "Unauthorized");
    }
    req.auth = auth;
    return next();
  }

  function requirePaasAdmin(req, res, next) {
    if (req.auth?.user?.role !== ROLE_PAAS_ADMIN) {
      return sendError(res, 403, "Forbidden");
    }
    return next();
  }

  function requirePasswordUpdated(req, res, next) {
    if (req.auth?.method === "session" && req.auth?.user?.mustChangePassword) {
      return sendError(res, 403, "Password change required");
    }
    return next();
  }

  function listUsers() {
    const rows = statements.listUsersWithLastAccess.all();
    return rows.map(normalizeUserRow);
  }

  function createUser(payload) {
    const username = String(payload?.username || "").trim();
    const password = String(payload?.password || "");
    const isAdmin = normalizeBoolean(payload?.isAdmin, false);
    const role = isAdmin ? ROLE_PAAS_ADMIN : ROLE_PAAS_USER;

    if (!USERNAME_REGEX.test(username)) {
      throw new AppError(400, "Invalid username. Expected /^[a-z][a-z0-9]{2,19}$/");
    }
    if (password.length < 8) {
      throw new AppError(400, "password must be at least 8 characters");
    }

    const existing = statements.selectUserByUsername.get(username);
    if (existing) {
      throw new AppError(409, "Username already exists");
    }

    const createdAt = nowIso();
    const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
    try {
      const result = statements.insertUser.run(
        username,
        passwordHash,
        role,
        1,
        createdAt,
        createdAt
      );
      const userId = Number(result.lastInsertRowid);
      const createdUser = statements.selectUserById.get(userId);
      return toPublicUser(createdUser);
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new AppError(409, "Username already exists");
      }
      throw error;
    }
  }

  function deleteUser(payload) {
    const actorUserId = Number.parseInt(String(payload?.actorUserId || ""), 10);
    const targetUserId = Number.parseInt(String(payload?.targetUserId || ""), 10);
    const currentPassword = String(payload?.currentPassword || "");

    if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
      throw new AppError(401, "Unauthorized");
    }
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      throw new AppError(400, "Invalid user id");
    }
    if (!currentPassword) {
      throw new AppError(400, "currentPassword is required");
    }

    const actor = statements.selectUserById.get(actorUserId);
    if (!actor) {
      throw new AppError(401, "Unauthorized");
    }
    if (!bcrypt.compareSync(currentPassword, actor.passwordHash)) {
      throw new AppError(401, "Current password is incorrect");
    }

    const target = statements.selectUserById.get(targetUserId);
    if (!target) {
      throw new AppError(404, "User not found");
    }
    if (String(target.role || ROLE_PAAS_USER) === ROLE_PAAS_ADMIN) {
      throw new AppError(403, "Admin users cannot be removed");
    }

    const result = statements.deleteUserById.run(targetUserId);
    if (!result.changes) {
      throw new AppError(404, "User not found");
    }

    return {
      id: Number(target.id),
      username: String(target.username || ""),
      deleted: true
    };
  }

  function attachRoutes(app) {
    app.post("/auth/login", (req, res, next) => {
      try {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "");
        if (!USERNAME_REGEX.test(username)) {
          throw new AppError(400, "Invalid username. Expected /^[a-z][a-z0-9]{2,19}$/");
        }
        if (!password) {
          throw new AppError(400, "Password is required");
        }

        const user = statements.selectUserByUsername.get(username);
        if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
          throw new AppError(401, "Invalid credentials");
        }

        const session = issueSession(user.id);
        setSessionCookie(res, session.token, session.expiresAt);
        return sendOk(res, {
          user: toPublicUser(user),
          sessionExpiresAt: session.expiresAt
        });
      } catch (error) {
        return next(error);
      }
    });

    app.get("/auth/me", requireSessionAuth, (req, res) =>
      sendOk(res, {
        user: req.auth.user,
        sessionExpiresAt: req.auth.sessionExpiresAt
      })
    );

    app.post("/auth/logout", (req, res) => {
      const token = parseCookieValue(req, config.sessionCookieName);
      const parsed = parseStructuredToken(token, SESSION_TOKEN_PREFIX);
      if (parsed) {
        statements.revokeSessionById.run(nowIso(), parsed.id);
      }
      clearSessionCookie(res);
      return sendOk(res, { loggedOut: true });
    });

    app.post("/auth/change-password", requireSessionAuth, (req, res, next) => {
      try {
        const currentPassword = String(req.body?.currentPassword || "");
        const newPassword = String(req.body?.newPassword || "");
        if (!currentPassword || !newPassword) {
          throw new AppError(400, "currentPassword and newPassword are required");
        }
        if (newPassword.length < 8) {
          throw new AppError(400, "newPassword must be at least 8 characters");
        }

        const userId = req.auth.user.id;
        const currentUser = statements.selectUserById.get(userId);
        if (!currentUser) {
          throw new AppError(401, "Unauthorized");
        }
        if (!bcrypt.compareSync(currentPassword, currentUser.passwordHash)) {
          throw new AppError(401, "Current password is incorrect");
        }
        if (bcrypt.compareSync(newPassword, currentUser.passwordHash)) {
          throw new AppError(400, "newPassword must be different from current password");
        }

        const updatedAt = nowIso();
        const nextHash = bcrypt.hashSync(newPassword, config.bcryptRounds);
        statements.updateUserPassword.run(nextHash, updatedAt, userId);
        statements.revokeSessionsByUserId.run(updatedAt, userId);

        const session = issueSession(userId);
        setSessionCookie(res, session.token, session.expiresAt);
        const updatedUser = statements.selectUserById.get(userId);
        return sendOk(res, {
          user: toPublicUser(updatedUser),
          sessionExpiresAt: session.expiresAt
        });
      } catch (error) {
        return next(error);
      }
    });

    app.use("/api-keys", requireSessionAuth, requirePaasAdmin, requirePasswordUpdated);

    app.get("/api-keys", (req, res) => {
      const rows = statements.listApiKeysByUserId.all(req.auth.user.id);
      return sendOk(res, { apiKeys: rows.map(normalizeApiKeyRow) });
    });

    app.post("/api-keys", (req, res, next) => {
      try {
        const rawName = String(req.body?.name || "").trim();
        const name = rawName || `key-${Date.now()}`;
        if (name.length < 1 || name.length > 60) {
          throw new AppError(400, "name must be 1-60 characters");
        }

        const secret = crypto.randomBytes(32).toString("base64url");
        const secretHash = hashSecret(secret);
        const keyPrefix = secret.slice(0, 8);
        const createdAt = nowIso();
        const result = statements.insertApiKey.run(
          req.auth.user.id,
          name,
          secretHash,
          keyPrefix,
          createdAt
        );
        const id = Number(result.lastInsertRowid);
        const apiKey = `${API_KEY_TOKEN_PREFIX}.${id}.${secret}`;

        return sendOk(
          res,
          {
            apiKey,
            item: normalizeApiKeyRow({
              id,
              name,
              keyPrefix,
              createdAt,
              lastUsedAt: null,
              revokedAt: null
            })
          },
          201
        );
      } catch (error) {
        return next(error);
      }
    });

    app.delete("/api-keys/:id", (req, res, next) => {
      try {
        const apiKeyId = Number.parseInt(String(req.params.id || ""), 10);
        if (!Number.isInteger(apiKeyId) || apiKeyId <= 0) {
          throw new AppError(400, "Invalid api key id");
        }
        const result = statements.deleteApiKeyByIdForUser.run(apiKeyId, req.auth.user.id);
        if (!result.changes) {
          throw new AppError(404, "API key not found");
        }
        return sendOk(res, { deleted: true, revoked: true, id: apiKeyId });
      } catch (error) {
        return next(error);
      }
    });
  }

  async function init() {
    await fs.mkdir(path.dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '${ROLE_PAAS_ADMIN}',
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_secret_hash ON api_keys(secret_hash);
    `);

    statements.selectUserById = db.prepare(`
      SELECT
        id,
        username,
        password_hash AS passwordHash,
        role,
        must_change_password AS mustChangePassword
      FROM users
      WHERE id = ?
    `);
    statements.selectUserByUsername = db.prepare(`
      SELECT
        id,
        username,
        password_hash AS passwordHash,
        role,
        must_change_password AS mustChangePassword
      FROM users
      WHERE username = ?
    `);
    statements.insertUser = db.prepare(`
      INSERT INTO users (
        username,
        password_hash,
        role,
        must_change_password,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    statements.updateUserPassword = db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 0, updated_at = ?
      WHERE id = ?
    `);
    statements.insertSession = db.prepare(`
      INSERT INTO sessions (
        user_id,
        token_hash,
        created_at,
        expires_at
      )
      VALUES (?, ?, ?, ?)
    `);
    statements.selectSessionWithUserById = db.prepare(`
      SELECT
        s.id,
        s.token_hash AS tokenHash,
        s.expires_at AS expiresAt,
        s.revoked_at AS revokedAt,
        u.id AS id,
        u.username,
        u.role,
        u.must_change_password AS mustChangePassword
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `);
    statements.touchSessionLastUsed = db.prepare(`
      UPDATE sessions
      SET last_used_at = ?
      WHERE id = ?
    `);
    statements.revokeSessionById = db.prepare(`
      UPDATE sessions
      SET revoked_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `);
    statements.revokeSessionsByUserId = db.prepare(`
      UPDATE sessions
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `);
    statements.revokeExpiredSessions = db.prepare(`
      UPDATE sessions
      SET revoked_at = ?
      WHERE revoked_at IS NULL AND expires_at <= ?
    `);
    statements.insertApiKey = db.prepare(`
      INSERT INTO api_keys (
        user_id,
        name,
        secret_hash,
        key_prefix,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `);
    statements.selectApiKeyWithUserById = db.prepare(`
      SELECT
        ak.id,
        ak.secret_hash AS secretHash,
        ak.revoked_at AS revokedAt,
        u.id AS id,
        u.username,
        u.role,
        u.must_change_password AS mustChangePassword
      FROM api_keys ak
      INNER JOIN users u ON u.id = ak.user_id
      WHERE ak.id = ?
    `);
    statements.touchApiKeyLastUsed = db.prepare(`
      UPDATE api_keys
      SET last_used_at = ?
      WHERE id = ?
    `);
    statements.listApiKeysByUserId = db.prepare(`
      SELECT
        id,
        name,
        key_prefix AS keyPrefix,
        created_at AS createdAt,
        last_used_at AS lastUsedAt,
        revoked_at AS revokedAt
      FROM api_keys
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY id DESC
    `);
    statements.deleteApiKeyByIdForUser = db.prepare(`
      DELETE FROM api_keys
      WHERE id = ? AND user_id = ?
    `);
    statements.listUsersWithLastAccess = db.prepare(`
      SELECT
        u.id,
        u.username,
        u.role,
        u.created_at AS createdAt,
        MAX(COALESCE(s.last_used_at, s.created_at)) AS lastAccessAt
      FROM users u
      LEFT JOIN sessions s ON s.user_id = u.id
      GROUP BY
        u.id,
        u.username,
        u.role,
        u.created_at
      ORDER BY
        CASE WHEN u.role = '${ROLE_PAAS_ADMIN}' THEN 0 ELSE 1 END ASC,
        u.created_at ASC,
        u.id ASC
    `);
    statements.deleteUserById = db.prepare(`
      DELETE FROM users
      WHERE id = ?
    `);

    const admin = statements.selectUserByUsername.get("admin");
    if (!admin) {
      const createdAt = nowIso();
      const hash = bcrypt.hashSync("admin", config.bcryptRounds);
      statements.insertUser.run("admin", hash, ROLE_PAAS_ADMIN, 1, createdAt, createdAt);
      console.warn("[portal] bootstrap admin created: id=admin, pw=admin");
    }

    const now = nowIso();
    statements.revokeExpiredSessions.run(now, now);
  }

  function getPublicConfig() {
    return {
      sessionCookieName: config.sessionCookieName,
      apiKeyPrefix: `${API_KEY_TOKEN_PREFIX}.<id>.<secret>`
    };
  }

  return {
    init,
    attachRoutes,
    requireAnyAuth,
    requireSessionAuth,
    requirePaasAdmin,
    requirePasswordUpdated,
    resolveSessionAuth,
    listUsers,
    createUser,
    deleteUser,
    getPublicConfig,
    getDbPath: () => config.dbPath,
    isLegacyApiKeyEnabled: () => Boolean(config.legacyApiKey)
  };
}

module.exports = {
  createAuthService
};

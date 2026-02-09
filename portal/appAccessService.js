"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const Database = require("better-sqlite3");

const KEY_TOKEN_PREFIX = "client";
const KEY_HEADER_NAME = "X-App-Key";

function nowIso() {
  return new Date().toISOString();
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function safeEqual(left, right) {
  const leftBuf = Buffer.from(String(left), "utf8");
  const rightBuf = Buffer.from(String(right), "utf8");
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
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

function normalizeKeyRow(row) {
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    keyPreview: `${KEY_TOKEN_PREFIX}.${row.id}.${row.keyPrefix}...`,
    userid: String(row.userid || ""),
    appname: String(row.appname || ""),
    createdAt: row.createdAt || null,
    lastUsedAt: row.lastUsedAt || null,
    revokedAt: row.revokedAt || null
  };
}

function createAppAccessService(options) {
  const config = {
    dbPath: String(options.dbPath || "").trim(),
    userIdRegex: options.userIdRegex,
    appNameRegex: options.appNameRegex
  };

  const sendError = options.sendError;
  const AppError = options.AppError;

  if (!config.dbPath) {
    throw new Error("dbPath is required for createAppAccessService()");
  }
  if (!(config.userIdRegex instanceof RegExp) || !(config.appNameRegex instanceof RegExp)) {
    throw new Error("userIdRegex and appNameRegex are required for createAppAccessService()");
  }

  let db = null;
  const statements = {};

  function assertScope(userid, appname) {
    const normalizedUserId = String(userid || "").trim();
    const normalizedAppName = String(appname || "").trim();
    if (!config.userIdRegex.test(normalizedUserId)) {
      throw new AppError(400, "Invalid userid");
    }
    if (!config.appNameRegex.test(normalizedAppName)) {
      throw new AppError(400, "Invalid appname");
    }
    return {
      userid: normalizedUserId,
      appname: normalizedAppName
    };
  }

  function issueKey(payload) {
    const { userid, appname } = assertScope(payload?.userid, payload?.appname);
    const rawName = String(payload?.name || "").trim();
    const name = rawName || `${userid}-${appname}-${Date.now()}`;
    if (name.length < 1 || name.length > 60) {
      throw new AppError(400, "name must be 1-60 characters");
    }

    const secret = crypto.randomBytes(32).toString("base64url");
    const secretHash = hashSecret(secret);
    const keyPrefix = secret.slice(0, 8);
    const createdAt = nowIso();

    const result = statements.insertAppClientKey.run(
      userid,
      appname,
      name,
      secretHash,
      keyPrefix,
      createdAt
    );
    const id = Number(result.lastInsertRowid);

    return {
      clientKey: `${KEY_TOKEN_PREFIX}.${id}.${secret}`,
      item: normalizeKeyRow({
        id,
        userid,
        appname,
        name,
        keyPrefix,
        createdAt,
        lastUsedAt: null,
        revokedAt: null
      })
    };
  }

  function listKeys(payload) {
    const { userid, appname } = assertScope(payload?.userid, payload?.appname);
    const rows = statements.listAppClientKeysByScope.all(userid, appname);
    return rows.map(normalizeKeyRow);
  }

  function revokeKey(payload) {
    const { userid, appname } = assertScope(payload?.userid, payload?.appname);
    const keyId = Number.parseInt(String(payload?.keyId || ""), 10);
    if (!Number.isInteger(keyId) || keyId <= 0) {
      throw new AppError(400, "Invalid key id");
    }
    const result = statements.deleteAppClientKeyByIdAndScope.run(keyId, userid, appname);
    if (!result.changes) {
      throw new AppError(404, "Client key not found");
    }
    return {
      id: keyId,
      deleted: true
    };
  }

  function authenticateForScope(rawKey, userid, appname) {
    const parsed = parseStructuredToken(rawKey, KEY_TOKEN_PREFIX);
    if (!parsed) {
      return null;
    }
    const row = statements.selectAppClientKeyById.get(parsed.id);
    if (!row || row.revokedAt) {
      return null;
    }
    if (String(row.userid) !== String(userid) || String(row.appname) !== String(appname)) {
      return null;
    }
    if (!safeEqual(hashSecret(parsed.secret), row.secretHash)) {
      return null;
    }
    statements.touchAppClientKeyLastUsed.run(nowIso(), parsed.id);
    return {
      method: "app-client-key",
      keyId: parsed.id,
      userid: String(row.userid),
      appname: String(row.appname),
      name: String(row.name || "")
    };
  }

  function requireAppClientKey(req, res, next) {
    try {
      const { userid, appname } = assertScope(req.params?.userid, req.params?.appname);
      const rawKey = String(req.get(KEY_HEADER_NAME) || "").trim();
      if (!rawKey) {
        return sendError(res, 401, "Unauthorized");
      }

      const auth = authenticateForScope(rawKey, userid, appname);
      if (!auth) {
        return sendError(res, 401, "Unauthorized");
      }

      req.appClientAuth = auth;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  async function init() {
    await fs.mkdir(path.dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_client_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userid TEXT NOT NULL,
        appname TEXT NOT NULL,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_client_keys_secret_hash
        ON app_client_keys(secret_hash);
      CREATE INDEX IF NOT EXISTS idx_app_client_keys_scope
        ON app_client_keys(userid, appname, id DESC);
    `);

    statements.insertAppClientKey = db.prepare(`
      INSERT INTO app_client_keys (
        userid,
        appname,
        name,
        secret_hash,
        key_prefix,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    statements.listAppClientKeysByScope = db.prepare(`
      SELECT
        id,
        userid,
        appname,
        name,
        key_prefix AS keyPrefix,
        created_at AS createdAt,
        last_used_at AS lastUsedAt,
        revoked_at AS revokedAt
      FROM app_client_keys
      WHERE userid = ? AND appname = ? AND revoked_at IS NULL
      ORDER BY id DESC
    `);
    statements.deleteAppClientKeyByIdAndScope = db.prepare(`
      DELETE FROM app_client_keys
      WHERE id = ? AND userid = ? AND appname = ?
    `);
    statements.selectAppClientKeyById = db.prepare(`
      SELECT
        id,
        userid,
        appname,
        name,
        secret_hash AS secretHash,
        revoked_at AS revokedAt
      FROM app_client_keys
      WHERE id = ?
    `);
    statements.touchAppClientKeyLastUsed = db.prepare(`
      UPDATE app_client_keys
      SET last_used_at = ?
      WHERE id = ?
    `);
  }

  return {
    init,
    issueKey,
    listKeys,
    revokeKey,
    requireAppClientKey
  };
}

module.exports = {
  createAppAccessService
};

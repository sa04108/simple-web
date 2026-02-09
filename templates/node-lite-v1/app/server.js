"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number.parseInt(process.env.PORT || "3000", 10) || 3000;
const APP_ID = process.env.APP_ID || "node-lite-app";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.url || "/");

  if (method === "GET" && path === "/") {
    return sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      message: "Node app is ready",
      endpoints: {
        info: "GET /app/info",
        execute: "POST /app/execute"
      }
    });
  }

  if (method === "GET" && path === "/app/info") {
    return sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      node: process.version,
      now: new Date().toISOString()
    });
  }

  if (method === "POST" && path === "/app/execute") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      executionId: randomUUID(),
      received: payload,
      now: new Date().toISOString()
    });
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(PORT, () => {
  console.log(`[app] ${APP_ID} listening on ${PORT}`);
});

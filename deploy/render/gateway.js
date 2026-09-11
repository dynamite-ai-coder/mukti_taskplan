#!/usr/bin/env node
/**
 * Planner A2A service — Render web-service entrypoint (planner-only).
 *
 * Runs in one process:
 *   - A2A registry (in-process, 127.0.0.1:$A2A_REGISTRY_PORT)
 * and exposes a public HTTP API on 0.0.0.0:$PORT (Render injects PORT):
 *
 *   GET  /health                    public liveness
 *   GET  /.well-known/agent.json    planner Agent Card
 *   POST /rpc                       JSON-RPC: decompose {objective} -> task-dag skeleton
 *   ALL  /a2a/*                     proxy -> in-process A2A registry
 *
 * Auth: Authorization: Bearer $SERVICE_API_KEY (or x-api-key / ?key=).
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const LOG_DIR = path.resolve(process.env.AACP_LOG_DIR || path.join(DATA_DIR, "logs"));
const REPORTS_DIR = path.resolve(process.env.REPORTS_DIR || path.join(DATA_DIR, "reports"));
const GLOBAL_DIR = process.env.OPENCODE_GLOBAL_DIR || path.join(os.homedir(), ".config", "opencode");
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "true";
const A2A_PORT = Number(process.env.A2A_REGISTRY_PORT || 8788);
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

process.env.A2A_HOST = process.env.A2A_HOST || "127.0.0.1";
process.env.A2A_REGISTRY_PORT = String(A2A_PORT);
process.env.AACP_LOG_DIR = LOG_DIR;
process.env.REPORTS_DIR = REPORTS_DIR;
process.env.A2A_STATE_FILE = process.env.A2A_STATE_FILE || path.join(DATA_DIR, "a2a-agents.json");

for (const dir of [DATA_DIR, LOG_DIR, REPORTS_DIR]) fs.mkdirSync(dir, { recursive: true });

/* ------------------------------------------------------------------ signing */

let signed = (value) => value;
try {
  ({ signed } = require(path.join(GLOBAL_DIR, "scripts", "crypto-sign.js")));
} catch (err) {
  process.stderr.write(`[gateway] crypto-sign unavailable, serving unsigned cards: ${err.message}\n`);
}

/* ------------------------------------------------------------------ in-process registry */

const serviceState = { registry: "starting" };
try {
  require(path.join(GLOBAL_DIR, "scripts", "a2a-registry.js"));
  serviceState.registry = "running";
} catch (err) {
  serviceState.registry = `error: ${err.message}`;
  process.stderr.write(`[gateway] a2a-registry failed: ${err.message}\n`);
}

/* ------------------------------------------------------------------ planner card + decompose */

function plannerCard() {
  return signed({
    did: "did:local:planner",
    name: "planner",
    capabilities: ["task_dag", "decompose", "dispatch"],
    endpoints: { rpc: `${PUBLIC_URL}/rpc`, stream: `${PUBLIC_URL}/a2a/stream` },
    limits: { max_rps: 5, timeout_ms: 120000 },
    trust: 0.95,
  });
}

function decompose(objective, tasks) {
  const runId = `run-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  const list = Array.isArray(tasks) && tasks.length
    ? tasks
    : [
        {
          id: "t1",
          subject: objective,
          description: "TODO: expand into concrete sub-tasks and assign each a capability.",
          role: "builder",
          capability: "code_gen",
          blockedBy: [],
          evidence: { files: [], commands: [] },
          writes: [],
          meta: { remote: true },
        },
      ];
  return { run_id: runId, objective, meta: { remote: true }, tasks: list };
}

/* ------------------------------------------------------------------ auth + http */

function tokenFrom(req, url) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return req.headers["x-api-key"] || url.searchParams.get("key") || "";
}

function authorized(req, url) {
  if (!SERVICE_API_KEY) return ALLOW_UNAUTHENTICATED;
  const token = Buffer.from(tokenFrom(req, url));
  const expected = Buffer.from(SERVICE_API_KEY);
  return token.length === expected.length && crypto.timingSafeEqual(token, expected);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, Object.assign({ "content-type": "application/json", "access-control-allow-origin": "*" }, headers));
  res.end(payload);
}

function readBody(req, limit = 1_048_576) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleRpc(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (err) {
    return send(res, 400, { error: `invalid JSON: ${err.message}` });
  }
  const isRpc = typeof body.method === "string";
  const method = isRpc ? body.method : "decompose";
  const params = isRpc ? body.params || {} : body;
  const respond = (status, payload) =>
    isRpc ? send(res, status, Object.assign({ jsonrpc: "2.0", id: body.id !== undefined ? body.id : null }, payload)) : send(res, status, payload);

  if (method !== "decompose") {
    return respond(200, { error: { code: -32601, message: `method not found: ${method}` } });
  }
  const objective = typeof params.objective === "string" ? params.objective.trim() : "";
  if (!objective) {
    return respond(400, { error: { code: -32602, message: "objective is required" } });
  }
  const dag = decompose(objective, params.tasks);
  return respond(200, { result: dag });
}

async function proxy(req, res, base, prefix) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const target = base + (url.pathname.slice(prefix.length) || "/") + url.search;
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers["content-length"];
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, signal: AbortSignal.timeout(120000) });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(buffer);
  } catch (err) {
    send(res, 502, { error: `proxy to ${target} failed: ${err.message}` });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    return send(res, 204, "", {
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-api-key",
    });
  }

  if (req.method === "GET" && route === "/health") {
    return send(res, 200, {
      ok: true,
      service: "mukti-taskplan-planner",
      version: "3.0.0",
      uptime_s: Math.round(process.uptime()),
      services: serviceState,
    });
  }

  if (req.method === "GET" && route === "/.well-known/agent.json") {
    return send(res, 200, plannerCard());
  }

  if (req.method === "GET" && route === "/") {
    return send(res, 200, {
      service: "mukti-taskplan-planner",
      endpoints: ["/health", "/.well-known/agent.json", "/rpc", "/a2a/*"],
      auth: SERVICE_API_KEY ? "Bearer SERVICE_API_KEY" : ALLOW_UNAUTHENTICATED ? "disabled" : "not configured",
    });
  }

  if (!authorized(req, url)) {
    const status = SERVICE_API_KEY ? 401 : 503;
    return send(res, status, {
      error: SERVICE_API_KEY ? "unauthorized" : "SERVICE_API_KEY is not configured (set it or ALLOW_UNAUTHENTICATED=true)",
    });
  }

  if (req.method === "POST" && route === "/rpc") {
    return handleRpc(req, res);
  }

  if (route === "/a2a" || route.startsWith("/a2a/")) {
    return proxy(req, res, `http://127.0.0.1:${A2A_PORT}`, "/a2a");
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `mukti-taskplan planner A2A service listening on http://${HOST}:${PORT}\n` +
      `  data=${DATA_DIR}  logs=${LOG_DIR}  reports=${REPORTS_DIR}\n` +
      `  registry=${serviceState.registry} :${A2A_PORT}\n` +
      `  auth=${SERVICE_API_KEY ? "api-key" : ALLOW_UNAUTHENTICATED ? "disabled" : "unconfigured"}\n`
  );
});

function shutdown() {
  process.stdout.write("[gateway] shutting down\n");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

#!/usr/bin/env node
/**
 * A2A registry — JSON-RPC 2.0 over HTTP on port 8788 (spec: protocols/a2a.md).
 *
 *   GET  /.well-known/agent.json         registry card
 *   GET  /.well-known/agents/<name>.json registered agent card
 *   GET  /health                         liveness
 *   GET  /stream                         SSE job events
 *   POST /rpc                            JSON-RPC 2.0
 *
 * RPC: registry.register|unregister|list|discover, task.dispatch|status|cancel|result
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sign, signed, verify } = require("./crypto-sign.js");
const { decode } = require("../protocols/aacp-encoder.js");

const PORT = Number(process.env.A2A_REGISTRY_PORT || 8788);
const HOST = process.env.A2A_HOST || "127.0.0.1";
const LOG_DIR = path.resolve(process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
const STATE_FILE = process.env.A2A_STATE_FILE || path.join(LOG_DIR, "a2a-agents.json");
const REQUIRE_SIGNATURES = String(process.env.A2A_REQUIRE_SIGNATURES || "false") === "true";
const WHITELIST = (process.env.A2A_CAPABILITY_WHITELIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REGISTRY_DID = "did:local:a2a-registry";

const agents = new Map();
const jobs = new Map();
const sseClients = new Set();

function log(record) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, "a2a.log"),
      JSON.stringify(Object.assign({ ts: new Date().toISOString(), registry: PORT }, record)) + "\n",
      "utf8"
    );
  } catch {
    /* logging must never crash the registry */
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const cards = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const card of cards) if (card && card.did) agents.set(card.did, card);
  } catch {
    /* ignore corrupt state */
  }
}

function saveState() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify([...agents.values()], null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function registryCard() {
  return signed({
    did: REGISTRY_DID,
    name: "a2a-registry",
    capabilities: ["registry", "capability_discovery", "task_routing"],
    endpoints: {
      rpc: `http://${HOST}:${PORT}/rpc`,
      stream: `http://${HOST}:${PORT}/stream`,
    },
    limits: { max_rps: 50, timeout_ms: 60000 },
    trust: 1.0,
  });
}

function assertCard(card) {
  if (!card || typeof card !== "object") throw new Error("card must be an object");
  for (const field of ["did", "name"]) if (!card[field]) throw new Error(`card.${field} is required`);
  if (!Array.isArray(card.capabilities)) throw new Error("card.capabilities must be an array");
  if (!card.endpoints || !card.endpoints.rpc) throw new Error("card.endpoints.rpc is required");
  if (REQUIRE_SIGNATURES && !verify(card, card.sig)) throw new Error("card signature missing or invalid");
  if (WHITELIST.length) {
    const bad = card.capabilities.filter((c) => !WHITELIST.includes(c));
    if (bad.length) throw new Error(`capabilities not whitelisted: ${bad.join(", ")}`);
  }
}

function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function rpc(method, params = {}) {
  switch (method) {
    case "registry.register": {
      const card = params.card;
      assertCard(card);
      agents.set(card.did, card);
      saveState();
      log({ dir: "registry.register", did: card.did, capabilities: card.capabilities });
      broadcast("agent.registered", card);
      return card;
    }
    case "registry.unregister": {
      const ok = agents.delete(params.did);
      saveState();
      log({ dir: "registry.unregister", did: params.did, ok });
      broadcast("agent.unregistered", { did: params.did });
      return ok;
    }
    case "registry.list":
      return [...agents.values()];
    case "registry.discover": {
      if (!params.capability) throw rpcError(-32602, "capability is required");
      return [...agents.values()].filter((c) => c.capabilities.includes(params.capability));
    }
    case "task.dispatch": {
      const { target, packet, from } = params;
      if (!target) throw rpcError(-32602, "target is required");
      if (!packet) throw rpcError(-32602, "packet is required");
      const parsed = typeof packet === "string" ? decode(packet) : decode(JSON.stringify(packet));
      if (REQUIRE_SIGNATURES && !verify(parsed, parsed.sig)) throw rpcError(-32001, "packet signature missing or invalid");

      let endpoint = target;
      let agent = null;
      if (!/^https?:\/\//.test(target)) {
        agent = agents.get(target) || [...agents.values()].find((c) => c.name === target);
        if (!agent) throw rpcError(-32002, `target not registered: ${target}`);
        endpoint = agent.endpoints.rpc;
      }

      const id = `${parsed.task}-${crypto.randomBytes(4).toString("hex")}`;
      const job = { id, task: parsed.task, target, status: "running", started: Date.now() };
      jobs.set(id, job);
      log({ dir: "task.dispatch", id, task: parsed.task, target, from });
      broadcast("job.updated", { id, status: "running", task: parsed.task });

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method: "task.dispatch",
            params: { packet: parsed, from: from || REGISTRY_DID },
          }),
          signal: AbortSignal.timeout(60000),
        });
        const body = await res.json().catch(() => ({}));
        job.status = body.error ? "failed" : "completed";
        job.response = body.result !== undefined ? body.result : body.error;
      } catch (err) {
        job.status = "failed";
        job.response = { error: err.message };
      }
      job.finished = Date.now();
      log({ dir: "task.result", id, status: job.status, task: parsed.task });
      broadcast("job.updated", { id, status: job.status, task: parsed.task });
      return { job_id: id, status: job.status, result: job.response };
    }
    case "task.status": {
      const job = jobs.get(params.id);
      if (!job) throw rpcError(-32003, `unknown job: ${params.id}`);
      return { id: job.id, status: job.status, task: job.task, target: job.target };
    }
    case "task.result": {
      const job = jobs.get(params.id);
      if (!job) throw rpcError(-32003, `unknown job: ${params.id}`);
      return { id: job.id, status: job.status, result: job.response };
    }
    case "task.cancel": {
      const job = jobs.get(params.id);
      if (!job) throw rpcError(-32003, `unknown job: ${params.id}`);
      job.status = "cancelled";
      log({ dir: "task.cancel", id: job.id });
      broadcast("job.updated", { id: job.id, status: "cancelled" });
      return true;
    }
    default:
      throw rpcError(-32601, `method not found: ${method}`);
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ "content-type": "application/json", "access-control-allow-origin": "*" }, headers));
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_048_576) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    return send(res, 204, "", { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" });
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, port: PORT, agents: agents.size, jobs: jobs.size });
  }
  if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
    return send(res, 200, registryCard());
  }
  if (req.method === "GET" && url.pathname.startsWith("/.well-known/agents/")) {
    const name = decodeURIComponent(url.pathname.split("/").pop().replace(/\.json$/, ""));
    const card = [...agents.values()].find((c) => c.name === name || c.did === name);
    return card ? send(res, 200, card) : send(res, 404, { error: "agent not found" });
  }
  if (req.method === "GET" && url.pathname === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ registry: REGISTRY_DID })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/rpc") {
    let request;
    try {
      request = JSON.parse((await readBody(req)) || "{}");
    } catch (err) {
      return send(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } });
    }
    try {
      const result = await rpc(request.method, request.params || {});
      return send(res, 200, { jsonrpc: "2.0", id: request.id !== undefined ? request.id : null, result });
    } catch (err) {
      log({ dir: "rpc.error", method: request.method, error: err.message });
      return send(res, 200, {
        jsonrpc: "2.0",
        id: request.id !== undefined ? request.id : null,
        error: { code: err.code || -32603, message: err.message },
      });
    }
  }
  send(res, 404, { error: "not found" });
});

server.on("error", (err) => {
  process.stderr.write(`a2a-registry server error: ${err.message}\n`);
  log({ dir: "registry.error", error: err.message });
});

loadState();
server.listen(PORT, HOST, () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  process.stdout.write(`a2a-registry listening on http://${HOST}:${PORT} (agents: ${agents.size})\n`);
  log({ dir: "registry.start", port: PORT, agents: agents.size });
});

function shutdown() {
  log({ dir: "registry.stop", port: PORT });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

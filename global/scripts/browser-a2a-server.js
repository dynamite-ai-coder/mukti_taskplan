#!/usr/bin/env node
/**
 * Browser A2A server — wraps the `opencode-browser-control` MCP server in an
 * A2A JSON-RPC/SSE endpoint on port 8789 (spec: protocols/a2a.md).
 *
 *   GET  /.well-known/agent.json   Agent Card (signed)
 *   GET  /health                   liveness
 *   GET  /stream                   SSE job events
 *   POST /rpc                      JSON-RPC 2.0
 *
 * RPC: task.dispatch, task.status, task.cancel, task.result, tools.call, did.info
 * Replies to task.dispatch are AACP RESULT packets (protocols/aacp.md).
 *
 *   node browser-a2a-server.js [--port 8789] [--register-only]
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { sign, signed, verify } = require("./crypto-sign.js");
const { encode } = require("../protocols/aacp-encoder.js");

const PORT = Number(process.env.BROWSER_A2A_PORT || 8789);
const HOST = process.env.A2A_HOST || "127.0.0.1";
const LOG_DIR = path.resolve(process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
const ARTIFACT_DIR = path.resolve(process.env.BROWSER_ARTIFACT_DIR || path.join(process.cwd(), "artifacts/browser"));
const REQUIRE_SIGNATURES = String(process.env.A2A_REQUIRE_SIGNATURES || "false") === "true";
const MCP_COMMAND = process.env.BROWSER_MCP_CMD || "npx";
const MCP_ARGS = (process.env.BROWSER_MCP_ARGS || "-y opencode-browser-control").split(" ");
const MCP_TIMEOUT_MS = Number(process.env.BROWSER_MCP_TIMEOUT_MS || 90000);
const REGISTRY = process.env.A2A_REGISTRY_URL || "http://127.0.0.1:8788";
const DID = "did:local:browser-agent";

/**
 * Environment for the browser MCP child process.
 * Under root/container environments Chromium refuses to start without --no-sandbox,
 * so inject the flags through the Chromium launcher wrapper (CHROMIUM_USER_FLAGS).
 * Disable with BROWSER_NO_SANDBOX=false.
 */
function childEnv() {
  const env = Object.assign({}, process.env);
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const wantNoSandbox = process.env.BROWSER_NO_SANDBOX === "true" || (asRoot && process.env.BROWSER_NO_SANDBOX !== "false");
  if (wantNoSandbox && !env.CHROMIUM_USER_FLAGS) {
    env.CHROMIUM_USER_FLAGS = "--no-sandbox --disable-dev-shm-usage --disable-gpu";
  }
  return env;
}

const jobs = new Map();
const sseClients = new Set();

function log(record) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, "a2a.log"),
      JSON.stringify(Object.assign({ ts: new Date().toISOString(), server: "browser-agent" }, record)) + "\n",
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

function agentCard() {
  return signed({
    did: DID,
    name: "browser-agent",
    capabilities: ["web_navigate", "form_fill", "data_extract", "screenshot"],
    endpoints: {
      rpc: `http://${HOST}:${PORT}/rpc`,
      stream: `http://${HOST}:${PORT}/stream`,
    },
    limits: { max_rps: 5, timeout_ms: 60000 },
    trust: 0.95,
  });
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

/* ------------------------------------------------------------------ MCP client */

class McpClient {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.starting = null;
  }

  async start() {
    if (this.ready) return this;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
      this.child.stderr.on("data", (d) => process.stderr.write(`[browser-mcp] ${d}`));
      this.child.on("exit", () => {
        this.ready = false;
        this.child = null;
        for (const { reject } of this.pending.values()) reject(new Error("browser MCP exited"));
        this.pending.clear();
      });
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk) => this.onData(chunk));
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "browser-a2a-server", version: "2.0.0" },
      });
      this.notify("notifications/initialized", {});
      this.ready = true;
      return this;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    }
  }

  request(method, params, timeoutMs = MCP_TIMEOUT_MS) {
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.child.stdin.write(message + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser MCP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name, args) {
    await this.start();
    const result = await this.request("tools/call", { name, arguments: args || {} });
    const parts = (result && result.content) || [];
    const text = parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
    if (result && result.isError) throw new Error(text || "browser tool failed");
    return { text, raw: result };
  }

  async stop() {
    if (this.ready) {
      try {
        await this.request("tools/call", { name: "browser", arguments: { action: "stop" } }, 5000);
      } catch {
        /* best effort */
      }
    }
    if (this.child) this.child.kill();
  }
}

const mcp = new McpClient(MCP_COMMAND, MCP_ARGS);

/* ------------------------------------------------------------------ job runner */

function toolCallFor(action) {
  if (action.tool) return { tool: action.tool, args: action.args || {} };
  switch (action.action) {
    case "navigate":
      return { tool: "browser", args: { action: "navigate", url: action.url } };
    case "snapshot":
      return { tool: "browser_snapshot", args: {} };
    case "click":
      return { tool: "browser_click", args: { ref: action.ref } };
    case "type":
      return { tool: "browser_type", args: { ref: action.ref, text: action.text, submit: !!action.submit } };
    case "screenshot":
      return { tool: "browser", args: { action: "screenshot" } };
    case "evaluate":
      return { tool: "browser", args: { action: "evaluate", code: action.code } };
    case "start":
      return { tool: "browser", args: { action: "start", headed: !!action.headed } };
    case "stop":
      return { tool: "browser", args: { action: "stop" } };
    default:
      throw new Error(`unsupported browser action: ${action.action || "unknown"}`);
  }
}

function normalizeActions(params) {
  if (Array.isArray(params.actions) && params.actions.length) return params.actions;
  const refs = (params.packet && params.packet.ref) || [];
  const url = refs.find((r) => /^https?:\/\//.test(r));
  if (!url) throw new Error("task.dispatch requires params.actions or an http(s) URL in packet.ref");
  return [
    { action: "start", headed: !!params.headed },
    { action: "navigate", url },
    { action: "snapshot" },
  ];
}

async function runJob(job, params) {
  const evidence = [];
  const snapshotFiles = [];
  try {
    const browserStarted = Array.isArray(params.actions);
    if (!browserStarted) {
      await mcp.callTool("browser", { action: "start", headed: !!params.headed }).catch(() => {});
    }
    for (const action of normalizeActions(params)) {
      if (job.cancelled) throw new Error("cancelled");
      const { tool, args } = toolCallFor(action);
      job.step = action.action || tool;
      broadcast("job.updated", { id: job.id, status: "running", step: job.step });
      const result = await mcp.callTool(tool, args);
      evidence.push({ tool, action: action.action || tool, bytes: result.text.length });
      if (tool === "browser_snapshot" || action.action === "snapshot") {
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        const file = path.join(ARTIFACT_DIR, `snapshot-${job.id}.txt`);
        fs.writeFileSync(file, result.text, "utf8");
        snapshotFiles.push(file);
      }
    }
    const packet = JSON.parse(
      encode(job.task, "RESULT", {
        role: "browser",
        dom: "web",
        ref: snapshotFiles.length ? snapshotFiles : [`http://${HOST}:${PORT}/rpc`],
        ret: ["snapshot"],
        meta: { run: job.run, job: job.id, steps: evidence.length },
      })
    );
    job.status = "completed";
    job.result = signed({ packet, steps: evidence, job_id: job.id });
    const line = JSON.stringify(packet);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, "aacp.log"), line + "\n", "utf8");
  } catch (err) {
    job.status = job.cancelled ? "cancelled" : "failed";
    job.result = signed({
      packet: JSON.parse(encode(job.task, "FAIL", { role: "browser", dom: "web", meta: { reason: err.message, job: job.id } })),
      error: err.message,
    });
  }
  job.finished = Date.now();
  log({ dir: "task.result", id: job.id, status: job.status, task: job.task });
  broadcast("job.updated", { id: job.id, status: job.status, task: job.task });
}

/* ------------------------------------------------------------------ JSON-RPC */

async function rpc(method, params = {}) {
  switch (method) {
    case "did.info":
      return agentCard();
    case "task.dispatch": {
      const packet = params.packet;
      if (!packet) throw new Error("packet is required");
      if (REQUIRE_SIGNATURES && !verify(packet, packet.sig)) throw new Error("packet signature missing or invalid");
      const id = `${packet.task || "task"}-${crypto.randomBytes(4).toString("hex")}`;
      const job = {
        id,
        task: packet.task || "task",
        run: (packet.meta && packet.meta.run) || null,
        status: "accepted",
        started: Date.now(),
        cancelled: false,
      };
      jobs.set(id, job);
      log({ dir: "task.dispatch", id, task: job.task, from: params.from });
      broadcast("job.updated", { id, status: "accepted", task: job.task });
      runJob(job, params);
      return { job_id: id, status: job.status };
    }
    case "task.status": {
      const job = jobs.get(params.id);
      if (!job) throw new Error(`unknown job: ${params.id}`);
      return { id: job.id, status: job.status, task: job.task, step: job.step || null };
    }
    case "task.result": {
      const job = jobs.get(params.id);
      if (!job) throw new Error(`unknown job: ${params.id}`);
      return { id: job.id, status: job.status, result: job.result || null };
    }
    case "task.cancel": {
      const job = jobs.get(params.id);
      if (!job) throw new Error(`unknown job: ${params.id}`);
      job.cancelled = true;
      if (job.status === "accepted") job.status = "cancelled";
      return true;
    }
    case "tools.call": {
      if (!params.tool) throw new Error("tool is required");
      const result = await mcp.callTool(params.tool, params.args || {});
      return { text: result.text };
    }
    default:
      throw new Error(`method not found: ${method}`);
  }
}

/* ------------------------------------------------------------------ HTTP */

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
      if (data.length > 1_048_576) reject(new Error("payload too large"));
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
    return send(res, 200, { ok: true, port: PORT, did: DID, jobs: jobs.size, mcp_ready: mcp.ready });
  }
  if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
    return send(res, 200, agentCard());
  }
  if (req.method === "GET" && url.pathname === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ did: DID })}\n\n`);
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
        error: { code: -32603, message: err.message },
      });
    }
  }
  send(res, 404, { error: "not found" });
});

async function registerCard() {
  try {
    const res = await fetch(`${REGISTRY}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "registry.register",
        params: { card: agentCard() },
      }),
      signal: AbortSignal.timeout(4000),
    });
    return (await res.json()).result;
  } catch (err) {
    throw new Error(`registry unavailable at ${REGISTRY}: ${err.message}`);
  }
}

const args = process.argv.slice(2);
if (args.includes("--register-only")) {
  registerCard()
    .then((card) => {
      process.stdout.write(`registered ${card.name} (${card.did})\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(err.message + "\n");
      process.exit(1);
    });
} else {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`browser-a2a-server listening on http://${HOST}:${PORT} (${DID})\n`);
    log({ dir: "browser.start", port: PORT });
    registerCard().then(
      (card) => log({ dir: "browser.registered", did: card.did }),
      (err) => log({ dir: "browser.register_failed", error: err.message })
    );
  });
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ dir: "browser.stop", port: PORT });
    await mcp.stop().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

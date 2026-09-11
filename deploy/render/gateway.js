#!/usr/bin/env node
/**
 * Render gateway — single web service entrypoint for the multi-agent system.
 *
 * Runs in one process:
 *   - A2A registry               (in-process,   127.0.0.1:8788)
 *   - Browser A2A server         (in-process,   127.0.0.1:8789)
 *   - OpenCode headless server   (child,        127.0.0.1:4096, optional)
 * and exposes a public HTTP API on 0.0.0.0:$PORT (Render injects PORT):
 *
 *   GET  /health                       public liveness
 *   GET  /.well-known/agent.json       public gateway Agent Card
 *   POST /swarm                        run a task DAG / objective (auth)
 *   GET  /jobs, /jobs/:id, /jobs/:id/log, /jobs/:id/summary   (auth)
 *   DELETE /jobs/:id                   cancel a run (auth)
 *   GET  /stream                       SSE job events (auth via ?key=)
 *   ALL  /a2a/*                        proxy -> A2A registry (auth)
 *   ALL  /browser/*                    proxy -> browser agent (auth)
 *   ALL  /opencode/*                   proxy -> OpenCode server (auth)
 *
 * Auth: Authorization: Bearer $SERVICE_API_KEY (or x-api-key / ?key=).
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const LOG_DIR = path.resolve(process.env.AACP_LOG_DIR || path.join(DATA_DIR, "logs"));
const REPORTS_DIR = path.resolve(process.env.REPORTS_DIR || path.join(DATA_DIR, "reports"));
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(DATA_DIR, "workspace"));
const GLOBAL_DIR = process.env.OPENCODE_GLOBAL_DIR || path.join(os.homedir(), ".config", "opencode");
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "true";
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const OPENCODE_SERVE_PORT = Number(process.env.OPENCODE_SERVE_PORT || 4096);
const OPENCODE_SERVE_ENABLED = process.env.OPENCODE_SERVE_ENABLED !== "false";
const A2A_PORT = Number(process.env.A2A_REGISTRY_PORT || 8788);
const BROWSER_PORT = Number(process.env.BROWSER_A2A_PORT || 8789);
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 600000);
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

process.env.A2A_HOST = process.env.A2A_HOST || "127.0.0.1";
process.env.AACP_LOG_DIR = LOG_DIR;
process.env.REPORTS_DIR = REPORTS_DIR;

for (const dir of [DATA_DIR, LOG_DIR, REPORTS_DIR, WORKSPACE]) fs.mkdirSync(dir, { recursive: true });

const { signed } = require(path.join(GLOBAL_DIR, "scripts", "crypto-sign.js"));

/* ------------------------------------------------------------------ side services */

const serviceState = { registry: "starting", browser: "starting", opencode_serve: OPENCODE_SERVE_ENABLED ? "starting" : "disabled" };

try {
  require(path.join(GLOBAL_DIR, "scripts", "a2a-registry.js"));
  serviceState.registry = "running";
} catch (err) {
  serviceState.registry = `error: ${err.message}`;
  process.stderr.write(`[gateway] a2a-registry failed: ${err.message}\n`);
}

try {
  require(path.join(GLOBAL_DIR, "scripts", "browser-a2a-server.js"));
  serviceState.browser = "running";
} catch (err) {
  serviceState.browser = `error: ${err.message}`;
  process.stderr.write(`[gateway] browser-a2a-server failed: ${err.message}\n`);
}

let opencodeServe = null;
const shuttingDown = { value: false };

function startOpencodeServe() {
  if (!OPENCODE_SERVE_ENABLED || shuttingDown.value) return;
  opencodeServe = spawn(OPENCODE_BIN, ["serve", "--port", String(OPENCODE_SERVE_PORT), "--hostname", "127.0.0.1"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  opencodeServe.stdout.on("data", (d) => process.stdout.write(`[opencode-serve] ${d}`));
  opencodeServe.stderr.on("data", (d) => process.stderr.write(`[opencode-serve] ${d}`));
  opencodeServe.on("exit", (code) => {
    serviceState.opencode_serve = `exited(${code})`;
    opencodeServe = null;
    if (!shuttingDown.value) setTimeout(startOpencodeServe, 2500);
  });
  serviceState.opencode_serve = "running";
}
startOpencodeServe();

// Re-register the browser card once the in-process registry is listening.
async function registerBrowserCard(attempt = 1) {
  if (shuttingDown.value) return;
  try {
    const card = await fetch(`http://127.0.0.1:${BROWSER_PORT}/.well-known/agent.json`).then((r) => r.json());
    const body = await fetch(`http://127.0.0.1:${A2A_PORT}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "gateway-register", method: "registry.register", params: { card } }),
    }).then((r) => r.json());
    if (body.error) throw new Error(body.error.message);
    process.stdout.write(`[gateway] browser-agent registered as ${card.did}\n`);
  } catch (err) {
    if (attempt >= 10) {
      process.stderr.write(`[gateway] browser card registration failed: ${err.message}\n`);
      return;
    }
    setTimeout(() => registerBrowserCard(attempt + 1), 500 * attempt);
  }
}
setTimeout(() => registerBrowserCard(), 1000);

/* ------------------------------------------------------------------ jobs */

const jobs = new Map();
const queue = [];
const sseClients = new Set();
let running = 0;
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    for (const job of JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"))) {
      if (job.status === "running" || job.status === "queued") job.status = "interrupted";
      jobs.set(job.id, job);
    }
  } catch {
    /* ignore corrupt state */
  }
}

function saveJobs() {
  try {
    const plain = [...jobs.values()].map((j) => publicJob(j)).slice(-200);
    fs.writeFileSync(JOBS_FILE, JSON.stringify(plain, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function publicJob(job) {
  return {
    id: job.id,
    run_id: job.run_id,
    objective: job.objective,
    status: job.status,
    created: job.created,
    started: job.started,
    finished: job.finished,
    exit_code: job.exit_code,
    summary: job.summary || null,
  };
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

function createJob(body) {
  if (!body || (!body.tasks && !body.objective)) throw new Error("body must contain tasks[] or objective");
  const runId = body.run_id || `run-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  const objective = body.objective || "Execute the supplied task DAG";
  const dag = body.tasks
    ? Object.assign({}, body, { run_id: runId, objective })
    : { run_id: runId, objective, tasks: [] };
  const dagPath = path.join(WORKSPACE, "task-dag.json");
  fs.writeFileSync(dagPath, JSON.stringify(dag, null, 2), "utf8");
  const job = {
    id: `job-${crypto.randomBytes(4).toString("hex")}`,
    run_id: runId,
    objective,
    dag_path: dagPath,
    status: "queued",
    created: Date.now(),
    logFile: path.join(LOG_DIR, `run-${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`),
  };
  jobs.set(job.id, job);
  queue.push(job);
  saveJobs();
  broadcast("job.updated", publicJob(job));
  pumpQueue();
  return job;
}

function pumpQueue() {
  while (running < MAX_CONCURRENT_JOBS && queue.length) {
    startJob(queue.shift());
  }
}

function startJob(job) {
  running += 1;
  job.status = "running";
  job.started = Date.now();
  broadcast("job.updated", publicJob(job));
  fs.writeFileSync(job.logFile, "", "utf8");

  const prompt =
    `@planner Execute the task DAG at ${job.dag_path}. run_id=${job.run_id}. ` +
    `Emit one AACP DISPATCH per task and dispatch ready tasks to builder-1/builder-2/builder-3/browser. ` +
    `Route browser work through the A2A registry. Objective: ${job.objective}`;
  const env = Object.assign({}, process.env, { AACP_RUN_ID: job.run_id, AACP_LOG_DIR: LOG_DIR, REPORTS_DIR });
  const child = spawn(OPENCODE_BIN, ["run", "--agent", "planner", prompt], { cwd: WORKSPACE, env });
  job.child = child;

  const extractor = spawn(process.execPath, [path.join(GLOBAL_DIR, "scripts", "extract-packets.js"), "--dir", LOG_DIR], {
    stdio: ["pipe", "ignore", "inherit"],
  });

  const writeLog = (chunk) => {
    const text = String(chunk);
    try {
      fs.appendFileSync(job.logFile, text);
    } catch {
      /* ignore */
    }
    for (const line of text.split("\n")) {
      if (line.trim()) broadcast("job.log", { job_id: job.id, line: line.slice(0, 2000) });
    }
  };

  child.stdout.on("data", (chunk) => {
    writeLog(chunk);
    try {
      extractor.stdin.write(chunk);
    } catch {
      /* extractor closed */
    }
  });
  child.stderr.on("data", writeLog);
  child.on("error", (err) => {
    writeLog(`[gateway] planner spawn error: ${err.message}\n`);
    finalize(job, 1);
  });

  job.timer = setTimeout(() => {
    job.status = "timeout";
    writeLog(`[gateway] job exceeded JOB_TIMEOUT_MS=${JOB_TIMEOUT_MS}; terminating\n`);
    child.kill("SIGTERM");
  }, JOB_TIMEOUT_MS);

  child.on("close", (code) => {
    try {
      extractor.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => finalize(job, code), 250);
  });

  broadcast("job.updated", publicJob(job));
}

function finalize(job, code) {
  if (job.finished) return;
  clearTimeout(job.timer);
  job.finished = Date.now();
  job.exit_code = code;
  if (job.status !== "timeout") job.status = code === 0 ? "completed" : "failed";
  const report = path.join(REPORTS_DIR, `budget-${job.run_id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  if (fs.existsSync(report)) {
    try {
      job.summary = JSON.parse(fs.readFileSync(report, "utf8"));
    } catch {
      /* ignore */
    }
  }
  delete job.child;
  saveJobs();
  broadcast("job.finished", publicJob(job));
  running = Math.max(0, running - 1);
  pumpQueue();
}

function cancelJob(job) {
  if (job.finished) return false;
  if (job.child) job.child.kill("SIGTERM");
  job.status = "cancelled";
  setTimeout(() => finalize(job, 143), 300);
  return true;
}

/* ------------------------------------------------------------------ gateway card */

function gatewayCard() {
  return signed({
    did: "did:local:mukti-taskplan",
    name: "mukti-taskplan",
    capabilities: ["swarm_orchestration", "task_dag", "browser_automation", "a2a_registry"],
    endpoints: { rpc: `${PUBLIC_URL}/a2a/rpc`, stream: `${PUBLIC_URL}/stream` },
    limits: { max_rps: 5, timeout_ms: JOB_TIMEOUT_MS },
    trust: 0.98,
  });
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

function readBody(req, limit = 2_097_152) {
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

async function listAgents() {
  try {
    const res = await fetch(`http://127.0.0.1:${A2A_PORT}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "list", method: "registry.list", params: {} }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    return body.result || [];
  } catch {
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    return send(res, 204, "", { "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-api-key" });
  }

  if (req.method === "GET" && route === "/health") {
    return send(res, 200, {
      ok: true,
      service: "mukti-taskplan",
      version: "2.0.0",
      uptime_s: Math.round(process.uptime()),
      services: serviceState,
      jobs: { total: jobs.size, running, queued: queue.length },
    });
  }

  if (req.method === "GET" && route === "/.well-known/agent.json") {
    return send(res, 200, gatewayCard());
  }

  if (req.method === "GET" && route === "/") {
    return send(res, 200, {
      service: "mukti-taskplan",
      docs: "https://github.com/dynamite-ai-coder/mukti_taskplan",
      endpoints: ["/health", "/.well-known/agent.json", "/swarm", "/jobs", "/stream", "/a2a/*", "/browser/*", "/opencode/*"],
      auth: SERVICE_API_KEY ? "Bearer SERVICE_API_KEY" : ALLOW_UNAUTHENTICATED ? "disabled" : "not configured",
    });
  }

  if (!authorized(req, url)) {
    const status = SERVICE_API_KEY ? 401 : 503;
    return send(res, status, {
      error: SERVICE_API_KEY ? "unauthorized" : "SERVICE_API_KEY is not configured (set it or ALLOW_UNAUTHENTICATED=true)",
    });
  }

  if (req.method === "GET" && route === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ service: "mukti-taskplan", jobs: jobs.size })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && route === "/agents") {
    return send(res, 200, { agents: await listAgents() });
  }

  if (req.method === "POST" && route === "/swarm") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const job = createJob(body);
      return send(res, 202, publicJob(job));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (req.method === "GET" && route === "/jobs") {
    return send(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse() });
  }

  const jobMatch = route.match(/^\/jobs\/([^/]+)(\/log|\/summary)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return send(res, 404, { error: "unknown job" });
    if (req.method === "DELETE" && !jobMatch[2]) {
      cancelJob(job);
      return send(res, 200, { cancelled: true, job: publicJob(job) });
    }
    if (req.method === "GET" && jobMatch[2] === "/log") {
      const tail = Number(url.searchParams.get("tail") || 200);
      const lines = fs.existsSync(job.logFile) ? fs.readFileSync(job.logFile, "utf8").split("\n").filter(Boolean) : [];
      return send(res, 200, { job_id: job.id, lines: lines.slice(-tail) });
    }
    if (req.method === "GET" && jobMatch[2] === "/summary") {
      return job.summary ? send(res, 200, job.summary) : send(res, 404, { error: "no summary yet" });
    }
    if (req.method === "GET") return send(res, 200, publicJob(job));
  }

  if (route.startsWith("/a2a/") || route === "/a2a") {
    return proxy(req, res, `http://127.0.0.1:${A2A_PORT}`, "/a2a");
  }
  if (route.startsWith("/browser/") || route === "/browser") {
    return proxy(req, res, `http://127.0.0.1:${BROWSER_PORT}`, "/browser");
  }
  if (route.startsWith("/opencode/") || route === "/opencode") {
    return proxy(req, res, `http://127.0.0.1:${OPENCODE_SERVE_PORT}`, "/opencode");
  }

  send(res, 404, { error: "not found" });
});

loadJobs();
server.listen(PORT, HOST, () => {
  process.stdout.write(
    `mukti-taskplan gateway listening on http://${HOST}:${PORT}\n` +
      `  data=${DATA_DIR}  logs=${LOG_DIR}  reports=${REPORTS_DIR}\n` +
      `  auth=${SERVICE_API_KEY ? "api-key" : ALLOW_UNAUTHENTICATED ? "disabled" : "unconfigured"}\n`
  );
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
function shutdown() {
  if (shuttingDown.value) return;
  shuttingDown.value = true;
  process.stdout.write("[gateway] shutting down\n");
  for (const job of jobs.values()) if (job.child) job.child.kill("SIGTERM");
  if (opencodeServe) opencodeServe.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

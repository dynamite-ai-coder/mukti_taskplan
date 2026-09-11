#!/usr/bin/env node
/**
 * a2a-registry MCP front — capability discovery + task routing (protocols/a2a.md).
 * Auto-starts the HTTP registry (scripts/a2a-registry.js) when it is not running.
 *
 * Tools: a2a_register, a2a_unregister, a2a_list, a2a_discover, a2a_dispatch
 */
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { serveMcp } = require("./mcp-stdio.js");

const PORT = Number(process.env.A2A_REGISTRY_PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const REGISTRY_SCRIPT = path.join(__dirname, "a2a-registry.js");

async function health(timeoutMs = 700) {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureRegistry() {
  if (await health()) return;
  const child = spawn(process.execPath, [REGISTRY_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await health()) return;
  }
  throw new Error("a2a-registry did not start on port " + PORT);
}

async function rpc(method, params = {}) {
  await ensureRegistry();
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(65000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const tools = {
  a2a_register: {
    description: "Register an Agent Card with the local A2A registry (localhost:" + PORT + ").",
    inputSchema: {
      type: "object",
      required: ["card"],
      properties: {
        card: {
          type: "object",
          required: ["did", "name", "capabilities", "endpoints"],
          properties: {
            did: { type: "string" },
            name: { type: "string" },
            capabilities: { type: "array", items: { type: "string" } },
            endpoints: {
              type: "object",
              required: ["rpc"],
              properties: { rpc: { type: "string" }, stream: { type: "string" } },
            },
            limits: { type: "object" },
            trust: { type: "number" },
          },
        },
      },
    },
    handler: (args) => rpc("registry.register", { card: args.card }),
  },

  a2a_unregister: {
    description: "Remove an agent from the A2A registry by DID.",
    inputSchema: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    handler: (args) => rpc("registry.unregister", { did: args.did }),
  },

  a2a_list: {
    description: "List all registered remote agents.",
    inputSchema: { type: "object", properties: {} },
    handler: () => rpc("registry.list", {}),
  },

  a2a_discover: {
    description: "Find registered agents that provide a capability (e.g. web_navigate).",
    inputSchema: { type: "object", required: ["capability"], properties: { capability: { type: "string" } } },
    handler: (args) => rpc("registry.discover", { capability: args.capability }),
  },

  a2a_dispatch: {
    description: "Route an AACP DISPATCH packet to a registered agent via the A2A registry.",
    inputSchema: {
      type: "object",
      required: ["target", "packet"],
      properties: {
        target: { type: "string", description: "agent name, DID, or http(s) RPC endpoint" },
        packet: { type: "object", description: "AACP v1 packet" },
        from: { type: "string", description: "sender DID" },
      },
    },
    handler: (args) => rpc("task.dispatch", { target: args.target, packet: args.packet, from: args.from }),
  },
};

serveMcp({ name: "a2a-registry", version: "2.0.0", tools });

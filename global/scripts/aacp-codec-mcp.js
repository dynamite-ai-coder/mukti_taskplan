#!/usr/bin/env node
/**
 * aacp-codec MCP server — encode/decode AACP packets and write ACCP snapshots.
 * Tools: aacp_encode, aacp_decode, aacp_log, accp_snapshot, accp_read, aacp_tail
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serveMcp } = require("./mcp-stdio.js");
const { encode, decode, encodeAccp } = require("../protocols/aacp-encoder.js");

function logDir() {
  return path.resolve(process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
}

function append(file, line) {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  fs.appendFileSync(target, line.replace(/\n+$/, "") + "\n", "utf8");
  return target;
}

function packetPayload(args) {
  const { task, op, role, dom, ref, ret, meta } = args;
  return { task, op, role, dom, ref, ret, meta };
}

const tools = {
  aacp_encode: {
    description: "Encode an AACP v1 packet (compact one-line JSON).",
    inputSchema: {
      type: "object",
      required: ["task", "op"],
      properties: {
        task: { type: "string", description: "task ID from task-dag.json" },
        op: { type: "string", enum: ["DISPATCH", "RESULT", "QUERY", "ACK", "FAIL"] },
        role: { type: "string", enum: ["planner", "builder", "browser", "reviewer", "integrator"] },
        dom: { type: "string", enum: ["code", "web", "fs", "test", "research"] },
        ref: { type: "array", items: { type: "string" } },
        ret: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
      },
    },
    handler(args) {
      return encode(args.task, args.op, args);
    },
  },

  aacp_decode: {
    description: "Decode and validate an AACP packet string.",
    inputSchema: {
      type: "object",
      required: ["packet"],
      properties: { packet: { type: "string" } },
    },
    handler(args) {
      return JSON.stringify(decode(args.packet), null, 2);
    },
  },

  aacp_log: {
    description: "Encode an AACP packet and append it to logs/aacp.log.",
    inputSchema: {
      type: "object",
      required: ["task", "op"],
      properties: {
        task: { type: "string" },
        op: { type: "string", enum: ["DISPATCH", "RESULT", "QUERY", "ACK", "FAIL"] },
        role: { type: "string" },
        dom: { type: "string" },
        ref: { type: "array", items: { type: "string" } },
        ret: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
        run: { type: "string", description: "run_id stored in meta.run" },
      },
    },
    handler(args) {
      const packet = decode(encode(args.task, args.op, args));
      if (args.run) packet.meta = Object.assign({}, packet.meta, { run: args.run });
      packet.meta = Object.assign({}, packet.meta, { ts: Date.now() });
      const line = JSON.stringify(packet);
      const file = append("aacp.log", line);
      return `${line}\nlogged -> ${file}`;
    },
  },

  accp_snapshot: {
    description: "Build an ACCP v1 snapshot and optionally append it to logs/accp.jsonl.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
        cursor: { type: "string", description: "last completed task ID" },
        facts: { type: "array", items: { type: "object", properties: { k: { type: "string" }, v: {} } } },
        intent: { type: "string", enum: ["code_gen", "refactor", "test", "research"] },
        delta: { type: "array", items: { type: "string" } },
        write: { type: "boolean", description: "append to logs/accp.jsonl (default true)" },
      },
    },
    handler(args) {
      const snapshot = encodeAccp(args);
      const line = JSON.stringify(snapshot);
      let suffix = "";
      if (args.write !== false) suffix = `\nlogged -> ${append("accp.jsonl", line)}`;
      return line + suffix;
    },
  },

  accp_read: {
    description: "Read the newest ACCP snapshots for a run_id from logs/accp.jsonl.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: { run_id: { type: "string" }, n: { type: "number", description: "max snapshots (default 5)" } },
    },
    handler(args) {
      const file = path.join(logDir(), "accp.jsonl");
      if (!fs.existsSync(file)) return "[]";
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const snapshots = [];
      for (const line of lines) {
        try {
          const snap = JSON.parse(line);
          if (snap.run_id === args.run_id) snapshots.push(snap);
        } catch {
          /* skip malformed */
        }
      }
      return JSON.stringify(snapshots.slice(-(args.n || 5)), null, 2);
    },
  },

  aacp_tail: {
    description: "Tail logs/aacp.log (newest n packets).",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    handler(args) {
      const file = path.join(logDir(), "aacp.log");
      if (!fs.existsSync(file)) return "";
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      return lines.slice(-(args.n || 20)).join("\n");
    },
  },
};

serveMcp({ name: "aacp-codec", version: "2.0.0", tools });

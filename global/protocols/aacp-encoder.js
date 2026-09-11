#!/usr/bin/env node
/**
 * AACP v1 encoder/decoder — zero dependencies, CommonJS.
 * Spec: protocols/aacp.md
 *
 *   const { encode, decode, hash } = require("./aacp-encoder.js")
 *   encode("t1", "DISPATCH", { role: "builder-1", dom: "code", ref: ["task-dag.json"] })
 */
"use strict";

const crypto = require("node:crypto");

const OPS = ["DISPATCH", "RESULT", "QUERY", "ACK", "FAIL"];
const ROLES = ["planner", "builder", "browser", "reviewer", "integrator"];
const DOMAINS = ["code", "web", "fs", "test", "research"];
const CORE_FIELDS = ["v", "op", "task", "role", "dom", "ref", "ret", "meta"];

function isValidRole(role) {
  return ROLES.includes(role) || /^builder-\d+$/.test(role);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}

function hash(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

function asArray(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Build a compact AACP packet.
 * @param {string} taskId  task ID from task-dag.json
 * @param {string} op      DISPATCH|RESULT|QUERY|ACK|FAIL
 * @param {object} payload { role, dom, ref, ret, meta, sig }
 * @returns {string} one-line JSON packet
 */
function encode(taskId, op, payload = {}) {
  if (!taskId) throw new Error("AACP: taskId is required");
  if (!op) throw new Error("AACP: op is required");
  const verb = String(op).toUpperCase();
  if (!OPS.includes(verb)) throw new Error(`AACP: unknown op "${op}" (expected ${OPS.join("|")})`);

  const role = payload.role;
  if (role !== undefined && !isValidRole(role)) {
    throw new Error(`AACP: unknown role "${role}" (expected ${ROLES.join("|")} or builder-N)`);
  }
  const dom = payload.dom;
  if (dom !== undefined && !DOMAINS.includes(dom)) {
    throw new Error(`AACP: unknown dom "${dom}" (expected ${DOMAINS.join("|")})`);
  }

  const packet = { v: 1, op: verb, task: String(taskId) };
  if (role) packet.role = role;
  if (dom) packet.dom = dom;
  const ref = asArray(payload.ref);
  if (ref) packet.ref = ref;
  const ret = asArray(payload.ret);
  if (ret) packet.ret = ret;
  const meta = Object.assign({}, payload.meta);
  if (verb === "FAIL" && meta.reason === undefined) meta.reason = "unspecified";
  packet.meta = meta;
  packet.meta.hash = payload.hash || hash(packet);
  if (payload.sig) packet.sig = payload.sig;
  return JSON.stringify(packet);
}

/**
 * Parse and minimally validate an AACP packet (string or object).
 * @returns {object} structured packet
 */
function decode(packetString) {
  let packet = packetString;
  if (typeof packetString === "string") {
    const line = packetString.trim();
    if (!line) throw new Error("AACP: empty packet");
    try {
      packet = JSON.parse(line);
    } catch (err) {
      throw new Error(`AACP: invalid JSON — ${err.message}`);
    }
  }
  if (!packet || typeof packet !== "object") throw new Error("AACP: packet must be an object");
  if (packet.v !== 1) throw new Error(`AACP: unsupported version "${packet.v}"`);
  if (!OPS.includes(packet.op)) throw new Error(`AACP: unknown op "${packet.op}"`);
  if (!packet.task) throw new Error("AACP: missing task ID");
  return packet;
}

/** Strip transport-only fields and return the hashable core. */
function core(packet) {
  const out = {};
  for (const key of CORE_FIELDS) if (packet[key] !== undefined) out[key] = packet[key];
  return out;
}

/**
 * Build an ACCP v1 context snapshot (spec: protocols/accp.md).
 */
function encodeAccp({ run_id, cursor, facts = [], intent = "code_gen", delta = [] } = {}) {
  if (!run_id) throw new Error("ACCP: run_id is required");
  const snapshot = {
    v: 1,
    run_id: String(run_id),
    cursor: cursor ? String(cursor) : null,
    facts: Array.isArray(facts) ? facts : [],
    intent,
    delta: Array.isArray(delta) ? delta : [],
  };
  snapshot.hash = hash({ run_id: snapshot.run_id, cursor: snapshot.cursor, facts: snapshot.facts, delta: snapshot.delta });
  return snapshot;
}

module.exports = { encode, decode, hash, canonical, core, encodeAccp, OPS, ROLES, DOMAINS };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "encode") {
      const [taskId, op, payloadJson] = rest;
      const payload = payloadJson ? JSON.parse(payloadJson) : {};
      process.stdout.write(encode(taskId, op, payload) + "\n");
    } else if (cmd === "decode") {
      process.stdout.write(JSON.stringify(decode(rest.join(" ")), null, 2) + "\n");
    } else if (cmd === "hash") {
      process.stdout.write(hash(JSON.parse(rest.join(" "))) + "\n");
    } else if (cmd === "accp") {
      process.stdout.write(JSON.stringify(encodeAccp(JSON.parse(rest.join(" ")))) + "\n");
    } else {
      process.stderr.write(
        "usage: aacp-encoder.js encode <taskId> <op> ['{json payload}']\n" +
          "       aacp-encoder.js decode '<packet json>'\n" +
          "       aacp-encoder.js hash '<json>'\n" +
          "       aacp-encoder.js accp '<snapshot json>'\n"
      );
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`aacp-encoder: ${err.message}\n`);
    process.exit(1);
  }
}

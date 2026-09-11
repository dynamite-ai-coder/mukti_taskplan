#!/usr/bin/env node
/**
 * AACP/ACCP/A2A side-channel writer.
 *
 *   node aacp-log.js dispatch t1 '{"role":"builder-1","dom":"code"}'
 *   node aacp-log.js result   t1 '{"role":"builder-1","ref":["src/a.js"]}'
 *   node aacp-log.js ack      t1 '{"role":"reviewer"}'
 *   node aacp-log.js fail     t1 '{"role":"builder-1","meta":{"reason":"tests failed"}}'
 *   node aacp-log.js accp     '{"run_id":"run-1","cursor":"t1","facts":[...]}'
 *   node aacp-log.js packet   '{"v":1,"op":"QUERY","task":"t1"}'
 *   node aacp-log.js a2a      '{"dir":"rpc","method":"task.dispatch"}'
 *   node aacp-log.js tail 20
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { encode, decode, hash, encodeAccp } = require("../protocols/aacp-encoder.js");

const VERBS = { dispatch: "DISPATCH", result: "RESULT", query: "QUERY", ack: "ACK", fail: "FAIL" };

function logDir() {
  return path.resolve(process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function append(file, line) {
  const dir = logDir();
  ensureDir(dir);
  fs.appendFileSync(path.join(dir, file), line.replace(/\n+$/, "") + "\n", "utf8");
  return path.join(dir, file);
}

function withRun(packet, run) {
  if (!run) return packet;
  packet.meta = Object.assign({}, packet.meta, { run });
  return packet;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    process.stderr.write(
      "usage: aacp-log.js <dispatch|result|query|ack|fail> <taskId> ['{payload}']\n" +
        "       aacp-log.js accp '<snapshot json>'\n" +
        "       aacp-log.js packet '<packet json>'\n" +
        "       aacp-log.js a2a '<record json>'\n" +
        "       aacp-log.js tail [n]\n"
    );
    process.exit(1);
  }

  if (cmd === "tail") {
    const n = Number(rest[0] || 20);
    const file = path.join(logDir(), "aacp.log");
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    process.stdout.write(lines.slice(-n).join("\n") + "\n");
    return;
  }

  if (cmd === "accp") {
    const snapshot = typeof rest[0] === "string" ? JSON.parse(rest.join(" ")) : rest[0];
    const withHash = snapshot.hash ? snapshot : encodeAccp(snapshot);
    const line = JSON.stringify(withHash);
    process.stdout.write(line + "\n");
    append("accp.jsonl", line);
    return;
  }

  if (cmd === "a2a") {
    const record = JSON.parse(rest.join(" "));
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, record));
    process.stdout.write(line + "\n");
    append("a2a.log", line);
    return;
  }

  if (cmd === "packet") {
    const data = JSON.parse(rest.join(" "));
    const packet = decode(data);
    const line = JSON.stringify(withRun(packet, process.env.AACP_RUN_ID));
    process.stdout.write(line + "\n");
    append("aacp.log", line);
    return;
  }

  const op = VERBS[cmd];
  if (!op) {
    process.stderr.write(`aacp-log: unknown command "${cmd}"\n`);
    process.exit(1);
  }
  const [taskId, payloadJson] = rest;
  const payload = payloadJson ? JSON.parse(payloadJson) : {};
  const packet = decode(encode(taskId, op, payload));
  packet.meta = Object.assign({}, packet.meta, {
    hash: packet.meta.hash || hash(packet),
    ts: Date.now(),
  });
  withRun(packet, process.env.AACP_RUN_ID);
  const line = JSON.stringify(packet);
  process.stdout.write(line + "\n");
  append("aacp.log", line);
}

try {
  main();
} catch (err) {
  process.stderr.write(`aacp-log: ${err.message}\n`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Live AACP/ACCP/A2A dashboard.
 *
 *   tail -f logs/*.log | node dashboard.js
 *   node dashboard.js --dir ./logs [--once]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const once = args.includes("--once");
const dirIndex = args.indexOf("--dir");
const LOG_DIR = path.resolve(dirIndex >= 0 ? args[dirIndex + 1] : process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
const FOLLOW = !args.includes("--no-follow") && !once;

const state = {
  packets: 0,
  snapshots: 0,
  a2a: 0,
  ail: 0,
  dictDefs: 0,
  bytes: { aacp: 0, accp: 0, a2a: 0, ail: 0 },
  ops: {},
  roles: {},
  methods: {},
  ailTypes: {},
  tasks: new Map(),
  recent: [],
};
const AIL_LINE = /^[>$~@#][a-z0-9]{6}\|/;

function touchTask(task) {
  if (!task) return null;
  if (!state.tasks.has(task)) state.tasks.set(task, { dispatch: 0, result: 0, ack: 0, fail: 0 });
  return state.tasks.get(task);
}

function ingest(line) {
  const size = Buffer.byteLength(line);
  if (AIL_LINE.test(line)) {
    state.ail += 1;
    state.bytes.ail += size;
    const sigil = line[0];
    const type = { ">": "control", $: "state", "~": "reason", "@": "directive", "#": "dict" }[sigil] || sigil;
    state.ailTypes[type] = (state.ailTypes[type] || 0) + 1;
    if (type === "dict") state.dictDefs += 1;
    if (type === "control") {
      const op = line.split("|")[1];
      state.ops[`AIL_${op}`] = (state.ops[`AIL_${op}`] || 0) + 1;
    }
    state.recent.push(`AIL ${type} ${line.slice(0, 48)}`);
    state.recent = state.recent.slice(-8);
    return;
  }
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (obj.v === 1 && obj.op && obj.task) {
    state.packets += 1;
    state.bytes.aacp += size;
    state.ops[obj.op] = (state.ops[obj.op] || 0) + 1;
    if (obj.role) state.roles[obj.role] = (state.roles[obj.role] || 0) + 1;
    const task = touchTask(obj.task);
    if (obj.op === "DISPATCH") task.dispatch += 1;
    if (obj.op === "RESULT") task.result += 1;
    if (obj.op === "ACK") task.ack += 1;
    if (obj.op === "FAIL") task.fail += 1;
    state.recent.push(`${obj.op} ${obj.task} ${obj.role || ""}`.trim());
  } else if (obj.v === 1 && obj.run_id && obj.facts) {
    state.snapshots += 1;
    state.bytes.accp += size;
    state.recent.push(`ACCP ${obj.run_id} cursor=${obj.cursor}`);
  } else if (obj.method || obj.dir) {
    state.a2a += 1;
    state.bytes.a2a += size;
    const key = obj.method || obj.dir;
    state.methods[key] = (state.methods[key] || 0) + 1;
    state.recent.push(`A2A ${key}`);
  } else {
    return;
  }
  state.recent = state.recent.slice(-8);
}

const tokens = (bytes) => Math.ceil(bytes / 4);

function render() {
  const lines = [];
  lines.push(`AACP/ACCP/A2A/AIL dashboard  dir=${LOG_DIR}  ${new Date().toISOString()}`);
  lines.push("".padEnd(72, "-"));
  lines.push(`packets=${state.packets}  snapshots=${state.snapshots}  a2a_calls=${state.a2a}  ail=${state.ail}  coord_tokens_est=${tokens(state.bytes.aacp + state.bytes.accp + state.bytes.a2a + state.bytes.ail)}`);
  lines.push(`ops: ${Object.entries(state.ops).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  lines.push(`ail: ${Object.entries(state.ailTypes).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}  dict_defs=${state.dictDefs}`);
  lines.push(`roles: ${Object.entries(state.roles).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  lines.push(`a2a: ${Object.entries(state.methods).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  lines.push("".padEnd(72, "-"));
  lines.push("task        DISP  RES  ACK  FAIL");
  for (const [task, t] of state.tasks) {
    lines.push(`${task.padEnd(11)} ${String(t.dispatch).padStart(4)} ${String(t.result).padStart(4)} ${String(t.ack).padStart(4)} ${String(t.fail).padStart(5)}`);
  }
  if (!state.tasks.size) lines.push("(no tasks yet)");
  lines.push("".padEnd(72, "-"));
  lines.push("recent:");
  for (const event of state.recent) lines.push("  " + event);

  if (process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
  }
}

async function readStdin() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) ingest(line);
}

function followFiles() {
  const files = ["aacp.log", "accp.jsonl", "a2a.log", "ail.log", "ail-dict.jsonl"];
  const offsets = new Map();
  const readNew = () => {
    for (const file of files) {
      const full = path.join(LOG_DIR, file);
      if (!fs.existsSync(full)) continue;
      const offset = offsets.get(file) || 0;
      const stat = fs.statSync(full);
      if (stat.size < offset) offsets.set(file, 0);
      if (stat.size === offset) continue;
      const stream = fs.createReadStream(full, { start: offsets.get(file) || 0, encoding: "utf8" });
      let data = "";
      stream.on("data", (chunk) => (data += chunk));
      stream.on("close", () => {
        offsets.set(file, stat.size);
        for (const line of data.split("\n")) if (line.trim()) ingest(line);
      });
    }
  };
  readNew();
  const timer = setInterval(readNew, 1000);
  const paint = setInterval(render, 2000);
  render();
  if (!FOLLOW) {
    clearInterval(timer);
    clearInterval(paint);
    render();
    process.exit(0);
  }
  process.on("SIGINT", () => {
    clearInterval(timer);
    clearInterval(paint);
    process.exit(0);
  });
}

if (!process.stdin.isTTY) {
  readStdin().then(() => {
    render();
    if (once) process.exit(0);
  });
} else {
  followFiles();
}

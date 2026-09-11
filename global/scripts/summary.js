#!/usr/bin/env node
/**
 * Per-run summary + token budget report.
 *
 *   node summary.js <run_id> [--dir ./logs]
 *   node summary.js --dir ./logs            (all runs)
 *
 * Counts AACP/ACCP (legacy) and AIL (AI-native) traffic. When AIL frames are
 * present they are the primary wire cost; AACP logs are kept for comparison.
 * Writes reports/budget-<run_id>.json and prints a human summary.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const A = require("../protocols/ail-codec.js");

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const LOG_DIR = path.resolve(dirIndex >= 0 ? args[dirIndex + 1] : process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
const runId = args.find((a, i) => !a.startsWith("--") && i !== dirIndex + 1) || null;

const BASELINE_PER_HOP = 1125; // 4500 tokens / 4-hop baseline (context/budget.md)
const AACP_TARGET_PER_HOP = 375; // <= 1500 tokens / 4-hop
const AIL_TARGET_PER_HOP = 225; // <= 900 tokens / 4-hop (AI-native target)
const SAVINGS_TARGET = 30;
const AIL_OP = { D: "DISPATCH", R: "RESULT", Q: "QUERY", A: "ACK", F: "FAIL" };

function readLines(file) {
  const full = path.join(LOG_DIR, file);
  if (!fs.existsSync(full)) return [];
  return fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
}

function parse(file) {
  const out = [];
  for (const line of readLines(file)) {
    try {
      out.push({ obj: JSON.parse(line), bytes: Buffer.byteLength(line) });
    } catch {
      /* skip */
    }
  }
  return out;
}

const aacp = parse("aacp.log").filter((r) => !runId || (r.obj.meta && r.obj.meta.run === runId));
const accp = parse("accp.jsonl").filter((r) => !runId || r.obj.run_id === runId);
const a2a = parse("a2a.log");
const integration = parse("integration.jsonl").filter((r) => !runId || r.obj.run_id === runId);
const ail = readLines("ail.log").map((line) => ({ line, bytes: Buffer.byteLength(line), parsed: A.parseLine(line) }));
const ailDict = readLines("ail-dict.jsonl").map((line) => ({ line, bytes: Buffer.byteLength(line) }));

const ops = {};
const roles = {};
const tasks = {};
for (const { obj } of aacp) {
  ops[obj.op] = (ops[obj.op] || 0) + 1;
  if (obj.role) roles[obj.role] = (roles[obj.role] || 0) + 1;
  if (!tasks[obj.task]) tasks[obj.task] = {};
  tasks[obj.task][obj.op] = (tasks[obj.task][obj.op] || 0) + 1;
}

const ailTypes = {};
for (const { parsed } of ail) {
  if (!parsed) continue;
  ailTypes[parsed.type] = (ailTypes[parsed.type] || 0) + 1;
  if (parsed.type === "control") {
    const op = AIL_OP[parsed.fields[0]] || parsed.fields[0];
    ops[`AIL_${op}`] = (ops[`AIL_${op}`] || 0) + 1;
    const task = parsed.fields[1];
    if (task && task !== "_") {
      if (!tasks[task]) tasks[task] = {};
      tasks[task][op] = (tasks[task][op] || 0) + 1;
    }
  }
}

const aacpBytes = [...aacp, ...accp].reduce((sum, r) => sum + r.bytes, 0);
const a2aBytes = a2a.reduce((sum, r) => sum + r.bytes, 0);
const ailBytes = ail.reduce((sum, r) => sum + r.bytes, 0) + ailDict.reduce((sum, r) => sum + r.bytes, 0);
const coordBytes = aacpBytes + a2aBytes; // legacy AACP/ACCP wire cost
const coordTokens = Math.ceil(coordBytes / 4);
const ailMode = ail.length > 0;
const wireBytes = ailMode ? ailBytes + a2aBytes : coordBytes;
const wireTokens = Math.ceil(wireBytes / 4);

const hops = Object.values(tasks).filter((t) => t.DISPATCH).length || 1;
const baseline = hops * BASELINE_PER_HOP;
const savings = baseline > 0 ? ((baseline - wireTokens) / baseline) * 100 : 0;
const onBudget = savings >= SAVINGS_TARGET;
const aacpOnBudget = !ailMode || coordTokens <= hops * AACP_TARGET_PER_HOP;
const ailOnBudget = !ailMode || wireTokens <= hops * AIL_TARGET_PER_HOP;
const acked = Object.values(tasks).filter((t) => t.ACK && !t.FAIL).length;
const failed = Object.values(tasks).filter((t) => t.FAIL).length;
const perHop = Number((wireTokens / hops).toFixed(1));

const report = {
  run_id: runId || "all",
  generated_at: new Date().toISOString(),
  log_dir: LOG_DIR,
  mode: ailMode ? "ail" : "aacp",
  packets: aacp.length,
  snapshots: accp.length,
  a2a_calls: a2a.length,
  integration_records: integration.length,
  ail_frames: ail.length,
  ail_dict_defs: ailDict.length,
  ail_types: ailTypes,
  ops,
  roles,
  tasks: Object.keys(tasks).length,
  tasks_acked: acked,
  tasks_failed: failed,
  hops,
  coord_bytes: coordBytes,
  coord_tokens_est: coordTokens,
  ail_bytes: ailBytes,
  wire_bytes: wireBytes,
  wire_tokens_est: wireTokens,
  wire_tokens_per_hop: perHop,
  baseline_tokens_est: baseline,
  savings_pct: Number(savings.toFixed(1)),
  savings_target_pct: SAVINGS_TARGET,
  aacp_target_per_hop: AACP_TARGET_PER_HOP,
  ail_target_per_hop: AIL_TARGET_PER_HOP,
  aacp_on_budget: aacpOnBudget,
  ail_on_budget: ailOnBudget,
  on_budget: onBudget,
};

const reportsDir = path.resolve(process.env.REPORTS_DIR || path.join(process.cwd(), "reports"));
fs.mkdirSync(reportsDir, { recursive: true });
const safeRun = (runId || "all").replace(/[^a-zA-Z0-9._-]/g, "_");
const reportFile = path.join(reportsDir, `budget-${safeRun}.json`);
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");

const bar = (value) => "#".repeat(Math.max(0, Math.min(40, Math.round(value / 2.5))));
process.stdout.write(
  [
    `run:        ${report.run_id}   mode: ${report.mode}`,
    `tasks:      ${report.tasks} (acked ${acked}, failed ${failed})   hops: ${hops}`,
    `packets:    ${report.packets}   snapshots: ${report.snapshots}   a2a: ${report.a2a_calls}   ail: ${report.ail_frames} (+${report.ail_dict_defs} defs)`,
    `ail types:  ${JSON.stringify(ailTypes)}`,
    `ops:        ${JSON.stringify(ops)}`,
    `tokens est: wire ${wireTokens} (${perHop}/hop); legacy ${coordTokens}; baseline ${baseline}`,
    `savings:    ${report.savings_pct}% ${onBudget ? ">= 30% ON BUDGET" : "< 30% OVER BUDGET"}`,
    `targets:    ail<=${AIL_TARGET_PER_HOP}/hop ${ailOnBudget ? "OK" : "MISS"}   aacp<=${AACP_TARGET_PER_HOP}/hop ${aacpOnBudget ? "OK" : "MISS"}`,
    `            [${bar(report.savings_pct)}]`,
    `report:     ${reportFile}`,
    "",
  ].join("\n")
);

process.exitCode = onBudget ? 0 : 2;

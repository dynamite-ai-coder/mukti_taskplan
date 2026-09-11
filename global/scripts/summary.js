#!/usr/bin/env node
/**
 * Per-run summary + token budget report.
 *
 *   node summary.js <run_id> [--dir ./logs]
 *   node summary.js --dir ./logs            (all runs)
 *
 * Writes reports/budget-<run_id>.json and prints a human summary.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const LOG_DIR = path.resolve(dirIndex >= 0 ? args[dirIndex + 1] : process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
const runId = args.find((a, i) => !a.startsWith("--") && i !== dirIndex + 1) || null;

const BASELINE_PER_HOP = 1125; // 4500 tokens / 4-hop baseline (context/budget.md)
const SAVINGS_TARGET = 30;

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

const ops = {};
const roles = {};
const tasks = {};
for (const { obj } of aacp) {
  ops[obj.op] = (ops[obj.op] || 0) + 1;
  if (obj.role) roles[obj.role] = (roles[obj.role] || 0) + 1;
  if (!tasks[obj.task]) tasks[obj.task] = {};
  tasks[obj.task][obj.op] = (tasks[obj.task][obj.op] || 0) + 1;
}

const coordBytes = [...aacp, ...accp, ...a2a].reduce((sum, r) => sum + r.bytes, 0);
const coordTokens = Math.ceil(coordBytes / 4);
const hops = Object.values(tasks).filter((t) => t.DISPATCH).length || 1;
const baseline = hops * BASELINE_PER_HOP;
const savings = baseline > 0 ? ((baseline - coordTokens) / baseline) * 100 : 0;
const onBudget = savings >= SAVINGS_TARGET;
const acked = Object.values(tasks).filter((t) => t.ACK && !t.FAIL).length;
const failed = Object.values(tasks).filter((t) => t.FAIL).length;

const report = {
  run_id: runId || "all",
  generated_at: new Date().toISOString(),
  log_dir: LOG_DIR,
  packets: aacp.length,
  snapshots: accp.length,
  a2a_calls: a2a.length,
  integration_records: integration.length,
  ops,
  roles,
  tasks: Object.keys(tasks).length,
  tasks_acked: acked,
  tasks_failed: failed,
  coord_bytes: coordBytes,
  coord_tokens_est: coordTokens,
  baseline_tokens_est: baseline,
  savings_pct: Number(savings.toFixed(1)),
  savings_target_pct: SAVINGS_TARGET,
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
    `run:        ${report.run_id}`,
    `tasks:      ${report.tasks} (acked ${acked}, failed ${failed})`,
    `packets:    ${report.packets}   snapshots: ${report.snapshots}   a2a: ${report.a2a_calls}`,
    `ops:        ${JSON.stringify(ops)}`,
    `tokens est: ${coordTokens} (baseline ${baseline})`,
    `savings:    ${report.savings_pct}% ${onBudget ? ">= 30% ON BUDGET" : "< 30% OVER BUDGET"}`,
    `            [${bar(report.savings_pct)}]`,
    `report:     ${reportFile}`,
    "",
  ].join("\n")
);

process.exitCode = onBudget ? 0 : 2;

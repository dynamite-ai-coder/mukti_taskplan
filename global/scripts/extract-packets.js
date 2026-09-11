#!/usr/bin/env node
/**
 * Extract AACP packets and ACCP snapshots from arbitrary agent output.
 * Used by dispatch-swarm.sh to build the side-channel logs from a run's stdout.
 *
 *   opencode run --agent planner "..." 2>&1 | node extract-packets.js
 *   node extract-packets.js --dir ./logs run-output.log
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { OPS } = require("../protocols/aacp-encoder.js");

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const LOG_DIR = path.resolve(dirIndex >= 0 ? args[dirIndex + 1] : process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
const inputs = args.filter((a, i) => !a.startsWith("--") && i !== dirIndex + 1);

fs.mkdirSync(LOG_DIR, { recursive: true });

const seen = new Set();
const counters = { aacp: 0, accp: 0, a2a: 0, ail: 0, skipped: 0 };
const AIL_LINE = /^[>$~@#][a-z0-9]{6}\|/;

function classify(obj) {
  if (!obj || typeof obj !== "object" || obj.v !== 1) return null;
  if (obj.op && obj.task && OPS.includes(obj.op)) return "aacp";
  if (obj.run_id && Array.isArray(obj.facts)) return "accp";
  if (obj.method && (obj.dir || obj.registry || obj.server)) return "a2a";
  return null;
}

function append(kind, obj) {
  const line = JSON.stringify(obj);
  if (seen.has(line)) {
    counters.skipped += 1;
    return;
  }
  seen.add(line);
  const file = kind === "aacp" ? "aacp.log" : kind === "accp" ? "accp.jsonl" : "a2a.log";
  fs.appendFileSync(path.join(LOG_DIR, file), line + "\n", "utf8");
  counters[kind] += 1;
}

function ingest(line) {
  const trimmed = line.trim().replace(/^```[a-z]*$/i, "").replace(/^`+|`+$/g, "").trim();
  if (!trimmed || trimmed.startsWith("```")) return;
  if (AIL_LINE.test(trimmed)) {
    if (seen.has(trimmed)) {
      counters.skipped += 1;
      return;
    }
    seen.add(trimmed);
    const file = trimmed[0] === "#" ? "ail-dict.jsonl" : "ail.log";
    fs.appendFileSync(path.join(LOG_DIR, file), trimmed + "\n", "utf8");
    counters.ail += 1;
    return;
  }
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const kind = classify(item);
    if (kind) append(kind, item);
  }
}

async function main() {
  if (inputs.length) {
    for (const file of inputs) {
      const stream = fs.createReadStream(path.resolve(file), "utf8");
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) ingest(line);
    }
  } else {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) ingest(line);
  }
  process.stderr.write(
    `extract-packets: aacp=${counters.aacp} accp=${counters.accp} a2a=${counters.a2a} ail=${counters.ail} dup=${counters.skipped} -> ${LOG_DIR}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`extract-packets: ${err.message}\n`);
  process.exit(1);
});

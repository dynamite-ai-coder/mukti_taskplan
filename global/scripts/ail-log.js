#!/usr/bin/env node
/**
 * AIL side-channel writer — encodes AI-native frames, persists the dictionary and
 * appends frames to logs (spec: protocols/ail.md).
 *
 *   node ail-log.js dispatch t1 '{"role":"builder","dom":"code","ref":["src/app.js"]}'
 *   node ail-log.js result   t1 '{"role":"builder","ref":["src/app.js"]}'
 *   node ail-log.js ack|fail|query <task> ['{payload}']
 *   node ail-log.js state    '{"run_id":"r1","cursor":"t1","facts":{...},"delta":[...]}'
 *   node ail-log.js reason   '{"intent":"code_gen","claims":[...],"next":[...]}'
 *   node ail-log.js directive '<frame json>'
 *   node ail-log.js line     '<ail line>'
 *   node ail-log.js dict
 *   node ail-log.js tail     [n]
 *
 * Prints the encoded lines (dictionary delta first) so the caller can forward them.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const A = require("../protocols/ail-codec.js");

const VERBS = { dispatch: "DISPATCH", result: "RESULT", query: "QUERY", ack: "ACK", fail: "FAIL" };

function logDir() {
  return path.resolve(process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"));
}

function dictPath() {
  return process.env.AIL_DICT_FILE || path.join(logDir(), "ail-dict.jsonl");
}

function append(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.replace(/\n+$/, "") + "\n", "utf8");
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    process.stderr.write("usage: ail-log.js <dispatch|result|query|ack|fail|state|reason|directive|line|dict|tail> ...\n");
    process.exit(1);
  }

  const dictFile = dictPath();
  const dict = A.loadDictFile(dictFile);

  if (cmd === "dict") {
    process.stdout.write(JSON.stringify(dict.toJSON(), null, 2) + "\n");
    return;
  }

  if (cmd === "tail") {
    const file = path.join(logDir(), "ail.log");
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    process.stdout.write(lines.slice(-Number(rest[0] || 20)).join("\n") + "\n");
    return;
  }

  if (cmd === "line") {
    const line = rest.join(" ");
    if (!A.isAil(line)) {
      process.stderr.write("ail-log: not a valid AIL line\n");
      process.exit(1);
    }
    process.stdout.write(line + "\n");
    append(path.join(logDir(), "ail.log"), line);
    return;
  }

  let frame;
  if (VERBS[cmd]) {
    const [taskId, payloadJson] = rest;
    const payload = payloadJson ? JSON.parse(payloadJson) : {};
    if (!taskId) {
      process.stderr.write(`ail-log: task ID required for ${cmd}\n`);
      process.exit(1);
    }
    frame = Object.assign({ type: "control", op: VERBS[cmd], task: taskId }, payload);
    if (process.env.AACP_RUN_ID) frame.meta = Object.assign({}, frame.meta, { run: process.env.AACP_RUN_ID });
  } else if (["state", "reason", "directive"].includes(cmd)) {
    frame = Object.assign({ type: cmd }, JSON.parse(rest.join(" ")));
  } else {
    process.stderr.write(`ail-log: unknown command "${cmd}"\n`);
    process.exit(1);
  }

  const result = A.encode(frame, dict, { sign: process.argv.includes("--sign") });
  for (const line of result.lines) {
    process.stdout.write(line + "\n");
    if (line.startsWith("#")) append(dictFile, line);
    else append(path.join(logDir(), "ail.log"), line);
  }
  process.stderr.write(`ail-log: ${result.tokens} tokens, dict=${result.dict}, defs=${result.defs.length}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`ail-log: ${err.message}\n`);
  process.exit(1);
}

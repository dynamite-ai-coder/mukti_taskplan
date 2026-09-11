#!/usr/bin/env node
/**
 * Deep-merge a source opencode.json into a target opencode.json.
 * Objects merge recursively, arrays are replaced, `$schema` is preserved.
 *
 *   node merge-config.js <source> <target> [--keys provider,mcp] [--drop a.b,c] [--rewrite-home]
 *
 * Used by scripts/install-global.sh to install the planner providers and MCP
 * servers without destroying existing user configuration. `--drop` removes
 * dotted paths from the incoming block (e.g. swarm-only MCP servers).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const keysIndex = args.indexOf("--keys");
const onlyKeys = keysIndex >= 0 ? args[keysIndex + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
const dropIndex = args.indexOf("--drop");
const dropPaths = dropIndex >= 0 ? args[dropIndex + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];
const rewriteHome = args.includes("--rewrite-home");
const valueIndexes = new Set();
if (keysIndex >= 0) valueIndexes.add(keysIndex + 1);
if (dropIndex >= 0) valueIndexes.add(dropIndex + 1);
const positional = args.filter((a, i) => !a.startsWith("--") && !valueIndexes.has(i));
const [sourceFile, targetFile] = positional;

if (!sourceFile || !targetFile) {
  process.stderr.write("usage: merge-config.js <source.json> <target.json> [--keys a,b,c] [--drop a.b] [--rewrite-home]\n");
  process.exit(1);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: invalid JSON — ${err.message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(target, source) {
  const out = Object.assign({}, target);
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function dropPath(root, dotted) {
  const parts = dotted.split(".").filter(Boolean);
  if (!parts.length) return;
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor)) return;
    cursor = cursor[part];
  }
  if (isPlainObject(cursor)) delete cursor[parts[parts.length - 1]];
}

function rewrite(value) {
  const text = JSON.stringify(value)
    .replaceAll("./global/scripts/", "{env:HOME}/.config/opencode/scripts/")
    .replaceAll("./global/protocols/", "{env:HOME}/.config/opencode/protocols/");
  return JSON.parse(text.replaceAll("{env:HOME}", "{env:HOME}"));
}

const source = readJson(sourceFile, {});
const target = readJson(targetFile, { $schema: "https://opencode.ai/config.json" });

let incoming = source;
if (onlyKeys) {
  incoming = {};
  for (const key of onlyKeys) if (source[key] !== undefined) incoming[key] = source[key];
}
for (const dotted of dropPaths) dropPath(incoming, dotted);
if (rewriteHome) incoming = rewrite(incoming);

const merged = merge(target, incoming);
fs.mkdirSync(path.dirname(path.resolve(targetFile)), { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2) + "\n", "utf8");
process.stdout.write(`merged ${Object.keys(incoming).join(", ")} into ${targetFile}\n`);

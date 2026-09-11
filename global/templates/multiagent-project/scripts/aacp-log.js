#!/usr/bin/env node
/**
 * Project shim -> global AACP/ACCP log writer.
 * Builders call: node scripts/aacp-log.js result t1 '{"role":"builder-1"}'
 */
"use strict";

const path = require("node:path");
const os = require("node:os");

const globalDir = process.env.OPENCODE_GLOBAL_DIR || path.join(os.homedir(), ".config", "opencode");
const target = path.join(globalDir, "scripts", "aacp-log.js");

try {
  process.argv = [process.argv[0], target, ...process.argv.slice(2)];
  require(target);
} catch (err) {
  process.stderr.write(`aacp-log shim: cannot load ${target}\n${err.message}\n`);
  process.stderr.write("Run: bash scripts/install-global.sh\n");
  process.exit(1);
}

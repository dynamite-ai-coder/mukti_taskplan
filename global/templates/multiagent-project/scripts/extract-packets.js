#!/usr/bin/env node
/** Project shim -> global packet extractor (dispatch-swarm side channel). */
"use strict";

const path = require("node:path");
const os = require("node:os");

const globalDir = process.env.OPENCODE_GLOBAL_DIR || path.join(os.homedir(), ".config", "opencode");
const target = path.join(globalDir, "scripts", "extract-packets.js");

try {
  process.argv = [process.argv[0], target, ...process.argv.slice(2)];
  require(target);
} catch (err) {
  process.stderr.write(`extract-packets shim: cannot load ${target}\n${err.message}\n`);
  process.exit(1);
}

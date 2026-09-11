#!/usr/bin/env node
/**
 * Project shim -> global A2A registry (step 8 of the build prompt).
 * The real implementation lives in ~/.config/opencode/scripts/a2a-registry.js.
 */
"use strict";

const path = require("node:path");
const os = require("node:os");

const globalDir = process.env.OPENCODE_GLOBAL_DIR || path.join(os.homedir(), ".config", "opencode");
const target = path.join(globalDir, "scripts", "a2a-registry.js");

try {
  require(target);
} catch (err) {
  process.stderr.write(`a2a-registry shim: cannot load ${target}\n${err.message}\n`);
  process.stderr.write("Run: bash scripts/install-global.sh\n");
  process.exit(1);
}

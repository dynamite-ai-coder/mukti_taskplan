#!/usr/bin/env node
/**
 * Local DID envelope signing — HMAC-SHA256, zero dependencies.
 * Used by the A2A registry and the browser A2A server (protocols/a2a.md §4).
 */
"use strict";

const crypto = require("node:crypto");

const DEFAULT_SECRET = "local-dev-secret-change-me";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}

function secret() {
  return process.env.A2A_SECRET || DEFAULT_SECRET;
}

/** @returns {string} "hmac-sha256:<hex>" */
function sign(payload, key = secret()) {
  const body = Object.assign({}, payload);
  delete body.sig;
  const mac = crypto.createHmac("sha256", key).update(canonical(body)).digest("hex");
  return "hmac-sha256:" + mac;
}

function verify(payload, signature, key = secret()) {
  if (!signature) return false;
  const expected = sign(payload, key);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signed(payload, key = secret()) {
  return Object.assign({}, payload, { sig: sign(payload, key) });
}

module.exports = { sign, verify, signed, canonical, DEFAULT_SECRET };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "sign") {
    process.stdout.write(signed(JSON.parse(rest.join(" "))).sig + "\n");
  } else if (cmd === "verify") {
    const payload = JSON.parse(rest[0]);
    process.stdout.write(String(verify(payload, rest[1])) + "\n");
  } else {
    process.stderr.write("usage: crypto-sign.js sign '<json>' | verify '<json>' '<sig>'\n");
    process.exit(1);
  }
}

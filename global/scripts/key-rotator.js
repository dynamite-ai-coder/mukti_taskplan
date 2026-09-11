#!/usr/bin/env node
/**
 * DeepSeek key rotator — 5-account pool with 429 cooldown + in-flight tracking.
 * Zero dependencies. Callable as a module or from the `get-key` custom tool.
 *
 *   const { KeyRotator, fromEnv } = require("./key-rotator.js")
 *   const rotator = fromEnv()
 *   const slot = rotator.acquire()        // -> { index, env, masked, inFlight }
 *   rotator.release(slot.env, { status: 429 })   // marks cooling, counts switch
 *
 * CLI:
 *   node key-rotator.js status
 *   node key-rotator.js next
 *   node key-rotator.js test
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function mask(value) {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

class KeyRotator {
  constructor(keys, options = {}) {
    this.cooldownMs = Number(options.cooldownMs || process.env.KEY_COOLDOWN_MS || 60000);
    this.maxInFlight = Number(options.maxInFlight || process.env.KEY_MAX_IN_FLIGHT || 2500);
    this.keys = keys.map((entry, index) => {
      const isObject = entry && typeof entry === "object";
      const value = isObject ? entry.value || "" : String(entry || "");
      return {
        index,
        env: isObject && entry.env ? entry.env : `DEEPSEEK_KEY_${index + 1}`,
        value,
        inFlight: 0,
        coolingUntil: 0,
        uses: 0,
        errors429: 0,
      };
    });
    this.metrics = { key_switches_total: 0, requests_total: 0, rate_limits_total: 0, exhausted_total: 0 };
  }

  available(now = Date.now()) {
    return this.keys.filter((k) => k.value && k.coolingUntil <= now && k.inFlight < this.maxInFlight);
  }

  cooldownRemaining(now = Date.now()) {
    const cooling = this.keys.filter((k) => k.coolingUntil > now).map((k) => k.coolingUntil - now);
    return cooling.length ? Math.min(...cooling) : 0;
  }

  /** Pick the next available key (fewest in-flight). Does not reserve it. */
  getNextKey(now = Date.now()) {
    const pool = this.available(now);
    if (!pool.length) {
      this.metrics.exhausted_total += 1;
      return {
        exhausted: true,
        retry_in_ms: this.cooldownRemaining(now),
        cooling: this.keys.filter((k) => k.coolingUntil > now).map((k) => k.env),
      };
    }
    pool.sort((a, b) => a.inFlight - b.inFlight || a.uses - b.uses || a.index - b.index);
    const key = pool[0];
    return { index: key.index, env: key.env, masked: mask(key.value), inFlight: key.inFlight, cooling: false };
  }

  /** Reserve the next available key (increments in-flight). */
  acquire(now = Date.now()) {
    const info = this.getNextKey(now);
    if (info.exhausted) return info;
    const key = this.keys[info.index];
    key.inFlight += 1;
    key.uses += 1;
    this.metrics.requests_total += 1;
    return info;
  }

  /** Release a reservation; status 429 puts the key into cooldown. */
  release(env, { status } = {}) {
    const key = this.keys.find((k) => k.env === env);
    if (!key) return false;
    key.inFlight = Math.max(0, key.inFlight - 1);
    if (Number(status) === 429) {
      key.coolingUntil = Date.now() + this.cooldownMs;
      key.errors429 += 1;
      this.metrics.rate_limits_total += 1;
      this.metrics.key_switches_total += 1;
    }
    this.persist();
    return true;
  }

  state() {
    const now = Date.now();
    return this.keys.map((k) => ({
      account: k.index + 1,
      env: k.env,
      masked: mask(k.value),
      present: Boolean(k.value),
      in_flight: k.inFlight,
      cooling_for_ms: Math.max(0, k.coolingUntil - now),
      uses: k.uses,
      errors_429: k.errors429,
    }));
  }

  persist() {
    const file = process.env.KEY_STATE_FILE || path.join(process.env.AACP_LOG_DIR || path.join(process.cwd(), "logs"), "key-state.json");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ metrics: this.metrics, keys: this.state(), ts: Date.now() }, null, 2));
    } catch {
      /* non-fatal */
    }
  }
}

/** Build a rotator from DEEPSEEK_KEY_1..5. */
function fromEnv(count = 5) {
  const keys = [];
  for (let i = 1; i <= count; i += 1) keys.push({ env: `DEEPSEEK_KEY_${i}`, value: process.env[`DEEPSEEK_KEY_${i}`] || "" });
  return new KeyRotator(keys);
}

module.exports = { KeyRotator, fromEnv, mask };

if (require.main === module) {
  const [cmd] = process.argv.slice(2);
  const rotator = fromEnv();
  if (cmd === "status" || !cmd) {
    process.stdout.write(JSON.stringify({ keys: rotator.state(), metrics: rotator.metrics }, null, 2) + "\n");
  } else if (cmd === "next") {
    process.stdout.write(JSON.stringify(rotator.getNextKey(), null, 2) + "\n");
  } else if (cmd === "test") {
    const first = rotator.acquire();
    if (first.exhausted) {
      process.stderr.write("no keys configured — set DEEPSEEK_KEY_1..5\n");
      process.exit(1);
    }
    rotator.release(first.env, { status: 429 });
    const second = rotator.acquire();
    process.stdout.write(
      JSON.stringify(
        {
          first: first.env,
          first_after_429_cooling: true,
          next: second.exhausted ? null : second.env,
          key_switches_total: rotator.metrics.key_switches_total,
          state: rotator.state(),
        },
        null,
        2
      ) + "\n"
    );
  } else {
    process.stderr.write("usage: key-rotator.js status|next|test\n");
    process.exit(1);
  }
}

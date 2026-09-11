#!/usr/bin/env node
/**
 * AIL v1 codec — AI-native Interlingua (spec: protocols/ail.md).
 * Zero dependencies. Positional frames + append-only symbol dictionary.
 *
 *   const { encode, decode, createDict, estimateTokens, bench } = require("./ail-codec.js")
 *   const dict = createDict()
 *   encode({ type:"control", op:"DISPATCH", task:"t1", role:"builder", ref:["src/app.js"] }, dict)
 *   // => { lines:["#1x9k|+#a3f2=src/app.js", ">1x9k|D|t1|b|c|#a3f2|fo|p1"], tokens:... }
 */
"use strict";

const crypto = require("node:crypto");

/* ------------------------------------------------------------------ core */

const CORE = {
  version: "ail-core-1",
  ops: { D: "DISPATCH", R: "RESULT", Q: "QUERY", A: "ACK", F: "FAIL" },
  rol: { p: "planner", b: "builder", w: "browser", v: "reviewer", i: "integrator" },
  dom: { c: "code", w: "web", s: "fs", t: "test", r: "research" },
  ret: { f: "files", o: "stdout", s: "snapshot", e: "errors", j: "json", p: "patch" },
  met: { p: "pri", t: "ttl", h: "hash", n: "reason", j: "job", r: "run" },
  int: { c: "code_gen", r: "refactor", t: "test", s: "research", x: "integration" },
  fac: { fc: "files_created", fm: "files_modified", tp: "tests_passing", bl: "blockers", cv: "commands_verified", ar: "artifacts" },
  sigils: { control: ">", state: "$", reason: "~", directive: "@", dict: "#" },
};

const invert = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));

/* ------------------------------------------------------------------ helpers */

const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
};

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

function base36(hex, chars) {
  return BigInt("0x" + hex).toString(36).padStart(chars, "0").slice(0, chars);
}

const ESCAPES = [
  [/%/g, "%25"],
  [/\|/g, "%7C"],
  [/;/g, "%3B"],
  [/,/g, "%2C"],
  [/\^/g, "%5E"],
  [/=/g, "%3D"],
];
const esc = (value) => {
  let out = String(value);
  for (const [re, rep] of ESCAPES) out = out.replace(re, rep);
  return out;
};
const unesc = (value) =>
  String(value)
    .replace(/%3D/gi, "=")
    .replace(/%5E/gi, "^")
    .replace(/%2C/gi, ",")
    .replace(/%3B/gi, ";")
    .replace(/%7C/gi, "|")
    .replace(/%25/gi, "%");

const empty = (value) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
const field = (value) => (empty(value) ? "_" : value);
const fromField = (value) => (value === "_" || value === "" ? undefined : value);

/**
 * Heuristic BPE token estimator (documented approximation, no tokenizer dependency).
 * Punctuation = 1 token, words = ceil(len/4), numbers = ceil(len/3), whitespace ~ 0.
 */
function estimateTokens(text) {
  if (!text) return 0;
  const parts = String(text).match(/[A-Za-z]+|\d+|\s+|[^\sA-Za-z0-9]/g) || [];
  let tokens = 0;
  for (const part of parts) {
    if (/^\s+$/.test(part)) continue;
    if (/^[A-Za-z]+$/.test(part)) tokens += part.length <= 4 ? 1 : Math.ceil(part.length / 4);
    else if (/^\d+$/.test(part)) tokens += part.length <= 3 ? 1 : Math.ceil(part.length / 3);
    else tokens += 1;
  }
  return tokens;
}

/* ------------------------------------------------------------------ dictionary */

class Dict {
  constructor(core = CORE) {
    this.core = core;
    this.words = new Map();
    this.reverse = new Map();
  }

  static fromJSON(json) {
    const dict = new Dict();
    const words = (json && json.words) || {};
    for (const [handle, word] of Object.entries(words)) {
      dict.words.set(handle, word);
      dict.reverse.set(word, handle);
    }
    return dict;
  }

  learn(word) {
    const existing = this.reverse.get(word);
    if (existing) return existing;
    for (let len = 4; len <= 7; len += 1) {
      const handle = "#" + base36(sha1(word), len);
      if (!this.words.has(handle)) {
        this.words.set(handle, word);
        this.reverse.set(word, handle);
        return handle;
      }
    }
    const handle = "#" + base36(sha1(word + "#salt"), 8);
    this.words.set(handle, word);
    this.reverse.set(word, handle);
    return handle;
  }

  resolve(handle) {
    return this.words.get(handle);
  }

  applyDefs(line) {
    const parsed = parseLine(line);
    if (!parsed || parsed.sigil !== "#") throw new Error("AIL: not a dictionary delta line");
    let added = 0;
    for (const def of parsed.fields[0].split(",")) {
      const match = def.match(/^\+?(#[a-z0-9]+)=(.+)$/i);
      if (!match) continue;
      this.words.set(match[1], match[2]);
      this.reverse.set(match[2], match[1]);
      added += 1;
    }
    return added;
  }

  hash() {
    return base36(sha1(canonical({ core: this.core.version, words: Object.fromEntries(this.words) })), 6);
  }

  toJSON() {
    return { v: 1, core: this.core.version, hash: this.hash(), words: Object.fromEntries(this.words) };
  }
}

function createDict(seed) {
  return seed ? Dict.fromJSON(seed) : new Dict();
}

function shouldLearn(value) {
  if (typeof value !== "string" || value.length <= 6 || value.startsWith("#")) return false;
  if (!/[./]/.test(value)) return false;
  return /^[A-Za-z0-9_@:./~-]+$/.test(value);
}

function compress(value, dict, newDefs) {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => compress(v, dict, newDefs)).filter((v) => v !== "");
    return items.length ? `[${items.join(",")}]` : "";
  }
  const text = String(value);
  if (shouldLearn(text)) {
    const fresh = !dict.reverse.has(text);
    const handle = dict.learn(text);
    if (fresh) newDefs.add(`${handle}=${text}`);
    return handle;
  }
  return esc(text);
}

function uncompress(value, dict, mode = "string") {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.startsWith("[")) {
    const inner = value.replace(/^\[|\]$/g, "");
    if (!inner) return [];
    return inner.split(",").map((v) => uncompress(v, dict, mode));
  }
  if (mode === "bool") {
    if (value === "1") return true;
    if (value === "0") return false;
  }
  if (typeof value === "string" && value.startsWith("#")) {
    const word = dict && dict.resolve(value.split(",")[0]);
    return word !== undefined ? word : `<?${value}>`;
  }
  return unesc(value);
}

function compressList(values, dict, newDefs, separator = ",") {
  if (empty(values)) return "";
  return (Array.isArray(values) ? values : [values]).map((v) => compress(v, dict, newDefs)).join(separator);
}

function uncompressList(value, dict, separator = ",") {
  const raw = fromField(value);
  if (raw === undefined) return [];
  return String(raw).split(separator).map((v) => uncompress(v, dict));
}

/* ------------------------------------------------------------------ frames */

function encodeControl(frame, dict, newDefs) {
  const op = invert(CORE.ops)[frame.op] || frame.op;
  const role = frame.role ? invert(CORE.rol)[frame.role] || frame.role : "";
  const dom = frame.dom ? invert(CORE.dom)[frame.dom] || frame.dom : "";
  const ref = compressList(frame.ref, dict, newDefs);
  const ret = (frame.ret || []).map((r) => invert(CORE.ret)[r] || r).join("");
  const meta = Object.entries(frame.meta || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${invert(CORE.met)[k] || k}=${compress(v, dict, newDefs)}`)
    .join(",");
  return [field(op), field(frame.task), field(role), field(dom), field(ref), field(ret), field(meta)].join("|");
}

function decodeControl(fields, dict) {
  const [op, task, role, dom, ref, ret, meta] = fields;
  const metaObj = {};
  for (const pair of String(fromField(meta) || "").split(",")) {
    if (!pair) continue;
    const [k, ...rest] = pair.split("=");
    if (!k) continue;
    const raw = rest.join("=");
    const value = uncompress(raw, dict);
    metaObj[CORE.met[k] || k] = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return {
    v: 1,
    op: CORE.ops[op] || op,
    task: fromField(task),
    role: CORE.rol[role] || fromField(role),
    dom: CORE.dom[dom] || fromField(dom),
    ref: uncompressList(ref, dict),
    ret: String(fromField(ret) || "").split("").map((r) => CORE.ret[r] || r).filter(Boolean),
    meta: metaObj,
  };
}

function encodeState(frame, dict, newDefs) {
  const intent = invert(CORE.int)[frame.intent] || frame.intent || "";
  const facts = Object.entries(frame.facts || {})
    .filter(([, v]) => !empty(v))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${invert(CORE.fac)[k] || k}=${compress(v, dict, newDefs)}`)
    .join(",");
  const delta = compressList(frame.delta, dict, newDefs, ";");
  const hash = frame.hash || base36(sha1(canonical({ facts, delta })), 6);
  return [field(frame.run || frame.run_id), field(frame.cursor), field(intent), field(facts), field(delta), field(hash)].join("|");
}

function decodeState(fields, dict) {
  const [run, cursor, intent, factsRaw, deltaRaw, hash] = fields;
  const facts = {};
  for (const pair of String(fromField(factsRaw) || "").split(",")) {
    if (!pair) continue;
    const [k, ...rest] = pair.split("=");
    if (!k || !rest.length) continue;
    const raw = rest.join("=");
    if (raw === "") continue;
    facts[CORE.fac[k] || k] = uncompress(raw, dict, "bool");
  }
  return {
    v: 1,
    run_id: fromField(run),
    cursor: fromField(cursor),
    intent: CORE.int[intent] || fromField(intent),
    facts,
    delta: uncompressList(deltaRaw, dict, ";"),
    hash: fromField(hash),
  };
}

function encodeReason(frame, dict, newDefs) {
  const intent = invert(CORE.int)[frame.intent] || frame.intent || "";
  const claims = compressList(frame.claims, dict, newDefs, ";");
  const next = compressList(frame.next, dict, newDefs, ";");
  const conf = frame.confidence === undefined ? "" : String(Math.max(0, Math.min(9, Math.round(frame.confidence * 10))));
  return [field(intent), field(claims), field(next), field(conf)].join("|");
}

function decodeReason(fields, dict) {
  const [intent, claims, next, conf] = fields;
  return {
    v: 1,
    intent: CORE.int[intent] || fromField(intent),
    claims: uncompressList(claims, dict, ";"),
    next: uncompressList(next, dict, ";"),
    confidence: conf ? Number(conf) / 10 : undefined,
  };
}

function encodeDirective(frame, dict, newDefs) {
  return [
    field(frame.task),
    field(compress(frame.subject, dict, newDefs)),
    field(compressList(frame.steps, dict, newDefs, ";")),
    field(compressList(frame.writes, dict, newDefs)),
    field(compressList(frame.evidence, dict, newDefs, ";")),
    field(compressList(frame.done || frame.done_when, dict, newDefs, ";")),
  ].join("|");
}

function decodeDirective(fields, dict) {
  const [task, subject, steps, writes, evidence, done] = fields;
  return {
    v: 1,
    task: fromField(task),
    subject: subject === "_" ? undefined : uncompress(subject, dict),
    steps: uncompressList(steps, dict, ";"),
    writes: uncompressList(writes, dict),
    evidence: uncompressList(evidence, dict, ";"),
    done_when: uncompressList(done, dict, ";"),
  };
}

const FRAME_TYPES = { ">": "control", $: "state", "~": "reason", "@": "directive", "#": "dict" };

/* ------------------------------------------------------------------ parse / encode / decode */

function parseLine(line) {
  let body = String(line).trim();
  if (!body) return null;
  let sig = null;
  const caret = body.lastIndexOf("^");
  if (caret > 1 && /^[0-9a-f]{8}$/i.test(body.slice(caret + 1))) {
    sig = body.slice(caret + 1);
    body = body.slice(0, caret);
  }
  const sigil = body[0];
  if (!FRAME_TYPES[sigil]) return null;
  const dictHash = body.slice(1, 7);
  const rest = body.slice(7);
  if (!rest.startsWith("|")) return null;
  return { sigil, type: FRAME_TYPES[sigil], dict: dictHash, fields: rest.slice(1).split("|"), sig, raw: line };
}

/** Detect whether a line looks like AIL (used by loggers/extractors). */
function isAil(line) {
  const parsed = parseLine(line);
  if (!parsed) return false;
  if (parsed.type === "dict") return /\+?#[a-z0-9]+=/i.test(parsed.fields[0] || "");
  if (parsed.type === "control") return Object.prototype.hasOwnProperty.call(CORE.ops, parsed.fields[0]);
  return parsed.fields.join("|").trim().length > 0;
}

function encode(frame, dict = createDict(), options = {}) {
  if (!frame || typeof frame !== "object") throw new Error("AIL: frame must be an object");
  const type = frame.type || (frame.op ? "control" : frame.run_id && frame.facts ? "state" : null);
  if (!type) throw new Error("AIL: cannot infer frame type");
  const newDefs = new Set();
  const encoder = { control: encodeControl, state: encodeState, reason: encodeReason, directive: encodeDirective }[type];
  if (!encoder) throw new Error(`AIL: unsupported frame type "${type}"`);
  const body = encoder(frame, dict, newDefs);
  const dictHash = dict.hash();
  const base = CORE.sigils[type] + dictHash + "|" + body;
  const sig = options.sign ? signLine(base, options.secret) : frame.sig || null;
  const line = sig ? `${base}^${sig}` : base;
  const lines = [];
  if (options.includeDefs !== false && newDefs.size) lines.push(`#${dictHash}|${[...newDefs].map((d) => `+${d}`).join(",")}`);
  lines.push(line);
  return { lines, line, dict: dictHash, defs: [...newDefs], tokens: lines.reduce((n, l) => n + estimateTokens(l), 0) };
}

function decode(input, dict = createDict()) {
  const lines = Array.isArray(input) ? input : String(input).split("\n");
  const parsedFrames = [];
  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.type === "dict") {
      dict.applyDefs(parsed.raw);
      parsedFrames.push({ type: "dict", v: 1, dict: parsed.dict, defs: parsed.fields[0] });
      continue;
    }
    const decoder = { control: decodeControl, state: decodeState, reason: decodeReason, directive: decodeDirective }[parsed.type];
    const frame = decoder(parsed.fields, dict);
    frame.type = parsed.type;
    frame.dict = parsed.dict;
    frame.sig = parsed.sig;
    frame.raw = parsed.raw;
    parsedFrames.push(frame);
  }
  if (!Array.isArray(input)) {
    return parsedFrames.length === 1 ? parsedFrames[0] : parsedFrames;
  }
  return parsedFrames;
}

/* ------------------------------------------------------------------ signing + AACP bridge */

function signLine(line, secret = process.env.A2A_SECRET || "local-dev-secret-change-me") {
  return crypto.createHmac("sha256", secret).update(line).digest("hex").slice(0, 8);
}

function verifyLine(line, secret = process.env.A2A_SECRET || "local-dev-secret-change-me") {
  const caret = line.lastIndexOf("^");
  if (caret < 0) return false;
  const base = line.slice(0, caret);
  const sig = line.slice(caret + 1);
  const expected = signLine(base, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Convert an AACP packet object into an AIL control frame. */
function fromAacp(packet) {
  return {
    type: "control",
    op: packet.op,
    task: packet.task,
    role: packet.role,
    dom: packet.dom,
    ref: packet.ref,
    ret: packet.ret,
    meta: packet.meta,
  };
}

/** Convert an AIL control frame back into an AACP packet object. */
function toAacp(frame) {
  if (!frame || frame.type !== "control") throw new Error("AIL: not a control frame");
  const { type, dict, sig, raw, ...packet } = frame;
  return Object.assign({ v: 1 }, packet);
}

/* ------------------------------------------------------------------ benchmark */

function bench(aacpText, frameOrText, dict) {
  const useDict = dict || createDict();
  let ailLines;
  if (typeof frameOrText === "string") ailLines = frameOrText.split("\n");
  else if (frameOrText && frameOrText.lines) ailLines = frameOrText.lines;
  else ailLines = encode(frameOrText, useDict).lines;
  const aacpTokens = estimateTokens(aacpText);
  const ailTokens = ailLines.reduce((n, l) => n + estimateTokens(l), 0);
  return {
    aacp_tokens: aacpTokens,
    ail_tokens: ailTokens,
    savings_pct: aacpTokens ? Number((((aacpTokens - ailTokens) / aacpTokens) * 100).toFixed(1)) : 0,
    ail_lines: ailLines.length,
  };
}

function loadDictFile(file, dict = createDict()) {
  if (!file || !require("node:fs").existsSync(file)) return dict;
  for (const line of require("node:fs").readFileSync(file, "utf8").split("\n")) {
    if (line.trim()) {
      try {
        dict.applyDefs(line.trim());
      } catch {
        /* skip malformed */
      }
    }
  }
  return dict;
}

module.exports = {
  CORE,
  Dict,
  createDict,
  loadDictFile,
  encode,
  decode,
  parseLine,
  isAil,
  estimateTokens,
  bench,
  signLine,
  verifyLine,
  fromAacp,
  toAacp,
  canonical,
  esc,
  unesc,
};

/* ------------------------------------------------------------------ CLI */

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const [cmd, ...rest] = process.argv.slice(2);
  const dictFileIndex = rest.indexOf("--dict");
  const dictFile = dictFileIndex >= 0 ? rest[dictFileIndex + 1] : process.env.AIL_DICT_FILE || path.join(process.cwd(), "logs", "ail-dict.jsonl");
  const args = rest.filter((a, i) => i !== dictFileIndex + 1 && a !== "--dict");
  try {
    if (cmd === "encode") {
      const frame = JSON.parse(args.join(" "));
      const dict = loadDictFile(dictFile);
      const result = encode(frame, dict, { sign: process.argv.includes("--sign") });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (cmd === "decode") {
      const dict = loadDictFile(dictFile);
      const input = args.length ? args.join(" ") : fs.readFileSync(0, "utf8");
      process.stdout.write(JSON.stringify(decode(input, dict), null, 2) + "\n");
    } else if (cmd === "learn") {
      const dict = loadDictFile(dictFile);
      const handle = dict.learn(args.join(" "));
      if (process.argv.includes("--write")) {
        fs.mkdirSync(path.dirname(dictFile), { recursive: true });
        fs.appendFileSync(dictFile, `${"#" + dict.hash()}|+${handle}=${args.join(" ")}\n`, "utf8");
      }
      process.stdout.write(handle + "\n");
    } else if (cmd === "tokens") {
      process.stdout.write(String(estimateTokens(args.join(" "))) + "\n");
    } else if (cmd === "bench") {
      const [aacpText, frameText] = args;
      const frame = frameText ? JSON.parse(frameText) : undefined;
      process.stdout.write(JSON.stringify(bench(aacpText, frame, loadDictFile(dictFile)), null, 2) + "\n");
    } else if (cmd === "dict") {
      process.stdout.write(JSON.stringify(loadDictFile(dictFile).toJSON(), null, 2) + "\n");
    } else {
      process.stderr.write(
        "usage: ail-codec.js encode '<frame json>' [--dict f] [--sign]\n" +
          "       ail-codec.js decode '<line or lines>' [--dict f]\n" +
          "       ail-codec.js learn <word> [--write] [--dict f]\n" +
          "       ail-codec.js tokens '<text>'\n" +
          "       ail-codec.js bench '<aacp json>' ['<frame json>'] [--dict f]\n" +
          "       ail-codec.js dict [--dict f]\n"
      );
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`ail-codec: ${err.message}\n`);
    process.exit(1);
  }
}

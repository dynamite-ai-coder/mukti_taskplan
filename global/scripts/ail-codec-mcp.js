#!/usr/bin/env node
/**
 * ail-codec MCP server — AI-native Interlingua tools for agents.
 * Tools: ail_encode, ail_decode, ail_learn, ail_dict, ail_tokens, ail_bench, ail_log
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serveMcp } = require("./mcp-stdio.js");
const A = require("../protocols/ail-codec.js");

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

function encodeFrame(args) {
  const frame = args.frame || args;
  const dict = A.loadDictFile(dictPath());
  const result = A.encode(frame, dict, { sign: args.sign === true });
  if (args.write === true) {
    for (const line of result.lines) {
      if (line.startsWith("#")) append(dictPath(), line);
      else append(path.join(logDir(), "ail.log"), line);
    }
  }
  return result;
}

const tools = {
  ail_encode: {
    description: "Encode an AI-native AIL frame (control/state/reason/directive) into compact lines. Returns lines, token estimate, dictionary hash and new definitions.",
    inputSchema: {
      type: "object",
      required: ["frame"],
      properties: {
        frame: {
          type: "object",
          description: "control: {op,task,role,dom,ref,ret,meta}; state: {run_id,cursor,intent,facts,delta}; reason: {intent,claims,next,confidence}; directive: {task,subject,steps,writes,evidence,done_when}",
          properties: { type: { type: "string", enum: ["control", "state", "reason", "directive"] } },
        },
        sign: { type: "boolean" },
        write: { type: "boolean", description: "append lines to logs/ail.log and logs/ail-dict.jsonl" },
      },
    },
    handler: (args) => encodeFrame(args),
  },

  ail_decode: {
    description: "Decode AIL lines (dictionary deltas are applied automatically) into structured frames.",
    inputSchema: {
      type: "object",
      required: ["lines"],
      properties: { lines: { type: ["string", "array"], items: { type: "string" } } },
    },
    handler(args) {
      const dict = A.loadDictFile(dictPath());
      return JSON.stringify(A.decode(args.lines, dict), null, 2);
    },
  },

  ail_learn: {
    description: "Learn a word (path/URL/recurring term) into a short dictionary handle.",
    inputSchema: {
      type: "object",
      required: ["word"],
      properties: { word: { type: "string" }, write: { type: "boolean" } },
    },
    handler(args) {
      const dict = A.loadDictFile(dictPath());
      const handle = dict.learn(args.word);
      if (args.write) append(dictPath(), `#${dict.hash()}|+${handle}=${args.word}`);
      return handle;
    },
  },

  ail_dict: {
    description: "Return the current AIL dictionary (core version, hash, learned words).",
    inputSchema: { type: "object", properties: {} },
    handler: () => JSON.stringify(A.loadDictFile(dictPath()).toJSON(), null, 2),
  },

  ail_tokens: {
    description: "Estimate BPE tokens for a text (heuristic, no tokenizer dependency).",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    handler: (args) => String(A.estimateTokens(args.text)),
  },

  ail_bench: {
    description: "Benchmark AIL vs the equivalent AACP JSON: tokens and savings percentage.",
    inputSchema: {
      type: "object",
      required: ["aacp"],
      properties: { aacp: { type: "string" }, frame: { type: "object" } },
    },
    handler: (args) => JSON.stringify(A.bench(args.aacp, args.frame, A.loadDictFile(dictPath())), null, 2),
  },

  ail_log: {
    description: "Encode a frame, append it to logs/ail.log (+ dict deltas) and return the lines.",
    inputSchema: {
      type: "object",
      required: ["frame"],
      properties: { frame: { type: "object" } },
    },
    handler: (args) => encodeFrame(Object.assign({}, args, { write: true })),
  },
};

serveMcp({ name: "ail-codec", version: "1.0.0", tools });

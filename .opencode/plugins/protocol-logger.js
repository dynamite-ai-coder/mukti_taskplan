/**
 * ProtocolLogger — side-channel observer for AACP / ACCP / A2A traffic.
 *
 * AACP/A2A messages are not visible in the OpenCode TUI, so this plugin writes
 * every Task-tool dispatch and every AACP/ACCP line it sees to:
 *   logs/aacp.log    (AACP packets, one line each)
 *   logs/accp.jsonl  (ACCP snapshots)
 *   logs/a2a.log     (A2A task dispatches)
 *
 * Loaded from .opencode/plugins/ (project) or ~/.config/opencode/plugins/ (global).
 * A globalThis guard prevents double-logging when both copies are loaded.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OPS = new Set(["DISPATCH", "RESULT", "QUERY", "ACK", "FAIL"]);
const AIL_LINE = /^[>$~@#][a-z0-9]{6}\|/;
const ROLE_MAP = {
  planner: "planner",
  "builder-1": "builder",
  "builder-2": "builder",
  "builder-3": "builder",
  builder: "builder",
  browser: "browser",
  reviewer: "reviewer",
  integrator: "integrator",
};

function sha1Short(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function extractTaskId(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/"task"\s*:\s*"([^"]+)"/) || text.match(/\b(t\d+)\b/);
  return match ? match[1] : null;
}

export const ProtocolLogger = async ({ worktree, directory }) => {
  if (globalThis.__MULTIAGENT_PROTOCOL_LOGGER__) return {};
  globalThis.__MULTIAGENT_PROTOCOL_LOGGER__ = true;

  const root = worktree || directory || process.cwd();
  const logDir = process.env.AACP_LOG_DIR ? path.resolve(process.env.AACP_LOG_DIR) : path.join(root, "logs");
  const seen = new Set();

  const appendRaw = (file, line) => {
    try {
      if (seen.has(line)) return;
      if (seen.size > 5000) seen.clear();
      seen.add(line);
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, file), line.replace(/\n+$/, "") + "\n", "utf8");
    } catch {
      /* logging must never break a session */
    }
  };

  const append = (file, obj) => {
    try {
      appendRaw(file, JSON.stringify(obj));
    } catch {
      /* ignore circular */
    }
  };

  const ingestText = (text) => {
    if (typeof text !== "string" || text.length > 1_000_000) return;
    for (const raw of text.split("\n")) {
      const line = raw.trim().replace(/^```[a-z]*$/i, "").replace(/^`+|`+$/g, "").trim();
      if (!line) continue;
      if (AIL_LINE.test(line)) {
        appendRaw(line[0] === "#" ? "ail-dict.jsonl" : "ail.log", line);
        continue;
      }
      if (!line.startsWith("{")) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj && obj.v === 1 && OPS.has(obj.op) && obj.task) {
        append("aacp.log", obj);
      } else if (obj && obj.v === 1 && obj.run_id && Array.isArray(obj.facts)) {
        append("accp.jsonl", obj);
      }
    }
  };

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      const args = output.args || {};
      const subagent = args.subagent_type || args.agent || args.subagentType || "builder";
      const role = ROLE_MAP[subagent] || "builder";
      const task = extractTaskId(args.prompt || "") || extractTaskId(args.description || "") || "t?";
      append("aacp.log", {
        v: 1,
        op: "DISPATCH",
        task,
        role,
        dom: subagent === "browser" ? "web" : "code",
        ref: ["task-dag.json"],
        meta: { hash: sha1Short(`${task}:${subagent}`), ts: Date.now(), run: process.env.AACP_RUN_ID },
      });
      append("a2a.log", {
        ts: new Date().toISOString(),
        dir: "task.dispatch",
        target: subagent,
        session: input.sessionID,
        description: args.description,
      });
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "task") {
        const args = output.args || {};
        const subagent = args.subagent_type || args.agent || "builder";
        append("a2a.log", {
          ts: new Date().toISOString(),
          dir: "task.result",
          target: subagent,
          session: input.sessionID,
          bytes: typeof output.output === "string" ? output.output.length : undefined,
        });
      }
      if (typeof output.output === "string") ingestText(output.output);
      else if (output.output && typeof output.output === "object") {
        try {
          ingestText(JSON.stringify(output.output));
        } catch {
          /* ignore circular */
        }
      }
    },
  };
};

#!/usr/bin/env bash
# ============================================================
# verify-prereqs.sh — planner-core environment check
# Checks Node >= 22.19.0, OpenCode CLI, Git, the planner agent and
# whether the A2A registry port 8788 is free.
#
# Browser/Chromium checks are intentionally NOT part of this repo: the
# planner is worker-agnostic and host projects bring their own agents.
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_DIR="${OPENCODE_GLOBAL_DIR:-$HOME/.config/opencode}"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }

echo "verify-prereqs: checking environment (planner-only)"
echo

# --- Node.js >= 22.19.0 ---
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  if node -e 'const [maj,min]=process.versions.node.split(".").map(Number);process.exit(maj>22||(maj===22&&min>=19)?0:1)'; then
    pass "Node.js $NODE_VERSION (>= 22.19.0)"
  else
    bad "Node.js $NODE_VERSION is too old (need >= 22.19.0)"
  fi
else
  bad "Node.js not found"
fi

# --- OpenCode CLI ---
if command -v opencode >/dev/null 2>&1; then
  pass "OpenCode CLI $(opencode --version 2>/dev/null | head -1)"
else
  bad "OpenCode CLI not found (install from https://opencode.ai)"
fi

# --- Git ---
if command -v git >/dev/null 2>&1; then
  pass "Git $(git --version | awk '{print $3}')"
else
  bad "Git not found"
fi

# --- Planner agent (repo or global install) ---
if [ -f "$ROOT/.opencode/agents/planner.md" ]; then
  pass "planner agent present ($ROOT/.opencode/agents/planner.md)"
elif [ -f "$GLOBAL_DIR/agents/planner.md" ]; then
  pass "planner agent present ($GLOBAL_DIR/agents/planner.md)"
else
  warn "planner agent not found — run bash scripts/install-global.sh"
fi

# --- A2A registry port 8788 ---
PORT_STATE="$(node -e '
const net=require("net");
const s=net.createServer();
s.once("error",()=>{ console.log("busy"); process.exit(0); });
s.once("listening",()=>s.close(()=>{ console.log("free"); process.exit(0); }));
s.listen(Number(process.env.A2A_REGISTRY_PORT||8788),"127.0.0.1");
' 2>/dev/null || echo "unknown")"
if [ "$PORT_STATE" = "free" ]; then
  pass "Port ${A2A_REGISTRY_PORT:-8788} is free"
elif [ "$PORT_STATE" = "unknown" ]; then
  warn "Could not determine A2A registry port availability"
else
  warn "Port ${A2A_REGISTRY_PORT:-8788} in use (fine if the registry is already running)"
fi

# --- Resolved OpenCode config (best effort) ---
if command -v opencode >/dev/null 2>&1; then
  if opencode debug config >/dev/null 2>&1; then
    pass "opencode config resolves"
  else
    warn "opencode debug config failed — check JSON syntax / provider blocks"
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "verify-prereqs: all hard checks passed."
else
  echo "verify-prereqs: one or more hard checks failed." >&2
fi
exit "$FAILED"

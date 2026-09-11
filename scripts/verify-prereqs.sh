#!/usr/bin/env bash
# ============================================================
# verify-prereqs.sh — Step 1 of the build prompt
# Checks Node >= 22.19.0, OpenCode CLI, Git, Chrome/Edge/Chromium,
# and whether ports 8788 (A2A registry) / 8789 (browser agent) are free.
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }

echo "verify-prereqs: checking environment"
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

# --- Browser for Playwright/CDP ---
BROWSER=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable; do
  if command -v "$candidate" >/dev/null 2>&1; then BROWSER="$candidate"; break; fi
done
if [ -z "$BROWSER" ] && ls "$HOME/.cache/ms-playwright"/chromium* >/dev/null 2>&1; then
  BROWSER="playwright-bundled-chromium"
fi
if [ -n "$BROWSER" ]; then
  pass "Browser available ($BROWSER)"
else
  bad "No Chrome/Edge/Chromium found (needed by opencode-browser-control)"
fi

# --- Ports 8788 / 8789 ---
PORTS="$(node -e '
const net=require("net");
const ports=[8788,8789];
const busy=[];
let pending=ports.length;
const done=()=>{ if(0===--pending){ console.log(busy.length?busy.join(","):"free"); } };
for(const p of ports){
  const s=net.createServer();
  s.once("error",()=>{ busy.push(p); done(); });
  s.once("listening",()=>s.close(done));
  s.listen(p,"127.0.0.1");
}
' 2>/dev/null || echo "unknown")"
if [ "$PORTS" = "free" ]; then
  pass "Ports 8788 and 8789 are free"
elif [ "$PORTS" = "unknown" ]; then
  warn "Could not determine port availability"
else
  warn "Port(s) in use: $PORTS (fine if the A2A registry / browser agent is already running)"
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

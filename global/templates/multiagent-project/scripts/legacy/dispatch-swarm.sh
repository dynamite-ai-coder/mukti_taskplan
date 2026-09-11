#!/usr/bin/env bash
# ============================================================
# dispatch-swarm.sh — run a whole task DAG through the planner
#   bash scripts/dispatch-swarm.sh [task-dag.json] [--with-browser]
#
# Reads the DAG, starts the A2A registry + browser A2A front,
# streams the planner run through extract-packets.js so that
# logs/aacp.log, logs/accp.jsonl and logs/a2a.log are populated,
# then prints the budget summary.
# ============================================================
set -euo pipefail

DAG="${1:-task-dag.json}"
WITH_BROWSER="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_DIR="${OPENCODE_GLOBAL_DIR:-$HOME/.config/opencode}"
REGISTRY_PORT="${A2A_REGISTRY_PORT:-8788}"
BROWSER_PORT="${BROWSER_A2A_PORT:-8789}"

cd "$ROOT"
mkdir -p logs reports artifacts/browser

if [ ! -f "$DAG" ]; then
  echo "dispatch-swarm: missing DAG file: $DAG" >&2
  exit 1
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

RUN_ID="$(node -e "const p=require('path');process.stdout.write(require(p.resolve(process.argv[1])).run_id || '')" "$DAG" 2>/dev/null || true)"
[ -n "$RUN_ID" ] || RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
OBJECTIVE="$(node -e "const p=require('path');process.stdout.write(require(p.resolve(process.argv[1])).objective || '')" "$DAG" 2>/dev/null || true)"

export AACP_RUN_ID="$RUN_ID"
export AACP_LOG_DIR="$ROOT/logs"

echo "[dispatch-swarm] run_id=$RUN_ID"
echo "[dispatch-swarm] objective=$OBJECTIVE"

# --- A2A registry (idempotent) ---
if ! curl -sf "http://127.0.0.1:${REGISTRY_PORT}/health" >/dev/null 2>&1; then
  node "$GLOBAL_DIR/scripts/a2a-registry.js" >>logs/registry.out 2>&1 &
  echo "[dispatch-swarm] started a2a-registry :$REGISTRY_PORT (pid $!)"
  sleep 1
fi

# --- Browser A2A front (optional) ---
if [ "$WITH_BROWSER" = "--with-browser" ]; then
  if ! curl -sf "http://127.0.0.1:${BROWSER_PORT}/health" >/dev/null 2>&1; then
    node "$GLOBAL_DIR/scripts/browser-a2a-server.js" >>logs/browser.out 2>&1 &
    echo "[dispatch-swarm] started browser-a2a-server :$BROWSER_PORT (pid $!)"
    sleep 1
  fi
fi

# --- Planner run, streamed into the side channel ---
PROMPT="@planner Execute the task DAG at ${DAG}. run_id=${RUN_ID}. Emit one AACP DISPATCH per task and dispatch ready tasks to builder-1/builder-2/builder-3/browser. Route browser work through the A2A registry. Objective: ${OBJECTIVE}"

set +e
opencode run --agent planner "$PROMPT" 2>&1 | tee "logs/run-${RUN_ID}.log" | node "$GLOBAL_DIR/scripts/extract-packets.js" --dir logs
STATUS=${PIPESTATUS[0]}
set -e

echo "[dispatch-swarm] planner exit=$STATUS"

# --- Observability ---
node "$GLOBAL_DIR/scripts/summary.js" "$RUN_ID" --dir logs || true
node "$GLOBAL_DIR/scripts/dashboard.js" --dir logs --once || true

exit "$STATUS"

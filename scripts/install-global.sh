#!/usr/bin/env bash
# ============================================================
# install-global.sh — install the multi-agent system globally
#   bash scripts/install-global.sh [--dry-run] [--project DIR]
#
# Installs into ~/.config/opencode (override: OPENCODE_GLOBAL_DIR):
#   - opencode.json   providers + MCP servers (merged, not replaced)
#   - agents/         planner, builder-1..3, browser, reviewer, integrator
#   - protocols/      aacp.md, accp.md, a2a.md, aacp-encoder.js
#   - context/        task-dag.md, budget.md
#   - scripts/        key-rotator, a2a-registry, browser-a2a-server, dashboard, summary, ...
#   - plugins/        protocol-logger.js
#   - tools/          get-key.ts
#   - templates/      multiagent-project (drop-in project template)
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_DIR="${OPENCODE_GLOBAL_DIR:-$HOME/.config/opencode}"
DRY_RUN=""
PROJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --project) PROJECT="${2:-}"; shift ;;
    --global-dir) GLOBAL_DIR="${2:-}"; shift ;;
    *) echo "install-global: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

run() {
  if [ -n "$DRY_RUN" ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

copy_tree() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  run mkdir -p "$dst"
  if [ -n "$DRY_RUN" ]; then
    echo "[dry-run] cp -R $src/. $dst/"
  else
    cp -R "$src/." "$dst/"
  fi
}

echo "install-global: repo=$ROOT"
echo "install-global: global_dir=$GLOBAL_DIR"

# --- 1. config merge (never destroy existing keys) ---
if [ -f "$GLOBAL_DIR/opencode.json" ] && [ -z "$DRY_RUN" ]; then
  backup="$GLOBAL_DIR/opencode.json.bak.$(date +%Y%m%d%H%M%S)"
  cp "$GLOBAL_DIR/opencode.json" "$backup"
  echo "install-global: backed up config -> $backup"
fi
run mkdir -p "$GLOBAL_DIR"
run node "$ROOT/scripts/merge-config.js" "$ROOT/opencode.json" "$GLOBAL_DIR/opencode.json" \
  --keys small_model,provider,mcp --rewrite-home

# --- 2. global artifacts ---
copy_tree "$ROOT/.opencode/agents" "$GLOBAL_DIR/agents"
copy_tree "$ROOT/global/protocols" "$GLOBAL_DIR/protocols"
copy_tree "$ROOT/global/context" "$GLOBAL_DIR/context"
copy_tree "$ROOT/global/scripts" "$GLOBAL_DIR/scripts"
copy_tree "$ROOT/global/plugins" "$GLOBAL_DIR/plugins"
copy_tree "$ROOT/global/tools" "$GLOBAL_DIR/tools"
copy_tree "$ROOT/.opencode/plugins" "$GLOBAL_DIR/plugins"
copy_tree "$ROOT/.opencode/tools" "$GLOBAL_DIR/tools"
copy_tree "$ROOT/global/templates" "$GLOBAL_DIR/templates"

# --- 3. make scripts executable ---
if [ -z "$DRY_RUN" ]; then
  chmod +x "$GLOBAL_DIR"/scripts/*.js 2>/dev/null || true
  chmod +x "$GLOBAL_DIR"/templates/multiagent-project/scripts/* 2>/dev/null || true
fi

# --- 4. optional: install the project template into a target project ---
if [ -n "$PROJECT" ]; then
  echo "install-global: installing project template -> $PROJECT"
  run mkdir -p "$PROJECT"
  copy_tree "$ROOT/global/templates/multiagent-project" "$PROJECT"
  if [ ! -f "$PROJECT/.env" ] && [ -f "$ROOT/.env" ] && [ -z "$DRY_RUN" ]; then
    cp "$ROOT/.env" "$PROJECT/.env"
    echo "install-global: copied .env -> $PROJECT/.env"
  fi
fi

echo
echo "install-global: done."
echo "next steps:"
echo "  1. cp .env.example .env && edit DEEPSEEK_KEY_1..5"
echo "  2. source .env"
echo "  3. bash scripts/verify-prereqs.sh"
echo "  4. opencode run --agent planner \"@planner decompose and dispatch\""

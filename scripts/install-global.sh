#!/usr/bin/env bash
# ============================================================
# install-global.sh — install the planner core globally
#   bash scripts/install-global.sh [--dry-run] [--project DIR]
#
# Installs into ~/.config/opencode (override: OPENCODE_GLOBAL_DIR):
#   - opencode.json   providers + planner MCPs (merged, never replaced)
#   - agents/         planner.md ONLY (host projects register their own agents)
#   - protocols/      aacp, accp, ail, a2a docs + encoders
#   - context/        task-dag.md, budget.md
#   - scripts/        registry + codecs + crypto-sign + MCP wrappers + aacp/ail logs
#   - plugins/        protocol-logger.js
#   - tools/          get-key.ts
#   - templates/      multiagent-project (host-project template)
#
# It is intentionally tolerant: missing builder/browser/reviewer/integrator files
# are skipped, never fatal.
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

copy_file() {
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    echo "install-global: (skip) missing $src"
    return 0
  fi
  run mkdir -p "$(dirname "$dst")"
  if [ -n "$DRY_RUN" ]; then
    echo "[dry-run] cp $src $dst"
  else
    cp "$src" "$dst"
  fi
}

echo "install-global: repo=$ROOT"
echo "install-global: global_dir=$GLOBAL_DIR"

# --- 1. config merge (never destroy existing keys; drop swarm-only MCPs) ---
if [ -f "$GLOBAL_DIR/opencode.json" ] && [ -z "$DRY_RUN" ]; then
  backup="$GLOBAL_DIR/opencode.json.bak.$(date +%Y%m%d%H%M%S)"
  cp "$GLOBAL_DIR/opencode.json" "$backup"
  echo "install-global: backed up config -> $backup"
fi
run mkdir -p "$GLOBAL_DIR"
run node "$ROOT/scripts/merge-config.js" "$ROOT/opencode.json" "$GLOBAL_DIR/opencode.json" \
  --keys small_model,provider,mcp,autoupdate,share --drop mcp.browser-control --rewrite-home

# --- 2. planner agent (only the planner; hosts register their own agents) ---
copy_file "$ROOT/.opencode/agents/planner.md" "$GLOBAL_DIR/agents/planner.md"

# --- 3. protocols + context + templates ---
copy_tree "$ROOT/global/protocols" "$GLOBAL_DIR/protocols"
copy_tree "$ROOT/global/context" "$GLOBAL_DIR/context"
copy_tree "$ROOT/global/templates" "$GLOBAL_DIR/templates"

# --- 4. planner-core scripts (no browser/swarm server) ---
for script in \
  crypto-sign.js \
  mcp-stdio.js \
  a2a-registry.js \
  a2a-registry-mcp.js \
  aacp-codec-mcp.js \
  aacp-log.js \
  ail-codec-mcp.js \
  ail-log.js \
  summary.js \
  dashboard.js \
  extract-packets.js \
  key-rotator.js
do
  copy_file "$ROOT/global/scripts/$script" "$GLOBAL_DIR/scripts/$script"
done

# --- 5. plugins + tools (only what is present) ---
copy_tree "$ROOT/global/plugins" "$GLOBAL_DIR/plugins"
copy_tree "$ROOT/.opencode/plugins" "$GLOBAL_DIR/plugins"
copy_tree "$ROOT/global/tools" "$GLOBAL_DIR/tools"
copy_tree "$ROOT/.opencode/tools" "$GLOBAL_DIR/tools"

# --- 6. make installed scripts executable ---
if [ -z "$DRY_RUN" ]; then
  chmod +x "$GLOBAL_DIR"/scripts/*.js 2>/dev/null || true
  find "$GLOBAL_DIR/templates/multiagent-project/scripts" -type f \
    \( -name '*.js' -o -name '*.sh' \) -exec chmod +x {} + 2>/dev/null || true
fi

# --- 7. optional: install the host-project template into a target project ---
if [ -n "$PROJECT" ]; then
  echo "install-global: installing host-project template -> $PROJECT"
  run mkdir -p "$PROJECT"
  copy_tree "$ROOT/global/templates/multiagent-project" "$PROJECT"
  copy_tree "$ROOT/deploy" "$PROJECT/deploy"
  for file in Dockerfile .dockerignore render.yaml; do
    copy_file "$ROOT/$file" "$PROJECT/$file"
  done
  if [ ! -f "$PROJECT/.env" ] && [ -f "$ROOT/.env" ] && [ -z "$DRY_RUN" ]; then
    cp "$ROOT/.env" "$PROJECT/.env"
    echo "install-global: copied .env -> $PROJECT/.env"
  fi
fi

echo
echo "install-global: done."
echo "next steps:"
echo "  1. The planner model/API key comes from your global OpenCode config."
echo "  2. bash scripts/verify-prereqs.sh"
echo "  3. opencode run --agent planner \"@planner decompose and dispatch\""

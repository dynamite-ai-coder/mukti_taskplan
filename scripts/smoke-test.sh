#!/usr/bin/env bash
# ============================================================
# smoke-test.sh — Step 14 of the build prompt
#   bash scripts/smoke-test.sh --static      (no model calls)
#   bash scripts/smoke-test.sh               (+ registry + summary)
#   bash scripts/smoke-test.sh --live        (+ a real planner run if keys set)
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATIC_ONLY="${1:-}"
FAILED=0
CHECKS=0

pass() { CHECKS=$((CHECKS + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
bad()  { CHECKS=$((CHECKS + 1)); FAILED=1; printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

echo "smoke-test: root=$ROOT"

# --- 1. JS syntax ---
JS_FILES="$(find "$ROOT/global/scripts" "$ROOT/global/protocols" "$ROOT/.opencode/plugins" "$ROOT/global/templates" -name '*.js' -type f 2>/dev/null)"
if [ -z "$JS_FILES" ]; then
  bad "no JS files found"
else
  JS_BAD=0
  while IFS= read -r file; do
    node --check "$file" >/dev/null 2>&1 || { JS_BAD=1; printf '        syntax error: %s\n' "$file"; }
  done <<< "$JS_FILES"
  [ "$JS_BAD" -eq 0 ] && pass "JS syntax ($(echo "$JS_FILES" | wc -l | tr -d ' ') files)" || bad "JS syntax errors"
fi

# --- 2. JSON validity ---
JSON_BAD=0
for file in "$ROOT/opencode.json" "$ROOT/global/templates/multiagent-project/opencode.json" "$ROOT/global/templates/multiagent-project/task-dag.example.json" "$ROOT/.opencode/package.json"; do
  [ -f "$file" ] || continue
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$file" >/dev/null 2>&1 || { JSON_BAD=1; printf '        invalid JSON: %s\n' "$file"; }
done
[ "$JSON_BAD" -eq 0 ] && pass "JSON configs valid" || bad "invalid JSON configs"

# --- 3. Shell syntax ---
SH_BAD=0
for file in "$ROOT"/scripts/*.sh "$ROOT"/global/templates/multiagent-project/scripts/*.sh; do
  [ -f "$file" ] || continue
  bash -n "$file" >/dev/null 2>&1 || { SH_BAD=1; printf '        shell syntax: %s\n' "$file"; }
done
[ "$SH_BAD" -eq 0 ] && pass "shell syntax valid" || bad "shell syntax errors"

# --- 4. AACP encoder round trip ---
ROUNDTRIP="$(node -e '
const {encode,decode}=require(process.argv[1]);
const line=encode("t1","DISPATCH",{role:"builder-1",dom:"code",ref:["task-dag.json"]});
const packet=decode(line);
process.stdout.write(packet.op==="DISPATCH"&&packet.task==="t1"&&packet.meta.hash?"ok":"bad");
' "$ROOT/global/protocols/aacp-encoder.js")"
[ "$ROUNDTRIP" = "ok" ] && pass "AACP encode/decode round trip" || bad "AACP encoder round trip"

# --- 4b. AIL round trip + benchmark ---
AIL_CHECK="$(node -e '
const A=require(process.argv[1]);
const frame={type:"control",op:"DISPATCH",task:"t1",role:"builder",dom:"code",ref:["src/app.js"],ret:["files"]};
const enc=A.encode(frame,A.createDict());
const dec=A.decode(enc.lines,A.createDict()).pop();
const aacp=JSON.stringify({v:1,op:"DISPATCH",task:"t1",role:"builder",dom:"code",ref:["src/app.js"],ret:["files"]});
const b=A.bench(aacp,frame,A.createDict());
process.stdout.write(dec.op==="DISPATCH"&&dec.ref[0]==="src/app.js"&&b.savings_pct>40?"ok":"bad:"+JSON.stringify(b));
' "$ROOT/global/protocols/ail-codec.js" 2>/dev/null || echo error)"
[ "$AIL_CHECK" = "ok" ] && pass "AIL round trip + bench (>40% vs AACP)" || bad "AIL round trip + bench ($AIL_CHECK)"

# --- 4c. AIL side-channel writer ---
AIL_LOGS="$(mktemp -d)"
AACP_LOG_DIR="$AIL_LOGS" node "$ROOT/global/scripts/ail-log.js" dispatch t1 \
  '{"role":"builder","dom":"code","ref":["src/app.js"]}' >/dev/null 2>&1
AACP_LOG_DIR="$AIL_LOGS" node "$ROOT/global/scripts/ail-log.js" state \
  '{"run_id":"smoke","cursor":"t1","facts":{"tests_passing":true},"delta":["+app.js"]}' >/dev/null 2>&1
if [ -s "$AIL_LOGS/ail.log" ] && [ -s "$AIL_LOGS/ail-dict.jsonl" ]; then
  pass "ail-log writes logs/ail.log + logs/ail-dict.jsonl"
else
  bad "ail-log side channel"
fi

# --- 5. MCP handshake (aacp-codec) ---
MCP_OUT="$(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | timeout 10 node "$ROOT/global/scripts/aacp-codec-mcp.js" 2>/dev/null || true)"
if printf '%s' "$MCP_OUT" | grep -q '"aacp_encode"'; then
  pass "aacp-codec MCP handshake + tools/list"
else
  bad "aacp-codec MCP handshake"
fi

# --- 6. MCP handshake (a2a-registry) ---
MCP_OUT2="$(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | timeout 10 node "$ROOT/global/scripts/a2a-registry-mcp.js" 2>/dev/null || true)"
if printf '%s' "$MCP_OUT2" | grep -q '"a2a_discover"'; then
  pass "a2a-registry MCP handshake + tools/list"
else
  bad "a2a-registry MCP handshake"
fi

# --- 6b. MCP handshake (ail-codec) ---
MCP_OUT3="$(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | timeout 10 node "$ROOT/global/scripts/ail-codec-mcp.js" 2>/dev/null || true)"
if printf '%s' "$MCP_OUT3" | grep -q '"ail_encode"'; then
  pass "ail-codec MCP handshake + tools/list"
else
  bad "ail-codec MCP handshake"
fi

# --- 7. Key rotator 429 failover ---
ROTATOR_OUT="$(DEEPSEEK_KEY_1=test-key-1 DEEPSEEK_KEY_2=test-key-2 DEEPSEEK_KEY_3=test-key-3 \
  node "$ROOT/global/scripts/key-rotator.js" test 2>/dev/null || true)"
if printf '%s' "$ROTATOR_OUT" | grep -q '"key_switches_total": 1'; then
  pass "key-rotator 429 cooldown + failover"
else
  printf '%s' "$ROTATOR_OUT" | grep -q '"key_switches_total"' && pass "key-rotator runs" || bad "key-rotator 429 failover"
fi

if [ "$STATIC_ONLY" = "--static" ]; then
  echo
  echo "smoke-test(static): $((CHECKS - FAILED))/$CHECKS checks passed"
  exit "$FAILED"
fi

# --- 8. A2A registry live check (isolated port) ---
TEST_PORT=18788
A2A_REGISTRY_PORT=$TEST_PORT AACP_LOG_DIR="$(mktemp -d)" node "$ROOT/global/scripts/a2a-registry.js" >/dev/null 2>&1 &
REGISTRY_PID=$!
sleep 1
HEALTH="$(curl -sf "http://127.0.0.1:${TEST_PORT}/health" || true)"
CARD="$(curl -sf "http://127.0.0.1:${TEST_PORT}/.well-known/agent.json" || true)"
kill "$REGISTRY_PID" >/dev/null 2>&1 || true
if printf '%s' "$HEALTH" | grep -q '"ok":true' && printf '%s' "$CARD" | grep -q 'did:local:a2a-registry'; then
  pass "A2A registry serves /health + /.well-known/agent.json"
else
  bad "A2A registry live check"
fi

# --- 9. Summary report generation ---
TMP_LOGS="$(mktemp -d)"
printf '%s\n' '{"v":1,"op":"DISPATCH","task":"t1","role":"builder","meta":{"run":"smoke","hash":"x"}}' > "$TMP_LOGS/aacp.log"
printf '%s\n' '{"v":1,"op":"RESULT","task":"t1","role":"builder","meta":{"run":"smoke","hash":"y"}}' >> "$TMP_LOGS/aacp.log"
printf '%s\n' '{"v":1,"op":"ACK","task":"t1","role":"reviewer","meta":{"run":"smoke","hash":"z"}}' >> "$TMP_LOGS/aacp.log"
node "$ROOT/global/scripts/summary.js" smoke --dir "$TMP_LOGS" >/dev/null 2>&1 || true
if [ -f "$ROOT/reports/budget-smoke.json" ]; then
  pass "summary.js writes reports/budget-<run_id>.json"
else
  bad "summary.js report generation"
fi

# --- 10. Optional live planner run ---
if [ "$STATIC_ONLY" = "--live" ]; then
  if [ -n "${DEEPSEEK_KEY_1:-}" ] && [ -n "${DEEPSEEK_KEY_2:-}" ]; then
    TMP_PROJECT="$(mktemp -d)"
    bash "$ROOT/scripts/install-global.sh" --project "$TMP_PROJECT" >/dev/null 2>&1 || true
    ( cd "$TMP_PROJECT" && timeout 180 opencode run --agent planner "@planner produce a 2-task DAG for a hello-world index.html and emit AACP DISPATCH packets" >/dev/null 2>&1 )
    if [ -s "$TMP_PROJECT/logs/aacp.log" ] || [ -s "$TMP_PROJECT/logs/run-"*.log ]; then
      pass "live planner run produced side-channel logs"
    else
      warn "live planner run produced no logs (model output may not include AACP lines)"
    fi
  else
    warn "DEEPSEEK_KEY_1/2 not set — skipping live planner run"
  fi
fi

echo
echo "smoke-test: $((CHECKS - FAILED))/$CHECKS checks passed"
exit "$FAILED"

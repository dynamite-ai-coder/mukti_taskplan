# mukti_taskplan

Portable **OpenCode multi-agent system** with a Task Planner, parallel Builders, a
Playwright Browser agent, a strict Reviewer and an Integrator. All inter-agent
coordination goes through compressed protocols:

| Protocol | Purpose | Spec |
| --- | --- | --- |
| **AACP** | compact coordination packets (task routing, verbs, resource URIs) | [`global/protocols/aacp.md`](global/protocols/aacp.md) |
| **ACCP** | context-state snapshots between handoffs (facts + delta, never transcripts) | [`global/protocols/accp.md`](global/protocols/accp.md) |
| **A2A** | remote agent discovery + JSON-RPC/SSE transport | [`global/protocols/a2a.md`](global/protocols/a2a.md) |

Built for **DeepSeek V4** with a **5-account key pool**: `deepseek-v4-pro` for
planner/reviewer/integrator, `deepseek-v4-flash` for the parallel builders and browser.

```
planner (primary, Pro)
   |  AACP DISPATCH (task IDs only)
   +--> builder-1 (account 2) --\
   +--> builder-2 (account 3) ---+--> reviewer (Pro) --ACK/FAIL--> integrator (Pro)
   +--> builder-3 (account 4) --/
   +--> browser  (account 5) ---> A2A :8789 -> browser-control MCP -> ARIA snapshots
a2a-registry MCP :8788  |  aacp-codec MCP  |  key-rotator (429 failover)
```

## Quickstart

```bash
cp .env.example .env                 # fill DEEPSEEK_KEY_1..5
bash scripts/install-global.sh       # install agents/protocols/scripts globally
bash scripts/verify-prereqs.sh       # step 1 checks
bash scripts/smoke-test.sh --static  # 7/7 static checks

source .env
opencode run --agent planner "@planner decompose the goal in task-dag.json and dispatch the swarm"
# or run a full DAG with side-channel logs:
bash global/templates/multiagent-project/scripts/dispatch-swarm.sh task-dag.json
```

## Layout

```
.opencode/agents/       planner, builder-1..3, browser, reviewer, integrator
.opencode/plugins/      protocol-logger (AACP/ACCP/A2A side channel)
.opencode/tools/        get-key (5-account failover, never exposes secrets)
global/protocols/       AACP / ACCP / A2A specs + aacp-encoder
global/scripts/         a2a-registry(+MCP), browser-a2a-server, key-rotator, dashboard, summary
global/context/         task-dag schema, token budget
global/templates/       drop-in multiagent-project template
scripts/                install-global, verify-prereqs, smoke-test
```

## Observability

```bash
tail -f logs/*.log | node global/scripts/dashboard.js   # live packet/A2A dashboard
node global/scripts/summary.js <run_id>                 # reports/budget-<run_id>.json
```

Target: **<= 1500 tokens / 4-hop flow** (from a ~4500-token naive baseline).

Full documentation: [`README-multiagent.md`](README-multiagent.md).

## Security

- Secrets only via env vars (`{env:DEEPSEEK_KEY_N}`); `.env`, `logs/`, `reports/` are git-ignored.
- Local DIDs + HMAC-SHA256 envelope signing; enable `A2A_REQUIRE_SIGNATURES=true` in production.
- Registry enforces a capability whitelist; planner can only dispatch to registered agents.
- The `get-key` tool returns account slots, never raw API keys.

The complete build specification lives in [`promt.txt`](promt.txt).

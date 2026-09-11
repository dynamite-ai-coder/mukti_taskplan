# mukti_taskplan

Portable **OpenCode multi-agent system** with a Task Planner, parallel Builders, a
Playwright Browser agent, a strict Reviewer and an Integrator. All inter-agent
coordination goes through compressed protocols:

| Protocol | Purpose | Spec |
| --- | --- | --- |
| **AIL** | **AI-native interlingua** — positional frames + symbol dictionary (default wire language) | [`global/protocols/ail.md`](global/protocols/ail.md) |
| **AACP** | compact coordination packets (human-readable fallback) | [`global/protocols/aacp.md`](global/protocols/aacp.md) |
| **ACCP** | context-state snapshots between handoffs (facts + delta, never transcripts) | [`global/protocols/accp.md`](global/protocols/accp.md) |
| **A2A** | remote agent discovery + JSON-RPC/SSE transport | [`global/protocols/a2a.md`](global/protocols/a2a.md) |

Built for **DeepSeek V4** with a **5-account key pool**: `deepseek-v4-pro` for
planner/reviewer/integrator, `deepseek-v4-flash` for the parallel builders and browser.
Agents write AIL frames (`>1x9k|D|t1|b|c|#a3f2|fo|p1`) instead of human JSON — one
dictionary delta per peer, then positional frames only (**57-95% fewer coordination tokens**).

```
planner (primary, Pro)
   |  AIL control/directive frames (task IDs + symbol handles only)
   +--> builder-1 (account 2) --\
   +--> builder-2 (account 3) ---+--> reviewer (Pro) --AIL ACK/FAIL--> integrator (Pro)
   +--> builder-3 (account 4) --/
   +--> browser  (account 5) ---> A2A :8789 -> browser-control MCP -> ARIA snapshots
a2a-registry MCP :8788  |  aacp-codec + ail-codec MCP  |  key-rotator (429 failover)
```

## Quickstart

```bash
cp .env.example .env                 # fill DEEPSEEK_KEY_1..5
bash scripts/install-global.sh       # install agents/protocols/scripts globally
bash scripts/verify-prereqs.sh       # step 1 checks
bash scripts/smoke-test.sh --static  # 10/10 static checks

source .env
opencode run --agent planner "@planner decompose the goal in task-dag.json and dispatch the swarm"
# or run a full DAG with side-channel logs:
bash global/templates/multiagent-project/scripts/dispatch-swarm.sh task-dag.json
```

## Deploy on Render (web service)

The repo ships a single-container Render deployment: OpenCode server + A2A registry +
browser agent + public gateway API. See [`deploy/render/gateway.js`](deploy/render/gateway.js).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dynamite-ai-coder/mukti_taskplan)

1. In Render: **New -> Blueprint**, select this repo. It reads [`render.yaml`](render.yaml)
   (Docker, health check `/health`, 1 GB disk at `/data`, `SERVICE_API_KEY`/`A2A_SECRET`
   auto-generated).
2. Set the five `DEEPSEEK_KEY_N` secrets in the dashboard (`sync: false`).
3. Deploy; then drive the service:

```bash
curl https://<service>.onrender.com/health
curl -X POST https://<service>.onrender.com/swarm \
  -H "Authorization: Bearer $SERVICE_API_KEY" -H "content-type: application/json" \
  -d '{"objective":"Build a todo app","tasks":[]}'
curl -H "Authorization: Bearer $SERVICE_API_KEY" https://<service>.onrender.com/jobs
```

Gateway API: `/health`, `/.well-known/agent.json`, `/swarm`, `/jobs/:id[/log|/summary]`,
`/stream` (SSE), `/agents`, and proxies `/a2a/*`, `/browser/*`, `/opencode/*`.
The [`Dockerfile`](Dockerfile) installs Chromium with `--no-sandbox` for containers.

## Layout

```
.opencode/agents/       planner, builder-1..3, browser, reviewer, integrator
.opencode/plugins/      protocol-logger (AIL/AACP/ACCP/A2A side channel)
.opencode/tools/        get-key (5-account failover, never exposes secrets)
global/protocols/       AIL spec+codec, AACP/ACCP/A2A specs, aacp-encoder
global/scripts/         ail-log, ail-codec MCP, a2a-registry(+MCP), browser-a2a-server,
                        key-rotator, dashboard, summary
global/context/         task-dag schema, token budget
global/templates/       drop-in multiagent-project template
deploy/render/          Render gateway (web service entrypoint)
Dockerfile render.yaml  Render deployment (Chromium, OpenCode, gateway)
scripts/                install-global, verify-prereqs, smoke-test
```

## Observability

```bash
tail -f logs/*.log | node global/scripts/dashboard.js   # live AIL/AACP/A2A dashboard
node global/scripts/summary.js <run_id>                 # reports/budget-<run_id>.json
```

Targets: **<= 1500 tokens / 4-hop** with AACP, **<= 900 tokens / 4-hop** with AIL
(from a ~4500-token naive baseline). A measured dispatch -> result -> state -> reason ->
ack cycle costs 54 AIL tokens (95% below baseline).

Full documentation: [`README-multiagent.md`](README-multiagent.md).

## Security

- Secrets only via env vars (`{env:DEEPSEEK_KEY_N}`); `.env`, `logs/`, `reports/` are git-ignored.
- Local DIDs + HMAC-SHA256 envelope signing; enable `A2A_REQUIRE_SIGNATURES=true` in production.
- Registry enforces a capability whitelist; planner can only dispatch to registered agents.
- The `get-key` tool returns account slots, never raw API keys.

The complete build specification lives in [`promt.txt`](promt.txt).

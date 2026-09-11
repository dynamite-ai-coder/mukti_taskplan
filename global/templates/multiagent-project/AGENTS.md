# AGENTS.md — host project (planner-only)

This is a **host project** that uses the globally installed **planner**. It does not ship
any workers: the planner decomposes an objective into a `task-dag.json` and dispatches
tasks to agents that **this project registers itself** in the A2A registry.

The integration contract is:

1. The planner lives in the global install (`~/.config/opencode/agents/planner.md`) and is
   reused by every host project.
2. The host project declares its own agents by registering their A2A Agent Cards with the
   local registry. Capabilities are what the planner discovers and routes by
   (`code_gen`, `web_navigate`, `test`, `review`, `integration`, ...).
3. The planner never assumes an agent name, model or account — every dispatch target comes
   from the registry at runtime.

## Setup

```bash
# 1. Install the planner core once, from the planner repo:
bash scripts/install-global.sh          # run inside the planner repo

# 2. Configure this project (A2A + logs only; the planner key lives in the
#    host's global OpenCode config, not here):
cp .env.example .env

# 3. Start the registry and register this project's agents (their cards).
```

## Decompose an objective

```bash
source .env
opencode run --agent planner "@planner decompose the objective in objective.md into task-dag.json"
```

The planner discovers registered agents through the A2A registry and emits one AIL/AACP
`DISPATCH` frame per ready task, referencing the task ID and `ref: ["task-dag.json"]`.

## Register your own agents

Agents are registered at runtime through the registry MCP/HTTP API, for example:

```bash
curl -s localhost:${A2A_REGISTRY_PORT:-8788}/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"registry.register","params":{"card":{
        "did":"did:local:builder-1","name":"builder-1",
        "capabilities":["code_gen","code_write"],
        "endpoints":{"rpc":"http://127.0.0.1:9001/rpc"},
        "trust":0.9}}}'
```

Then the planner will find it with `a2a_discover` for a matching capability. If no agent
matches a ready task, the planner marks it `meta.remote: true` and leaves it queued.

## Build / test / lint commands

Replace with the real commands for this project — the agents you register run these:

| Action | Command |
| --- | --- |
| Build | `npm run build` |
| Test | `npm test` |
| Lint | `npm run lint` |

## Conventions

- Agents speak **AIL first** (`~/.config/opencode/protocols/ail.md`), AACP as fallback.
  Task bodies live only in `task-dag.json`; agents exchange AIL frames with task IDs and
  dictionary handles (`#a3f2`) instead of inline content.
- Handoffs carry AIL state frames (or ACCP snapshots), never transcripts.
- Remote agents are discovered through the A2A registry (port `${A2A_REGISTRY_PORT:-8788}`).
- Side-channel logs are mandatory and git-ignored: `logs/ail.log`, `logs/ail-dict.jsonl`,
  `logs/aacp.log`, `logs/accp.jsonl`, `logs/a2a.log`.
- Secrets only via env vars; never commit `.env`.

## Deploy on Render

`Dockerfile` + `render.yaml` are included and deploy the **planner A2A service**: it serves
`/health`, `/.well-known/agent.json`, a `decompose` RPC and proxies `/a2a/*` to the
in-process registry. Set `A2A_SECRET` and `SERVICE_API_KEY` in the Render dashboard; logs
and reports live on the `/data` disk.

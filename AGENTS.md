# AGENTS.md — mukti_taskplan (planner-only repo)

## What this repo is

mukti_taskplan exports **one reusable agent**: the planner
(`.opencode/agents/planner.md`). It decomposes a goal into `task-dag.json`, discovers
agents in the A2A registry, dispatches task IDs, consumes `RESULT` + snapshots, and
honours `ACK`/`FAIL`. The installed core contains **no worker agents** — host projects
connect their own through Agent Cards.

## Repo rules (this repo)

- **Planner-only core.** Keep `.opencode/agents/planner.md` host-agnostic: no hardcoded
  agent names, roles, models or accounts. Every target is discovered at runtime via
  `a2a_list` / `a2a_discover`.
- **Worker agents are examples.** `examples/agents/` holds optional reference prompts
  (builder-1/2/3, browser, reviewer, integrator). They are **not** installed by
  `scripts/install-global.sh` and must not be treated as dependencies.
- **Never inline task bodies.** Inter-agent messages carry the task ID plus
  `ref: ["task-dag.json"]`; the body stays in the DAG.
- **AIL first.** Emit AIL frames (`global/protocols/ail.md`) where possible, AACP JSON
  (`global/protocols/aacp.md`) as fallback. Handoffs carry ACCP snapshots
  (`global/protocols/accp.md`), never transcripts.
- **Side-channel logs are mandatory**: `logs/ail.log`, `logs/ail-dict.jsonl`,
  `logs/aacp.log`, `logs/accp.jsonl`, `logs/a2a.log`.
- **Secrets only via env vars** (`{env:DEEPSEEK_KEY_N}`); never hardcode keys in configs.

## How host agents interact

1. Register an Agent Card (`did`, `name`, `capabilities`, `endpoints.rpc`) — MCP
   `a2a_register` or JSON-RPC `registry.register` on port 8788.
2. The planner discovers it with `a2a_list` / `a2a_discover` and routes work with
   `a2a_dispatch` (`task.dispatch`) to the card's RPC endpoint.
3. The agent receives an AACP `DISPATCH` (or AIL `>` frame) carrying a task ID and
   `ref: ["task-dag.json"]`, reads the body from the DAG, executes, and replies a
   `RESULT` plus an ACCP snapshot (or AIL `$` state frame).
4. A registered `reviewer`-capability agent emits `ACK`/`FAIL`; the planner marks a task
   done only on `ACK` and requeues on `FAIL` or timeout.

## Setup

```bash
cp .env.example .env          # fill DEEPSEEK_KEY_1..5 (only the accounts your host uses)
bash scripts/install-global.sh
bash scripts/verify-prereqs.sh
bash scripts/smoke-test.sh --static
```

## Invoke the planner

```bash
source .env
opencode run --agent planner "@planner decompose the goal in task-dag.json and dispatch ready tasks to registered agents"
```

## Build / test / lint commands (this repo)

| Action | Command |
| --- | --- |
| Syntax + protocol checks | `bash scripts/smoke-test.sh --static` |
| Verify environment | `bash scripts/verify-prereqs.sh` |
| Validate resolved config | `opencode debug config` |
| Install planner globally | `bash scripts/install-global.sh` |
| A2A registry health | `curl -s localhost:8788/.well-known/agent.json` |
| A2A registry agents | `curl -s localhost:8788/rpc -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"registry.list","params":{}}'` |
| AIL token benchmark | `node global/protocols/ail-codec.js bench '<aacp json>' '<frame json>'` |
| Per-run summary | `node global/scripts/summary.js <run_id>` |
| Live log dashboard | `tail -f logs/*.log \| node global/scripts/dashboard.js` |
| Render gateway (local) | `DATA_DIR=/tmp/mukti PORT=10000 node deploy/render/gateway.js` |

## Conventions

- AIL-first (`global/protocols/ail.md`), AACP fallback; ACCP snapshots for handoffs.
- Task IDs only; never inline a task body. Long paths/URLs become dictionary handles (`#a3f2`).
- Remote agents are discovered through the A2A registry (`global/protocols/a2a.md`); the
  planner can only dispatch to registered agents.
- Worker agents live in `examples/agents/` and are **not** part of the installed core.
- Secrets only via env vars (`{env:DEEPSEEK_KEY_N}`); never hardcode keys in configs.

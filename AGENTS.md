# AGENTS.md — mukti_taskplan multi-agent template

## What this repo is

A portable OpenCode multi-agent system (planner / builders / browser / reviewer / integrator)
that coordinates through AACP + ACCP + A2A packets and a 5-account DeepSeek key pool.

## Setup

```bash
cp .env.example .env          # then fill DEEPSEEK_KEY_1..5
bash scripts/install-global.sh
bash scripts/verify-prereqs.sh
```

## Dispatch a swarm

```bash
source .env
opencode run --agent planner "@planner decompose the goal in task-dag.json and dispatch the swarm"
# or stream a whole DAG:
bash global/templates/multiagent-project/scripts/dispatch-swarm.sh task-dag.json
```

## Build / test / lint commands (this repo)

| Action | Command |
| --- | --- |
| Syntax-check all JS | `bash scripts/smoke-test.sh --static` |
| Verify environment | `bash scripts/verify-prereqs.sh` |
| Validate resolved config | `opencode debug config` |
| A2A registry health | `curl -s localhost:8788/.well-known/agent.json` |
| Browser A2A health | `curl -s localhost:8789/.well-known/agent.json` |
| AIL token benchmark | `node global/protocols/ail-codec.js bench '<aacp json>' '<frame json>'` |
| Per-run summary | `node global/scripts/summary.js <run_id>` |
| Live log dashboard | `tail -f logs/*.log \| node global/scripts/dashboard.js` |
| Render gateway (local) | `DATA_DIR=/tmp/mukti PORT=10000 node deploy/render/gateway.js` |

## Conventions

- Coordination language is **AIL first** (`global/protocols/ail.md`), AACP as fallback.
  Never inline a task body in an inter-agent message; send the task ID and the
  `task-dag.json` URI. Long paths/URLs become dictionary handles (`#a3f2`).
- Handoffs carry **AIL state frames** (or ACCP snapshots), never transcripts.
- Remote agents are discovered through the A2A registry (`global/protocols/a2a.md`).
- Every agent output that crosses a boundary is one AIL frame or one JSON object per line.
- Side-channel logs are mandatory: `logs/ail.log`, `logs/aacp.log`, `logs/accp.jsonl`,
  `logs/a2a.log`, `logs/ail-dict.jsonl`.
- Secrets only via env vars (`{env:DEEPSEEK_KEY_N}`); never hardcode keys in configs.

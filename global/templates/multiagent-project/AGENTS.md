# AGENTS.md — multi-agent project

This project runs the mukti_taskplan swarm: planner -> builders -> reviewer -> integrator,
coordinated with AACP packets, ACCP snapshots and the A2A registry.

## Dispatch a swarm

```bash
cp .env.example .env              # fill DEEPSEEK_KEY_1..5
source .env
opencode run --agent planner "@planner decompose the goal in task-dag.json and dispatch the swarm"
# or stream a whole DAG:
bash scripts/dispatch-swarm.sh task-dag.json
```

## Build / test / lint commands

Replace with the real commands for this project — builders and the reviewer run these:

| Action | Command |
| --- | --- |
| Build | `npm run build` |
| Test | `npm test` |
| Lint | `npm run lint` |

## Conventions

- Task bodies live only in `task-dag.json`; agents exchange only AACP packets with task IDs.
- Handoffs carry ACCP snapshots (`~/.config/opencode/protocols/accp.md`), never transcripts.
- Remote agents are discovered through the A2A registry (port 8788).
- Side-channel logs are mandatory and git-ignored: `logs/aacp.log`, `logs/accp.jsonl`, `logs/a2a.log`.
- Secrets only via env vars; never commit `.env`.

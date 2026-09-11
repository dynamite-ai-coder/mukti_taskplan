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

- Agents speak **AIL first** (`~/.config/opencode/protocols/ail.md`), AACP as fallback.
  Task bodies live only in `task-dag.json`; agents exchange AIL frames with task IDs and
  dictionary handles (`#a3f2`) instead of inline content.
- Handoffs carry AIL state frames (or ACCP snapshots), never transcripts.
- Remote agents are discovered through the A2A registry (port 8788).
- Side-channel logs are mandatory and git-ignored: `logs/ail.log`, `logs/ail-dict.jsonl`,
  `logs/aacp.log`, `logs/accp.jsonl`, `logs/a2a.log`.
- Secrets only via env vars; never commit `.env`.

## Deploy on Render

`Dockerfile` + `render.yaml` are included: Render -> New -> Blueprint -> select the repo,
then set `DEEPSEEK_KEY_1..5`. The gateway serves `/health`, `/swarm`, `/jobs`, `/stream`,
`/agents` and proxies `/a2a/*`, `/browser/*`, `/opencode/*`; logs and reports live on the
`/data` disk.

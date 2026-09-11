# examples/ — optional reference agents

These are **example worker agents** for host projects that want to drive the
mukti_taskplan planner with a ready-made worker set. They are **reference
implementations only**:

- They are **not installed** by `scripts/install-global.sh` (which installs only the
  planner plus the shared protocols/scripts).
- The planner does **not** depend on them. It discovers agents at runtime through the A2A
  registry by capability, so any agent that respects the contract works.
- Copy or adapt them into your own host project if they fit; rewrite the model, permissions
  and workflow to match your environment.

The planner itself is the only agent this repo exports:
[`../.opencode/agents/planner.md`](../.opencode/agents/planner.md).

## The six examples

| File | Role | Description |
| --- | --- | --- |
| [`agents/builder-1.md`](agents/builder-1.md) | builder | Executes exactly one atomic DAG task; reports AACP `RESULT` + ACCP snapshot. |
| [`agents/builder-2.md`](agents/builder-2.md) | builder | Same contract as builder-1; a second parallel worker. |
| [`agents/builder-3.md`](agents/builder-3.md) | builder | Same contract as builder-1; a third parallel worker. |
| [`agents/browser.md`](agents/browser.md) | browser | Navigates real sites with ARIA snapshots, fills forms, extracts data; speaks A2A + AACP. |
| [`agents/reviewer.md`](agents/reviewer.md) | reviewer | Validates ACCP snapshots and DAG evidence; emits AACP `ACK` or `FAIL`. |
| [`agents/integrator.md`](agents/integrator.md) | integrator | Merges ACKed outputs, resolves conflicts, produces the final artifact + report. |

Each file starts with `<!-- EXAMPLE agent for host projects — copy into your project, not
installed by this repo. -->`.

## How to use them

1. Copy the file(s) you want into your host project's agent directory, e.g.
   `cp examples/agents/builder-1.md ~/work/my-app/.opencode/agents/` (or into
   `~/.config/opencode/agents/`).
2. Point each agent's `model:` at a provider/model configured in **your**
   `opencode.json` — the examples reference `deepseek-account-2..5`, which only exist if
   you configured those accounts. Replace them with your own provider/model strings.
3. Keep `permission.task` on the planner open (`task: allow`) so it can reach host-local
   subagents, or register the agent's RPC endpoint as an Agent Card so the planner routes
   to it over A2A.
4. Assign each task a disjoint `writes` glob in `task-dag.json` so parallel workers do not
   collide.

## Capabilities they advertise

When registering these as remote agents (or mapping them to DAG tasks), typical
capabilities are:

| Agent | Capabilities |
| --- | --- |
| builder-1/2/3 | `code_gen`, `test` |
| browser | `web_navigate`, `form_fill`, `data_extract`, `screenshot` |
| reviewer | `review` |
| integrator | `integration`, `merge` |

## What they assume

The examples read the shared protocols and use the global scripts, so they expect a prior
`bash scripts/install-global.sh`:

- `~/.config/opencode/protocols/aacp.md`, `accp.md`, `ail.md`
- `~/.config/opencode/context/task-dag.md`
- `~/.config/opencode/scripts/ail-log.js` (and `aacp-log.js` fallback)

They follow the repo conventions: AIL first with AACP fallback, task IDs only (never
inline task bodies), and ACCP snapshots for handoffs. See [`../README.md`](../README.md)
and [`../README-multiagent.md`](../README-multiagent.md).

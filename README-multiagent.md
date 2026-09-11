# README-multiagent.md — OpenCode multi-agent system v2.0

Portable multi-agent template for OpenCode + DeepSeek V4 (5 accounts) with
**AACP** (coordination compression), **ACCP** (context compression), **A2A**
(remote agent discovery/transport) and a Playwright browser agent.

```
LAYER 1  OpenCode CLI ................ agent runtime
LAYER 2  5x DeepSeek accounts ........ V4-Flash builders, V4-Pro planner/reviewer
LAYER 3  AACP + ACCP + A2A ........... compressed coordination
LAYER 4  browser-control MCP ......... ARIA-snapshot web automation
LAYER 5  key pool + 429 failover ..... resilience
```

Roles: `planner` (primary) -> `builder-1..3` (parallel) + `browser` (A2A) ->
`reviewer` (ACK/FAIL) -> `integrator` (primary).

---

## 1. Install in a new project

```bash
git clone <this-repo> mukti_taskplan
cd mukti_taskplan

cp .env.example .env          # fill DEEPSEEK_KEY_1..5
bash scripts/install-global.sh
bash scripts/verify-prereqs.sh
```

`install-global.sh` merges providers + MCP servers into `~/.config/opencode/opencode.json`
(existing keys are preserved, a `.bak.<timestamp>` backup is written) and copies
`agents/`, `protocols/`, `context/`, `scripts/`, `plugins/`, `tools/`, `templates/`
into `~/.config/opencode/`.

To scaffold a new project:

```bash
bash scripts/install-global.sh --project ~/work/my-app
cd ~/work/my-app
cp .env.example .env && $EDITOR .env
```

The project template expects the global install; `opencode.json` in the project only
pins models, MCP usage and `default_agent: planner`.

## 2. Set the 5 API keys

Each account maps to a provider (`deepseek-account-1..5`) in `opencode.json` and reads
`{env:DEEPSEEK_KEY_N}`. Never hardcode keys. Account assignment:

| Account | Provider | Used by |
| --- | --- | --- |
| 1 | `deepseek-account-1` | planner, reviewer, integrator (V4-Pro), `small_model` (V4-Flash) |
| 2 | `deepseek-account-2` | builder-1 (V4-Flash) |
| 3 | `deepseek-account-3` | builder-2 (V4-Flash) |
| 4 | `deepseek-account-4` | builder-3 (V4-Flash) |
| 5 | `deepseek-account-5` | browser (V4-Flash) |

```bash
source .env
opencode models | grep deepseek-account
```

## 3. Dispatch a swarm

Interactive: switch to the `planner` agent (Tab) or mention it:

```
@planner Build a simple todo app with HTML/CSS/JS. Decompose into tasks.
```

CLI with a DAG:

```bash
source .env
opencode run --agent planner "@planner decompose the goal in task-dag.json and dispatch the swarm"

# full pipeline with side-channel logging + budget report:
bash scripts/dispatch-swarm.sh task-dag.json
bash scripts/dispatch-swarm.sh task-dag.json --with-browser
```

Flow: planner writes the DAG -> emits AACP `DISPATCH` per task -> Task tool invokes
`builder-1..3` / `browser` in parallel -> each returns `RESULT` + ACCP snapshot ->
`reviewer` emits `ACK`/`FAIL` -> `integrator` merges ACKed tasks into the final artifact.

## 4. Add custom roles

1. Create `~/.config/opencode/agents/my-role.md`:

   ```markdown
   ---
   description: One-line description used for Task-tool routing.
   mode: subagent
   model: deepseek-account-3/deepseek-v4-flash
   permission:
     read: allow
     edit: allow
     bash: allow
     task: deny
   ---
   You are ... follow protocols/aacp.md and protocols/accp.md ...
   ```

2. Allow the planner to invoke it by adding `my-role: allow` under
   `permission.task` in `agents/planner.md`.
3. Use a distinct `writes` glob in the DAG for every new role (conflict boundary).

## 5. Extend AACP with new verbs

1. Add the verb to the spec (`protocols/aacp.md`) and to `OPS` in
   `protocols/aacp-encoder.js`.
2. Add its semantics to the verb table (direction + expected `ret`).
3. Update consumers that switch on `op` (reviewer/integrator prompts, `summary.js`).
4. Keep packets one-line JSON; bump `v` only for breaking field changes.

## 6. Extend A2A with new capabilities

1. Add the capability string to an agent's card `capabilities` array.
2. If the registry enforces a whitelist (`A2A_CAPABILITY_WHITELIST`), add it there.
3. Planner discovers it with the `a2a_discover` MCP tool; route work via `a2a_dispatch`.
4. Long operations should stream status over SSE (`/stream`).

## 7. Interpret ACCP snapshots

```json
{
  "v": 1, "run_id": "run-2026-09-11-abc123", "cursor": "t5",
  "facts": [
    { "k": "files_created", "v": ["src/a.js"] },
    { "k": "tests_passing", "v": true },
    { "k": "blockers", "v": [] }
  ],
  "intent": "code_gen",
  "delta": ["added localStorage persistence"],
  "hash": "sha256:..."
}
```

`facts` = durable state (must match DAG evidence), `delta` = last step only. Identical
`hash` = cache hit. Reviewers accept snapshots, never transcripts.

## 8. Troubleshoot 429s

- Native OpenCode multi-provider does **not** auto-rotate on 429. This template uses two
  layers:
  - **Pinning**: each builder/browser uses a different `deepseek-account-N`, so a 429 on
    one account does not affect the others.
  - **Rotator**: `scripts/key-rotator.js` (and the `get-key` custom tool) tracks in-flight
    requests per key, cools a key on 429, and exposes `key_switches_total`.

```bash
node ~/.config/opencode/scripts/key-rotator.js status
node ~/.config/opencode/scripts/key-rotator.js next
DEEPSEEK_KEY_1=x node ~/.config/opencode/scripts/key-rotator.js test
```

The `get-key` tool never returns raw keys — only the account/env slot, so the model
cannot leak secrets. It accepts `rate_limited_account: N` to trigger failover.

## 9. Read the dashboard

```bash
tail -f logs/*.log | node ~/.config/opencode/scripts/dashboard.js
node ~/.config/opencode/scripts/dashboard.js --dir logs --once
node ~/.config/opencode/scripts/summary.js <run_id>
```

- `logs/aacp.log` — AACP packets (JSON lines)
- `logs/accp.jsonl` — ACCP snapshots
- `logs/a2a.log` — A2A RPC calls / dispatches
- `reports/budget-<run_id>.json` — token budget vs the 4500-token naive baseline

A run is on budget when `savings_pct >= 30`.

## 10. Observability via plugin

`plugins/protocol-logger.js` hooks `tool.execute.before/after` and writes every Task-tool
dispatch and every AACP/ACCP line it sees to the side-channel logs. A `globalThis` guard
prevents double logging when both the global and project copies are loaded.

## 11. Security & trust

- Local DIDs for remote agents (`did:local:browser-agent`, `did:local:a2a-registry`).
- HMAC-SHA256 envelope signing (`A2A_SECRET`); set `A2A_REQUIRE_SIGNATURES=true` in prod.
- Registry capability whitelist via `A2A_CAPABILITY_WHITELIST`.
- Planners can only dispatch to registry-registered agents.
- Secrets only via env vars; `.env`, `logs/` and `reports/` are git-ignored.

## 12. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `browser-control` MCP fails | `npm i -g playwright-core && npx playwright install chromium` |
| Browser launch hangs/fails as root | the wrapper auto-injects `--no-sandbox` via `CHROMIUM_USER_FLAGS`; override with `BROWSER_NO_SANDBOX=false`, or raise `BROWSER_MCP_TIMEOUT_MS` |
| A2A registry port busy | `A2A_REGISTRY_PORT=9788` (update `.env` and MCP config) |
| `agent.json` 404 for browser | start `node ~/.config/opencode/scripts/browser-a2a-server.js` |
| 429 from DeepSeek | use `get-key`, or pin builders to other accounts |
| No packets in `logs/aacp.log` | run via `dispatch-swarm.sh`; the plugin only sees Task-tool traffic |
| `opencode debug config` errors | check JSON in `~/.config/opencode/opencode.json` |

## 13. Repo layout

```
opencode.json                  project config (5 providers + 3 MCP servers)
AGENTS.md                      repo rules for agents
.opencode/agents/              canonical agent markdown (installed globally)
.opencode/plugins/             protocol-logger side-channel plugin
.opencode/tools/               get-key custom tool
global/protocols/              aacp.md, aacp-encoder.js, accp.md, a2a.md
global/context/                task-dag.md, budget.md
global/scripts/                key-rotator, a2a-registry(+mcp), browser-a2a-server, dashboard, summary, ...
global/templates/              multiagent-project drop-in template
scripts/                       install-global.sh, verify-prereqs.sh, smoke-test.sh
```

## 14. Smoke test

```bash
bash scripts/smoke-test.sh --static   # syntax, JSON, MCP handshakes, rotator
bash scripts/smoke-test.sh            # + live A2A registry + summary
bash scripts/smoke-test.sh --live     # + real planner run (needs DEEPSEEK_KEY_1/2)
```

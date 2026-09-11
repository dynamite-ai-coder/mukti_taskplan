# mukti_taskplan — reusable task-decomposition agent (planner)

**mukti_taskplan** packages exactly one reusable OpenCode agent: the **planner**. Given a
goal, it decomposes the work into a `task-dag.json`, discovers agents through the **A2A
registry**, dispatches each ready task with a compact AIL/AACP packet, and consumes the
`RESULT` plus its context snapshot. It never executes a task itself (no file writes, no
bash).

The repo does **not** bundle worker agents. Host projects connect their own agents by
registering an **Agent Card**; the planner discovers them at runtime by capability.

## What it is

- **One agent, planner-only.** The installed core is
  [`.opencode/agents/planner.md`](.opencode/agents/planner.md). It decomposes, routes and
  never executes.
- **Discovery, not assumptions.** The planner calls `a2a_list` / `a2a_discover` and routes
  by capability — never by a hardcoded agent name, model or account. If nothing matches a
  ready task, it marks the task `meta.remote: true` and leaves it queued.
- **Compressed coordination.** AIL frames are the default wire language; AACP JSON is the
  fallback. Handoffs carry ACCP state snapshots, never transcripts.
- **Host-owned workers.** Builders, browsers, reviewers and integrators are examples, not
  dependencies. See [`examples/agents/`](examples/agents/).

## Quickstart

Prerequisites: Node.js >= 22.19.0 and the OpenCode CLI (checked by
`scripts/verify-prereqs.sh`).

```bash
cp .env.example .env                 # fill DEEPSEEK_KEY_1 (planner) and any others you use
bash scripts/install-global.sh       # installs the planner + protocols/scripts into ~/.config/opencode
bash scripts/verify-prereqs.sh       # Node, OpenCode, ports 8788/8789
bash scripts/smoke-test.sh --static  # offline: syntax, JSON, AIL/AACP round-trips, MCP handshakes
```

Invoke the planner on a goal:

```bash
source .env
opencode run --agent planner \
  "@planner decompose the goal in task-dag.json and dispatch ready tasks to agents registered in the A2A registry"
```

The planner emits a `task-dag.json` document plus one `DISPATCH` per ready task. To scaffold
a host project with the template config and dispatch helper:

```bash
bash scripts/install-global.sh --project ~/work/my-app
```

## How to connect your own agent

The integration contract has four steps.

**1. Register an Agent Card** with the local A2A registry (port 8788). Required fields are
`did`, `name`, `capabilities`, and `endpoints.rpc`:

```json
{
  "did": "did:local:my-builder",
  "name": "my-builder",
  "capabilities": ["code_gen", "test"],
  "endpoints": {
    "rpc": "http://127.0.0.1:8790/rpc",
    "stream": "http://127.0.0.1:8790/stream"
  },
  "limits": { "max_rps": 5, "timeout_ms": 60000 },
  "trust": 0.9
}
```

Register it with the `a2a_register` MCP tool (`{ "card": { ... } }`) or over JSON-RPC:

```bash
curl -s http://127.0.0.1:8788/rpc -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "registry.register",
  "params": { "card": { "did": "did:local:my-builder", "name": "my-builder",
    "capabilities": ["code_gen", "test"],
    "endpoints": { "rpc": "http://127.0.0.1:8790/rpc" } } }
}'
```

**2. The planner discovers you.** Before routing, the planner calls `a2a_list` (all agents)
or `a2a_discover` (capability match, e.g. `code_gen`) and picks a target by `did` or `name`.

**3. You receive a `DISPATCH`.** The planner routes an AACP `DISPATCH` (or AIL `>` control
frame) through `a2a_dispatch`, which the registry proxies to your `endpoints.rpc` as
JSON-RPC `task.dispatch`. The packet carries only the **task ID** and
`ref: ["task-dag.json"]` — read the task body from the DAG file.

```json
{"v":1,"op":"DISPATCH","task":"t1","role":"builder","dom":"code","ref":["task-dag.json"],"ret":["files","stdout"]}
```

Your endpoint must answer the JSON-RPC method `task.dispatch` with
`params: { "packet": {...}, "from": "did:local:a2a-registry" }` and return the result
synchronously (the registry proxy times out after 60 s; acknowledge long work and report
via the side channel / SSE).

**4. You reply `RESULT` + snapshot.** Execute the task, then return an AACP `RESULT` with
evidence, appended with an ACCP snapshot (or AIL `$` state frame):

```json
{"v":1,"op":"RESULT","task":"t1","role":"builder","ref":["index.html"],"ret":["files","stdout"]}
```

```json
{
  "v": 1, "run_id": "run-2026-09-12-abc123", "cursor": "t1",
  "facts": [{ "k": "files_created", "v": ["index.html"] }, { "k": "tests_passing", "v": true }],
  "intent": "code_gen", "delta": ["created index.html"], "hash": "sha256:..."
}
```

The registry stores the response on the job; the planner reads it back with
`task.result` / `task.status` (keyed by `job_id`).

A `reviewer`-capability agent is optional: register one and the planner forwards snapshots
for `ACK`/`FAIL`. Without one, the planner treats a well-formed `RESULT` as done and
requeues on timeout.

## Protocols

| Protocol | Purpose | Spec |
| --- | --- | --- |
| **AIL** | AI-native interlingua — positional frames + symbol dictionary (default wire language) | [`global/protocols/ail.md`](global/protocols/ail.md) |
| **AACP** | compact coordination packets (human-readable fallback) | [`global/protocols/aacp.md`](global/protocols/aacp.md) |
| **ACCP** | context-state snapshots between handoffs (facts + delta, never transcripts) | [`global/protocols/accp.md`](global/protocols/accp.md) |
| **A2A** | remote agent discovery + JSON-RPC 2.0/SSE transport | [`global/protocols/a2a.md`](global/protocols/a2a.md) |

The registry MCP front (`global/scripts/a2a-registry-mcp.js`) exposes `a2a_register`,
`a2a_unregister`, `a2a_list`, `a2a_discover` and `a2a_dispatch`. The `aacp-codec` and
`ail-codec` MCP servers provide encode/decode/log/bench tools.

## Layout

```
.opencode/agents/planner.md   the exported planner agent (installed by install-global.sh)
global/protocols/             ail.md + ail-codec.js, aacp.md + aacp-encoder.js, accp.md, a2a.md
global/scripts/               a2a-registry.js + a2a-registry-mcp.js, ail-codec-mcp.js,
                              aacp-codec-mcp.js, ail-log.js, aacp-log.js, dashboard.js,
                              summary.js, key-rotator.js, crypto-sign.js
global/context/               task-dag.md schema, budget.md
examples/agents/              optional reference workers (builder-1/2/3, browser, reviewer,
                              integrator) — NOT installed
global/templates/             multiagent-project host template
scripts/                      install-global.sh, verify-prereqs.sh, smoke-test.sh
deploy/, Dockerfile, render.yaml   optional Render web-service host
```

## Observability

```bash
tail -f logs/*.log | node global/scripts/dashboard.js   # AIL/AACP/A2A dashboard
node global/scripts/summary.js <run_id>                 # reports/budget-<run_id>.json
```

Side-channel logs: `logs/ail.log`, `logs/ail-dict.jsonl`, `logs/aacp.log`,
`logs/accp.jsonl`, `logs/a2a.log`. Targets: **<= 1500 tokens / 4-hop** with AACP,
**<= 900 tokens / 4-hop** with AIL (from a ~4500-token naive baseline).

## Security

- Secrets only via env vars (`{env:DEEPSEEK_KEY_N}`); `.env`, `logs/` and `reports/` are git-ignored.
- Local DIDs + HMAC-SHA256 envelope signing; set `A2A_REQUIRE_SIGNATURES=true` in production.
- The registry enforces a capability whitelist; the planner only dispatches to registered agents.
- The `get-key` tool returns account slots, never raw API keys.

Guide: [`README-multiagent.md`](README-multiagent.md) — **Connect an agent to the planner**.

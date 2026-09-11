# Connect an agent to the planner

A practical guide for host projects that use the **mukti_taskplan planner**. The planner
decomposes a goal into a `task-dag.json` and dispatches each ready task to an agent it
discovers in the **A2A registry**. This guide shows how to install the planner, stand up a
host project, register your own agent, and speak the dispatch protocol.

- The planner is the only agent installed by this repo (`.opencode/agents/planner.md`).
- Your agent can be local (an OpenCode subagent in your project) or remote (any process
  exposing a JSON-RPC endpoint). For remote agents, the registry is the contract.
- Reference worker prompts live in [`examples/agents/`](examples/agents/) — copy them if
  you want a starting point, but they are not installed and not required.

---

## 1. Install the planner globally

From a clone of this repo:

```bash
cp .env.example .env          # fill DEEPSEEK_KEY_1 (planner); add more accounts as needed
bash scripts/install-global.sh
bash scripts/verify-prereqs.sh
```

`install-global.sh`:

- merges the providers + MCP servers from `opencode.json` into
  `~/.config/opencode/opencode.json` (existing keys preserved; a
  `opencode.json.bak.<timestamp>` backup is written);
- copies the planner (`.opencode/agents/`), `global/protocols/`, `global/context/`,
  `global/scripts/`, plugins, tools and the project template into `~/.config/opencode/`;
- does **not** copy `examples/agents/`.

Verify:

```bash
opencode debug config                       # resolved config parses
curl -s localhost:8788/.well-known/agent.json   # registry card (starts on first a2a call)
```

`A2A_REGISTRY_PORT` (default `8788`) and `BROWSER_A2A_PORT` (default `8789`) can be
overridden via env.

## 2. Define a host project

Scaffold a project from the template (config + `task-dag.example.json` + dispatch helper +
optional Render assets):

```bash
bash scripts/install-global.sh --project ~/work/my-app
cd ~/work/my-app
cp .env.example .env && $EDITOR .env
```

The host project's `opencode.json`:

- pins `default_agent: planner` and the planner's `provider/model`;
- enables the MCP servers `a2a-registry`, `aacp-codec` and `ail-codec` (the template
  versions reference `~/.config/opencode/scripts/...`);
- optionally declares your own subagents under `agent` (for local agents).

Model accounts are referenced by env var only:

| Account | Provider | Typical use |
| --- | --- | --- |
| 1 | `deepseek-account-1` | planner (V4-Pro) |
| 2–5 | `deepseek-account-2..5` | whatever your host assigns to its workers |

The planner assumes nothing about which accounts exist — per-task `model` values are
`provider/model` strings supplied by your host, and every target is discovered at runtime.

## 3. Register an Agent Card

An Agent Card is the only thing the planner needs to find and call your agent. Required
fields: `did`, `name`, `capabilities`, `endpoints.rpc`.

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

| Field | Required | Notes |
| --- | --- | --- |
| `did` | yes | stable local DID, e.g. `did:local:my-builder` |
| `name` | yes | target handle the planner can pass to `a2a_dispatch` |
| `capabilities` | yes | capability strings, e.g. `code_gen`, `test`, `web_navigate`, `review` |
| `endpoints.rpc` | yes | your JSON-RPC 2.0 endpoint that answers `task.dispatch` |
| `endpoints.stream` | no | SSE endpoint for long-running `job.updated` events |
| `limits` | no | advertised `max_rps` / `timeout_ms` |
| `trust` | no | 0–1; the planner prefers higher trust among matching agents |

Register via the `a2a_register` MCP tool with `{ "card": { ... } }`, or over JSON-RPC:

```bash
curl -s http://127.0.0.1:8788/rpc -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "registry.register",
  "params": { "card": {
    "did": "did:local:my-builder", "name": "my-builder",
    "capabilities": ["code_gen", "test"],
    "endpoints": { "rpc": "http://127.0.0.1:8790/rpc" }
  } }
}'
```

Confirm discovery:

```bash
# all agents
curl -s http://127.0.0.1:8788/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"registry.list","params":{}}'
# capability match
curl -s http://127.0.0.1:8788/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"registry.discover","params":{"capability":"code_gen"}}'
```

Remove a card with `a2a_unregister` / `registry.unregister` (`{ "did": "..." }`).

## 4. The dispatch flow

```
host / user
   │ goal
   ▼
planner ── writes task-dag.json ──► a2a_list / a2a_discover  (registry :8788)
   │                                        │ cards
   │  AACP DISPATCH / AIL > frame           ▼
   └── a2a_dispatch ─► registry task.dispatch ─► your endpoint :8790 (JSON-RPC task.dispatch)
                                                        │ execute task body from task-dag.json
                                                        ▼
                                             RESULT + ACCP snapshot / AIL $ state
                                                        │
        planner ◄── task.result / task.status ──────────┘
           │ (optional reviewer) ─► ACK / FAIL
           ▼
     mark task done / requeue on FAIL or timeout
```

Step by step:

1. **Plan.** The planner writes `task-dag.json` (`run_id`, `objective`, `tasks[]`), each
   task with `id`, `role`, `blockedBy`, `evidence`, `writes`.
2. **Discover.** It calls `a2a_list` / `a2a_discover` and maps each ready task to a
   registered agent by capability, preferring higher `trust`.
3. **Dispatch.** For every ready task it emits one AACP `DISPATCH` (or AIL `>` control
   frame) carrying only the task ID and `ref: ["task-dag.json"]`, then routes it with
   `a2a_dispatch` → registry `task.dispatch` → your `endpoints.rpc`.
4. **Receive.** Your endpoint is called with JSON-RPC method `task.dispatch` and
   `params: { "packet": { ... }, "from": "did:local:a2a-registry" }`. Read the full task
   body from `task-dag.json` by the packet's `task` ID. Never expect the body on the wire.
5. **Reply.** Return the task outcome as the JSON-RPC `result`: an AACP `RESULT` packet
   plus an ACCP snapshot (or AIL `$` state frame). The registry stores it on the job and
   returns `{ job_id, status, result }` to the planner, which can re-read it with
   `task.result` (`{ "id": "<job_id>" }`).
6. **Review.** If a `reviewer`-capability agent is registered, the planner forwards the
   snapshot for `ACK`/`FAIL`; a task is done only on `ACK`, and `FAIL`/timeout requeues it.

The registry proxy waits up to **60 s** for your endpoint. For longer work, answer quickly
with an acknowledgement and stream progress over your `endpoints.stream` SSE, then write the
final `RESULT`/snapshot to the side channel.

### Packet examples

AACP control (human-readable fallback):

```json
{"v":1,"op":"DISPATCH","task":"t1","role":"builder","dom":"code","ref":["task-dag.json"],"ret":["files","stdout"]}
{"v":1,"op":"RESULT","task":"t1","role":"builder","ref":["index.html"],"ret":["files","stdout"]}
```

AIL control (default wire language; `>` = control, `D`/`R` = DISPATCH/RESULT, `b` = builder,
`c` = code):

```
>1x9k|D|t1|b|c|#a3f2|fo|p1
>1x9k|R|t1|b|_|#a3f2|fo|_
```

Emit into the side channel with:

```bash
node ~/.config/opencode/scripts/ail-log.js dispatch t1 '{"role":"builder","dom":"code","ref":["task-dag.json"]}'
node ~/.config/opencode/scripts/aacp-log.js result t1 '{"role":"builder","ref":["index.html"],"ret":["files"]}'
```

## 5. ACCP snapshot format

Handoffs carry a snapshot, never a transcript. Return one alongside your `RESULT`:

```json
{
  "v": 1,
  "run_id": "run-2026-09-12-abc123",
  "cursor": "t1",
  "facts": [
    { "k": "files_created", "v": ["index.html"] },
    { "k": "tests_passing", "v": true },
    { "k": "blockers", "v": [] }
  ],
  "intent": "code_gen",
  "delta": ["created index.html"],
  "hash": "sha256:..."
}
```

| Field | Meaning |
| --- | --- |
| `run_id` | must match `task-dag.json:run_id` |
| `cursor` | the completed task ID |
| `facts` | durable state matching the DAG `evidence` (files, tests, blockers) |
| `intent` | `code_gen` \| `refactor` \| `test` \| `research` |
| `delta` | only what changed in the last step |
| `hash` | content address; identical hash = cache hit |

Journal it to `logs/accp.jsonl` (one JSON object per line) or use the `ail-codec` /
`aacp-codec` MCP `*_log` tools. The AIL equivalent is a `$` state frame:

```
$1x9k|run-2026-09-12-abc123|t1|c|fc=#a3f2,tp=1,bl=_|created index.html
```

## 6. Roles and capabilities

The planner routes by the capability you advertise, not by a fixed role name. Common
capabilities and the example agents that implement them:

| Capability | Example agent |
| --- | --- |
| `code_gen`, `test` | `builder-1`, `builder-2`, `builder-3` |
| `web_navigate`, `form_fill`, `data_extract` | `browser` |
| `review` | `reviewer` |
| `integration`, `merge` | `integrator` |

If no registered agent matches a ready task, the planner marks it `meta.remote: true` and
leaves it queued rather than fabricating a worker.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Planner finds no agents | register a card (`a2a_register`/`registry.register`) and confirm `registry.list` returns it; the `a2a-registry` MCP auto-starts the HTTP registry on 8788 |
| `target not registered: my-builder` | pass the exact `did` or `name` from `a2a_list`; names are matched case-sensitively |
| Dispatch times out | your `endpoints.rpc` must answer JSON-RPC `task.dispatch` within 60 s; ack long work and stream progress |
| `packet signature missing or invalid` | set `A2A_SECRET` consistently and/or `A2A_REQUIRE_SIGNATURES=false` for local dev |
| Registry port busy | `A2A_REGISTRY_PORT=9788` (update `.env` and the MCP command) |
| `opencode debug config` errors | check JSON in `~/.config/opencode/opencode.json` |
| 429 from DeepSeek | use the `get-key` tool / `key-rotator.js`, or assign workers to other accounts |
| Planner emits no packets | the planner is read-only (`edit: deny`, `bash: deny`) and only routes; make sure `task-dag.json` exists and your prompt asks it to dispatch to registered agents |
| No side-channel logs | ensure `logs/` exists and the plugin is installed; check `logs/a2a.log` for dispatch attempts |

See also: [`README.md`](README.md) for the contract overview,
[`global/protocols/a2a.md`](global/protocols/a2a.md) for the registry RPC reference, and
[`global/context/task-dag.md`](global/context/task-dag.md) for the DAG schema.

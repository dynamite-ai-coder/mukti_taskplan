# ACCP — Agent Context Compression Protocol v1

**Purpose:** compress context state during agent handoffs so the receiving agent does not
re-read the whole transcript. A handoff carries a snapshot, never history.

## Context snapshot format

```json
{
  "v": 1,
  "run_id": "run-2026-09-11-abc123",
  "cursor": "t5",
  "facts": [
    { "k": "files_created", "v": ["src/a.js"] },
    { "k": "tests_passing", "v": true },
    { "k": "blockers", "v": [] }
  ],
  "intent": "code_gen | refactor | test | research",
  "delta": ["only what changed since the last snapshot"],
  "hash": "sha256:..."
}
```

| Field | Meaning |
| --- | --- |
| `run_id` | DAG run identifier (`task-dag.json:run_id`) |
| `cursor` | last completed task ID |
| `facts` | durable key/value state; keep values small and addressable |
| `intent` | coarse intent label for routing |
| `delta` | changes since the previous snapshot for this run |
| `hash` | content address of `facts`+`delta`; identical hash = cache hit |

## Rules

1. Each agent handoff passes an ACCP snapshot, not full history.
2. `facts` holds durable state; `delta` holds last-step changes only.
3. Snapshots are content-addressed; identical snapshot = cache hit.
4. Reviewer accepts snapshots, not transcripts.
5. Snapshot lines go to `logs/accp.jsonl` (one JSON object per line).
6. Evidence stays in files/logs and is referenced by URI inside `facts` values.

## Producing a snapshot

```bash
node ~/.config/opencode/scripts/aacp-log.js accp \
  '{"run_id":"run-1","cursor":"t3","facts":[{"k":"tests_passing","v":true}],"intent":"code_gen","delta":["created src/a.js"]}'
```

Or through the `aacp-codec` MCP server (`accp_snapshot` tool), which computes `hash`
and appends the snapshot to `logs/accp.jsonl` automatically.

## Consuming a snapshot

The reviewer reads `logs/accp.jsonl`, selects the newest snapshot for the `run_id`,
and validates `facts` + `delta` against `task-dag.json` evidence rules. If a fact is
missing or stale, emit AACP `FAIL` with `meta.reason`; otherwise emit `ACK`.

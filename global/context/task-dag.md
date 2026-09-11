# Task DAG schema

The planner emits this document; every other agent reads it. Only task IDs travel between
agents (via AACP). Only task bodies stay in the DAG file.

```json
{
  "run_id": "run-2026-09-11-abc123",
  "objective": "Build a simple todo app with HTML/CSS/JS",
  "tasks": [
    {
      "id": "t1",
      "subject": "Scaffold static app shell",
      "description": "Create index.html with a form, list container and script/style links.",
      "role": "builder",
      "model": "deepseek-account-2/deepseek-v4-flash",
      "blockedBy": [],
      "reviewBy": "reviewer",
      "evidence": {
        "files": ["index.html"],
        "commands": ["node --check app.js"]
      },
      "writes": ["index.html", "app.js", "style.css"]
    },
    {
      "id": "t2",
      "subject": "Implement todo logic",
      "description": "Add add/remove/toggle logic with localStorage persistence.",
      "role": "builder",
      "blockedBy": ["t1"],
      "reviewBy": "reviewer",
      "evidence": {
        "files": ["app.js"],
        "commands": ["node --check app.js"]
      },
      "writes": ["app.js"]
    }
  ]
}
```

## Field reference

| Field | Required | Notes |
| --- | --- | --- |
| `run_id` | yes | unique run identifier; used by ACCP snapshots and `summary.js` |
| `objective` | yes | one-line goal |
| `tasks[].id` | yes | short stable ID (`t1`, `t2`, ...) |
| `tasks[].subject` | yes | imperative one-liner |
| `tasks[].description` | yes | full body — stays in this file only |
| `tasks[].role` | yes | `builder \| browser \| reviewer` |
| `tasks[].model` | no | `provider/model` override |
| `tasks[].blockedBy` | no | task IDs that must finish first |
| `tasks[].reviewBy` | no | reviewer agent name (default `reviewer`) |
| `tasks[].evidence.files` | yes | artifacts that must exist after the task |
| `tasks[].evidence.commands` | no | commands that must pass for ACK |
| `tasks[].writes` | yes | globs the task may modify — also the conflict boundary |

## Rules

1. Independent tasks (no `blockedBy`) are dispatched in parallel to `builder-1..3`.
2. `writes` globs must be disjoint between tasks; overlap = conflict, resolve at planning.
3. The reviewer compares ACCP `facts`/`delta` against `evidence` and `writes`.
4. A task is done only after an AACP `ACK` for its ID appears in `logs/aacp.log`.
5. The integrator merges only ACKed tasks.

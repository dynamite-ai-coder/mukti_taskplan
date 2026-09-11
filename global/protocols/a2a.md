# A2A — Agent-to-Agent Protocol (JSON-RPC 2.0 over HTTP/SSE)

**Purpose:** remote agent discovery + transport. Every remote agent (browser, external
tool) exposes an Agent Card; the planner discovers agents by capability, never by
hard-coded IDs.

## Agent Card (served at `/.well-known/agent.json`)

```json
{
  "did": "did:local:browser-agent",
  "name": "browser-agent",
  "capabilities": ["web_navigate", "form_fill", "data_extract", "screenshot"],
  "endpoints": {
    "rpc": "http://localhost:8789/rpc",
    "stream": "http://localhost:8789/stream"
  },
  "limits": { "max_rps": 5, "timeout_ms": 60000 },
  "trust": 0.95,
  "sig": "hmac-sha256:..."
}
```

## Registry (port 8788)

`scripts/a2a-registry.js` serves the registry card plus per-agent cards:

| Endpoint | Method | Description |
| --- | --- | --- |
| `/.well-known/agent.json` | GET | registry card |
| `/.well-known/agents/<name>.json` | GET | registered agent card |
| `/rpc` | POST | JSON-RPC 2.0 endpoint |
| `/health` | GET | liveness |

### RPC methods

| Method | Params | Result |
| --- | --- | --- |
| `registry.register` | `{ card }` | registered card |
| `registry.unregister` | `{ did }` | `true` |
| `registry.list` | `{}` | `[card]` |
| `registry.discover` | `{ capability }` | `[card]` capability match |
| `task.dispatch` | `{ target, packet }` | proxy to target `rpc` `task.dispatch` |
| `task.status` | `{ id }` | job status |
| `task.cancel` | `{ id }` | cancellation ack |
| `task.result` | `{ id }` | stored AACP `RESULT` packet |

## Rules

1. Every remote agent exposes a Card; the planner queries the registry for capability discovery.
2. Calls use JSON-RPC methods: `task.dispatch`, `task.status`, `task.cancel`, `task.result`.
3. Streaming via SSE for long browser tasks: `GET /stream` emits `job.updated` events.
4. Messages are signed with a local DID (HMAC-SHA256, secret from `A2A_SECRET`).
5. The registry enforces a capability whitelist (`A2A_CAPABILITY_WHITELIST`, comma-separated).
6. Planners cannot dispatch to agents outside the registry.
7. All RPC calls are logged one JSON object per line to `logs/a2a.log`.

## MCP front

`a2a-registry` MCP server exposes `a2a_register`, `a2a_list`, `a2a_discover` and
`a2a_dispatch` tools. It auto-starts the HTTP registry on port 8788 if it is not running.

## Browser wrapper

`scripts/browser-a2a-server.js` wraps the `browser-control` MCP server in an A2A
server on port 8789 and replies to `task.dispatch` with AACP `RESULT` packets.

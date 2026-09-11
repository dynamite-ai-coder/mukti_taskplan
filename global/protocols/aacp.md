# AACP — Agent Action Compression Protocol v1

**Purpose:** replace verbose natural-language coordination between agents with compact,
semantic, cache-friendly packets. Task bodies live in the DAG; agents exchange only IDs,
URIs and action verbs.

## Packet format (one JSON object per line)

```json
{
  "v": 1,
  "op": "DISPATCH|RESULT|QUERY|ACK|FAIL",
  "task": "t1",
  "role": "builder|browser|reviewer|planner|integrator",
  "dom": "code|web|fs|test|research",
  "ref": ["src/feature/**", "https://x.com"],
  "ret": ["files", "stdout", "snapshot"],
  "meta": { "pri": 1, "ttl": 60, "hash": "..." },
  "sig": "hmac-sha256:... (optional)"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `v` | yes | protocol version, currently `1` |
| `op` | yes | action verb, uppercase |
| `task` | yes | task ID from `task-dag.json` (never the body) |
| `role` | yes | intended / reporting role (`builder` or instance `builder-N`) |
| `dom` | no | work domain hint for routing |
| `ref` | no | resource URIs (globs, URLs, file paths) — never inline content |
| `ret` | no | expected return shape |
| `meta` | no | `pri` priority, `ttl` seconds, `hash` content address |
| `sig` | no | HMAC signature of the canonical packet |

## Verbs

| Verb | Direction | Semantics |
| --- | --- | --- |
| `DISPATCH` | planner -> worker | execute task ID; `ref` points at the DAG |
| `RESULT` | worker -> planner/reviewer | task complete; `ref` = evidence URIs |
| `QUERY` | any -> any | request state for a task ID |
| `ACK` | reviewer -> planner | task accepted against evidence rules |
| `FAIL` | any -> planner | task rejected/failed; `meta.reason` required |

## Rules

1. **NEVER** send full task descriptions between agents.
2. Task body lives in `task-dag.json`; agents exchange only task IDs.
3. Reference resources by URI, not by inlined content.
4. Use short verbs: `DISPATCH`, `RESULT`, `QUERY`, `ACK`, `FAIL`.
5. Cache identical packets by `meta.hash` -> zero re-tokenization.
6. One line per packet; logs are JSON Lines (`.jsonl`/`.log`).
7. Emit packets in a fenced block tagged `aacp` **and** append them to the side channel:

```bash
node ~/.config/opencode/scripts/aacp-log.js dispatch t1 '{"role":"builder-1","dom":"code"}'
node ~/.config/opencode/scripts/aacp-log.js result  t1 '{"role":"builder-1","ref":["src/a.js"]}'
```

## Encoder

`protocols/aacp-encoder.js` (zero dependencies, CommonJS):

```js
const { encode, decode, hash } = require("~/.config/opencode/protocols/aacp-encoder.js")

encode("t1", "DISPATCH", { role: "builder-1", dom: "code", ref: ["task-dag.json"] })
// => '{"v":1,"op":"DISPATCH","task":"t1","role":"builder-1","dom":"code","ref":["task-dag.json"],"meta":{"hash":"..."}}'

decode('{"v":1,"op":"ACK","task":"t1","role":"reviewer"}')
```

CLI:

```bash
node aacp-encoder.js encode t1 DISPATCH '{"role":"builder-1"}'
node aacp-encoder.js decode '{"v":1,"op":"ACK","task":"t1","role":"reviewer"}'
```

## Budget

Target: planner -> builder handoff <= 250 tokens; builder -> reviewer <= 400 tokens;
4-hop flow <= 1500 tokens. Measure with `scripts/summary.js <run_id>`; written to
`reports/budget-<run_id>.json`.

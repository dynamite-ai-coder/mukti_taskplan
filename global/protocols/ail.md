# AIL — AI-native Interlingua v1

**Purpose:** replace human-language coordination between agents/models with a dense,
model-native language. AIL is positional (no keys), dictionary-coded (long strings become
short handles), and content-addressed (dictionary hash + frame hash). AACP/ACCP remain the
human-readable compatibility layer; AIL is the default on the wire.

> Design rule: every AIL frame must be shorter (in BPE tokens) than its AACP/ACCP JSON
> equivalent. Measure with `ail-codec.js bench`.

## 1. Line anatomy

```
<sigil><dict6>|<f1>|<f2>|...|<fn>[^sig8]
```

| Part | Meaning |
| --- | --- |
| `sigil` | frame type: `>` control, `$` state, `~` reason, `@` directive, `#` dictionary delta |
| `dict6` | 6-char base36 hash of the sender dictionary (core + learned words) |
| fields | positional, separated by `\|`; empty field is `_` |
| `sig8` | optional truncated HMAC-SHA256 (8 hex) over the line before `^` |

Field lists: joined with `,`. Item lists: joined with `;` (used when items may contain `,`).
Symbol handles start with `#` and are 5+ chars (e.g. `#a3f2` -> `src/app.js`).

## 2. Core vocabulary (tier 0, stable)

| Group | Symbols |
| --- | --- |
| op | `D`=DISPATCH `R`=RESULT `Q`=QUERY `A`=ACK `F`=FAIL |
| role | `p`=planner `b`=builder `w`=browser `v`=reviewer `i`=integrator |
| dom | `c`=code `w`=web `s`=fs `t`=test `r`=research |
| ret | `f`=files `o`=stdout `s`=snapshot `e`=errors `j`=json `p`=patch |
| meta | `p`=pri `t`=ttl `h`=hash `n`=reason `j`=job `r`=run |
| intent | `c`=code_gen `r`=refactor `t`=test `s`=research `x`=integration |
| facts | `fc`=files_created `fm`=files_modified `tp`=tests_passing `bl`=blockers `cv`=commands_verified `ar`=artifacts |
| bool | `1`=true `0`=false |

The core is embedded in every agent prompt (a few tokens) and never transmitted.

## 3. Frames

### 3.1 Control frame `>` (replaces AACP packets)

```
><dict6>|<op>|<task>|<role>|<dom>|<ref>|<ret>|<meta>[^sig8]
```

Example:

```
>1x9k|D|t1|b|c|#a3f2|fo|p1,h7c3^1a2b3c4d
```

decodes to:

```json
{
  "v": 1, "op": "DISPATCH", "task": "t1", "role": "builder", "dom": "code",
  "ref": ["src/app.js"], "ret": ["files", "stdout"],
  "meta": { "pri": 1, "hash": "h7c3" }
}
```

Tokens: 28 for the frame, 41 including the one-time dictionary definition, vs 95 for the
AACP JSON form — **57-71% fewer tokens** (heuristic estimator). Definitions are amortized:
each receiving agent gets a `#` delta once per run, then only frames travel.

Boolean values are `1`/`0`; arrays are wrapped in `[a,b]`; empty values are omitted.

### 3.2 State frame `$` (replaces ACCP snapshots)

```
$<dict6>|<run>|<cursor>|<intent>|<facts>|<delta>|<hash>[^sig8]
```

`facts`: `k=v` pairs (`fc=#a3f2,tp=1,bl=_`); `delta`: `;`-separated items.

```
$1x9k|r1|t5|c|fc=#a3f2,tp=1,bl=_|+persist;+styles|7f2a
```

State example measured: 46 tokens including defs vs 131 for the ACCP JSON snapshot (65% fewer).

### 3.3 Reason frame `~` (model-to-model thinking state)

```
~<dict6>|<intent>|<claims>|<next>|<conf>[^sig8]
```

`claims` / `next`: `;`-separated terse clauses; `conf`: `0`-`9` (tenths).

```
~1x9k|c|todo-logic-localStorage;evt-delegation|write-app.js;run-node-check|8
```

### 3.4 Directive frame `@` (agent -> model task brief)

```
@<dict6>|<task>|<subject>|<steps>|<writes>|<evidence>|<done>[^sig8]
```

`steps` / `evidence` / `done`: `;`-separated; `writes`: `,`-separated.

```
@1x9k|t2|todo-logic|impl-add-remove-toggle;persist-localStorage|#b1c2,app.js|node-check-app.js|items-survive-reload
```

### 3.5 Dictionary delta `#` (append-only, no signature)

```
#<dict6>|+<handle>=<word>[,+<handle>=<word>...]
```

Example: `#1x9k|+#a3f2=src/app.js,+#b1c2=style.css`

Rules:

1. The sender learns a word once; the receiver applies deltas before decoding.
2. Handles are stable: `#` + first 4+ chars of base36(sha1(word)). Collisions extend the handle.
3. Dictionary hash = base36(sha1(core-version + sorted handles))[0:6].
4. Identical dictionary + identical frame = cache hit (zero re-tokenization).

## 4. Learning budget

- Learn only what repeats or costs > 6 characters (`src/x.js`, URLs, recurring terms).
- Never learn words already in the core vocabulary.
- One `#` line may carry many definitions; send it once per receiving agent per run.
- Receivers may request `#?<dict6>` to get the full dictionary from a peer.

## 5. Signing

```
sign(line, secret)   -> line + "^" + hmacSha256(line, secret)[0:8]
verify(line, secret) -> boolean
```

Enable with `A2A_REQUIRE_SIGNATURES=true`; same `A2A_SECRET` as the A2A envelopes.

## 6. Compatibility

- AACP packets remain valid; `ail-codec.js control` converts AACP <-> AIL frames.
- The side channels are `logs/ail.log` (frames) and `logs/ail-dict.jsonl` (deltas).
- Reviewers accept an AIL state frame wherever an ACCP snapshot was accepted.

## 7. Tooling

```bash
node ail-codec.js encode '{"type":"control","op":"DISPATCH","task":"t1","role":"builder","ref":["src/app.js"]}'
node ail-codec.js decode '>1x9k|D|t1|b|c|#a3f2|fo|p1'
node ail-codec.js learn src/app.js
node ail-codec.js tokens '{"op":"DISPATCH"}'
node ail-codec.js bench '<aacp json>' '<ail frame json>'
node ail-log.js dispatch t1 '{"role":"builder","ref":["src/app.js"]}'
```

MCP server `ail-codec` exposes: `ail_encode`, `ail_decode`, `ail_learn`, `ail_dict`,
`ail_tokens`, `ail_bench`, `ail_log`.

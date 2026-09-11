# Token & latency budget

Measurement is side-channel based: `logs/aacp.log` (packets), `logs/accp.jsonl`
(snapshots), `logs/a2a.log` (RPC calls).

## Baseline — naive natural-language coordination

| Hop | Tokens |
| --- | --- |
| Planner -> Builder handoff | ~800 |
| Builder -> Reviewer handoff | ~1200 |
| 4-hop flow total | ~4500 |

## Target — with AACP + ACCP

| Hop | Target |
| --- | --- |
| Planner -> Builder handoff | <= 250 |
| Builder -> Reviewer handoff | <= 400 |
| 4-hop flow total | <= 1500 |
| Expected savings | 30-45% on multi-hop flows |

## How to measure

```bash
tail -f logs/*.log | node global/scripts/dashboard.js
node global/scripts/summary.js <run_id>          # writes reports/budget-<run_id>.json
```

`summary.js` estimates tokens as `bytes / 4` per protocol line and compares against the
baseline above. A run is on budget when the reported `savings_pct >= 30`.

## Report format (`reports/budget-<run_id>.json`)

```json
{
  "run_id": "run-2026-09-11-abc123",
  "packets": 14,
  "snapshots": 4,
  "a2a_calls": 3,
  "coord_bytes": 5820,
  "coord_tokens_est": 1455,
  "baseline_tokens_est": 4500,
  "savings_pct": 67.7,
  "on_budget": true
}
```

## Latency notes

- DeepSeek V4-Flash is ~5-6x cheaper than V4-Pro on output tokens: use Flash for the
  parallel builders and the browser, Pro for planner/reviewer/integrator.
- 2500 concurrency is per **account**; five independent accounts = ~12,500 theoretical.
- Keep `browser_snapshot` outputs trimmed (extract only requested fields) — DOM text is
  the browser agent's dominant token cost.

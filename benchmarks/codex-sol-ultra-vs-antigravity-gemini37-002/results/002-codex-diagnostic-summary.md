# Benchmark 002 — Codex diagnostic reference

## Status

Benchmark 002 was pre-registered as a Codex-versus-Antigravity comparison at
lab commit `0b4760ee5a7b830dd375dd80b34442cb611b5dff`. After `codex-1` had started,
the user deliberately changed the product-development priority and cancelled
the Antigravity run. The completed Codex run is therefore archived only as a
diagnostic capability reference. It is not a comparative benchmark and no
winner is declared.

## Frozen configuration

- Product: Codex
- Model: GPT-5.6 Sol
- Reasoning: Ultra
- Context: fresh, with no inherited task history
- Baseline: `fa9b42015fe132762652c9f1b1070525e0ad7b37`
- Network, web, plugins, skills, helper agents, subagents, fallback, external
  memory, oracle access, and outside-repository access: prohibited
- Prompt submissions: one
- Hard limit: 15 minutes
- Provider/API spending: none

## Result

- Eligibility: passed
- Automated score: **100/100**
- Visible suite: 20/20; five tests passed
- Hidden oracle: 80/80; all eight behavioral properties passed
- Active elapsed time: **232.908 seconds** (3 minutes 52.908 seconds)
- Stop reason: completed
- Changed files: exactly the three allowlisted production files
- Final response: `RUN COMPLETE`
- Token and incremental-cost telemetry: not exposed by the harness

The run passed duplicate coalescing and replay, terminal-failure recovery,
same-key FIFO settlement races, retry-head ordering, cross-key work
conservation, the global concurrency bound, exact retry/exhaustion policy, and
scheduler cleanup.

## Scope and limitations

This is one run on one synthetic task. It establishes that the selected Codex
configuration can solve the frozen dispatcher repair under the stated controls;
it does not establish general model superiority. Because Antigravity was not
run, timing and score cannot be compared across products. The disposable run
did not modify `commercial-editor`.

## Archived evidence

- `002-codex-diagnostic-results.json`: raw scorer output
- `002-codex-gpt56-sol-ultra.patch`: exact production diff
- `002-manifest.json`: generated frozen-run manifest and hashes
- `002-timing.json`: monotonic timing and operator-action record

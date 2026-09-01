# Frontier Auto vs Codex — Benchmark 006

This is a frozen, offline software-engineering repair benchmark. Contestants receive fresh seed copies; the evaluator and reference are controller-only. Do not expose `.control/`, `reference/`, the other run, or prior output to either contestant.

## Controller sequence

From this directory:

```sh
node .control/prepare.mjs
```

Complete every null field in `state/run-config.json` with the exact visible configuration. For Codex, record the visible model/build, reasoning effort, service tier, permissions, and tools without guessing hidden identity.

For each contestant independently:

```sh
node .control/evidence.mjs before frontier-auto-1
node .control/clock.mjs start frontier-auto-1
# Give only runs/frontier-auto-1 and TASK.md to Frontier Auto.
node .control/clock.mjs stop frontier-auto-1
node .control/evidence.mjs after frontier-auto-1
node .control/eligibility.mjs frontier-auto-1
node .control/score.mjs frontier-auto-1
```

Replace `frontier-auto-1` with `codex-1` for Codex. Fill the generated evidence slots after each capture. Do not start both clocks concurrently. Raw results are written once under `results/`; scoring refuses ineligible or overwritten runs.

## Fixture verification (controller only)

```sh
node .control/validate.mjs
node .control/freeze.mjs
shasum -a 256 -c MANIFEST.sha256
```

`validate.mjs` proves that baseline visible tests partly pass, the fixture is unchanged by tests, the private evaluator discriminates the baseline, and the private reference reaches 100/100. `prepare.mjs` refuses to overwrite existing workspaces.

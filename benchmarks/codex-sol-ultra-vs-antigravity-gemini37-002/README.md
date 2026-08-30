# Codex Sol Ultra vs Antigravity Gemini 3.7 Flash — benchmark 002

This frozen benchmark measures two coding-agent configurations on a
deterministic, multi-file keyed delivery dispatcher repair.

Prepare the two identical disposable repositories:

```sh
npm run benchmark:002:prepare
```

The command prints a manifest with the frozen baseline commit, hashes, prompt,
run order, workspace paths, and timing-file path. Do not open the oracle or the
first completed workspace until both runs finish.

For each run, follow the fixed order in `RUBRIC.md`. Start the supplied monotonic
timer immediately before submitting `TASK.md`:

```sh
npm run benchmark:002:clock -- start /absolute/path/to/manifest.json codex-1
npm run benchmark:002:clock -- stop  /absolute/path/to/manifest.json codex-1 completed
```

Use `antigravity-1` for the second run. Codex uses GPT-5.6 Sol
at Ultra reasoning in a clean context. Antigravity uses Gemini 3.7 Flash at
Medium reasoning in a new session. Disable fallback and external assistance. If
Antigravity requires its normal one-click approval, record it while the timer is
active with `benchmark:002:clock -- accept-all MANIFEST antigravity-1`.

After both runs are final, score each one:

```sh
npm run benchmark:002:score -- /absolute/path/to/manifest.json codex-1
```

Repeat for `antigravity-1`. Scoring is offline and uses no provider credentials.
Do not use or modify `commercial-editor`.

## Recorded status

The planned comparison was cancelled after `codex-1` started because the user
chose to prioritize development of the OpenCode-based product over another
external-agent comparison. Antigravity was not run. The eligible 100/100 Codex
result is retained only as a diagnostic reference under
[`results/`](results/002-codex-diagnostic-summary.md); no comparative winner is
claimed.

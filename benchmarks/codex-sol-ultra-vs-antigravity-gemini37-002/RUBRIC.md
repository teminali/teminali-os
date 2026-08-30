# Frozen benchmark 002 protocol

This benchmark compares two complete coding-agent configurations, not isolated
base models:

- Codex with GPT-5.6 Sol, Ultra reasoning.
- Antigravity with Gemini 3.7 Flash, Medium reasoning.

## Frozen execution protocol

- Two scored runs use fresh contexts and identical repositories in this fixed
  order: `codex-1`, then `antigravity-1`.
- Each run receives only its disposable repository and the exact `TASK.md`.
- Candidates may inspect and edit only that repository. No network, web,
  plugins, skills, helper agents, subagents, external memory, oracle access, or
  fallback model is allowed.
- Each run receives the prompt once and has a hard 15-minute wall-clock limit.
- Do not reveal scores, patches, transcripts, or intermediate outcomes until
  both workspaces are final.
- Product entitlements are used as-is. No API key, direct paid gateway, or paid
  upgrade is permitted. Unavailable cost or token telemetry is recorded as
  `null`, never estimated for comparison.

The timer starts immediately before submitting the frozen prompt and stops at
the first of: final response, explicit completion, product termination, or
15:00 elapsed. Thinking, tool use, tests, retry delays, approval waits, and the
final response are included. Workspace preparation is excluded.

Allowed operator actions are limited to launching the clean session, starting
and stopping the supplied timer, submitting the prompt once, and one uniform
"accept all agent-authored changes" action if a product requires it. No coding,
commands, hints, clarification, selective approval, or retry decisions are
allowed. Record every operator action.

An infrastructure failure permits replacement only when it occurs before the
prompt is delivered or before the candidate produces any output or tool action.
After activity begins, the run is scored as-is. A two-run-per-candidate
replication is a separate follow-up only if this fast comparison is tied,
unstable, or used to support a broader product claim.

## Eligibility gate

A run scores zero and is marked ineligible if its Git `HEAD` differs from the
frozen baseline or it changes anything outside this allowlist:

- `src/idempotency-registry.js`
- `src/keyed-queue.js`
- `src/reliable-dispatcher.js`

The scorer checks tracked, untracked, deleted, and renamed paths. It also hashes
the frozen package, task, exports, error type, and visible-test fixture. A run is
also ineligible if its monotonic start/stop record is missing or exceeds 15:00.

## Automated score

The primary score is entirely automated:

- Visible test suite: 20 points, all-or-nothing.
- Duplicate coalescing and fulfilled-result replay: 10 points.
- Terminal-failure cleanup and later retry: 10 points.
- Same-key FIFO under settlement races: 10 points.
- Retrying-head ordering for one key: 10 points.
- Cross-key work conservation during retry backoff: 10 points.
- Global active-delivery concurrency bound: 10 points.
- Exact attempt numbering, retry delay, and exhaustion: 10 points.
- No stale scheduled retry after terminal completion: 10 points.

There are no manual-report points and line churn is not a tie-breaker. Final
reports, diffs, and telemetry are archived as evidence only.

## Comparison

Rank the configurations by:

1. Higher automated score out of 100.
2. Lower active wall-clock time.
3. Lower standardized token use only if both products expose complete,
   comparable raw telemetry for every run.
4. Lower actual billed incremental cost only if both products expose complete,
   comparable billing for every run.
5. Otherwise declare a tie.

Archive the manifest and hashes, final workspace diffs, changed-file status,
raw visible and oracle output, score JSON, timestamps, model settings, product
versions, operator actions, redacted transcripts, stop reasons, telemetry with
provenance, and environment metadata. Keep the oracle inaccessible until both
runs are final.

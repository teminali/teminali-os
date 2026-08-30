# Benchmark 001 results

## Scope

Baseline commit: `cde4872d164422abf92f26d06ba45f51133b5b87`

The original pre-registered comparison used the same disposable repository,
task prompt, visible tests, hidden oracle, 20-minute wall-clock limit, and
manual-report rubric for:

- OpenCode + controlled Claude Sonnet 5 Medium, no fallback, USD 0.50 process cap.
- Antigravity + Gemini 3.7 Flash Medium, no fallback.

A clean GPT-5.6 Sol Ultra Codex candidate was added after those two runs had
finished. It used a fresh copy of the same baseline and had no prior task
context, web access, skills, fallback, or helper agents. Because this candidate
was added after the original results were known, its comparison is exploratory
and explicitly post-hoc rather than pre-registered.

## Scores

| Candidate | Automated | Manual evidence | Total | Elapsed | Production diff |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenCode Claude Sonnet 5 Medium | 90/90 | 0/10 | 90/100 | 137 s | +29 / -12 (41) |
| Antigravity Gemini 3.7 Flash Medium | 90/90 | 10/10 | 100/100 | 79 s | +45 / -15 (60) |
| Codex GPT-5.6 Sol Ultra | 90/90 | 10/10 | 100/100 | 289 s | +47 / -10 (57) |

Every candidate passed the visible suite, all six hidden behavioral checks, and
fixture-integrity validation.

The original pre-registered winner is Antigravity, 100-90. In the exploratory
three-way table, Codex and Antigravity tie on total score. The frozen tie-breaker
orders fewer production lines before wall time, so Codex formally wins that tie
by 57 changed lines to 60. Antigravity was substantially faster.

## Manual evidence scoring

- Sonnet: 0/10. It produced a correct implementation but the process cap blocked
  the final response, so there was no change report or verification report to score.
- Antigravity: 10/10. Its change summary was accurate and its reported `npm test`
  result was verified.
- Codex: 10/10. Its concise change summary and verification claims matched the
  frozen diff and scorer output.

## Usage and interventions

- Sonnet: OpenCode recorded 99,665 input tokens and 3,905 output tokens. The
  gateway's conservative process accounting reached USD 0.474238 of the USD
  0.50 cap across seven requests and 122,431 estimated tokens. This is gateway
  budget accounting, not a provider invoice. Automatic retry time is included
  in the 137-second endpoint.
- Antigravity: token and provider-cost telemetry were not exposed. One normal
  UI `Accept all` approval finalized the agent-authored patch; no coding help or
  manual edit was provided.
- Codex: token and cost telemetry were not exposed. A separate clean-context
  Codex candidate performed the task without human intervention.

No API key or other provider secret is present in this archive. Absolute
temporary run paths were intentionally omitted because they are ephemeral.

## Evidence files

- [`001-results.json`](001-results.json): machine-readable scores and telemetry.
- [`001-opencode-sonnet5.patch`](001-opencode-sonnet5.patch): frozen Sonnet diff.
- [`001-antigravity-gemini37.patch`](001-antigravity-gemini37.patch): frozen Antigravity diff.
- [`001-codex-gpt56-sol-ultra.patch`](001-codex-gpt56-sol-ultra.patch): frozen Codex diff.

This single small task is evidence about one implementation problem, not enough
to claim general coding-agent superiority. Additional pre-registered tasks are
required before drawing product-level conclusions.

# Task State
## Objective
Wire and verify Claude Sonnet 5 as the controlled OpenCode coding model, preserve
explicit Groq recovery, and prepare the first frozen comparison against
Antigravity Gemini 3.7 Flash Medium.
## Acceptance Criteria
- Quota routing models organization-scoped limits and rejects duplicate quota groups.
- The HTTP gateway authenticates clients, streams responses, fails over safely before streaming, and never exposes provider secrets.
- Provider calls abort at a configured deadline and remain within hard run budgets.
- OpenCode resolves the gateway model without replacing the controlled Groq baseline.
- Offline tests pass without real credentials, provider traffic, spending, or changes to `commercial-editor`.
## Completed
- Groq health check passed.
- Fresh session successfully recovered Active, Blocked, and Next Action with no file changes.
- Defined the capability-first frontier-agent roadmap and gateway contract.
- Implemented the organization-aware quota pool and authenticated streaming HTTP gateway.
- Implemented strict Gemini and Groq adapters with logical model mapping.
- Verified heterogeneous Gemini-to-Groq failover using fake upstreams.
- Implemented a strict local-only environment launcher with redacted startup output.
- Added requests-per-day enforcement alongside RPM, TPM, and daily-token limits.
- Implemented process-scoped request, estimated-token, and integer micro-USD guards.
- Required explicit per-lane pricing and verified local rejection before dispatch.
- Added bounded upstream abort handling and a distinct timeout response and metric.
- Added controlled Gemini and enhanced Gemini-plus-three-Groq non-secret profiles.
- Verified OpenCode resolves `frontier-gateway/frontier-code` at medium reasoning.
- Added and smoke-tested the one-command controlled-agent launcher with dummy credentials.
- Ran the first controlled Gemini request; the provider returned HTTP 429.
- Confirmed automatic retries were blocked locally after the one-request budget was consumed.
- Added bounded, credential-redacted provider error diagnostics and a one-call diagnostic launcher.
- Verified 33 offline tests and a clean diff check.
- Diagnosed Gemini HTTP 429 directly: the terralink project's prepaid credits are depleted.
- Verified the Anthropic identity-linked key can list Claude Opus 5 and Sonnet 5.
- Added Anthropic workspace routing over the official OpenAI-compatible API surface.
- Mapped OpenCode medium reasoning to Claude `output_config.effort=medium`.
- Added controlled Sonnet 5, controlled Opus 5, and Sonnet-plus-three-Groq profiles.
- Added hard-capped Sonnet and Opus live diagnostic launchers.
- Added a frozen, disposable Sonnet 5 versus Antigravity Gemini 3.7 Flash benchmark.
- Added an oracle scorer, fixture-integrity checks, identical baseline preparation,
  and a 20-minute controlled-run policy.
- Verified 38 offline tests, all launcher smoke tests, benchmark preparation/scoring,
  shell syntax, OpenCode config resolution, cleanup, and diff checks.
## Active
- Run the first capped Claude generation checks, then execute benchmark 001.
## Blocked
- Live Claude calls require private API-key entry in the user's terminal.
## Next Action
- Run `npm run claude:diagnose-opus` and confirm `CLAUDE OPUS 5 READY` before
  spending on the controlled Sonnet benchmark.
## Evidence
- “GROQ GPT OSS 120B READY”
- `npm test --silent`: 33 passed, 0 failed.
- `git diff --check` passed.
- `opencode debug config --pure` resolved the gateway model and preserved the Groq baseline.
- Dummy-key `npm run agent:start` reached health, exited successfully, and left no listener behind.
- The failed live run transitioned from provider cooldown to local `Run budget exhausted` without another upstream call.
- Direct Gemini error: `RESOURCE_EXHAUSTED` because prepayment credits are depleted.
- Anthropic model catalog includes `claude-opus-5` and `claude-sonnet-5`.
- `npm test --silent`: 38 passed, 0 failed.
- Controlled Sonnet, Opus, enhanced, and benchmark launchers start and cleanly stop
  a loopback gateway with dummy credentials and leave no port 8787 listener.
- OpenCode resolves `Claude Sonnet 5 Controlled Benchmark` at medium and
  `Claude Opus 5 Controlled Escalation` at high.
- Benchmark seed scores 30/90 automated before repair, confirming the scorer
  distinguishes the intended defects.

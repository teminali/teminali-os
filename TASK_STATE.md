# Task State
## Objective
Measure frontier coding-agent configurations with frozen, reproducible tasks
while preserving secure Claude, Gemini, and Groq routing in the isolated lab.
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
- Verified a live Opus 5 generation request through the controlled gateway: HTTP 200,
  28 prompt tokens, 32 completion tokens, and no fallback.
- Verified live Sonnet 5 through the controlled gateway with the exact expected response.
- Identified the first benchmark interruption as an artificial local 50K TPM
  ceiling after two successful Claude tool turns, not a provider failure.
- Raised only local Claude throughput/token-accounting ceilings for agentic turns;
  retained the USD 0.20 benchmark cap, pinned Sonnet lane, and no-fallback policy.
- Observed the next clean attempt stop before editing because two conservative
  turn reservations exhausted USD 0.20; the user approved USD 0.50 specifically
  for benchmark 001. Ordinary runs remain at USD 0.20.
- Added a frozen, disposable Sonnet 5 versus Antigravity Gemini 3.7 Flash benchmark.
- Added an oracle scorer, fixture-integrity checks, identical baseline preparation,
  and a 20-minute controlled-run policy.
- Verified 38 offline tests, all launcher smoke tests, benchmark preparation/scoring,
  shell syntax, OpenCode config resolution, cleanup, and diff checks.
- Completed benchmark 001 on the identical frozen commit with OpenCode Claude
  Sonnet 5 Medium and Antigravity Gemini 3.7 Flash Medium.
- Both original candidates passed every visible and hidden functional check;
  Antigravity won the pre-registered comparison 100-90 because Sonnet exhausted
  its USD 0.50 process cap before producing the required final evidence report.
- Added a post-hoc clean-context Codex GPT-5.6 Sol Ultra candidate. It scored
  100/100 and formally edged Antigravity on the frozen line-churn tie-breaker,
  while Antigravity completed much faster (79 seconds versus 289 seconds).
- Archived the exact scores, methodology caveats, reports, telemetry, and three
  production patches under the benchmark `results` directory.
- Pre-registered benchmark 002 as a fast, frozen comparison of Codex GPT-5.6
  Sol Ultra and Antigravity Gemini 3.7 Flash Medium on a deterministic
  three-module keyed delivery dispatcher repair.
- Removed manual-report points and line-churn tie-breaking from benchmark 002;
  its primary score is 100% automated with strict scope and fixture eligibility
  gates, monotonic timing, frozen hashes, no fallback, and no external help.
- Limited the fast comparison to one clean 15-minute run per configuration;
  replication is reserved for a tied, unstable, or broader product claim.
- Verified the benchmark 002 seed passes all five visible tests while scoring
  60/100 against the hidden oracle, and verified an independent allowlisted
  repair scores 100/100.
## Active
- Execute benchmark 002 without inspecting either result until both candidate
  workspaces are final.
## Blocked
- Direct Gemini API calls remain blocked by depleted project prepayment credits;
  Antigravity model access is unaffected.
## Next Action
- Prepare the two frozen benchmark 002 workspaces, then run `codex-1` in a clean
  GPT-5.6 Sol Ultra context before opening the Antigravity workspace.
## Evidence
- “GROQ GPT OSS 120B READY”
- `npm test --silent`: 33 passed, 0 failed.
- `git diff --check` passed.
- `opencode debug config --pure` resolved the gateway model and preserved the Groq baseline.
- Dummy-key `npm run agent:start` reached health, exited successfully, and left no listener behind.
- The failed live run transitioned from provider cooldown to local `Run budget exhausted` without another upstream call.
- Direct Gemini error: `RESOURCE_EXHAUSTED` because prepayment credits are depleted.
- Anthropic model catalog includes `claude-opus-5` and `claude-sonnet-5`.
- Controlled Opus probe returned HTTP 200 from `claude-opus-5`; its 32-token
  high-effort ceiling ended with `finish_reason: length`, confirming access while
  motivating a larger diagnostic output allowance under the same USD 0.005 cap.
- `npm test --silent`: 38 passed, 0 failed.
- Controlled Sonnet, Opus, enhanced, and benchmark launchers start and cleanly stop
  a loopback gateway with dummy credentials and leave no port 8787 listener.
- OpenCode resolves `Claude Sonnet 5 Controlled Benchmark` at medium and
  `Claude Opus 5 Controlled Escalation` at high.
- Benchmark seed scores 30/90 automated before repair, confirming the scorer
  distinguishes the intended defects.
- `benchmarks/sonnet5-vs-antigravity-gemini37/results/001-summary.md` records the
  completed three-candidate evidence and benchmark-integrity caveats.
- Benchmark 002 validation: visible seed 5/5; baseline hidden 40/80 and total
  60/100; independent repaired fixture hidden 80/80 and total 100/100.

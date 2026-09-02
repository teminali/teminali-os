# Task State

> **Superseded work log — historical.** This tracked the pre-rename harness
> effort and stopped being updated before Teminali Code shipped. Its `Completed`
> and `Evidence` entries are kept as a record of how the system got here, with
> their original figures intact; do not read the counts in them as current.
>
> `Active` and `Next Action` below are **not live** — they describe a session
> that ended. Nothing here is a to-do list.
>
> For current state: [`studio/README.md`](studio/README.md) for the application,
> [`GATEWAY_DESIGN.md`](GATEWAY_DESIGN.md) for routing,
> [`CLAUDE.md`](CLAUDE.md) for the working agreement. Measured today: 109/109
> root, 501/501 studio, typecheck and production build clean.

## Objective
Build a skill-native, local-first website creation agent, beginning with
world-class landing and marketing sites, while retaining secure model routing,
hard budgets, repository recovery, and reproducible domain evaluations.
## Acceptance Criteria
- The website skill routes distinct site types, preserves supplied facts and brand,
  and enforces observable conversion, visual, responsive, accessibility,
  performance, and engineering gates.
- The orchestration workflow uses bounded specialist roles, one implementation
  owner, repository-backed handoffs, and skill-specific evaluation evidence.
- A resource-safe local model is the default coding lane; high-memory local and
  authorized cloud models are explicit, capacity-checked escalation lanes that
  unload after use rather than silent defaults.
- The HTTP gateway authenticates clients, streams transparently, reconciles actual
  usage, fails over only under classified policy, and never exposes secrets.
- Offline tests pass without real credentials, provider traffic, spending, or changes outside the canonical Frontier repository.
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
- Completed the frozen `codex-1` diagnostic with GPT-5.6 Sol Ultra: eligible,
  100/100, all visible and hidden checks passed, and 232.908 seconds elapsed.
- Cancelled the planned Antigravity run after the user prioritized OpenCode
  product development. Benchmark 002 is retained as a Codex diagnostic only;
  no comparative winner is claimed.
- Audited benchmark 001 telemetry and identified conservative output reservations
  as the cause of false local budget exhaustion despite substantially lower actual
  provider usage.
- Implemented two-phase run-budget and quota accounting: reserve worst case before
  dispatch, then settle to strict provider-reported input/output usage at body EOF.
- Updated official OpenAI-compatible provider adapters to request streaming usage
  while preserving an explicit caller opt-out and non-stream requests.
- Added bounded, byte-preserving JSON/SSE usage capture with conservative fallback
  for missing, malformed, oversized, non-success, and interrupted responses.
- Verified 45 offline tests, including actual JSON/SSE reconciliation, atomic
  validation, transparent fragmented streaming, and interruption cleanup.
- Established the skill-native product direction with `website-builder` as the
  first focused domain pack.
- Added a concise website router plus progressively loaded site-structure,
  quality-gate, and efficient-agent-workflow references.
- Forward-tested the skill independently on a pre-launch B2B SaaS brief and closed
  the observed gaps in claim evidence, public-form safety, greenfield stack
  selection, and bounded handoffs/model calls.
## Completed
- Implemented loopback Ollama provider adapter with model mapping, loopback-only endpoint enforcement, and keyless authentication headers.
- Added priority-aware quota selection to QuotaPool, ensuring deterministic local-first lane routing before cloud escalation.
- Added Ollama provider configuration and default zero-cost pricing to RuntimeConfig.
- Added lane profile definitions for controlled Devstral and enhanced Devstral-plus-Claude escalation.
- Verified 49 offline tests covering Ollama request transformation, loopback enforcement, priority-first routing, zero-cost accounting, and local-to-cloud 429 failover.
- Verified the installed Devstral 24B model through the real controlled Frontier
  gateway: HTTP 200, exact `FRONTIER_CODE_LOCAL_OK`, 569 prompt tokens, 8
  completion tokens, the `ollama-devstral` lane, zero cost, and no failover.
- Repaired and froze website benchmark 003: the untouched seed passes 2/2 visible
  tests but scores 20/100 on the withheld oracle, a complete reference solution
  reaches 100/100, and `MANIFEST.sha256` locks the fixture inputs.
- Completed benchmark 003 as a readiness diagnostic. Codex was eligible at 100/100,
  while the original Frontier run was ineligible before dispatch because its
  requested output exceeded the gateway limit; no comparative winner is claimed.
- Repaired the local execution stack: aligned output limits and timeouts, prepared
  a verified 32K Ollama alias, disabled hidden title / external fallback paths and
  unsafe globbing, made Ollama tool calls deterministic, and added an explicit
  required-change failure contract with fresh-session recovery.
- Added a bounded workspace snapshot for recovery and excluded hidden files from
  snapshots and workspace-change detection.
- Diagnosed the remaining readiness failure: the local Devstral agent does not yet
  reliably complete and verify multi-file changes within the 15-minute benchmark
  envelope. One remediation timed out with malformed partial edits at 20/100; a
  later constrained experiment made no edits in roughly eleven minutes and was
  stopped and removed rather than promoted.
- Demoted Devstral 24B to an explicit `local-24b` profile and made
  Qwen2.5-Coder 14B the resource-safe local default with an 8K bounded edit lane.
- Added strict parsing for fenced JSON `write_file` responses emitted by local
  models while preserving the per-run file allowlist and required-file contract.
- Verified 83 offline tests and a complete isolated 14B product canary: exactly
  two required files changed, tests passed, no scope violations occurred, the run
  finished in 11.597 seconds, and no Ollama model remained resident.
- Monitored an isolated Devstral canary and cancelled it before edits when its
  18.8 GB resident allocation reduced system memory free to 7%; cancellation
  propagated through the runner and unloaded the model, restoring 78% free memory.
## Completed
- Consolidated the product, gateway, runtime, benchmarks, and browser Studio under
  `/Users/teminali/Documents/my_projects/frontier`; `studio/` is the browser application.
- Added the public Frontier Flash, Frontier Auto, and Frontier Max modes across the
  shared routing policy and browser Copilot. Auto is the flagship; Max fails closed
  and remains visibly locked until its exact heavyweight path qualifies.
- Removed underlying provider/model names from the browser UI, including a display
  sanitizer for conversations persisted by older builds.
- Added authenticated Studio status and mode-resolution endpoints backed by the
  canonical root routing policy, batched streaming, cancellation/unload behavior,
  truthful operational evidence, and sequential resource-safe Swarm execution.
- Rebuilt the editor shell for wide, balanced, and compact windows. Explorer and
  Copilot resize continuously to zero, leave a thin restore divider, support keyboard
  and double-click resize, and avoid dead editor gaps.
- Fixed the balanced/compact Explorer positioning defect: the overlay now begins at
  the exact activity-rail edge instead of inheriting the editor grid column. Added a
  regression contract and verified 52→52 px balanced and 48→48 px compact alignment.
- Compacted and polished the Copilot header, intro, messages, evidence rows, actions,
  and composer. The header divider now spans the full left-to-right panel width.
- Verified a direct isolated Flash canary (`FRONTIER_FLASH_READY`) and a browser
  end-to-end Auto canary (`FRONTIER_UI_READY`); both unloaded the model afterward.
- Unloaded a resident Devstral process that had consumed about 16.3 GB, restoring
  Mac responsiveness. The current Ollama residency check is empty.
- Verified the current pre-benchmark gate: 106/106 root/runtime tests, 69/69 Studio
  tests, TypeScript checks, Vite production build, and live responsive browser proof.
- Completed frozen benchmark 006 on a new durable reservation-ledger repair. Both
  contestants were eligible and stayed in scope. Frontier Auto selected Frontier
  Flash and scored 37/100 in 207.029 seconds; Codex scored 100/100 in 206.250 seconds.
  Timings are non-authoritative because separate UI work overlapped part of Frontier's
  run. The deterministic correctness result is retained as a diagnostic, not a broad claim.
- Wired the Studio to the real authenticated workspace backend: bounded file tree and
  reads, live Explorer, real Monaco tabs/actions, only Code and Preview top modes,
  embedded Browser, and previews for HTML, SVG, text, PDF, CSV, XLSX, and XML-based XLS.
- Restarted the live gateway and verified `/api/workspace/tree` returns HTTP 200 for
  the real `frontier` root with 422 entries and no truncation.
- Closed the product-side benchmark-006 feedback-loop defects: repair turns now use
  fresh authoritative source, retain the complete task-contract checklist, classify
  all seven missed mechanism families, get bounded follow-up attempts, and can emit
  up to 3,072 tokens for complete multi-file edits.
- Added a non-oracle regression fixture and a two-turn repair integration. Focused
  runner/agent tests pass 44/44 and the full root/runtime suite passes 109/109.
## Active (as of the last update — superseded)

The suite has grown substantially since: the combined checkpoint below read
190/190, where the same two suites now measure 109/109 root and 501/501 studio.
The line about preserving a live studio on port 3000 refers to a session long
finished.

- The stable combined checkpoint is 190/190 (109 root/runtime + 81 Studio), TypeScript
  and build green. Live Edit, exact-path workspace writes, Preview synchronization,
  image attachments, and the `</>` logo are implemented.
- A direct qwen3-vl:2b screenshot canary passed. The first integrated browser canary
  exposed a 120-second `/api/chat` vision stall; the UI recovered without committing
  an incomplete file. Vision was switched to the already-proven `/api/generate` path.
- Focused verification and the full 190/190 + TypeScript + build gate pass after the
  transport patch. Retry the integrated image + Live Edit canary, then run the isolated
  repair-turn transfer canary.
- Preserve the current live Studio at `http://localhost:3000` until the user finishes
  inspecting the UI.
## Blocked (last recorded state)

Two of these are still confirmable in code: Devstral 24B's 32 GB floor is in
`PROFILES` in `gateway/frontier-runner.js`, and the Qwen3.8 27B disqualification
is `qwen38Iq3m.qualified: false` in `gateway/model-qualification.json`. The
Gemini credit state is an account fact and is not verifiable from this
repository.

- Direct Gemini API calls remain blocked by depleted project prepayment credits;
  Antigravity model access is unaffected.
- Devstral 24B is not safe on this 24 GB Mac: its 18.8 GB resident footprint leaves
  too little unified-memory headroom even when it is used only occasionally.
- The imported Qwen3.8 27B IQ3_M package is disqualified on the current Ollama
  runtime because direct loading returns HTTP 500. This does not block the benchmark:
  shipped Auto truthfully remains Flash-only and Max remains locked.
## Next Action (superseded — recorded, not pending)
- Follow `outputs/ANTIGRAVITY_HANDOVER.md` in order: verify the final vision transport,
  pass the integrated image + Live Edit canary, pass the isolated repair-turn canary,
  then freeze a genuinely new-domain task and compare Frontier Auto with Codex under
  matched idle-machine conditions. Never reuse or overwrite benchmark 006.
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
- Benchmark 002 Codex diagnostic: eligible 100/100; five visible tests and all
  eight hidden checks passed; elapsed time 232.908 seconds; Antigravity not run.
- Benchmark 001 audit: gateway reserved 28,672 output tokens while OpenCode
  reported 3,905 actual output tokens; conservative accounting recorded
  $0.474238 versus approximately $0.23838 at nominal actual usage.
- `npm test`: 45 passed, 0 failed after actual-usage settlement and interrupted-
  stream regression coverage.
- `website-builder` passed the official skill validator with no scaffold
  placeholders; its independent forward test produced a concrete, evidence-aware
  launch-site plan without editing either repository.
- Local Devstral smoke metrics: 1 request completed, 577 total measured tokens,
  0 upstream errors, 0 timeouts, 0 failovers, and USD `0.000000` used.
- Benchmark 003 fixture validation: manifest 11/11 hashes pass; visible tests 2/2;
  untouched seed oracle score 20/100; complete temporary reference 100/100.
- Benchmark 003 readiness result: Codex 100/100 in 522.047 seconds; original
  Frontier ineligible in 2.034 seconds; remediation attempt 10 timed out after
  967.961 seconds with malformed partial edits and a corrected 20/100 score.
- Final product verification after retained remediation: 67/67 offline tests,
  valid `website-builder` skill, and clean `git diff --check`.
- Current product verification: 83/83 offline tests pass.
- Safe-lane canary: eligible in 11.597 seconds with both required files changed,
  independent verification passing, and `residentModelsAfter: []`.
- Devstral capacity canary: cancelled at 44.019 seconds with 7% system memory free,
  zero file changes, and successful post-cancellation unload.
- Current full verification: 175/175 tests (106 root/runtime + 69 Studio), TypeScript
  checks passed, and the Vite production build completed successfully.
- Responsive browser proof: balanced activity/explorer edges 52 px/52 px; compact
  edges 48 px/48 px; Explorer grid column `1 / -1` with overlay z-index 30.
- Final direct Ollama residency check: `{"models":[]}`.
- Benchmark 006: Frontier Auto eligible 37/100 in 207.029 seconds; Codex eligible
  100/100 in 206.250 seconds. Raw result hashes and limitations are recorded in
  `benchmarks/frontier-auto-vs-codex-006/results/006-summary.md`.
- Studio full-wiring verification: TypeScript pass, gateway 15/15, Studio 70/70,
  production build pass; live authenticated workspace tree HTTP 200, 422 entries.
- Benchmark-gap product repair: focused 44/44 and full root/runtime 109/109 tests
  pass; all seven miss families are covered by a non-oracle regression fixture and
  the classified fresh-context repair-turn integration.
- Benchmark 006 immutable audit is fully green again, including its restored frozen
  README hash `08c2617a...`; result reporting remains in the results directory.

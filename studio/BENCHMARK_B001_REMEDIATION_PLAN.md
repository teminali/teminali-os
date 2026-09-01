# Frontier Studio — Benchmark B001 Findings and GPT-5.6 Sol Parity Plan

Date: 2026-08-31  
Target comparator: Codex using GPT-5.6 Sol with High reasoning  
Hardware: Apple M4 Pro, 24 GB Unified Memory  
Development instance: port 3000  
Reference clone: port 3001

## Objective

Bring Frontier Studio to defensible editor-level parity with Codex running GPT-5.6 Sol High on representative software-engineering work. Parity means comparable or better verified task outcomes, autonomy, recovery, visual accuracy, latency, and cost under controlled conditions. It does not mean claiming identical raw model intelligence.

The public claim is permitted only after a reproducible, blinded benchmark shows the result. Until then, UI labels and reports must describe measured behavior without superiority claims.

## B001 Evidence

### Passed

- The initial 20 TypeScript errors were diagnosed and repaired.
- `npm run build` passed after repair: 1,629 modules transformed in a 3.96-second end-to-end command.
- Ports 3000 and 3001 returned HTTP 200 after launch and synchronization.
- Ollama returned HTTP 200 and exposed `devstral-small-2:24b-instruct-2512-q4_K_M`.
- Devstral followed the deterministic instruction and returned exactly `FRONTIER_B001_LOCAL_OK`.
- Cold generation completed in 25.99 seconds, including 13.50 seconds of model load time.
- Warm generation completed in 1.86 seconds.
- The repaired master and reference clone were synchronized.

### Failed or unverified

- Measured generation was 7.26 output tok/s cold and 8.84 output tok/s warm; the UI displays a fixed 104.2 tok/s.
- Port 3888 was unavailable, but video requests can still report successful timeline edits.
- `package.json` declares `server/api-server.js`, but that file does not exist.
- `GodAgentSwarmService` simulates progress and returns a predetermined 99.8% consensus result.
- `E2EBrowserAgentService` returns predetermined passing assertions without driving a browser.
- `BenchmarkGapAnalyzer` simulates audit completion rather than executing an evaluation suite.
- `SpeculativeDraftingService` returns invented success metrics when inference fails.
- The AI fallback path can present canned code as a verified autonomous implementation.
- The tachometer, token counts, cost, duration, and several capability labels are not derived from authoritative runtime telemetry.
- Browser-based interaction, console, accessibility, and pixel-diff verification could not be measured because no browser backend was available in B001.
- There is no test or lint script in `package.json`.
- There is no repository-level Git history at the project path, preventing clean checkpoint and diff workflows.

## Non-negotiable engineering rules

1. Never convert a dependency failure into a success result.
2. Simulated demonstrations must be explicitly labeled `DEMO`; production mode must never use them.
3. Every displayed metric must come from a timestamped runtime measurement.
4. Every agent claim must link to an execution trace, tool result, diff, or test artifact.
5. No feature is complete until its narrow tests, production build, and relevant browser checks pass.
6. No benchmark contestant may inspect another contestant's solution.
7. Port 3000 remains the development instance; verified changes are synchronized to port 3001.

## Remediation phases

### Phase 0 — Restore truthfulness and observability

Scope:

- Replace the fixed tachometer with Ollama-derived prompt-evaluation, generation, load, and total-duration metrics.
- Add explicit runtime states: `healthy`, `degraded`, `offline`, and `demo`.
- Remove success wording from all fallback responses.
- Disable video actions when port 3888 is unhealthy.
- Make model, cost, tokens, duration, and tool status originate from recorded execution events.
- Add a persistent audit log with correlation IDs for prompts, model calls, tools, patches, and verification.

Exit gate:

- Displayed latency and throughput differ from raw Ollama measurements by no more than 5%.
- An offline dependency produces an actionable error and never a success card.
- A source scan finds no hard-coded performance or consensus values in production paths.

### Phase 1 — Build the real local gateway

Scope:

- Implement the missing backend entrypoint with authenticated loopback-only access.
- Add health endpoints for the gateway, Ollama, and Kerf MCP.
- Add streaming proxy support with cancellation, timeouts, retry classification, and structured errors.
- Separate provider adapters from orchestration logic.
- Validate request and response schemas at every boundary.
- Prevent secrets, environment values, and private file contents from appearing in logs.

Exit gate:

- Gateway health, streaming, cancellation, timeout, malformed-response, and provider-offline tests pass.
- The frontend can complete a real streamed Devstral request without a canned fallback.
- `npm run server` starts an existing, tested file.

### Phase 2 — Implement a real single-agent engineering loop

Scope:

- Build an explicit state machine: inspect, plan, edit, verify, repair, review, and report.
- Provide typed tools for file search, file reads, patch application, bounded shell commands, compiler diagnostics, and test execution.
- Require patch previews and preserve unrelated files.
- Add cancellation, retry budgets, loop detection, and resumable task state.
- Persist acceptance criteria and evidence across context compaction.
- Prove single-agent reliability before enabling swarm execution.

Exit gate:

- The agent repairs a seeded multi-file defect in an isolated fixture with zero human intervention.
- All acceptance and regression tests pass.
- The report contains exact changed files, tool calls, test outputs, elapsed time, and model usage.

### Phase 3 — Replace simulated swarm and verification services

Scope:

- Replace timer-driven workers with isolated role executions using real prompts, inputs, outputs, and budgets.
- Give Architect, Coder, and Verifier distinct responsibilities and immutable evidence.
- Compute consensus from independent verdicts instead of a constant.
- Detect conflicting patches and require deterministic synthesis.
- Replace the fake self-healing compiler report with real TypeScript diagnostics before and after repairs.
- Do not use multiple agents when a single agent is sufficient.

Exit gate:

- Each worker produces a traceable artifact.
- Injected worker disagreement is detected and resolved or reported honestly.
- Consensus scores are reproducible from stored verdicts.
- A verifier can reject a syntactically valid but behaviorally incorrect patch.

### Phase 4 — Add real automated quality gates

Scope:

- Add TypeScript typecheck, ESLint, Vitest unit/integration tests, and Playwright browser tests.
- Capture browser console errors, page errors, failed requests, screenshots, and interaction traces.
- Test workspace switching, file opening, search, Monaco editing, chat streaming, command palette actions, terminal toggling, and failure states.
- Replace the simulated benchmark analyzer with a runner that reads immutable result artifacts.
- Add accessibility checks for keyboard navigation, labels, focus, and contrast.

Exit gate:

- A single `npm run verify` command runs typecheck, lint, unit, integration, and browser suites.
- Tests fail when a seeded UI or service defect is introduced.
- The E2E report contains actual browser timestamps and captured failures.
- Production build passes after all suites.

### Phase 5 — Repair local inference performance and context handling

Scope:

- Benchmark cold and warm model behavior separately.
- Measure time to first token, prompt tok/s, generation tok/s, total latency, memory pressure, and cancellation latency.
- Tune Ollama context, batch, thread, keep-alive, and prompt size using controlled trials.
- Validate AST pruning against syntax-aware fixtures; never prune active contracts incorrectly.
- Implement context budgeting, retrieval, caching, and compaction with correctness tests.
- Replace invented speculative-decoding metrics with actual accepted and rejected token counts, or remove the feature.
- Use a fast deterministic lane only for genuinely deterministic commands, never for code-generation claims.

Exit gate:

- Performance reports include raw samples, warm/cold separation, median, p95, and run count.
- No displayed throughput exceeds measured throughput.
- Context pruning preserves all fixture acceptance tests.
- Long tasks survive interruption and resume without losing acceptance criteria.

### Phase 6 — Restore Kerf MCP and multimodal capability

Scope:

- Implement a real MCP client with capability discovery and health gating.
- Validate timeline state before mutation and verify state after mutation.
- Add idempotency keys, dry-run previews, undo metadata, and partial-failure handling.
- Store image attachments as real model inputs rather than textual attachment labels.
- Implement screenshot measurement and image-to-layout extraction with reproducible fixtures.

Exit gate:

- A sandbox timeline test performs and verifies a real edit through port 3888.
- MCP downtime disables mutations and produces no fabricated results.
- Image-based tasks prove that image pixels reached the selected model or vision pipeline.

### Phase 7 — Pixel-precision and interaction parity

Scope:

- Establish fixed viewport, fonts, device scale, animation state, and seeded application data.
- Capture reference and candidate screenshots from actual browsers.
- Measure structural geometry, computed styles, pixel difference, and perceptual difference.
- Test responsive breakpoints and keyboard-driven interactions.
- Require recursive repair to stop on a fixed retry budget and report residual differences.

Exit gate:

- Critical layout geometry stays within 1 CSS pixel of the reference.
- The agreed visual similarity threshold is at least 98.5% on fixed fixtures.
- All primary controls pass interaction and accessibility checks.

### Phase 8 — Controlled GPT-5.6 Sol High comparison

Scope:

- Start with 10 sealed representative tasks, then expand to 30–50.
- Include bug repair, multi-file features, refactoring, tests, visual reconstruction, browser debugging, dependency migration, unfamiliar-repository onboarding, MCP work, and interrupted-task recovery.
- Run each contestant from identical clean snapshots with equal time, retry, permission, and human-intervention budgets.
- Run each task at least three times before drawing reliability conclusions.
- Preserve prompts, raw logs, patches, screenshots, tests, timing, tokens, cost, and interventions.
- Use hidden acceptance tests and an evaluator that did not author either solution.

Win gate:

- Frontier Studio meets or exceeds GPT-5.6 Sol High on acceptance-test pass rate.
- Frontier Studio introduces no additional critical regressions or safety violations.
- Any speed or cost advantage is compared only at equivalent verified quality.
- The result remains favorable across repeated runs and is reported with uncertainty, failures, hardware, versions, and dates.

## Priority order

1. Phase 0: truthful states and telemetry.
2. Phase 1: real gateway and health boundaries.
3. Phase 2: reliable single-agent loop.
4. Phase 4: genuine automated verification.
5. Phase 5: measured inference and context performance.
6. Phase 6: MCP and multimodal wiring.
7. Phase 7: pixel and interaction parity.
8. Phase 3: real swarm execution after the single-agent path is reliable.
9. Phase 8: blinded head-to-head evaluation.

## Definition of completion

Frontier Studio reaches benchmark readiness only when every production capability is real, observable, failure-aware, and covered by executable verification. Passing UI animations, optimistic labels, or generated reports are not evidence. The evidence is the preserved execution trace plus independently runnable acceptance tests.

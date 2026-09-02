# Frontier Coding Agent Roadmap

> **This is a roadmap: it states intent, not current state.** Written before the
> rename, when the product was a harness rather than an application. Much of it
> shipped; some of it was overtaken. The status table below is the reconciled
> part — where a phase and the code disagree, the code wins. For what actually
> exists today read [`studio/README.md`](studio/README.md) and
> [`GATEWAY_DESIGN.md`](GATEWAY_DESIGN.md).

## Status

| Phase | State | Evidence |
| --- | --- | --- |
| 0 — proven foundation | shipped | Groq GPT-OSS-120B baseline in `opencode.jsonc`; isolated benchmark labs under `benchmarks/`. |
| 1 — rate-aware gateway | shipped | `gateway/http-gateway.js`, `quota-pool.js`, `run-budget.js`, eleven lane files, `/metrics`. See `GATEWAY_DESIGN.md`. |
| 2 — Claude single-agent baseline | shipped | `createAnthropicUpstream` in `gateway/provider-adapters.js`; `claude-sonnet` and `claude-opus` profiles. |
| 3 — engineering reliability | shipped | `studio/agent-runtime/` runs inspect → plan → edit → verify → repair → review → report; `studio/quality-runtime/` is the fail-closed gate. |
| 4 — UI and end-to-end verification | **partial** | `studio/visual-runtime/` does PNG comparison only. **Playwright was never added** — there is no Playwright dependency in the repository, and no browser-driven acceptance evidence. |
| 5 — enhanced frontier orchestration | **not started** | No architect/verifier/reviewer roles exist as separate agents. The `auto` profile escalates between models, which is not the same thing. |
| 6 — Antigravity comparison | partial | Five of seven benchmark suites under `benchmarks/` have recorded results; `video-mcp-timeline-sync-005` and `website-builder-saas-launch-003` have none. |

Four provider adapters exist — Groq, Gemini, Anthropic and Ollama — against the
three the roadmap anticipated; local Ollama models became the default engine,
which the roadmap did not foresee at all.

## North star

Build a provider-agnostic coding-agent system that can outperform Antigravity on
selected real software-engineering tasks through better repository intelligence,
persistent state, verification, recovery, and orchestration.

Cost is a safety constraint and evaluation metric. It is not the primary design
objective.

## Two evaluation tracks

### Controlled frontier comparison

- OpenCode harness with `claude-sonnet-5` at medium effort.
- Antigravity with `gemini-3.7-flash` at medium reasoning.
- Identical repository snapshot, task prompt, acceptance criteria, and time budget.
- No helper model, cross-provider fallback, or human coding assistance during a
  scored run.
- Report this as a cross-model, cross-harness comparison; do not claim it isolates
  harness quality.
- Preserve the existing GPT-OSS-120B baseline as a separate historical track.

### Enhanced frontier system

- Claude Sonnet 5 Medium as the default builder and general reasoning model while
  Gemini prepaid credits are unavailable.
- Explicit escalation to higher reasoning only for tasks that justify it.
- Add specialized architect, verifier, and reviewer roles only after the
  single-agent Gemini baseline is stable and measured.
- Use Groq GPT-OSS-120B as a diverse recovery or fallback model at persistent
  task/checkpoint boundaries, never silently inside controlled runs.
- Keep every provider, model, reasoning level, fallback, token count, latency,
  cost, and outcome visible in the evaluation record.

## Capability pillars

1. **Repository intelligence** — scoped search, repository maps, instructions,
   dependency awareness, and LSP diagnostics.
2. **Persistent execution** — task state, acceptance criteria, milestones,
   handoffs, resumable sessions, and bounded retries.
3. **Safe implementation** — least-privilege tools, worktrees, snapshots,
   approvals, secret isolation, and destructive-operation denial.
4. **Verification** — narrow tests, broader checks, UI/browser evidence,
   independent diff review, and explicit failure reporting.
5. **Model orchestration** — capability-based routing, task-boundary failover,
   circuit breakers, and provider-independent request policy.
6. **Evaluation** — reproducible tasks, frozen inputs, scored outputs, error
   taxonomy, token/cost accounting, and harness-versus-model attribution.

## Build sequence

### Phase 0 — proven foundation

- Groq GPT-OSS-120B health check succeeds.
- Isolated Git lab exists.
- Inspect/edit/test/report loop succeeds.
- Repository-backed state survives a fresh session.

### Phase 1 — rate-aware gateway and telemetry

- Implement an OpenAI-compatible local gateway with no-network fake-upstream
  tests first.
- Add deterministic provider lanes, credential isolation, quota tracking,
  bounded retry, circuit breaking, and non-secret metrics.
- Support a controlled single-provider mode and an explicit enhanced mode.

### Phase 2 — Claude single-agent baseline

- Add an Anthropic workspace-aware adapter with streaming and function-call tests.
- Start Sonnet 5 with medium effort and bounded outputs.
- Validate inspect/edit/test/report, malformed-tool recovery, long-task state,
  and interruption recovery.
- Run at least 10 controlled tasks and score them.

### Phase 3 — engineering reliability

- Add repository instructions and task templates.
- Add milestone checkpoints and isolated worktrees.
- Add LSP, formatter, narrow-test, broad-test, and final-diff gates.
- Add failure classification that distinguishes model, harness, provider,
  environment, and task defects.

### Phase 4 — UI and end-to-end verification

- Add Playwright in an isolated profile.
- Capture reproducible screenshots, console errors, network failures, and
  acceptance evidence.
- Require UI evidence for UI-affecting tasks.

### Phase 5 — enhanced frontier orchestration

- Introduce architect, builder, verifier, and reviewer roles one at a time.
- Measure whether each added role improves success rate enough to justify its
  latency and token cost.
- Add Groq recovery at checkpoint boundaries and later evaluate other providers.

### Phase 6 — Antigravity comparison

- Freeze a benchmark suite and scoring rubric before running comparisons.
- Run OpenCode Claude Sonnet 5 Medium and Antigravity Gemini 3.7 Flash Medium independently.
- Keep a future same-model Gemini-vs-Gemini control as a separate track when
  Gemini billing is available.
- Compare correctness, tests, regressions, time, tokens, cost, retries, recovery,
  and quality of evidence.
- Publish controlled and enhanced results separately.

## Advancement gates

- No phase advances on generated code alone; verification evidence is required.
- No live provider credential is added before secret handling and redaction tests
  pass.
- No paid traffic is enabled before a hard request, token, and spending budget is
  configured.
- No fallback is counted as a controlled-run success unless the benchmark policy
  explicitly allowed it before the run.

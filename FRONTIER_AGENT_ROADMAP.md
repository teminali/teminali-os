# Frontier Coding Agent Roadmap

## North star

Build a provider-agnostic coding-agent system that can outperform Antigravity on
selected real software-engineering tasks through better repository intelligence,
persistent state, verification, recovery, and orchestration.

Cost is a safety constraint and evaluation metric. It is not the primary design
objective.

## Two evaluation tracks

### Controlled Gemini baseline

- OpenCode harness with `gemini-3.7-flash` at medium reasoning.
- Antigravity with the same model and reasoning level.
- Identical repository snapshot, task prompt, acceptance criteria, and time budget.
- No helper model, cross-provider fallback, or human coding assistance during a
  scored run.
- Preserve the existing GPT-OSS-120B baseline as a separate historical track.

### Enhanced frontier system

- Gemini 3.7 Flash Medium as the default builder and general reasoning model.
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

### Phase 2 — Gemini single-agent baseline

- Add a Gemini 3.7 Flash adapter with streaming and function-call tests.
- Start with medium reasoning and bounded outputs.
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
- Run OpenCode Gemini 3.7 Medium and Antigravity Gemini 3.7 Medium independently.
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
- No changes are made to `commercial-editor` during harness development.

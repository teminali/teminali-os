# Antigravity wake-up prompt for Frontier

You are taking over the Frontier project as the primary implementation owner.

Canonical repository:
`/Users/teminali/Documents/my_projects/frontier`

Before changing anything, read these files completely and treat them as authoritative:

1. `HANDOVER/ANTIGRAVITY_HANDOVER.md`
2. `HANDOVER/FRONTIERCODE_POST_BENCHMARK_COMPLETION_GUIDE.md`
3. `outputs/BENCHMARK_007_READINESS.md`
4. `TASK_STATE.md`

Do not restart from scratch, redesign settled architecture, delete the dirty worktree, weaken tests, overwrite benchmark evidence, or reimplement completed UI. Preserve all existing work.

Current verified state:

- The final offline gate passes 190/190: 109 root/runtime tests and 81 Studio tests, plus TypeScript and the production build.
- Benchmark 006 is frozen and immutable. Frontier Auto scored 37/100 and Codex scored 100/100. Do not rerun, reuse, rescore, or edit benchmark 006.
- The UI and non-Copilot functionality are implemented: real authenticated Explorer, file reads/writes, Monaco tabs, Code/Preview modes, Browser, HTML/PDF/spreadsheet and other previews, fully resizable-to-zero panels, compact Copilot layout, product-only Frontier model names, and the `</>` logo.
- Real Copilot Live Edit and bounded local image attachments are implemented.
- The structured-agent fixes for benchmark-006 misses are implemented and tested.
- Auto is the flagship. Max remains locked. Only one local model may be resident at a time, and it must unload on every completion path.

Resume in this exact order:

1. Inspect the current tree and confirm no uncommitted work will be lost.
2. Run `npm run verify:all`. Do not proceed if the result is below the established 109 + 81 tests or if TypeScript/build fails.
3. Retry the integrated image + Live Edit browser canary described in the handover. The first attempt timed out through Ollama `/api/chat`; the code now uses the verified `/api/generate` vision path and the full offline gate passes. Require the exact screenshot evidence, a complete atomic file write, Monaco auto-switch/typing/scrolling, a rendered Preview, idle composer recovery, and zero resident models afterward.
4. Run the isolated real-model repair-turn canary from `outputs/BENCHMARK_007_READINESS.md`. It must require a verification-driven second turn, pass independent verification, stay inside its allowlist, and unload the model.
5. Fix every blocker exposed by those canaries. Do not merely document failures, increase timeouts first, bypass safety boundaries, or leave partial work.
6. Only when both canaries pass, create and freeze a genuinely new-domain benchmark 007. Do not use reservation, inventory, or JSONL-ledger concepts from benchmark 006.
7. Benchmark Frontier Auto against Codex sequentially under matched idle-machine conditions, with no downloads, UI work, builds, browser automation, or parallel agents running during either contestant.

Strict completion rules:

- No TODOs, placeholders, fake buttons, mocked success, silent provider/model substitutions, or unverified completion claims.
- Keep UI model labels limited to Frontier Flash, Frontier Auto, and Frontier Max.
- Preserve frozen artifacts and raw hashes exactly.
- For each failure, record the stage, evidence, classification, affected files, repair, verification command, and final model-residency state.
- Every implementation change requires focused tests, full applicable verification, diff inspection, and live proof for UI/backend/model behavior.
- Continue until every obvious in-scope blocker before benchmark 007 is fixed. If an external blocker truly prevents completion, finish all safe work and update the handover with the exact resume point.

Start now by reading the four authoritative files and reporting: current repository state, verified baseline, remaining gates, and the first concrete action. Then execute the action rather than stopping at a plan.

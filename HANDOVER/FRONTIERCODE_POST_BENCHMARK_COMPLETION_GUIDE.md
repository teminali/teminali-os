# FrontierCode Post-Benchmark Completion Guide

**Execution owner:** Antigravity Gemini 3.7 Flash High (handoff from Codex)  
**Benchmark opponent:** Codex; benchmark 006 used a fresh isolated Codex context and `codex-cli 0.149.1`, while the desktop UI did not expose the underlying model/build, reasoning effort, or service tier  
**Canonical repository:** `/Users/teminali/Documents/my_projects/teminali/teminaliCode`  
**Studio application:** `/Users/teminali/Documents/my_projects/teminali/teminaliCode/studio`  
**This guide begins:** from completed, immutable benchmark 006 evidence; the ordered work packages now begin with repairs for the measured Frontier Auto failures  
**Primary objective:** turn FrontierCode from a promising local-first prototype into a dependable, evidence-driven coding assistant that can be fairly measured against frontier coding products  
**Date of baseline:** 2026-08-31

---

## If Codex stops here: Antigravity resumes exactly from this point

Benchmark 006 is complete and frozen. Do not rerun the old pre-benchmark sequence or reinterpret the first result as broad superiority. Resume from the measured Frontier failures and the post-benchmark work packages in this document.

Current verified position:

- FrontierCode is consolidated into one canonical repository at `/Users/teminali/Documents/my_projects/teminali/teminaliCode`; the browser Studio is the `studio/` package in that repository.
- The final combined verification gate passes **190/190**: **109/109** root/runtime tests plus **81/81** Studio tests, followed by TypeScript checks and a successful Vite production build. This includes the generate-endpoint vision transport patch.
- The live Studio is available at `http://localhost:3000` with the authenticated local gateway at `http://127.0.0.1:4310` while the development process is running.
- The browser Copilot exposes only the product names **Frontier Flash**, **Frontier Auto**, and **Frontier Max**. It does not display provider or underlying local-model names, including in persisted route labels.
- Auto is selected as the flagship. Max is visibly locked because no heavyweight candidate has qualified. Auto truthfully routes to Flash while Max is unqualified.
- The Explorer and Copilot panels are responsive, drag-resizable, collapse through the resize gesture to a thin restore divider, and have keyboard/double-click resize behavior. Balanced and compact Explorer alignment was measured exactly at the activity-rail edge, with a regression test preventing the previous editor-gutter underlay.
- The Copilot UI has batched smooth streaming, cancellation, measured timing/tokens/tool evidence, a compact polished spacing system, a full-width edge-to-edge header divider, and a bottom composer that remains usable while output streams. Real Live Edit now applies complete fenced files through authenticated atomic writes, animates Monaco typing in read mode, switches/scrolls to exact working paths, synchronizes Preview, and lets the user stop visual following without cancelling safe complete-file commits.
- Image attachments support click, paste, and drag/drop for bounded PNG/JPEG/WebP inputs. A dedicated local `qwen3-vl:2b` vision lane grounds the coding prompt and unloads after every outcome. A direct image canary succeeded. The first integrated browser canary exposed a 120-second stall on Ollama's chat endpoint; the implementation now uses the already-proven bounded generate endpoint. Focused and full verification pass; one integrated retry remains.
- A direct isolated Flash canary returned exactly `FRONTIER_FLASH_READY`, unloaded afterward, and completed in 7.59 seconds including a 6.96-second cold load.
- A browser end-to-end Auto canary returned exactly `FRONTIER_UI_READY` in 7.23 seconds, exposed measured UI telemetry, and unloaded afterward.
- The final model-residency check returned `{"models":[]}`. No heavyweight local model is resident.
- Frozen benchmark 006 (`benchmarks/frontier-auto-vs-codex-006`) is complete. Both contestants were eligible. Frontier Auto selected Frontier Flash and scored **37/100** in **207.029 seconds**; Codex scored **100/100** in **206.250 seconds**.
- The benchmark winner for this one task is Codex. Timing is non-authoritative because separate Studio verification overlapped part of Frontier's run; correctness remains a deterministic diagnostic, not a broad product claim. Raw hashes and limitations are in `benchmarks/frontier-auto-vs-codex-006/results/006-summary.md`.
- The Studio now uses a real authenticated workspace tree/read backend, real Monaco tabs, only Preview and Code top modes, HTML/SVG/text/PDF/CSV/XLSX/XML-XLS previews, and an embedded Browser. Live verification loaded the real `frontier` tree and rendered `/preview/frontier-hypercar.html`.
- Qwen3.8 canary runs 1–5 are safely ineligible: no edits, failed independent verification, and no model left resident.
- Run 4 returned `structured_gateway_http_500` after the profile-specific prompt-JSON transport and an 8K ChatML alias were added. Run 5 repeated the failure after the alias was rebuilt from the text blob only.
- The direct bounded `/api/generate` probe against the text-only alias returned HTTP 500 with `unable to load model` for the confirmed text blob. The exact `hf.co/bartowski/Qwen3.8-27B-GGUF:IQ3_M` artifact is therefore not loadable in the current Ollama 0.17.4 runtime on this Mac; excluding the roughly 927 MB vision projector did not solve it.
- Do not keep changing JSON parsing, tool schemas, prompts, timeouts, or memory gates to repair this loader failure.

Resume in this exact order:

1. Preserve benchmark 006 raw files and verify the hashes in `results/006-summary.md`. Never edit or rescore those raw artifacts in place.
2. Run the focused Studio attachment test, then `npm run verify:all`. Require at least the last stable 109 root tests and 81 Studio tests, successful TypeScript checks, and a production build; record the exact contemporary total.
3. Retry the integrated image + Live Edit canary against only `outputs/live-edit-vision-canary.html`. Require grounded screenshot text, a complete atomic file write, Monaco auto-switch/read-mode playback, working Preview, clean terminal UI state, and zero resident Ollama models.
4. Run the isolated real-model repair-turn transfer canary described in `outputs/BENCHMARK_007_READINESS.md`. It must require a verification-driven second turn and leave zero resident models.
5. Preserve Auto as the flagship and Max as locked. Do not treat a model swap as a substitute for the repaired execution and verification loop.
6. Create benchmark 007 in a genuinely new domain. Do not rerun, reuse, or rescore benchmark 006. Freeze the task, seed, evaluator, controller, runtime, preregistration, and hashes before either contestant starts.
7. Compare Frontier Auto with Codex sequentially under matched idle-machine conditions, with no concurrent UI work, downloads, builds, or agents. Correctness is primary; latency is comparable only under matching process evidence.
8. Heavyweight Qwen qualification remains separate. Remove Devstral only if a replacement heavy path proves workable and Section 8's retirement gate passes.

The current benchmark intentionally measures the exact shipped Auto behavior with Flash as the only qualified local route. A future successful Qwen qualification creates a new product version and requires fresh benchmark evidence; it must not be back-applied to this run.

---

## 1. Operating instruction: do not reinterpret the mission

FrontierCode is not a demo wrapper around a local model. It is intended to become a provider-agnostic coding-agent platform whose advantage comes from repository intelligence, safe execution, persistent state, verification, recovery, explicit model routing, and reproducible evaluation.

The immediate product shape is:

- **Flash:** Qwen2.5-Coder 14B performs the entire task. It is the low-memory, fast, local default.
- **Auto (flagship):** a local hybrid policy. It starts or stays on Flash for ordinary work and may select or escalate only to an explicitly qualified heavyweight candidate, recording why. Auto does not mean cloud fallback. In benchmark 006 no heavyweight candidate was qualified, so Auto truthfully selected Flash.
- **Max (optional):** the qualified Qwen3.8 27B candidate performs the entire task. It must remain locked until that exact model artifact and FrontierCode execution path pass their qualification gates, and it is not assumed to be the best mode on a 24 GB Mac.
- **Advanced profiles:** controlled cloud/provider profiles may remain available for explicit testing and escalation, but they are not the meaning of the three chat-box modes.
- **Safety invariant:** only one local model may be resident at a time, and every run must unload its model on success, failure, timeout, cancellation, or client disconnect.
- **Benchmark invariant:** a scored candidate uses one predeclared configuration with no silent fallback, helper model, shared conversation, oracle access, or cross-contamination.

Do not reopen settled questions about whether Devstral should be the default, whether the three modes should exist, or whether Qwen-versus-Devstral needs a separate isolated comparison. Those decisions are settled:

1. Devstral 24B is unsafe on this 24 GB Mac and is not a viable default.
2. Qwen2.5-Coder 14B remains the lightweight model.
3. Qwen3.8 27B remains the intended heavyweight family. The originally selected Bartowski IQ3_M artifact is currently disqualified because Ollama cannot load it; any replacement quantization/package is a recorded candidate change that must qualify from zero.
4. The user explicitly skipped the isolated Qwen-versus-Devstral comparison.
5. Devstral is removed only after Qwen3.8 proves workable through the FrontierCode product path and the next benchmark evidence supports the decision.
6. Historical benchmark records that mention Devstral are evidence and must never be rewritten to make the current product look better.

---

## 2. Where the project came from

The repository already contains meaningful engineering, and it must be preserved rather than replaced.

### Proven foundation

- An authenticated loopback OpenAI-compatible gateway.
- Strict Gemini, Groq, Anthropic, and Ollama adapters.
- Deterministic lane selection with RPM, RPD, TPM, daily-token, cooldown, and in-flight accounting.
- Hard process-scoped request, token, and USD budgets.
- Two-phase usage accounting that reserves conservatively and settles from validated actual JSON/SSE usage.
- Bounded timeouts, cancellation handling, rate-limit classification, and one permitted failover attempt.
- Redacted diagnostics that do not disclose credentials, prompts, or authorization headers.
- Controlled profiles that pin a single provider lane and enhanced profiles that make fallback explicit.
- A specialist `website-builder` skill with routing, claim-integrity, responsive, accessibility, performance, and workflow rules.
- Repository snapshots, fresh-session recovery, required-change detection, hidden-file exclusion, and deterministic local sampling.
- A bounded structured local edit path with an exact file allowlist, required-file contract, strict `write_file` parsing, independent `npm test`, and cancellation propagation.
- A safe Qwen2.5-Coder 14B canary that changed exactly two required files, passed verification, had no scope violation, finished in 11.597 seconds, and left no resident model.
- A validated benchmark runner shape that detects changed files, scope violations, test results, timeouts, cancellation, and models resident before and after a run.

### Lessons already paid for

- Benchmark 001 proved the importance of actual-usage settlement. Conservative output reservations falsely exhausted a local budget even though provider-reported output was much lower.
- Historical benchmark 002 produced an eligible Codex diagnostic at 100/100 in 232.908 seconds, but Antigravity was cancelled. It is not a comparative result.
- Benchmark 003 showed that FrontierCode was not ready for comparison. Its initial run failed before dispatch, and later Devstral remediation produced malformed or absent edits. Codex demonstrated that the fixture was solvable, but the result was a readiness diagnostic, not a fair model comparison.
- A Devstral canary consumed about 18.8 GB and drove free system memory to 7%. It was cancelled before edits and unloaded successfully. This is a hard capacity finding, not a tuning suggestion.
- Local models may emit tool intentions as fenced JSON instead of native tool calls. The product must normalize only a narrow, validated form and fail closed on ambiguity.

### Historical evidence that must remain immutable

- `benchmarks/sonnet5-vs-antigravity-gemini37/`
- `benchmarks/codex-sol-ultra-vs-antigravity-gemini37-002/`
- `benchmarks/website-builder-saas-launch-003/`
- Archived result files and corrected evaluator records under those benchmark directories

Never overwrite, rename as a new result, rescore under changed rules without a versioned correction, or use historical candidate workspaces as a fresh benchmark baseline.

---

## 3. Exact state at this handoff

Treat these as facts until newer versioned evidence supersedes them.

### Models and modes

- Flash source: `qwen2.5-coder:14b-instruct`.
- Flash prepared aliases: `frontier-qwen2.5-coder-14b-16k` for the general OpenCode path and `frontier-qwen2.5-coder-14b-8k` for bounded structured edits.
- Disqualified original Max source: `hf.co/bartowski/Qwen3.8-27B-GGUF:IQ3_M`.
- Failed text-only alias: `frontier-qwen3.8-27b-iq3m-8k`, built from `/Users/teminali/.ollama/models/blobs/sha256-dd6cccbaed553b08e958bbd759e5f9d8985d782ea016c5eaf3cd770e64615851`; its direct load returned HTTP 500.
- Next candidate source: `batiai/qwen3.8-27b:iq3`, subject to direct load, memory, structured-edit, and three-canary qualification. This native Ollama package is a different quantization from IQ3_M and must be labeled as such in code and evidence.
- Devstral source: `devstral-small-2:24b-instruct-2512-q4_K_M`.
- Unsafe Devstral alias in the product: `frontier-devstral-24b-32k`.
- `gateway/model-qualification.json` still has `qwen38Iq3m.qualified: false`. Do not set it true merely because the model downloaded or generated text.
- Flash, Auto, and Max selection logic are shared by the gateway, terminal surface, and browser Studio. Max correctly remains qualification-locked. The browser surface imports the canonical root routing policy instead of maintaining a divergent policy copy.

### Qwen3.8 qualification state

Qwen3.8 is not qualified yet.

- Canary runs 1–5 are all ineligible, made no edits, failed independent verification, and left no model resident.
- The prompt-JSON transport and ChatML alias closed earlier request-shape gaps, but run 4 still failed with `structured_gateway_http_500`.
- The remaining blocker is below the gateway: Ollama 0.17.4 cannot load the imported split package or its confirmed roughly 13 GB text blob by itself. Run 5 and the direct HTTP 500 prove the text-only workaround is exhausted for this artifact/runtime combination.
- The next repair is to direct-probe one compatible native Ollama Qwen3.8 27B candidate, currently `batiai/qwen3.8-27b:iq3`, and then qualify it as a new immutable artifact. Do not undo the profile-specific transport or apply it to Qwen14/cloud lanes.
- A downloaded model, a successful `/api/show`, or zero resident models after failure is not a qualification pass.

### Verification checkpoint

The final development checkpoint is **190/190 passing**: 109 root/runtime tests and 81 Studio tests, plus successful TypeScript checking and a Vite production build. This includes responsive shell, authenticated workspace routes, Live Edit, exact tab identity, attachment policy, preview regressions, and the generate-endpoint vision transport patch. The remaining proof is the integrated browser retry, not offline verification.

### Worktree warning

The FrontierCode repository currently contains a large, intentional dirty worktree with modified and untracked product work. Do not assume these changes are disposable, do not reset them, and do not replace files wholesale from an older commit. Inspect and preserve them. Make a verified checkpoint only after the benchmark artifacts are frozen and the owner has confirmed the benchmark work is complete.

### Completed benchmark identity and next replication

Benchmark 006 is frozen at `benchmarks/frontier-auto-vs-codex-006`. It is a newly preregistered durable reservation-ledger task, not a mutation of benchmark 002. Its freeze manifest SHA-256 is `9f318aa3148dc5ac0a53a5f99d612683e42ad5d981ece64baa733a807dbe53cf`; the complete raw-result hashes, eligibility record, scores, limitations, and failure categories are in `results/006-summary.md`.

Any replication must receive a new immutable run identity or benchmark directory and must not overwrite benchmark 006 or historical benchmark 002. It must again preregister FrontierCode **Auto** as the flagship candidate; the exact Auto policy and qualification state; every model source/alias Auto may select; context; escalation rules; time limit; run order; allowed files; scoring rule; resource gates; and the exact visible Codex configuration before either candidate starts. Run it with the machine idle for both contestants so latency and resource conditions are matched. Auto's normal shipped routing/fallback behavior is part of the product under test. Do not force Max.

---

## 4. Anti-partial-work contract for Codex

These are execution rules, not suggestions.

1. **Start from evidence.** Read `TASK_STATE.md`, `FRONTIER_AGENT_ROADMAP.md`, `GATEWAY_DESIGN.md`, the new benchmark preregistration, current `git status`, and the relevant implementation/tests before editing.
2. **Preserve ownership.** Existing dirty changes belong to the user/main agent. Never use `git reset --hard`, broad checkout/revert operations, recursive deletion, or bulk replacement to simplify the tree.
3. **Maintain one implementation owner.** Subagents may inspect or verify disjoint concerns, but only one agent integrates overlapping product files.
4. **Turn every objective into observable acceptance gates before coding.** Add those gates to `TASK_STATE.md`. Do not silently narrow them when implementation becomes difficult.
5. **Do not declare completion from code generation.** Completion requires the relevant narrow tests, full offline suite, syntax/config validation, diff inspection, and real local canary where a local-runtime path changed.
6. **Do not leave placeholders.** An npm script that prints `Running...`, an empty benchmark directory, a TODO, a mocked product result, or a UI hint without behavior is unfinished work.
7. **Do not accept false success.** Exit zero plus no required edit, failed verification, a scope violation, a resident model, missing telemetry, or an unclassified transport error is failure.
8. **Repair the cause, not the fixture.** Do not weaken an oracle, visible test, allowlist, memory threshold, timeout, or benchmark task to make FrontierCode pass. Version a genuinely defective evaluator with an explicit correction record.
9. **Keep benchmark and development isolated.** Never inspect an oracle during a candidate run. Never develop inside a scored workspace. Never reuse a candidate workspace for another scored run.
10. **Never silently switch models.** Controlled benchmark runs remain pinned. Product Auto escalation must be visible in telemetry and may occur only at a defined task boundary.
11. **Close the loop on failures.** For every failed gate, record: stage, observed error, classification, evidence path, code owner, next repair, and the exact command that will prove the repair.
12. **Do not stop at the first green test.** Continue through every acceptance gate in the current work package. If external access is the only blocker, complete all safe offline work and leave a precise resume packet.
13. **Keep the machine usable.** Do not run FrontierCut, Devstral, Qwen14, and Qwen3.8 together. Abort a local run if memory reaches the defined emergency floor. Verify unload after every run.
14. **Report only measured facts.** Separate measured score/time/memory/tokens from interpretation. Do not claim model or platform superiority from one synthetic task.
15. **Update state before yielding.** A new agent must be able to resume using repository evidence without rereading this conversation.

---

## 4A. Architecture invariants

Treat FrontierCode as five isolated planes. Do not collapse responsibilities to get a demo working.

1. **Policy/control plane** — mode selection, model qualification, budgets, retries, escalation, permissions, and run state. Primary owners: `gateway/frontier-runner.js`, runtime configuration, and run-record code.
2. **Model transport plane** — provider-specific request/response transformation only. Primary owners: `gateway/provider-adapters.js` and lane configuration. It must not edit files, decide completion, or weaken policy.
3. **Tool execution plane** — schema-validated repository reads, edits, and checks inside a bounded workspace. It must not select models or trust model assertions.
4. **Verification plane** — product-owned exit codes, tests, diagnostics, diff/scope checks, browser evidence, and completion decision. A model can propose a check; it cannot certify itself.
5. **Evaluation plane** — frozen workspace creation, isolation, timing, scoring, and immutable artifacts. It must remain outside the candidate's writable scope and must not import product shortcuts.

Non-negotiable invariants:

- A provider adapter cannot bypass budgets, qualification, workspace policy, or verification.
- A model response is untrusted input until strict schema validation and path containment pass.
- Only the tool executor mutates a workspace.
- Only the verification plane can mark a change task successful.
- Every model selection is explicit in the run record.
- Every retry/escalation consumes a bounded policy allowance and has a classified reason.
- A controlled benchmark has no fallback; the Auto product benchmark may use only Auto's preregistered shipped policy.
- No run may own or overwrite pre-existing user changes without an exact baseline digest.
- Model unload and reservation/listener cleanup execute in a `finally`-equivalent path.
- Test/evaluator code cannot be modified by a candidate unless the preregistration explicitly allows it.
- Security and resource gates fail closed. They are never converted into model escalation.

---

## 4B. Engineering SLOs and error budgets

These are promotion gates. Measure them in automated run artifacts.

| Dimension | Alpha/Beta SLO | Hard failure condition |
|---|---:|---|
| Scope safety | 100% of qualified/scored runs have zero unauthorized file changes | any protected/out-of-scope write |
| Secret safety | zero secret values in logs, errors, metrics, prompts sent to unintended providers, or commits | any disclosure |
| False success | 0% of required-change runs report success without required files and passing product-owned verification | any occurrence |
| Cleanup | 100% of local runs leave zero resident models, child checks, gateway listeners, and unsettled reservations | any leak after bounded cleanup |
| Cancellation | request/child abort begins within 2 seconds; cleanup completes within 15 seconds in 95% of local canaries | process ignores cancellation or remains resident |
| Flash canary latency | 95% complete within 60 seconds on the two-file canary | any run exceeds the five-minute hard canary limit |
| Max/Qwen canary | three consecutive eligible runs within five minutes each | any loader error, scope violation, failed check, memory abort, or resident model |
| Memory | preflight expert free memory ≥10 GiB; runtime free memory >15%; warn at 15–25% | ≤15% runtime free memory or >1 GiB short-canary swap growth |
| Gateway overhead | p95 policy/adapter overhead below 250 ms excluding model generation and test commands | sustained regression >500 ms without accepted design reason |
| Resume integrity | 100% digest mismatch cases fail without overwrite | any stale overwrite or repeated external/destructive action |
| Evaluation eligibility | 100% of published comparison candidates satisfy preregistration and isolation | comparison/winner claim involving an ineligible candidate |
| Task reliability | ≥90% eligible success across the first ten-task mixed suite; report per-mode rates | aggregate hides failed/ineligible tasks |

An SLO miss consumes the release error budget and blocks promotion for the affected tier. Do not average away a security, scope, false-success, or cleanup violation; those have zero tolerance.

---

## 4C. Regression and change-control policy

Classify changes before implementation:

- **R0 documentation-only:** no runtime or benchmark semantics change. Validate links/commands and diff.
- **R1 local behavior:** isolated tool, UI, parser, or config change. Requires focused tests plus full offline suite.
- **R2 cross-plane:** routing, adapter, agent loop, verification, recovery, budget, cancellation, or state schema. Requires focused adversarial tests, full suite, relevant local canary, and run-record inspection.
- **R3 qualification/evaluation/security:** model alias/template, memory threshold, mode policy, benchmark, scorer, secret handling, permissions, destructive tools, or published result. Requires independent review, three canaries where applicable, immutable evidence, and versioned decision record.

Rules:

1. Add the failing regression test before or with the fix when the failure is deterministic.
2. Keep the smallest change that fixes the classified layer. Do not compensate for a loader error in the parser or for a model error in the oracle.
3. No benchmark task, oracle, scoring weights, time limit, allowed scope, or candidate configuration changes after the first candidate starts. A necessary correction creates a new version and preserves the invalid original.
4. No qualification bit changes in the same unverified step that adds a model alias or transport. Evidence comes first; promotion is a separate reviewed change.
5. Schema changes require a version, backward-read policy, migration test, and safe rejection of unknown future fields.
6. Any SLO regression requires either repair or an explicit, measured, owner-approved exception recorded in `TASK_STATE.md`. Security/scope/false-success exceptions are prohibited.
7. Review the final diff against the declared file list. Split unrelated changes instead of bundling them into a passing checkpoint.
8. Preserve raw test, canary, and benchmark evidence outside mutable candidate workspaces.

---

## 5. Benchmark closeout protocol and completed 006 record

This sequence was completed for benchmark 006. Preserve its evidence. Repeat the protocol for every future versioned replication before starting unrelated feature work.

### Step 5.1 — Freeze the run

Create immutable result artifacts under each benchmark's own results directory:

- preregistration and frozen manifest
- baseline commit and SHA-256 file hashes
- candidate labels, exact product version/commit, mode/profile, source model and prepared alias
- stdout and stderr
- monotonic start/stop timestamps and stop reason
- exit code, signal, timeout/cancellation status
- changed-file list and scope violations
- visible-test result
- hidden-oracle result, opened only after both candidates are final
- Frontier gateway metrics and model lane used
- input/output/reasoning tokens when exposed
- minimum free-memory percentage, swap before/after, resource aborts, and resident models before/after
- exact production patch
- final candidate response

Write files with create-once semantics where practical. If a report needs correction, keep the original as `*-v1-invalid` or equivalent and add a correction document. Do not edit raw logs after scoring.

### Step 5.2 — Determine eligibility before comparing scores

A candidate is eligible only if all are true:

- it started from the frozen byte-identical baseline
- no prohibited assistance, fallback, oracle access, or cross-candidate context occurred
- it finished within the preregistered time/resource policy
- its process and independent verification completed
- it changed no file outside the preregistered scope
- required files changed when the task required changes
- the model lane and alias match the preregistration
- the local model unloaded and no resident model remained

If either candidate is ineligible, label the run a **readiness diagnostic**. Do not announce a comparative winner based on raw score.

### Step 5.3 — Classify every FrontierCode failure

Use exactly one primary class and any secondary contributors:

- `MODEL_CAPABILITY`: valid context and tools reached the intended model, but its decisions or code were wrong.
- `MODEL_TRANSPORT`: prompt/template/tool schema/response normalization failed.
- `AGENT_LOOP`: context selection, tool sequencing, edit application, or stopping behavior failed.
- `VERIFICATION`: checks were absent, wrong, ignored, or falsely reported.
- `ROUTING`: wrong mode, lane, alias, fallback, or qualification state was used.
- `RESOURCE`: memory, swap, disk, CPU contention, or model residency caused failure.
- `HARNESS`: timer, workspace preparation, process capture, scoring, or cleanup failed.
- `FIXTURE_OR_ORACLE`: benchmark seed or evaluator was defective; this requires evidence from both baseline and reference-solution validation.
- `PROVIDER`: an authorized remote provider failed independently of the agent.
- `USER_INTERRUPTION`: the run was deliberately cancelled or its rules changed after start.

Do not call every failure “the model.” The remediation owner depends on the class.

### Step 5.4 — Write the result before interpreting it

For benchmark 006, the immutable raw JSON files and `results/006-summary.md` are the authoritative report. For future suite automation, also produce:

1. a machine-readable summary
2. a human report
3. an updated repository `TASK_STATE.md`

The human report must state eligibility first, then automated score, visible checks, elapsed time, memory/resource evidence, changed files, and limitations. The report must explicitly say that one run on one task does not establish broad superiority.

---

## 6. Post-benchmark decision tree

### Branch A — FrontierCode is eligible and scores 100/100

1. Preserve the result.
2. Run the same FrontierCode configuration two more times from fresh frozen workspaces. These are reliability replications, not replacements for the first run.
3. Require all three Frontier runs to be eligible, pass the visible suite and oracle, stay within scope, unload the model, and meet the resource floor.
4. Inspect Auto telemetry rather than assuming which model ran. If Auto used Qwen3.8 and all product-path qualification checks pass, set qualification true with evidence references, enable optional Max, and proceed to the conditional Devstral-retirement decision. If Auto used Flash, the benchmark validates Auto's shipped decision but does not by itself qualify Qwen3.8.
5. If only one or two of three runs pass, classify the instability and repair it before any superiority claim.
6. Proceed to Work Package 2, then build out the broader benchmark matrix. Do not repeatedly optimize the same dispatcher task.

### Branch B — FrontierCode is eligible but scores 60–99

1. Map every lost oracle point to the exact behavioral defect and file path.
2. Determine whether the cause is model capability, missing tool/context, agent sequencing, or verification.
3. Add a product regression test that reproduces the mechanism without copying hidden-oracle answers into the product.
4. Repair the product in a development workspace.
5. Pass all gates in Work Package 1.
6. Create a versioned rerun from a fresh frozen baseline. Preserve the original lower result.
7. Do not tune the benchmark prompt with oracle-specific wording.

### Branch C — FrontierCode is ineligible

1. Do not compare its raw score with the opponent.
2. Treat the run as a product-readiness diagnostic.
3. Fix the eligibility failure before adding features.
4. Run three consecutive short canaries through the exact failing product path.
5. Only then rerun the newly created benchmark under a versioned run ID.

### Branch D — FrontierCode fails because of memory or machine responsiveness

1. Stop the local model immediately and verify `/api/ps` has no resident model.
2. Record minimum free memory and swap growth.
3. Keep `qwen38Iq3m.qualified` false.
4. Do not weaken the memory gate to force a pass.
5. Optimize context, prompt payload, model residency, and competing processes; rerun the short canary before any versioned replication.
6. If Qwen3.8 cannot keep the machine responsive at 8K, Max is not viable on this Mac. Preserve the Auto flagship with Flash-only safe behavior until a safer heavyweight path is qualified; report that routing limitation honestly.

---

## 7. Ordered completion work packages

Complete these in order. A later package does not excuse an unfinished earlier gate.

## Work Package 0 — Establish a trustworthy post-benchmark baseline

**Goal:** make the active product tree reproducible without discarding current work.

### Actions

1. Inventory `git status --short`, the complete diff, untracked files, benchmark outputs, and current model inventory.
2. Reconcile `TASK_STATE.md` with the actual post-benchmark facts, test count, Qwen qualification state, and exact next action.
3. Run the current offline suite from `package.json`.
4. Run `git diff --check`.
5. Validate every JSON/JSONC lane/config and shell launcher touched by the current work.
6. Ensure no test or validation command contacted an external paid provider.
7. Check that no secrets, absolute temporary paths, model blobs, or candidate workspaces are staged.
8. Make one coherent verified checkpoint commit or a small ordered series. Preserve historical benchmark commits and user changes.

### Files to inspect

- `TASK_STATE.md`
- `FRONTIER_AGENT_ROADMAP.md`
- `GATEWAY_DESIGN.md`
- `package.json`
- `.gitignore`
- all changed `gateway/*.js`, `gateway/*.json`, `gateway/*.test.js`
- `bin/frontier.js`
- `scripts/`
- the new benchmark directory and its results

### Done when

- the actual test total is recorded and all tests pass
- diff hygiene passes
- the worktree contents are understood and no owner changes were lost
- the benchmark artifacts are immutable and independently scoreable
- `TASK_STATE.md` has one unambiguous Active item and one Next Action

---

## Work Package 1 — Finish Qwen3.8 transport and qualification

**Goal:** make the intended heavyweight model reliably perform bounded edits through FrontierCode without breaking other models.

### Required implementation

The prompt-JSON transport and ChatML request shape now have offline regression coverage. Do not keep editing them until a replacement model artifact can load directly. The Bartowski IQ3_M split alias and text-only alias have both failed below the gateway; diagnose higher-level transport only after a new candidate passes the direct-load gate.

Use the existing architecture; do not create a second gateway or a parallel agent implementation.

- Ollama model inventory/manifest: preserve the failed Bartowski IQ3_M text/projector digests and canary 5 evidence. Select and record exactly one new candidate package, quantization, digest, size, template, runtime version, and context. Do not call IQ3_XXS or another quantization IQ3_M.
- Candidate alias: use a source/quantization-specific name at 8K context. Never overwrite the failed alias while diagnosing, because artifact identity is part of the qualification evidence.
- Direct load gate: the new candidate must return HTTP 200 with non-empty text on a bounded direct generation and unload cleanly before any FrontierCode canary.
- `gateway/provider-adapters.js`: keep the ordinary OpenAI-compatible Ollama request path as the default. Preserve the narrow Qwen prompt-JSON transformation selected by explicit profile/lane configuration, loopback enforcement, and model mapping.
- `gateway/runtime-config.js`: validate transport choice against a closed enum and reject unknown fields. Never infer transport from arbitrary model-name substrings if a declarative setting is available.
- `gateway/lanes.controlled-qwen38-expert.json`: identify the exact Qwen transport and newly qualified provider alias without affecting the Qwen14 lane.
- `gateway/frontier-runner.js`: prepare/reuse the exact candidate 8K alias and fail with a classified model-load error rather than an opaque gateway 500.
- `gateway/local-structured-agent.js`: normalize a single strict prompt-JSON response into the existing validated `write_file` operation flow. Continue to enforce allowed files, required files, size budgets, protected directories, and independent verification.
- Corresponding test files: cover request shape, native-tool regression, fenced/prompt JSON, malformed JSON, multiple objects, extra prose, missing fields, unknown tool, path traversal, protected file, oversized content, abort, HTTP failure, and unload.

The transport must never execute arbitrary shell supplied by the model. Only product-owned, schema-validated operations are allowed.

### Qwen3.8 qualification sequence

1. Confirm no local model is resident before the run.
2. Confirm at least 10 GiB is free before loading, matching the current expert-profile contract.
3. Close FrontierCut and other known GPU/memory-heavy processes for qualification.
4. Prove the exact new candidate loads through a direct bounded HTTP generation and unload it.
5. Run the two-file canary through `local-expert`, 8K, required-change mode.
6. Record model alias, elapsed time, changed files, test output, minimum free-memory percentage, swap before/after, cancellation/resource state, and resident models after.
7. Repeat from a fresh workspace until three consecutive runs pass.

### Qualification gate

All three consecutive runs must:

- finish within five minutes each
- edit every required file and no other file
- pass independent tests
- exit zero without recovery ambiguity
- remain at or above 15% system free memory throughout; 15–25% is a warning that must be called out
- avoid more than 1 GiB additional swap use during a short canary
- leave zero resident models
- keep the machine responsive enough for ordinary foreground use

Only after this gate and an eligible product benchmark may `gateway/model-qualification.json` become:

```json
{
  "qwen38Iq3m": {
    "qualified": true,
    "reason": "<evidence paths and date>"
  }
}
```

Do not store a bare `qualified: true` without evidence.

### Done when

- all offline transport and regression tests pass
- Qwen14 behavior is unchanged
- three Qwen3.8 product canaries pass
- Auto can select the qualified heavy path through the same transport without breaking its Flash path
- optional Max unlocks from evidence, not an override

---

## Work Package 2 — Make Flash, Auto, and Max truthful product modes

**Goal:** the three choices in the chat box must have stable, testable behavior—not just labels.

### Settled semantics

| Mode | Model policy | Escalation | Qualification behavior |
|---|---|---|---|
| Flash | Qwen2.5-Coder 14B for the entire task | none | always available when the Flash model/capacity check passes |
| Auto | Flash for ordinary work; Max for classified complex work or a safe, classified Flash failure | local Qwen3.8 only; visible and bounded | remains Flash-only while Qwen3.8 is unqualified |
| Max | the exact qualified Qwen3.8 27B candidate for the entire task | none | locked until that immutable artifact and product path are qualified |

“Entire task” means planning, editing, verification interpretation, and final report use that mode's model policy. Utility commands such as deterministic file hashing or test execution are product tools, not separate models.

### Required repairs

1. Replace fragile keyword-only Auto routing with a small deterministic classifier based on observable task features: expected file count, repository breadth, requested operation, risk area, verification complexity, and prior classified failure. Keep the decision explainable.
2. Record `requestedMode`, `selectedProfile`, `selectionReason`, `complexitySignals`, `qualificationState`, and every escalation in the run result.
3. Make Auto escalation transactional. Flash may not leave an unverified partial mutation that Max unknowingly builds on.
   - For bounded allowed-file runs, snapshot the exact allowed files before Flash.
   - On classified Flash failure, restore only those files from the run snapshot, verify the original digest, and start Max from the same baseline.
   - Never restore or overwrite unrelated user changes.
   - For general dirty repositories, use a staging copy/worktree strategy and promote only a verified patch.
4. Escalate only for classified reasons such as repeated invalid structured output, inability to complete required files, failing checks after the one permitted repair pass, or a task classified complex before execution.
5. Never escalate for resource failure, user cancellation, invalid scope, missing model, broken harness, or unsafe free memory.
6. Enforce one resident model: unload Flash and verify it is gone before loading Max.
7. Make the selector actually operable. If the UI says `/mode`, Tab, or `ctrl+p` works, implement and test it; otherwise remove the hint. Do not ship decorative instructions for nonexistent controls.
8. Persist the chosen mode for the session and display the mode actually used for the completed run.
9. Do not confuse the legacy advanced `auto` cloud profile with the user-facing local Auto mode. Rename the advanced profile/config to a clear name such as `local-cloud-enhanced` if necessary, while maintaining a migration note.

### Files

- `gateway/frontier-runner.js`
- `gateway/frontier-runner.test.js`
- `gateway/frontier-tui.js`
- `gateway/frontier-tui.test.js`
- `bin/frontier.js`
- `gateway/model-qualification.json`
- model lane/config files
- a new run-result/telemetry module only if the existing runner cannot own the data cleanly

### Required tests

- Flash always selects local Qwen14, including complex prompts.
- Max selects Qwen3.8 only when qualified and fails closed otherwise.
- Auto selects Flash for small one-file work.
- Auto selects Max for a preregistered complex multi-file case when qualified.
- Auto remains Flash-only when Max is unqualified.
- Auto escalation unloads Flash before loading Max.
- A partial Flash edit is rolled back without touching unrelated dirty files.
- Cancellation does not escalate.
- Resource failure does not escalate.
- The result records the actual mode/model and reason.
- Every visible UI control performs the advertised action.

### Done when

- the labels, CLI, TUI, runtime, telemetry, and tests agree
- no silent fallback occurs
- Auto cannot corrupt a dirty worktree during escalation
- mode behavior is understandable from one result file

---

## Work Package 3 — Replace the narrow edit demo with a real safe agent loop

**Goal:** FrontierCode must solve ordinary repository tasks, not only whole-file writes against tiny snapshots.

The current structured path is valuable but intentionally narrow: bounded source collection, `write_file`, and `npm test`. A frontier assistant needs iterative repository inspection, surgical edits, diagnostics, and evidence-driven stopping.

### Build one controlled tool loop

Extend `gateway/local-structured-agent.js` or refactor it into a small cohesive agent subsystem. Do not keep two competing loops.

Minimum tools:

- `list_files`: scoped, bounded, respects hidden/protected directories
- `search_text`: exact/regex search with result and byte limits
- `read_file`: line/range reads with size limits
- `apply_patch`: validated surgical edit; reject ambiguous or stale hunks
- `write_file`: allowed only for new/small complete files or explicit full replacement
- `git_diff`: read-only diff summary and exact diff under output limits
- `run_check`: selects from a product-approved command list; never accepts arbitrary model shell
- `report_state`: structured completed/blocked/next/evidence checkpoint

Every tool requires:

- schema validation
- path normalization and containment
- file-count, byte, output, duration, and call limits
- cancellation support
- secret and hidden-file policy
- deterministic result envelopes
- an audit record without prompt/private-content logging

### Loop state machine

Use explicit states:

`INSPECT → PLAN → EDIT → VERIFY_NARROW → REPAIR_ONCE → VERIFY_BROAD → REVIEW_DIFF → COMPLETE`

Transitions to `FAILED` or `BLOCKED` must carry a classified reason and evidence. A model cannot emit `COMPLETE` unless product-owned verification gates pass.

### Context strategy

- Start from repository instructions, task, manifest, named files, and visible tests.
- Use search/read tools rather than sending an undifferentiated repository snapshot.
- Maintain a repository map with paths, languages, package roots, scripts, and instruction files.
- Summarize old observations into a bounded run ledger; do not repeatedly resend all tool output.
- Invalidate cached file summaries when the file digest changes.
- Never include `.env`, credentials, binary files, node_modules, `.git`, or benchmark oracle content.

### Verification strategy

Product code, not the model, decides whether checks passed. The model may choose from approved checks, but it may not claim a command succeeded without captured exit status.

Use escalating gates:

1. parse/syntax check for edited files
2. focused affected tests
3. formatter/linter/type checker where configured
4. broader package tests
5. diff/scope review
6. browser/UI checks when applicable

### Done when

- FrontierCode completes at least ten varied, isolated development tasks with no false-success exits
- it can modify existing files surgically, add files, read failures, repair once, and report evidence
- all tool boundaries have adversarial path/size/cancellation tests
- a fresh session can resume a deliberately interrupted run from its checkpoint

---

## Work Package 4 — Repository intelligence and instructions

**Goal:** approach frontier assistants in how quickly and correctly the agent understands a real codebase.

### Implement

1. Discover instruction files from repository root to target path, with nearer instructions taking precedence. Support the project's chosen convention and document it.
2. Build a bounded repository map: package roots, languages, build systems, test/lint/typecheck scripts, entry points, generated directories, and protected areas.
3. Add dependency awareness from manifests and import edges. Do not attempt an expensive whole-repo semantic index first.
4. Add diagnostics adapters for available language servers or compiler commands. Start with JavaScript/TypeScript because current benchmarks use them.
5. Add affected-test selection and a fallback broad-test policy.
6. Detect a dirty worktree and separate pre-existing changes from run-owned changes.
7. Include current file digests in edit operations so stale changes fail instead of overwriting concurrent edits.

### Acceptance cases

- monorepo with two package roots
- nested instruction override
- dirty target file plus unrelated dirty file
- renamed file/import update
- TypeScript error produced by a cross-file change
- test command in a nested package
- large repository where the context budget is not exceeded

### Done when

- the agent identifies the correct package and commands without broad guessing
- unrelated user changes remain byte-identical
- stale edits are rejected and recovered safely
- repository-map/context metrics are captured per run

---

## Work Package 5 — Persistent execution, recovery, and run records

**Goal:** long tasks survive context loss, process interruption, or model failure without repeating completed work.

### Run record schema

Create a versioned, non-secret record with:

- run ID and schema version
- objective and acceptance criteria
- workspace identity and baseline digest/commit
- requested mode and actual models/aliases
- protected scope and allowed files
- Completed, Active, Blocked, Next Action
- tool calls summarized by type/outcome
- file digests before/after
- verification commands, exit codes, and evidence paths
- retry/escalation count and reasons
- time, token, cost, and memory totals
- final status: complete, failed, cancelled, blocked

For ordinary user projects, store state in an explicit `.frontier/` project area only with documented behavior, or in an external FrontierCode state directory keyed by workspace digest. For benchmarks, store run records outside the candidate workspace so they cannot create scope violations.

### Recovery rules

- Resume only when workspace identity and expected digests still match.
- If user files changed after interruption, stop and show the conflict; do not overwrite.
- Never repeat a completed destructive/external action without an idempotency record.
- Limit automatic retries by class. One repair pass is the default; provider retry and model escalation are separate budgets.
- Cancellation must reach model request, child checks, gateway, and cleanup.

### Done when

- an interrupted three-file task resumes in a fresh process and finishes without repeating completed edits
- a changed-workspace conflict fails safely
- a cancelled run leaves no child process, listener, reservation, or resident model
- the run record is enough for another agent to continue without conversation history

---

## Work Package 6 — Verification, review, and UI evidence

**Goal:** make “done” mean the result is demonstrably correct.

### General verification

- Add a verification planner that reads project scripts and maps changes to available checks.
- Distinguish pre-existing failures from regressions with a baseline only when needed.
- Capture command, working directory, duration, exit code, and bounded output.
- Review the final diff for unintended files, debug code, disabled tests, secrets, and generated artifacts.
- Require explicit reporting when a required check cannot run.

### UI-affecting tasks

Add isolated browser verification, preferably Playwright, with:

- fresh browser profile
- mobile and desktop viewport captures
- console errors and failed network requests
- keyboard navigation and visible focus
- reduced-motion behavior
- semantic/accessibility checks
- reproducible screenshots linked from the run record

Do not claim visual quality from source inspection alone.

### Independent review

Introduce a verifier role only after the single-builder loop is stable. The verifier does not rewrite implementation. It receives task, acceptance criteria, final diff, and evidence; it returns concrete defects. Measure whether the role improves success enough to justify latency.

### Done when

- completion is gated by product-owned checks
- UI work includes visual and interaction evidence
- verifier findings lead to one bounded repair pass and then full re-verification
- false-success regression tests exist

---

## Work Package 7 — Skills and extensibility

**Goal:** make domain expertise reusable without bloating every prompt.

### Complete the existing skill path

- Validate `skills/website-builder/SKILL.md` and progressively loaded references.
- Ensure skill routing mounts only relevant instructions.
- Track which skill and version were used in run evidence.
- Add browser/visual gates to website completion.
- Keep facts/claims protected; never fabricate logos, metrics, testimonials, certifications, or capabilities.

### Add a skill contract

Every skill must define:

- trigger and exclusions
- required context
- protected facts/scope
- implementation workflow
- verification gates
- completion evidence
- safe external-action policy

Do not add many shallow skills. Add a second skill only after website-builder demonstrates measurable value over the generic agent.

### MCP/tool integrations

Treat MCP tools as typed external actions with authentication, permission, idempotency, timeout, and result validation. Do not consider benchmark 005 implemented merely because its README names an MCP action.

### Done when

- skill use changes measurable task success or quality
- skill instructions are validated and versioned
- an MCP integration has fake-server tests and a real opt-in smoke test

---

## Work Package 8 — Finish the evaluation system

**Goal:** measure platform progress without overfitting to one fixture.

### Do not reuse benchmark 002 as the new comparison

Create a new benchmark directory and ID derived from its dispatcher seed. Preserve 002 as the historical Codex-only diagnostic.

Every benchmark needs:

- `README.md`
- `TASK.md`
- `RUBRIC.md`
- machine-readable preregistration
- frozen seed
- visible tests
- withheld behavioral oracle
- independently verified reference solution
- SHA-256 manifest
- fresh-workspace preparation script
- monotonic runner
- scorer
- machine result schema
- versioned corrections

### Repair or quarantine incomplete benchmarks

- Benchmark 004 is not ready: its seed package points to a missing `test.js`, the oracle relies on shallow string checks, the task is underspecified, and freeze/preregistration machinery is missing. Build real TypeScript compilation/tests and behavioral state invariants before using it.
- Benchmark 005 is only a README. It needs a deterministic fake MCP service, frozen timeline/audio fixture metadata, exact expected operations, hidden verification, cleanup, and no dependency on the live `commercial-editor` repository.
- `package.json` scripts that only echo “Running” are placeholders. Replace them with real preparation/execution/scoring or remove them until implemented.

### Minimum benchmark matrix before frontier-standard claims

Run at least ten frozen tasks spanning:

1. focused bug repair
2. multi-file concurrency/state repair
3. TypeScript refactor with compiler gates
4. repository-wide API migration
5. test-driven feature addition
6. website/UI build with browser evidence
7. accessibility regression repair
8. instruction-following and protected-scope task
9. interruption/recovery task
10. typed MCP/external-tool integration

For each mode record success, eligibility, time, tokens, memory, retries, changed files, regressions, and evidence quality. Repeat tasks when results are unstable. Separate:

- model-only findings
- complete FrontierCode product findings
- controlled single-model findings
- enhanced orchestration findings

### Done when

- no placeholder benchmark is included in aggregate results
- baselines and reference solutions prove every evaluator distinguishes failure from success
- results are reproducible from frozen inputs
- claims are based on multiple task categories, not one synthetic win

---

## Work Package 9 — Product UX, packaging, and daily usability

**Goal:** a developer can install, understand, run, cancel, and trust FrontierCode without knowing its internals.

### CLI/TUI requirements

- one documented installation path
- `frontier status` reports model availability, qualification, memory gate, Ollama reachability, and no secrets
- the chat box exposes Flash, Auto, and Max clearly
- locked Max explains exactly what qualification is missing
- progress shows current stage, model, elapsed time, and verification—not hidden chain of thought
- cancellation is immediate and cleanup is visible
- final result lists changed files and checks
- errors give one actionable next step
- no hint advertises an unimplemented key or command
- no “Finished” banner appears when `outcome.ok === false`

### Packaging requirements

- pin or constrain runtime dependencies
- add supported Node/Ollama/macOS versions
- add first-run model setup and disk-size estimates
- provide model removal commands and explain shared Ollama blobs
- provide configuration examples without real credentials
- add upgrade/migration behavior for renamed profiles
- add a smoke test from a clean install

### Done when

- a new user can run a Flash canary from a clean install
- status accurately diagnoses missing model/Ollama/memory
- failed runs render as failed
- documentation matches real controls

---

## Work Package 10 — Security and production hardening

**Goal:** preserve the gateway's strong safety foundation while expanding agent powers.

### Required threat cases

- path traversal and symlink escape
- hidden-file and secret access
- prompt injection inside repository text
- model-requested arbitrary command
- test script attempting network access
- oversized file/tool output/context exhaustion
- malicious ANSI/log content
- stale patch overwrite
- concurrent run collision on port, state, or workspace
- client disconnect during stream/tool/check
- provider response with malformed usage or tool payload
- unauthorized external action

### Required controls

- workspace containment resolved through real paths
- explicit tool allowlists and command plans
- resource and duration limits on child processes
- per-run isolated temporary directories
- secret redaction tests
- no prompt/private source in metrics by default
- localhost authentication and host/model allowlists
- audit records using aliases, not credential fragments
- destructive/external actions require explicit user authority

### Done when

- adversarial tests pass offline
- expanding the tool set does not weaken existing gateway tests
- security failures are classified and never trigger Auto model escalation

---

## 8. Conditional Devstral retirement and storage recovery

The user wants Devstral removed to recover Mac storage, but only after Qwen3.8 proves workable.

### Retirement gate

All must be true:

- Qwen3.8 transport tests pass.
- Three consecutive Qwen3.8 FrontierCode canaries pass.
- The next FrontierCode Auto benchmark candidate is eligible and demonstrates workable correctness; if Qwen3.8 was selected/escalated, its exact heavy path is also verified by that evidence. If Auto stayed on Flash, use the three product canaries—not the benchmark—to decide whether Qwen is workable.
- Memory/resource evidence meets the qualification gate.
- Flash/Qwen14 remains installed and passing.
- The user has not reversed the removal decision.

The separate Qwen-versus-Devstral model-only comparison is not required.

### Exact retirement procedure

1. Record `ollama list`, disk free space, and `/api/ps` before removal.
2. Confirm no Devstral process is resident.
3. Remove only exact installed Devstral names. Expected names to check include:
   - `frontier-devstral-24b-32k`
   - any confirmed `frontier-devstral-24b-16k` or `frontier-devstral-24b-8k` aliases
   - `devstral-small-2:24b-instruct-2512-q4_K_M`
4. Never use a wildcard or broad Ollama storage deletion.
5. Verify `ollama list` contains no Devstral entry and measure actual reclaimed disk space. Aliases may share blobs, so report measured recovery rather than adding nominal model sizes.
6. Remove active product references:
   - `local-24b` from `gateway/frontier-runner.js`
   - Devstral labels from `gateway/frontier-tui.js` and `bin/frontier.js`
   - active Devstral profile tests
   - `gateway/lanes.controlled-devstral.json`
   - `gateway/lanes.controlled-devstral-structured.json` if present
   - rename `gateway/lanes.enhanced-devstral-claude.example.json` to a model-neutral local-plus-Claude name and update references
7. Preserve historical benchmark documents/results that truthfully record Devstral.
8. Run the full offline suite, status command, Flash canary, Max canary, and diff check.
9. Update `TASK_STATE.md` with exact model names removed and measured storage reclaimed. State that models can be redownloaded.

### Done when

- no active product path or help text selects Devstral
- historical evidence remains intact
- Flash and Max still pass
- actual disk recovery is reported

---

## 9. Frontier-standard release gates

Do not call FrontierCode ready for daily use or competitive benchmarking until all gates in the relevant tier pass.

### Tier 1 — Safe local alpha

- Flash passes ten varied tasks with at least 90% eligible completion.
- No false-success exits.
- Cancellation and unload pass every time.
- No scope or secret violations.
- Full offline suite passes.
- Clean-install smoke test passes.

### Tier 2 — Qualified hybrid beta

- The Auto flagship passes routing, transactional escalation, memory, canary, and product benchmark gates; optional Max passes its separate heavy-only qualification gates before it is exposed.
- Auto routing is deterministic, explainable, transactional, and tested.
- At least one interruption/recovery task passes.
- TypeScript diagnostics and affected tests work.
- Run records are complete and resumable.
- UI controls and status are truthful.

### Tier 3 — Frontier-comparison ready

- At least ten frozen benchmark tasks span the matrix in Work Package 8.
- Each evaluator has baseline and reference-solution validation.
- Candidate isolation is automated.
- Three-run replication exists for unstable or headline results.
- Controlled and enhanced modes are reported separately.
- Scores, time, tokens, cost, memory, and evidence quality are captured.
- No active P0 correctness, safety, memory, or cleanup defect remains.

### Tier 4 — Frontier assistant standard

- Reliable inspect/plan/edit/test/review loop on real multi-package repositories.
- Persistent recovery across sessions.
- Surgical conflict-aware edits in dirty worktrees.
- Browser evidence for UI work.
- Typed, permissioned external/MCP tools.
- Measured specialist skill value.
- Release packaging, upgrades, migrations, and support diagnostics.
- Security threat suite and reproducible evaluation suite pass in CI.

---

## 10. Mandatory verification matrix for every material change

| Change area | Minimum offline proof | Required live/local proof |
|---|---|---|
| Gateway/provider adapter | adapter + gateway regression tests, malformed/error/cancel cases | one bounded smoke through the affected provider/model |
| Local transport/tool parsing | strict schema, path, size, extra-text, abort tests | three fresh structured canaries for qualification-affecting changes |
| Model mode/routing | unit decision table, qualification lock, telemetry assertions | one Flash, one Auto, one Max run when qualified |
| Memory/capacity | injected deterministic unit tests | sampled preflight/runtime/unload evidence on the Mac |
| Agent edit loop | fake model/tool integration, rollback, false-success tests | isolated multi-file task with independent verification |
| Recovery | digest/conflict/cancel tests | kill and resume a real isolated run |
| UI/TUI | render and input behavior tests | manual terminal smoke with narrow/wide layouts |
| Website skill | validator and deterministic content tests | mobile/desktop browser evidence |
| Benchmark harness | fake candidate pass, fail, timeout, cancel, scope violation, resident-model cases | dry run before candidates; then fresh scored workspaces |
| Model deletion/profile removal | config/help/test updates | model inventory and disk before/after |

After every work package also run:

- the full current `npm test` command
- syntax/config checks for changed non-test files
- `git diff --check`
- `git status --short`
- manual inspection of the exact diff

Record commands, exit codes, durations, and relevant output in `TASK_STATE.md` or a linked run record. “Tests pass” without the command and count is insufficient.

---

## 11. Definition of done for an individual task

A task is complete only when:

1. the requested behavior exists in the product path, not only a fixture or test helper
2. all stated acceptance criteria are checked off
3. changed files are within scope and unrelated user changes are preserved
4. focused and broad verification pass
5. failure, timeout, cancellation, and cleanup paths are covered when applicable
6. documentation/help reflects actual behavior
7. no placeholder, disabled test, temporary bypass, or unexplained warning remains
8. resource/model state is clean
9. evidence and remaining limitations are recorded
10. `TASK_STATE.md` names the next uncompleted objective rather than repeating completed work

If any item is false, report the task as active or blocked—not done.

---

## 12. Required end-of-turn handoff format

Every Codex work session must end by updating repository-backed state and reporting:

```text
OBJECTIVE
<one concrete objective>

COMPLETED
- <implemented item with file paths>

VERIFICATION
- <command>: <exit code>, <test count/result>, <duration if relevant>
- <live canary>: <profile/model>, <changed files>, <memory minimum>, <resident models after>

ACTIVE
- <unfinished item being worked>

BLOCKED
- <only genuine external/authority blocker, with evidence>

NEXT ACTION
- <single exact next command or edit>

RISKS / LIMITATIONS
- <measured or specific remaining risk>
```

Do not use “mostly done,” “should work,” “appears fixed,” or “ready” without the corresponding gate evidence.

---

## 13. First post-benchmark execution checklist

Use this checklist from the completed benchmark 006 baseline:

- [x] Freeze benchmark 006 raw artifacts under its immutable ID.
- [ ] Confirm historical benchmark 002 is byte-unchanged.
- [x] Determine candidate eligibility before comparing score.
- [x] Classify every FrontierCode failure.
- [x] Record exact model alias, context, transport, mode, and qualification state.
- [x] Record available resource evidence and confirm no resident model after the run; repeat under matched idle conditions before using latency comparatively.
- [x] Write the immutable raw JSON files and `results/006-summary.md`.
- [x] Update `TASK_STATE.md` with the stable 190/190 full-suite count and benchmark outcome.
- [ ] Inspect and checkpoint the current dirty product tree without losing user work.
- [ ] Add regression fixtures for every benchmark 006 Frontier miss and repair the iterative verification-feedback loop.
- [ ] Re-run a versioned replication under matched idle-machine conditions after repairs; never overwrite benchmark 006.
- [ ] Pass three fresh Qwen3.8 canaries before unlocking Max.
- [ ] Make Flash/Auto/Max semantics and UI truthful.
- [ ] Retire Devstral only after the retirement gate; report measured storage recovery.
- [ ] Build the safe iterative agent loop and repository intelligence.
- [ ] Add persistent recovery and product-owned verification.
- [ ] Repair benchmark 004 and implement benchmark 005 before including them in a suite.
- [ ] Reach the ten-task frozen evaluation matrix before frontier-standard claims.

---

## 14. Final product direction

FrontierCode is promising because its strongest work is in the layers that make coding agents trustworthy: bounded spending, explicit routing, secure credentials, reproducible benchmarks, required-change detection, cancellation, local cleanup, and evidence-based diagnosis. Its failures have also been informative rather than hidden.

The remaining gap is substantial but specific. FrontierCode must evolve from a safe gateway plus a narrow local edit loop into a complete coding system that can understand repositories, make surgical multi-file changes, verify them independently, recover across interruptions, and expose truthful Flash/Auto/Max behavior. The route to frontier standards is therefore not to keep swapping models or polishing the terminal. It is to complete the execution loop, verification system, transactional routing, repository intelligence, persistent state, and broad evaluation matrix in the order defined above.

Codex must carry this plan to completed gates, not merely create scaffolding for them.

---

## Appendix A — Required three-pass validation of this handoff

This guide was cross-checked in three passes before delivery. Codex must repeat these checks whenever it materially updates the plan.

### Pass 1 — Factual consistency: completed

- [x] Cross-checked against `TASK_STATE.md`, `FRONTIER_AGENT_ROADMAP.md`, `GATEWAY_DESIGN.md`, current profiles/lanes, runner/TUI/tests, canary JSON/logs, and benchmark 001–005 contents.
- [x] Distinguishes historical facts from current state: benchmark 002 remains a Codex-only diagnostic; benchmark 003 remains a readiness diagnostic.
- [x] Records the final suite as 190/190 (109 root/runtime + 81 Studio) after the vision transport patch.
- [x] Records Qwen canaries 1–5 as ineligible/no edits/no resident, including run 5 after the text-only alias workaround.
- [x] Records the direct HTTP 500 `unable to load model` result and disqualifies the exact Bartowski IQ3_M artifact on Ollama 0.17.4 instead of asking the next agent to repeat it.
- [x] Labels the native Ollama `batiai/qwen3.8-27b:iq3` option as a different, unqualified candidate rather than silently treating IQ3_XXS as IQ3_M.
- [x] Records Auto—not Max—as the flagship and benchmark candidate.
- [x] Records Codex as the benchmark 006 opponent and truthfully records that the UI did not expose the underlying model/build, reasoning effort, or service tier; the run used `codex-cli 0.149.1` in a fresh isolated context.
- [x] Records benchmark 006 as complete and immutable and requires any replication to use a new identity without mutating benchmark 002 or 006.

### Pass 2 — Frontier-editor completeness: completed

- [x] Covers the capability areas required to approach Codex/Claude Code/Antigravity-class editors: repository intelligence, iterative tools, surgical edits, verification, diagnostics, persistence, recovery, UI evidence, model routing, permissions, telemetry, skills/MCP, packaging, security, and evaluation.
- [x] Separates model quality from transport, agent loop, verifier, harness, and resource failures.
- [x] Includes architecture invariants, measurable SLOs, resource limits, zero-tolerance safety conditions, and staged release gates.
- [x] Requires a multi-category evaluation matrix rather than extrapolation from one dispatcher task.
- [x] Identifies benchmark 004 and 005 as incomplete rather than counting their scaffolds as product capability.

### Pass 3 — Execution clarity and completion discipline: completed

- [x] Every ordered work package states a goal, concrete components/files, required actions, verification, failure handling, and definition of done.
- [x] The opening resume section starts from the immutable benchmark 006 evidence and gives the exact measured-failure repair order, canonical repository, verification gate, model-residency invariant, and replication rule.
- [x] The post-benchmark decision tree covers eligible pass, eligible partial score, ineligible run, and resource failure.
- [x] Change control prohibits oracle weakening, silent fallback, premature qualification, destructive cleanup, and loss of dirty user work.
- [x] Devstral retirement is conditional, exact-name-only, historically preserving, and requires measured storage recovery.
- [x] End-of-turn reporting prevents partial work from being mislabeled complete.

### Revalidation failure rule

If any checkbox becomes false because implementation or evidence changed, update the factual section and affected work package before proceeding. Do not preserve a stale instruction for consistency with this document. Record the change, evidence, and new gate in `TASK_STATE.md`.

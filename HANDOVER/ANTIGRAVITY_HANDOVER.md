# Frontier Antigravity handover

**Owner:** Antigravity Gemini 3.7 Flash High  
**Canonical repository:** `/Users/teminali/Documents/my_projects/teminali/teminaliCode`  
**Long-form engineering guide:** `outputs/FRONTIERCODE_POST_BENCHMARK_CODEX_GUIDE.md`  
**Benchmark-007 gate:** `outputs/BENCHMARK_007_READINESS.md`  
**Frozen benchmark:** `benchmarks/frontier-auto-vs-codex-006`

## Mission

Continue Frontier as a reliable local-first coding editor at Codex/Claude/Antigravity product standards. Finish every observable acceptance gate; do not substitute scaffolding, mock behavior, TODOs, or a passing narrow test for complete integration.

## Proven state

- Benchmark 006 is immutable: Frontier Auto 37/100; Codex 100/100. Both eligible. Correctness is diagnostic; latency is not comparable because UI verification overlapped the Frontier run.
- Full manifest validation is green. Never edit or rescore manifest-covered 006 artifacts. Results belong only in `results/006-summary.md` and later versioned records.
- Final integrated gate after the vision transport patch: 109/109 root/runtime + 81/81 Studio = 190/190, TypeScript green, production build green.
- UI/non-engine functionality is implemented: real authenticated Explorer/tree/read/write; Monaco tabs; Code and Preview top modes only; HTML/SVG/text/PDF/CSV/XLSX/XML-XLS previews; embedded Browser; resize-to-zero Explorer/Copilot with thin restore dividers; compact edge-to-edge Copilot; product-only Flash/Auto/Max labels; `</>` logo.
- Live Edit is real: complete fenced files are parsed, typed in Monaco read mode, switched/scrolled by exact path, atomically written through the backend, and synchronized with Preview. “Stop Live Edit” stops visual following, not already-complete safe commits.
- Image attachments are bounded and local: click/paste/drop, four images maximum, 12 MB source each, 5 MB optimized total, 1536 px maximum. Dedicated `qwen3-vl:2b` vision grounds the coding prompt and unloads afterward.
- Benchmark-006 product misses are repaired in the structured loop: fresh authoritative source per turn, seven-family failure classification, persistent contract checklist, at least two bounded repair attempts, and a 3072-token complete-edit ceiling. Offline evidence is 44/44 focused and 109/109 root/runtime.

## Exact current edge

The direct `qwen3-vl:2b` screenshot canary passed in 15.412 seconds and read the exact visible error correctly. The first browser-integrated image + Live Edit canary hit a 120-second timeout because image input was sent through Ollama `/api/chat`. The UI recovered and preserved the `UPSTREAM_TIMEOUT` evidence; no incomplete file was committed. Codex changed the vision call to the already-proven `/api/generate` path, added a regression assertion, and reran the full 190/190 + TypeScript + build gate successfully. The only remaining vision gate is one integrated browser retry.

## Resume order — do not reorder

1. Read this file, `TASK_STATE.md`, the long-form guide, and `outputs/BENCHMARK_007_READINESS.md`. Inspect the dirty tree; preserve all user/product work.
2. Confirm the recorded final gate if the tree changed after handoff: `npm run verify:all` must produce at least 109 root/runtime and 81 Studio tests, plus TypeScript and build. Investigate any lower count; never edit tests to restore a number.
3. Confirm `qwen3-vl:2b` exists and `/api/ps` is empty before testing. Do not load another local model concurrently.
4. Retry one browser-integrated canary using the existing safe file `outputs/live-edit-vision-canary.html`. Require all of:
   - screenshot evidence contains the exact visible message `No gateway route matches this request.`;
   - returned output is one complete fenced HTML file with explicit `path="outputs/live-edit-vision-canary.html"`;
   - file contains `data-frontier-canary="vision-live-edit-ready"` and visible `Frontier vision + Live Edit verified`;
   - Monaco switches to the exact path, read-mode typing/scrolling is visible, Preview renders the result, and the composer returns to idle;
   - cancelled/timed-out output never writes an incomplete file;
   - `/api/ps` is empty afterward.
5. If the canary fails, classify and repair the exact layer. Preserve error evidence. Do not increase timeouts as the first response, bypass the gateway, weaken bounds, or claim success from the direct vision probe alone.
6. With the machine idle, run one isolated real-model transfer canary for the repaired structured agent. It must deliberately need a visible-test-driven second turn, reach independent green verification, change only allowed files, and unload the model.
7. Only after steps 2–6 pass, create a new-domain unseen benchmark 007. Do not use reservations, inventory, JSONL ledgers, or benchmark-006 vocabulary. Validate untouched baseline and reference solution, then freeze all hashes before contestants run.
8. Run Frontier Auto and Codex sequentially with identical scope, time, runtime, network policy, and idle conditions. No browser automation, builds, downloads, or parallel agents during either run. Never expose the oracle to a contestant.
9. Publish correctness first, raw hashes, eligibility, resource state, and limitations. Never overwrite benchmark 006.

## Strict operating rules

- Auto is the flagship. Flash is lightweight-only. Max stays locked until a heavyweight path qualifies; never silently substitute a model.
- UI must display only Frontier Flash, Frontier Auto, and Frontier Max—not Qwen, Ollama, provider, alias, or quantization names.
- One local model resident at a time. Unload on success, failure, timeout, cancellation, and disconnect. Stop immediately if the Mac becomes memory-starved.
- Kerf MCP currently returns an optional degraded 404. It does not block coding, Explorer, Preview, Live Edit, vision, or benchmark-007 preparation; do not fake its actions.
- Preserve the dirty worktree. No reset, broad checkout, destructive cleanup, or replacement from older copies.
- No placeholders, fake buttons, fake previews, mocked success, TODO completion claims, or undocumented disabled behavior.
- Every changed path needs focused tests, the full applicable suite, build/type verification, diff inspection, and live proof when behavior crosses UI/backend/model boundaries.
- On failure record: stage, evidence, classification, affected path, repair, proof command, and model residency.
- Keep the Studio available at `http://localhost:3000` for the user while UI work continues. Restart only when necessary and restore it before handoff.

## Definition of benchmark-ready

Benchmark 007 may start only when the full suite/build is green after the vision patch, integrated image + Live Edit proof passes, structured repair-turn transfer canary passes, models are unloaded, machine conditions are idle, and a new-domain frozen fixture has been independently validated. Until then the product is promising and materially improved, but ready only for canaries—not a defensible new competitive claim.

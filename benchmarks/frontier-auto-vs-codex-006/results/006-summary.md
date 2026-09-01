# Benchmark 006 result — Frontier Auto vs Codex

Date: 2026-08-31  
Task: durable multi-file reservation-ledger repair  
Fixture manifest: `9f318aa3148dc5ac0a53a5f99d612683e42ad5d981ece64baa733a807dbe53cf`

## Eligibility and result

Both contestants were eligible: identities were recorded, monotonic clocks were closed within the 45-minute limit, Node/runtime checks matched, workspaces stayed in scope, and no symlinks or forbidden changes were detected.

| Contestant | Configuration | Visible tests | Private score | Timed run |
| --- | --- | ---: | ---: | ---: |
| Frontier Auto | Auto selected Frontier Flash; Max locked | 6/7 | **37/100** | 207.029 s |
| Codex | Codex desktop task; underlying model/build, reasoning effort, and service tier not exposed by the current UI; CLI 0.149.1 recorded | 7/7 | **100/100** | 206.250 s |

**Winner for this frozen run: Codex.** The score margin is 63 points. Timings were effectively tied (0.779 seconds apart) and must not be used as a meaningful speed claim.

## Measured interpretation

- Frontier Auto stayed on the preregistered Flash route, changed only allowed source files, ran its product-owned verification loop, reported `verification_failed`, and unloaded the local model. Post-run Ollama residency was empty.
- Frontier's retained implementation passed normalization, reload, corruption rejection, snapshot isolation, unknown release, and unknown-SKU checks, but missed strict unit validation, normalized stock lookup, aggregate capacity, reserve/release idempotency, request-intent conflict, incomplete-tail recovery, and null-input validation.
- Codex changed only allowed source files and passed all visible and private checks.
- No contestant accessed the other workspace, controller oracle, reference solution, network, or an assisting model/agent.

## Limitations

- This is one synthetic task and does not establish broad product superiority.
- The Codex UI did not expose an underlying model/build, reasoning effort, or service tier. Those fields are recorded as not exposed rather than guessed, which limits exact third-party replication.
- At the user's request, a separate Studio UI agent was active during part of the Frontier run and finished before the Codex run. This is a resource-condition confound, especially for latency, so the timing comparison is non-authoritative. Correctness scoring remains deterministic and offline, but this run should be replicated under matched idle-machine conditions before making a strong platform claim.
- Frontier's failure occurred before the time limit and remained after its own repair loop; it was not classified as a timeout or model-residency failure.

## Immutable raw evidence

- `frontier-auto-1.raw.json` — SHA-256 `2d8bfe41fa13105bdc1e948fa1b266785f127b7a852c57d57b5628bdda7f92be`
- `codex-1.raw.json` — SHA-256 `f473cf872ec84cc97af7beb02b7504e5108244a55c7498c598b1491b0ea3b28a`

Historical benchmark results were not modified.

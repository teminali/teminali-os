# Teminali Studio — close the agent-integration gaps

## Context (read before acting)

Repo: `/Users/teminali/Documents/my_projects/teminali/teminaliCode` (reachable as `studio/` from
`/Users/teminali/Documents/my_projects/teminali`). Teminali Studio is an Electron IDE
(Cursor Obsidian Dark aesthetic, see `DESIGN.md`) with a coding-agent backend.

Three layers exist today:

1. **Rate-aware gateway** — `gateway/`, contract in `GATEWAY_DESIGN.md`. OpenAI-compatible,
   quota lanes, budget reservation, credential isolation, deterministic audit. This is the
   differentiated asset.
2. **Frontier harness lane** — adopted OpenCode, configured by the seven `opencode.*.jsonc`
   profiles, launched via `scripts/start-frontier-agent.zsh` and `tui.json`.
3. **Local harness lane** — `studio/agent-runtime/` (~1050 LOC), a strict
   inspect → plan → edit → verify → repair → review → report loop sized for the
   Qwen2.5-Coder-14B-8K / Devstral local models.

Roadmap and advancement gates: `FRONTIER_AGENT_ROADMAP.md`. Current state: `TASK_STATE.md`.

## Hard constraints — do not violate

- **Do not replace OpenCode.** The harness choice is settled. No DeepSeek Harness, no Codex
  CLI, no custom general-purpose harness.
- **Do not grow `agent-runtime/` into a general harness.** It stays a narrow, strict,
  auditable loop for the small-context local lane. Context compaction, MCP transport, and a
  plugin system are explicitly out of scope for it.
- **Do not change the controlled benchmark track.** Benchmarks 001–007 under `benchmarks/`
  are the evidence base; harness and model pinning must stay comparable across runs.
- **Do not touch `commercial-editor`** (roadmap gate).
- Follow `DESIGN.md` component governance: UI changes go into `src/components/ui/` primitives
  or `src/styles/tokens.css` so they propagate. Never one-off styled markup.

## Work

### 0. Audit first — report before changing anything

Map exactly how a Studio agent run is initiated today, end to end:
`src/store/studioStore.ts` → `server/api-server.js` / `server/agent-cli.js` /
`server/terminal.js` → `scripts/start-frontier-agent.zsh` → OpenCode.

Tell me which parts run in-process, which shell out, and where run state actually lives.
Read the files — do not guess. **Stop and show me this map before writing any code.**

### 1. Close the in-process gap (primary deliverable)

Studio's React UI currently hands agent runs off to a terminal/TUI. Make Studio drive and
observe a run natively:

- Runs start, stream, and terminate through the server API — no user-visible terminal
  handoff on the default path.
- Stream *structured* events (tool call, file edit, command run, verification result,
  token/cost usage) to the UI, not raw terminal bytes.
- Cancellation from the UI actually cancels the underlying run.
- Run state stays resumable and survives a Studio restart, consistent with how
  `agent-runtime/state-store.js` already persists under `.frontier-agent/runs`.
- Keep the OpenCode TUI path working as an explicit escape hatch. Do not delete it.

### 2. Unify the two lanes behind one run interface

`agent-runtime` (local) and OpenCode (frontier) are invoked in completely different ways.
Define one server-side interface both satisfy — start, stream events, cancel, resume, report
usage — so the UI never branches on which lane is active. Adapt at the server boundary;
prefer that over changing either runtime's internals.

### 3. Make cost and quota visible in the UI

The gateway already tracks per-credential quota, reservations, and USD budget
(`GATEWAY_DESIGN.md`, `GET /metrics`). Surface live budget/quota state and per-run token +
cost accounting in the Studio UI.

Non-secret counters only — never key fragments, never authorization headers, credential
aliases such as `groq-a` only. Build it from existing `src/components/ui/` primitives
(`Badge`, `Card`).

### 4. Reconcile the product story in `DESIGN.md` §4

§4 describes "Frontier Auto" and "Frontier Flash" as official models. They are routing and
orchestration policies over a gateway plus a harness. Rewrite §4 so it is accurate — name
what they actually are (lane + routing policy + verification loop) — without weakening the
product framing. Keep the ecosystem-vs-studio precedence note intact.

## Verification — required, no exceptions

- `npm --prefix studio run typecheck` clean.
- `npm --prefix studio test` passes, and from `studio/`: `node --test agent-runtime/runtime.test.js`.
- `npm run verify:all` passes.
- Any UI-affecting change needs screenshot evidence (roadmap Phase 4 rule).
- Report failures honestly, with output. Per the roadmap's advancement gates, no phase
  advances on generated code alone — verification evidence is required.

## Sequencing

Do step 0, show me the map, and wait for my go-ahead. Then 1 → 2 → 3 → 4, one at a time,
verifying each before moving to the next.

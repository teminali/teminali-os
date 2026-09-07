# Teminali OS

The monorepo behind **Teminali OS** — an autonomous AI studio that runs
on your machine. Local models, local speech, local screen understanding; hosted
providers available and never required. Since v1.2.0 it also records the screen
and edits what it recorded: a screen recorder that hands its take to a timeline
already cut, and an exporter that renders that timeline back out to a file.

The product ships as a desktop application from
[`teminali/releases`](https://github.com/teminali/releases/releases)
(currently **v0.0.2**). Everything below is how it is built.

> The repository directory is `teminaliCode`, under `my_projects/teminali/`, and
> the internal package is `@teminali/core`. "Frontier" survives as the name of
> the routing gateway and the local model wrapper (Frontier Flash / Auto / Max);
> the *product* is Teminali OS.

## Repository layout

| Path | What it is |
| --- | --- |
| [`studio/`](studio/) | **The application.** Electron shell, React renderer, local gateway, and the five verification runtimes. Start here — it has [its own README](studio/README.md). |
| [`gateway/`](gateway/) | The routing gateway and model-mode runner: profiles, lane files, provider adapters, quota pool, run budget, TUI. |
| [`bin/`](bin/) | `frontier.js` — the terminal agent launcher, exposed as `teminali` / `frontier`. |
| [`scripts/`](scripts/) | Agent start scripts, Ollama memory tuning, provider diagnostics, benchmark preparation and scoring. |
| [`skills/`](skills/) | Specialist skills the runner can mount: `website-builder`, `frontiercut-copilot`. |
| [`benchmarks/`](benchmarks/) | Seven isolated benchmark fixtures with preregistrations, oracles and historical evidence. |
| `opencode.*.jsonc` | OpenCode profile configs the start scripts select between. |

## First setup

```bash
npm run studio:install
```

The root runtime has no third-party dependencies of its own.

## Daily development

```bash
npm run dev          # gateway + browser renderer (studio: dev:full)
npm run dev:ui       # renderer only
npm run gateway:start   # the routing gateway on its own
npm run frontier     # terminal agent launcher
```

For the real desktop application — Electron, the menu bar items, the global
assistant hotkey and the screen overlay — run `npm start` inside `studio/`.

## Verification

```bash
npm test            # root gateway/runner/licence/billing suite — 143 tests
npm run studio:test # application suite — 1775 tests
npm run verify:all  # both, plus the studio typecheck and production build
cd studio && npm run eval:local  # the local lane's fixed eval against the real model (needs Ollama)
```

Both suites are green: 143/143 and 1775/1775, no skips.

## Product modes

The local model wrapper exposes three modes. They are routing architectures over
local engines, not weights that were trained here.

- **Flash** — a lightweight local model for the whole task. Instant edits, high
  throughput, VRAM released on Apple Silicon.
- **Auto** — the flagship adaptive router. Multi-file edits, tool execution and
  step-by-step verification; it uses only qualified model paths and reports the
  path it selected.
- **Max** — the heavyweight local model for the whole task. **Locked** until its
  exact artifact and product path qualify, which is recorded in
  [`gateway/model-qualification.json`](gateway/model-qualification.json) and is
  currently `qualified: false`.

Alongside these, Claude Code and Codex run as the operator's own CLIs in the
real workspace, and Anthropic / OpenAI / Google are available as hosted
providers with automatic light and heavy lanes. No provider's flagship is ever
selected automatically.

## Benchmark rule

Benchmarks run only from fresh isolated workspaces with immutable
preregistration, exact candidate identity, independent verification, resource
telemetry and no cross-candidate assistance. The editor, the runtime and the
model must be reported as separate failure domains. The in-app arena
(`studio/server/arena.js`) enforces the isolation half of this at runtime: a
private copy of the current working tree per contestant, and `git diff` rather
than the transcript as ground truth.

## Design

[`studio/DESIGN.md`](studio/DESIGN.md) is the canonical design contract for the
whole suite — the token sheet, the component primitives, the shell architecture,
the screen assistant and voice. Read it before changing any interface.

## Support

If this saved you time, [a coffee's worth of crypto](DONATE.md) is a good way to say so. It stays free either way.

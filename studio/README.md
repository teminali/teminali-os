# Teminali Code

**An autonomous AI code studio that runs on your machine.**

A desktop application (Electron + React) whose models, speech, screen
understanding and agents all run locally by default. Hosted providers are
available and never required. Everything the renderer can reach goes through one
loopback gateway that never binds off `127.0.0.1`.

- Package: `@teminali/code` · version **1.1.1** · app id `code.teminali.app`
- Ships as `Teminali-Code-<version>-macOS-Apple-Silicon.dmg` / `-Intel.dmg`,
  a Windows NSIS installer, and a Linux AppImage, from
  [`teminali/teminalicode`](https://github.com/teminali/teminalicode/releases).

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Electron main (electron/main.cjs)                              │
│  frameless window · application menu · two menu bar items      │
│  global assistant hotkey · screen overlay window · installer   │
└───────────────┬────────────────────────────────┬───────────────┘
                │ narrow contextBridge            │ imports directly
                ▼  (window.teminali)              ▼
┌───────────────────────────────┐   ┌────────────────────────────┐
│ Renderer — React 19 + Vite    │   │ Local gateway (server/)    │
│  sidebar · chat · panels      │──▶│  127.0.0.1:4310            │
│  Zustand stores · services    │   │  bearer token per process  │
└───────────────────────────────┘   └─────────┬──────────────────┘
                                              │
        ┌─────────────┬─────────────┬─────────┴───┬──────────────┐
        ▼             ▼             ▼             ▼              ▼
     Ollama      Claude Code    Codex CLI    whisper.cpp     Hosted
   (loopback)     (your CLI)    (your CLI)   + macOS say    providers
```

The renderer holds **no credentials and no model weights**. It never talks to a
provider, a model runner or the filesystem directly — every one of those is a
gateway route, and the gateway re-checks anything the renderer already checked.

### The gateway (`server/`)

Binds to `127.0.0.1` and refuses any other host. An allowed development origin
bootstraps a process-lifetime bearer token with `POST /api/session`; every other
route requires it. Roughly sixty routes across:

| Area | Routes |
| --- | --- |
| Health, session, audit | `/health` · `/api/session` · `/api/audit` |
| Model mode & routing | `/api/frontier/status` · `/api/frontier/resolve-mode` · `/api/models/*` |
| Hosted providers | `/api/providers` · `/api/providers/key` · `/api/providers/lanes` |
| Workspace | `/api/workspace/{tree,file,write,search,open,projects}` |
| Terminal | `/api/terminal/exec` |
| Agent CLIs | `/api/agents` · `/api/agents/models` · `/api/agents/run` |
| Screen assistant | `/api/assistant/{capabilities,permissions,observe,act}` |
| Voice | `/api/voice/{status,transcribe,speak}` |
| Guardian | `/api/guardian/{snapshot,unload,governor,storage}` |
| Benchmark arena | `/api/arena/{sandbox,measure,measure/stream,history,cleanup}` |
| Usage, files, device | `/api/usage` · `/api/files/{capabilities,ingest}` · `/api/system/device` |
| GitHub, admin | `/api/github/{status,repos,token,clone}` · `/api/me` · `/api/admin/*` |
| Updates & releases | `/api/updates/{check,download,publish}` |
| Upstream proxies | `/api/ollama/*` · `/api/anthropic/v1/messages` · `/api/mcp` |

Audit records are metadata only — route, status, duration, byte counts — with
bounded rotation to `benchmark-results/gateway-audit.jsonl`. Prompts, responses
and transcripts are never written to it.

---

## What the app does

### The shell

One 260px sidebar (there is no icon rail), the conversation, and a workspace
panel strip. Sidebar views: **Chats · Explorer · Search · Skills**. The panel
strip holds any number of tabs of eleven kinds:

| Panel | Shortcut | Panel | Shortcut |
| --- | --- | --- | --- |
| File | `⌘G` | Claude Code | `⇧⌘C` |
| Terminal | `⌘J` | Codex | `⇧⌘O` |
| Browser | `⇧⌘B` | Usage | `⇧⌘U` |
| Canvas | `⇧⌘A` | Benchmark | `⇧⌘N` |
| Side chat | `⇧⌘S` | Release *(admin)* | `⇧⌘R` |
| Guardian | `⇧⌘G` | | |

Plus `⌘B` sidebar · `⌘L` chats · `⇧⌘E` explorer · `⇧⌘F` search · `⌘K`/`⌘P`
command palette · `⌘,` settings.

### Engines

Three kinds of engine answer a turn, and they are peers rather than tiers.

**Frontier (local, via Ollama).** Three modes — `flash`, `auto`, `max` — backed
by profiles in `gateway/frontier-runner.js`:

| Profile | Model | Notes |
| --- | --- | --- |
| `local` | Qwen2.5-Coder 14B (16k / 8k structured) | The default. Needs 16 GB. |
| `local-expert` | Qwen3.8 27B IQ3_M | Needs 24 GB. **Gated** by `gateway/model-qualification.json`, currently unqualified. |
| `local-24b` | Devstral 24B | Needs 32 GB. |
| `auto` | Qwen Coder + Claude Sonnet escalation | Hybrid. |

**Agent CLIs.** Claude Code and Codex are not providers behind the chat box —
they are the CLIs already installed on the machine, spawned as real processes in
the real workspace with their own auth, tools and resumable sessions, driven
headless and normalised to one event shape. Neither may default to its most
permissive permission rung.

**Hosted providers.** Anthropic, OpenAI and Google, each with a light lane for
everyday turns and a heavy lane for hard ones. The flagship of each (Opus 5, o3,
Gemini 2.5 Ultra) is listed and **never selected automatically**. Keys are
stored server-side at mode `0600` and are never returned to the renderer — the
API reports only whether a key exists and a masked hint.

### The screen assistant

Hold the global shortcut, or press the microphone in any composer. It looks at
your screen and either explains it or acts on it.

- **Modes:** `dictate` (into the composer) · `talk` (explains and points) ·
  `agent` (may click, type, scroll).
- **Autonomy:** `guide` · `confirm` · `auto`. The default is **`confirm`**.
- **A vision model is never asked where anything is.** The screenshot is
  context; positions come from the macOS accessibility tree via the Swift helper
  in `native/macos/pointer/`. `PlanStep` carries no coordinate field on any
  variant, so a model-invented position is not representable in the protocol.
- The gateway re-checks every action against the observation it names: expired
  looks (90 s), unknown elements, disabled elements and a changed frontmost app
  are all refused.
- Vision runs locally on `qwen3-vl:2b`. Requires Screen Recording **and**
  Accessibility, which are detected and reported separately because they lose
  different things.

### Voice

Local by default: **whisper.cpp** for recognition, macOS `say` for synthesis. An
optional **VibeVoice** sidecar on `127.0.0.1:8321` upgrades both; the browser
speech engine is the always-available fallback. Push-to-talk dictation and
hands-free conversation with barge-in. Nothing reaches the chat unreviewed — every
utterance passes a repair pass the operator sees before it sends.

### Guardian

What the machine is holding, right now. **Every number is measured or it is
`null`** — a metric that could not be read is reported as null and named in
`unavailable`, never drawn as a plausible zero. Three layers:

1. **Snapshot** — resident Ollama models, real unified-memory footprint, pressure.
2. **Auto-unload** — evicts an idle or superseded resident model. Reversible, destroys no work.
3. **Governor** — can close applications, and is the most defensive code in the
   product: graceful AppleScript `quit` only, never a signal; unsaved work is
   absolute and *unknown* counts as unsafe; never the app you are using; a
   protected list that cannot be emptied.

### Benchmark arena

Frontier against a challenger on the same task, each in its own sandbox, judged
by an agent. Administrator-only, enforced in the gateway. Each contestant gets a
private copy of the **current working tree** (not HEAD) as its own `git init`,
with `node_modules` symlinked. `git diff` in the sandbox is ground truth; the
transcript is only what the agent claims. A watcher that is also a contestant is
marked `self-graded` on the verdict.

### Usage ledger

Append-only JSONL, one line per turn, aggregated on read. Per-model tokens
include that model's cache reads and writes so the table sums to the headline.
An unreported cost is `null`, never `$0.00` — Codex bills a subscription and
returns no figure.

### File ingestion

Dropped files are converted per kind rather than read as bytes: audio/video →
whisper.cpp · PDF → embedded text, OCR when scanned · office docs → `textutil` ·
images → downscaled for vision, plus OCR · archives → listing · data → structure
and a sample. Images: up to 4, PNG/JPEG/WebP, 1536px max edge.

### Releases and updates

The studio ships itself. Publishing (`/api/updates/publish`, the Release panel)
is administrator-only and drives typecheck → test → build → preflight → tag → CI
→ notes through the `gh` CLI. Checking for an update runs on every install
against the public Releases API with no credential. Installs are **full asset
replacement** — the app is ad-hoc signed, so Squirrel-style in-place updating is
not available, and macOS clears Screen Recording / Accessibility / Microphone on
every update.

---

## Verification runtimes

Each is dependency-free Node with its own README and test entry point.

| Runtime | What it does |
| --- | --- |
| `agent-runtime/` | Explicit `inspect → plan → edit → verify → repair → review → report` loop. Edits only caller-declared paths; refuses to report success until real verification passes. |
| `quality-runtime/` | Fail-closed gate over typecheck, unit, integration and browser commands. A missing runner is `unmeasured`, which cannot pass. |
| `visual-runtime/` | Deterministic PNG/RGBA comparison — exact differing-pixel counts and CIE76 deltas. Measurements, not a score. It does not capture browsers. |
| `performance-runtime/` | Live Ollama latency harness through the gateway. Records Ollama's authoritative counts; never logs prompt content. |
| `mcp-runtime/` | MCP client and image-proof helpers. |

---

## Getting started

```bash
npm install

npm run dev:full     # gateway + Vite renderer in the browser
npm start            # gateway + Vite + Electron (the real app)
npm run desktop      # Electron only, against an already-running dev server
```

Optional local capabilities:

```bash
npm run build:pointer     # compile the Swift accessibility/input helper (macOS)
npm run assistant:doctor  # report the whole screen-assistant path, honestly
brew install whisper-cpp  # local transcription; place a ggml model in ~/.cache/whisper
ollama serve              # local models on 127.0.0.1:11434
```

## Verification

```bash
npm run typecheck   # tsc --noEmit
npm test            # 501 tests, 0 failures
npm run build       # tsc && vite build
npm run verify:core # all three
```

`npm run assistant:doctor` exits non-zero until macOS Accessibility is granted.
That is the doctor working, not a regression.

## Packaging

```bash
npm run package:mac     # --arm64 --x64, renamed to Apple-Silicon / Intel
npm run package:win
npm run package:linux
```

`build/afterAllArtifactBuild.cjs` renames the two macOS DMGs after the fact,
because `artifactName` cannot branch on architecture. That is only safe because
`dmg.publish: null` is set in `electron-builder.yml` — do not remove it.

## Configuration

Everything is optional; every default is loopback.

| Variable | Default |
| --- | --- |
| `FRONTIER_GATEWAY_PORT` | `4310` |
| `FRONTIER_ALLOWED_ORIGINS` | `127.0.0.1`/`localhost` on ports 3000 and 3001 |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `TEMINALI_VOICE_URL` | `http://127.0.0.1:8321` |
| `TEMINALI_CUT_MCP_URL` | `http://127.0.0.1:3888` |
| `FRONTIER_WORKSPACE_ROOT` | the repository root |
| `TEMINALI_RELEASE_REPO` | `teminali/teminalicode` |
| `TEMINALI_RUNTIME_MODE` | `local` (or `api`) |

Non-loopback values are rejected at startup rather than accepted and ignored.

## Further reading

- [`DESIGN.md`](DESIGN.md) — the Teminali Design System contract, shell
  architecture, the screen assistant and voice. Read before changing any UI.
- [`docs/INVESTIGATION_DOCTRINE.md`](docs/INVESTIGATION_DOCTRINE.md) — how the
  model is required to investigate before it answers.
- [`docs/DILIGENCE_TEST_PLAN.md`](docs/DILIGENCE_TEST_PLAN.md) — the manual plan
  that proves it.
- [`docs/VOICE_SIDECAR.md`](docs/VOICE_SIDECAR.md) — the VibeVoice contract.

## Licence

This repository is private and ships no `LICENSE` file. No licence is granted.

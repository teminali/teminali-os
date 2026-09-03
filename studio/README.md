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
| Usage, files, device | `/api/usage` · `/api/plan` · `/api/files/{capabilities,ingest}` · `/api/system/device` |
| GitHub, admin | `/api/github/{status,repos,token,clone}` · `/api/me` · `/api/admin/*` |
| Updates & releases | `/api/updates/{check,releases,download,publish}` |
| Upstream proxies | `/api/ollama/*` · `/api/anthropic/v1/messages` · `/api/mcp` |

Audit records are metadata only — route, status, duration, byte counts — with
bounded rotation to `benchmark-results/gateway-audit.jsonl`. Prompts, responses
and transcripts are never written to it.

---

## What the app does

### The shell

A 48px activity bar, a 212px sidebar panel beside it, the conversation, and a
workspace panel strip. Sidebar views: **Chats · Explorer · Search · Skills**.
The rail stays on screen when the panel is collapsed, so a dismissed
sidebar is one click from open on any view. The panel strip holds any number of
tabs of thirteen kinds:

| Panel | Shortcut | Panel | Shortcut |
| --- | --- | --- | --- |
| File | `⌘G` | Claude Code | `⇧⌘C` |
| Terminal | `⌘J` | Codex | `⇧⌘O` |
| Browser | `⇧⌘B` | Usage | `⇧⌘U` |
| Canvas | `⇧⌘A` | Benchmark | `⇧⌘N` |
| Side chat | `⇧⌘S` | Release *(admin)* | `⇧⌘R` |
| Guardian | `⇧⌘G` | Video Editor | `⇧⌘V` |
| Record Screen | `⇧⌘8` | | |

Video Editor and Record Screen are the two kinds limited to a single tab. The
editor owns a timeline and a playback clock, and a second copy would be a
second project competing for them; the recorder owns the take, and a second
copy would offer to stop a recording the first one is holding. `⇧⌘8` is the
File menu's own accelerator — the recorder has no separate binding of its
own, and the menu item is the shortcut.

Plus `⌘B` sidebar · `⌘L` chats · `⇧⌘E` explorer · `⇧⌘F` search · `⌘K`/`⌘P`
command palette · `⌘,` settings. Skills is reached from the rail; it has no
shortcut. The media pool lives in the video editor's own rail.

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

Which installed model each lane actually resolves to is decided by
`planRouting` in `studio/server/model-catalog.js`, against the machine it is
running on. Two rules govern the heavy lane: it ranks by **parameter count, not
file size** — quantisation changes bytes without changing what a model knows —
and it refuses anything estimated below 10 tok/s, because a stronger answer
nobody waits for is not the stronger answer. If nothing clears that bar the
heavy lane collapses onto the light one rather than pretending.

Mixture-of-experts models are budgeted separately: memory against the whole
file, speed against the `activeBytes` a single token actually reads. GPT-OSS 20B
is the first such entry — measured on an M4 Pro at **29.4 tok/s against
Devstral 24B's 6.0**, on 4 GB less resident memory, which is why it wins the
heavy lane on a 24 GB machine despite the smaller file.

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
  `agent` (may click, type, scroll and open applications). The default is
  **`agent`**.
- **Autonomy:** `guide` · `confirm` · `auto`. The default is **`auto`**, chosen
  by the operator on 2026-09-03; the two safer rungs are one switch away.
- **Opening applications.** A `launch` step starts an application, and a browser
  may be given an `http`/`https` address. `app` names an id from the catalogue
  in `src/services/assistant/apps.ts` — never a path, never a command, and no
  terminal is in it. A launch is always the last step of a plan, because what it
  opens has no window to plan against yet.
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

### Video editor

A timeline editor ported from Teminali Cut, in a workspace panel (`⇧⌘V`). The
panel's own chat edits the project by emitting a ```` ```video-tool ```` fence,
and the same tools are served over MCP to the agent CLIs — Claude Code and Codex
get a `cut` server wired into the tab that spawned them, so the CLI already
running your repo can also cut your timeline.

**The exposed surface is an allowlist**, not the Cut's whole registry. Six tools
of a fifteen-tool budget: `describe_timeline`, `patch_clip`, `set_effect_param`,
`list_media_pool`, `import_media_from_path`, `ffmpeg_process`. The ceiling is
deliberate — the Cut's 115 tool descriptions are ~8.7k tokens on every request
that advertises the panel, so a name gets added only when someone decides to pay
for it. `ffmpeg_process`'s `custom` operation, which takes a raw filtergraph,
is reachable from the panel's own chat and is **not** advertised over MCP.

**The layout is a function of the panel's width.** The pane measures itself and
resolves a tier (`xs` < 460 · `sm` 460–639 · `md` 640–899 · `lg` ≥ 900), then
spends the width it actually has: at `lg` the media library, the program monitor
and the inspector are three columns; at `md` the library visits as an overlay;
below 576px both visit, and on the tightest tier the inspector arrives as a
bottom sheet so the monitor keeps the room. Nothing is removed at any width —
the 12 timeline tools that exist at 1200px all exist at 400px, folding into an
overflow menu that carries their labels and shortcuts. The alignment shelf that
floats over the stage follows the same rule: it is eight icons rather than
fourteen, with the four *transform* actions on it — both flips, fit-to-frame and
reset — behind a single `⋯`. Labels on the bar appear
at `lg` only; the controls themselves get *larger* at `xs`, not smaller. A drag
handle between the monitor and the timeline sets the split (arrow keys move it,
double-click resets it).

**The panel expands to the edge, and the inspector can always be put away.** The
tab strip's expand button runs the editor out to the vertical tab rail —
`--panel-w-expanded` is `calc(100vw - var(--shell-left-inset))`, not the flat
736px it was — and while expanded the conversation is hidden rather than crushed,
staying mounted. Dragged short of that, the chat keeps a 420px floor. `Edit` is
drawn at every tier, and only the mechanism behind it changes: where the
inspector is seated it minimises that column, where the inspector is summoned it
opens the overlay. One control, so there is no width at which the 296px rail
cannot be given back to the picture.

**The transport has keys**, and its play disc is centred on the picture rather
than on what is left of the row. `Space` plays and pauses — and replays, when the
playhead is parked at the end — `Home` / `End` jump to the in and out points,
`←` / `→` step a frame (hold to scrub), `M` drops a marker, `I` sets or clears
the in point, and `L` toggles loop. They are live only while the editor is the
open panel, and never while you are typing in a field.

**The media library lives in the editor.** It was a sidebar tab as well; that
tab is gone, and the editor's rail is the only seat now — which is where you
reach for a clip. It is the same component reading the same pool. The import
gate is unaffected: its prompt is mounted by `App.tsx`, never by this panel
(below).

Right-click menus and toasts now render inside the panel. They had been pushed
to `uiStore` since the port with nothing subscribed, so every track and clip
context menu was dead and beat detection reported its result to no one.

**Importing is a grant.** A file you pick or drop in the editor's media rail is
a human gesture, so it grants that file and its containing folder for the
session. Anything else — a path an agent names — raises an approval prompt that
shows the *resolved* path and offers: allow this file · allow this folder for the
session · deny. Nothing is persisted, and there is no "always allow".

Two refusals never become a prompt, because their only defensible answer is no:
a deny list (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`, the app's own
`userData`, and any dotfile) that overrides every grant, and a per-argument
extension rule. Unanswered, a prompt settles as a denial after 90 seconds, so a
blocked call never becomes a wedged CLI. Every decision — allowed or refused —
is one audit line naming the tool, the agent, the resolved path and *which* grant
satisfied it.

Design and reasoning: [`src/video/P3-import-gate.md`](src/video/P3-import-gate.md).

### Screen recording

Reachable three ways: **File → Record Screen…** (`⇧⌘8`), the **Record Screen**
pill on the empty-chat screen, and the add-panel menu in the title bar. All
three open the same single recorder panel.

Recording is split across the process boundary because it has to be. A renderer
is the only place a `MediaStream` can live, and main is the only place the four
things a `MediaRecorder` cannot reach can live:

| in main (`electron/screenRecorder.cjs`) | why it cannot be in the renderer |
| --- | --- |
| `desktopCapturer.getSources` | the renderer is handed ids, and can never ask for a source that was not offered |
| chunk-to-disk writing | a twenty-minute take held as a renderer blob is a gigabyte of heap, copied again on read |
| the cursor track, 30Hz | `screen.getCursorScreenPoint()` is main-only, and is the only cursor position in Electron |
| the floating control bar | its own window, `setContentProtection(true)`, so it is not *in* the recording it controls |

The cursor track is **not a click stream** — nothing in Electron reports a mouse
button pressed in another application. `electron/inputEvents.cjs` can see real
clicks when its optional `uiohook-napi` binding is installed; that binding is
deliberately **not** in this app's dependencies, so today the module reports
`not-installed` and the recorder falls back to inferring attention from the
track (travel, then stillness). The operator can also mark a moment by hand.

Takes land in `~/Videos/Teminali Code Recordings/<timestamp>/`, mode 0700 —
never in a temp directory, because losing a recording to a reboot would be
indefensible. Each take is remuxed to MP4 before it reaches a timeline: a
MediaRecorder file carries no duration in its header and no cue index, so a
`<video>` element reports `Infinity` and cannot seek. Stream copy is attempted
only when the file **actually holds** an MP4-taggable codec, which is read off
ffmpeg rather than trusted from the mime the renderer asked for
(`electron/remuxPlan.cjs`).

The sidecar — every cursor position and the timing of every keystroke — is
sealed with AES-GCM (`electron/recorderVault.cjs`). The video is deliberately
left in the clear: encrypting it would put the plaintext back on the same disk
at every export and buy nothing. What sealing buys and what it cannot is written
out in that file's header.

Global shortcuts while a take runs: `⌥⇧R` stop · `⌥⇧P` pause · `⌥⇧Z` mark.
These take the key away from every app on the machine for the length of the
recording, which is why they are `⌥⇧` rather than anything a person presses by
accident.

The renderer half is `src/video/engine/screenCapture.ts` (the capture engine),
`src/video/store/recorderStore.ts` (phases, sticky settings, the fault
watchdog), `src/video/components/recorder/` (the panel, source grid and capture
options) mounted through `src/components/workspace/panels/RecorderPane.tsx`, and
`src/components/recorder/RecorderBar.tsx` — the floating bar, which is its own
window and so lives outside `src/video/`, loaded from this same bundle at
`?window=recorder-bar`.

`src/video/engine/recordingProject.ts` turns a finished take into a project.
**Open on the timeline** in the review builds it in one undoable step, and what
that build contains is a matter of the six **Auto edit** switches on the capture
rail. All of them are on out of the box (`TUTORIAL_ASSEMBLE`); turn all six off
and you get `RAW_ASSEMBLE` — screen, camera and narration as separate clips on
their own tracks, sized and cornered by `pictureInPicture.ts`, nothing
interpreted.

| Switch | What it adds | Engine |
| --- | --- | --- |
| Push in on what you click | Zoom moments detected from real clicks, scrolls, keystrokes and marks, keyframed onto the screen clip | `cursorZoom.ts` |
| Draw the pointer | A shape layer following the cursor track, mapped through the zoom's own transform | `cursorLayer.ts` |
| Blur the zoom moves | `motionBlur` on the screen clip, and only when zooms were placed | — |
| Cinematic frame | Backdrop track, the picture inset and rounded on it, fades in and out | `cinematicLook.ts` |
| Click ticks and whooshes | Ticks and whooshes rendered offline into the take folder, on their own audio track | `sfxEngine.ts`, `recordingSound.ts` |
| Mark every moment | A timeline marker wherever a zoom was placed | — |

`assembleRecording` is `async` for one reason: the sound is rendered and written
to disk before the store transaction opens. With that switch off, nothing in the
build awaits anything.

**Not yet ported from the Cut:** everything decided from the WORDS. The camera
taking the whole frame during a spoken pause, opening on the face for an
introduction, and both caption tracks are all read out of a TRANSCRIPT, and this
app ships no speech model — `Take.transcript` exists and nothing fills it. Those
are not options that would behave conservatively without one; the Cut's
`alignToSpeech` returns null on an empty transcript, so `cameraOnPauses` would
find nothing every time. They are absent from `AssembleOptions` rather than
present and pinned to `false`, and Tutorial skill and Go live are absent from the
capture rail rather than shown and inert.

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

The running version is shown bottom-right and is itself the control: it opens
update, check and **rollback**. `/api/updates/releases` lists recent releases
with the artifact this machine could install and marks each one against the
running build, so the menu can offer the one release below it — a single step
back, which is where a regression introduced by an update lives. A rollback is
confirmed before it runs, downloads that release's own asset and installs it the
same way an update is installed. There is no update banner.

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

ELECTRON_DIST=1 npm run desktop   # Electron against the built dist/ bundle
```

An unpackaged Electron always loads the Vite dev server, retrying for ten
seconds while Vite starts, and only falls back to `dist/index.html` if the dev
server never answers. That preference is not cosmetic: only a packaged app
starts the gateway in-process and hands the renderer a session, so an
unpackaged `file://` page has neither an injected session nor an Origin the
gateway will accept. It draws, fails to bootstrap a session, and then reports
the gateway offline for good — empty explorer, silent Guardian, no voice.
`ELECTRON_DIST=1` opts into the built bundle deliberately, and inherits that
limitation.

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
npm test            # 631 tests, 0 failures
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

### Signing — wired, pending a certificate

There is no Apple Developer ID, so every build is **ad-hoc signed** by
`build/afterPack.cjs`, inside out and with `build/entitlements.mac.plist`
attached. That is what lets the assistant ask for Apple Events and Accessibility
at all; the hook fails the build rather than shipping a bundle whose signature
carries no entitlements.

The release workflow already passes `CSC_LINK`, `CSC_KEY_PASSWORD` and
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. An absent secret
arrives as an empty string, and every reader treats empty as "no certificate":
electron-builder skips signing, `afterPack.cjs` ad-hoc signs, and notarization —
which only runs after a real signature — never starts. **Adding the secrets in
repository settings is the whole switch-over; no file changes.** The macOS
variables are scoped to the macOS runner, because `CSC_LINK` also feeds
`signtool` on Windows.

Signing is not what gates updates. The updater here is bespoke
(`server/updates.js`, `server/install-macos.js`) and replaces the whole app, so
it works unsigned — see [Releases and updates](#releases-and-updates).

### What actually ships

`files` in `electron-builder.yml` is an allowlist, and getting it wrong is how
1.1.0 and 1.1.1 shipped a studio with no backend: it named only the four server
modules the menu bar items import, so nothing served `/api` and every chat ended
at "the local gateway session could not be created". It now takes `server/**/*`
whole, minus tests.

`server/gateway.js` imports `../../gateway/frontier-runner.js` — the one module
under `server/` reaching outside the package — so `gateway/` is copied to
`<Resources>/gateway` via `extraResources`. It cannot go in `files`, which only
collects paths under the app directory. The macOS block repeats that entry
verbatim: a platform block **replaces** the array it overrides rather than
extending it, so omitting it drops the runner from macOS builds alone.

### The gateway in a packaged app

`npm start` runs three processes; a packaged app is one, and nothing in it used
to start the gateway. `electron/main.cjs` now starts it in-process — the gateway
is ESM inside an asar, which Node can import but cannot execute as a script.

It prefers port 4310 and falls back to an ephemeral port rather than dying on
`EADDRINUSE` when a development gateway already holds it; the renderer is told
the address either way.

The session token is **handed over, not fetched**. `POST /api/session` mints one
only for an allowed browser origin, and the packaged renderer is a `file://`
page whose requests Chromium sends with no `Origin` header at all — so that
bootstrap cannot succeed there however the gateway starts. The main process
already holds the token and passes it through `preload.cjs` to the renderer,
which reads it once at preload via `sendSync`. Every other route already accepts
a header-less local caller presenting a valid bearer, so the gateway's origin
rule is not relaxed to make this work. In development the bridge is absent and
the ordinary POST bootstrap runs against the Vite proxy.

Everything under `server/` that resolves a writable path resolves it against
`process.cwd()`, which for an app launched from Finder is `/`. The main process
therefore points the store variables below at `userData/gateway/` before config
is read, and `FRONTIER_WORKSPACE_ROOT` at the user's home. Each is only a
default: an operator who exports one still wins.

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
| `FRONTIER_AUDIT_PATH` | `benchmark-results/gateway-audit.jsonl`; `userData/gateway/` in a packaged app |

Non-loopback values are rejected at startup rather than accepted and ignored.

## Further reading

- [`DESIGN.md`](DESIGN.md) — the Teminali Design System contract, shell
  architecture, the screen assistant and voice. Read before changing any UI.
- [`docs/INVESTIGATION_DOCTRINE.md`](docs/INVESTIGATION_DOCTRINE.md) — how the
  model is required to investigate before it answers.
- [`docs/DILIGENCE_TEST_PLAN.md`](docs/DILIGENCE_TEST_PLAN.md) — the manual plan
  that proves it.
- [`docs/VOICE_SIDECAR.md`](docs/VOICE_SIDECAR.md) — the VibeVoice contract.
- [`src/video/P3-import-gate.md`](src/video/P3-import-gate.md) — what the media
  approval gate grants, and why reading a path is the capability it guards.

## Licence

This repository is private and ships no `LICENSE` file. No licence is granted.

# Teminali OS

**An autonomous AI studio that runs on your machine.**

A desktop application (Electron + React) whose models, speech, screen
understanding and agents all run locally by default. Hosted providers are
available and never required. Everything the renderer can reach goes through one
loopback gateway that never binds off `127.0.0.1`.

- Package: `@teminali/os` · version **0.0.3** · app id `os.teminali.app`
- Ships as `Teminali-OS-<version>-macOS-Apple-Silicon.dmg` / `-Intel.dmg`,
  a Windows NSIS installer, and a Linux AppImage, from
  [`teminali/releases`](https://github.com/teminali/releases/releases).

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
| Entitlement | `/api/entitlement` · `/api/entitlement/{refresh,sign-in,sign-in/poll,sign-out}` · `/api/entitlement/{plans,checkout}` · `/api/entitlement/order/:id` |
| Hosted providers | `/api/providers` · `/api/providers/key` · `/api/providers/lanes` |
| Workspace | `/api/workspace/{tree,file,write,delete,mkdir,search,machine-search,open,projects}`, `/api/workspace/projects/{remember,forget}`, `/api/workspace/browser`, `/api/workspace/browser/{bookmark,unbookmark,visit,download}`, `/api/workspace/browser/history/clear`, `/api/workspace/browser/import`, `/api/workspace/browser/import/sources`, `/api/workspace/agent/{reveal,open-file,projects,open-project,browse,bookmarks,bookmark,browsing-history,downloads,player,player-control}`, `/api/workspace/player/state`, `/api/workspace/media/{probe,subtitle}` |
| Terminal | `/api/terminal/exec` |
| Agent CLIs | `/api/agents` · `/api/agents/models` · `/api/agents/run` · `/api/agents/permission` · `/api/agents/permission/resolve` |
| Screen assistant | `/api/assistant/{capabilities,permissions,observe,act}` · `/api/assistant/agent/{observe,act}` (the chat pane's agent, on its run's token) |
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
workspace panel strip. Sidebar views: **Chats · Explorer · Search · My Projects · Skills**.
**Search** covers the whole application from one field: panels, skills,
projects, workspace files by name and by content, files and folders elsewhere
on the machine (macOS, through Spotlight), chats and what was said in them,
bookmarks, history and downloads — with a last row that takes the query to the
web. Scope tabs narrow what is drawn rather than searching again.
The rail stays on screen when the panel is collapsed, so a dismissed
sidebar is one click from open on any view. The panel strip holds any number of
tabs of twelve kinds:

| Panel | Shortcut | Panel | Shortcut |
| --- | --- | --- | --- |
| File | `⌘G` | Claude Code | `⇧⌘C` |
| Terminal | `⌘J` | Codex | `⇧⌘O` |
| Browser | `⇧⌘B` | Usage | `⇧⌘U` |
| Canvas | `⇧⌘A` | Benchmark | `⇧⌘N` |
| Side chat | `⇧⌘S` | Release *(admin)* | `⇧⌘R` |
| Guardian | `⇧⌘G` | Video Editor | `⇧⌘V` |

Video Editor is the one kind limited to a single tab: it owns a timeline and a
playback clock, and a second copy would be a second project competing for them.

The **File** panel edits text and now also *shows* what it cannot edit: images
render as pictures, PDFs open in Chromium's own viewer, both straight from the
bytes the gateway already returns under its 8 MB cap. Neither is writable, so
nothing can overwrite a picture with text. Files whose whole name is their
extension — `.gitignore`, `Dockerfile`, `Makefile` — are visible to the tree,
the editor, search and the review dock for the first time; `.env` is
deliberately still excluded. An `.xlsx` is drawn as a grid — every sheet on a
tab strip, formula cells showing their results, capped at 200 × 50 cells with
the cut stated on screen — by [ExcelJS](https://www.npmjs.com/package/exceljs),
loaded on demand so a reader who never opens a spreadsheet never downloads the
parser. Legacy `.xls` is a different format (BIFF) and the pane says to save it
as `.xlsx`; the one `.xls` that does open is the HTML table many web apps export
under that name, which the gateway sniffs and treats as text. **Video and audio
play** in the desktop app, in a player this app draws: a scrubber, volume,
speed, subtitles, picture-in-picture, fullscreen, and — in a series — the
episode either side. The bytes do not come from the gateway: a `<video>` cannot
carry the session's bearer token, so the app registers `teminali-media://`
(`electron/workspaceMedia.cjs`, served by `server/workspace-media.js`) under
the same path guard as the reader, with HTTP Range and no size cap. A browser
build says playback needs the desktop app. A media pane waits for the gateway
to name the open project before it streams: the shell adopts that root at
startup, and until it has one a relative path would be resolved against a stale
project.

**Every format ffmpeg reads, not only the ones Chromium does.** `.mp4 .webm
.m4v .mov .mkv .avi .wmv .flv .mpg .mpeg .m2ts .mts .3gp .ogv .vob .mxf .asf
.f4v` and `.mp3 .m4a .wav .ogg .flac .aac .opus .aiff .wma .amr .weba` are
listed by the tree and opened by the player. Before it points an element
anywhere the pane asks the gateway what the file holds
(`POST /api/workspace/media/probe`, `server/media-probe.js`, ffprobe): a file
Chromium can play is handed to it untouched; a foreign container whose streams
are fine is rewrapped; HEVC, ProRes, VC-1, AC-3, 10-bit H.264 are re-encoded to
H.264/AAC live, ffmpeg writing fragmented MP4 straight into the response. That
stream has no length and no byte ranges, so a seek is a *new* stream from a new
offset and the player keeps its own timeline over it; the duration comes from
ffprobe. Without ffmpeg installed the pane says so and names `brew install
ffmpeg` rather than showing a control bar that never moves.

**Subtitles.** A sidecar `.srt` or `.vtt` beside the video is picked up by
name — `Episode 1.srt`, or `Episode 1.en.srt`, whose tag becomes the language's
name in the menu — and SubRip is converted to WebVTT in the renderer, tags,
decimal commas and coordinate suffixes and all. Subtitle *streams* inside the
file are read out by ffmpeg on demand and appear in the same menu, labelled
`embedded`. Bitmap subtitles (PGS, DVD) are not offered: they are pictures, and
no amount of ffmpeg makes them text. The chosen language is remembered and
comes back on the next episode.

**The agent has the player's controls.** The `teminali-workspace` MCP server
carries two more tools: `player` reads what is showing — the episode and its
number, playing or paused, position, duration, volume, speed, the subtitle
tracks and which is on — and `player_control` plays, pauses, seeks, sets volume
or speed, turns subtitles on, goes fullscreen, or moves to another episode.
Both are pre-approved, because they act on a file the operator opened and write
nothing; the alternative was an agent asked to pause a video reaching for the
pointer. `open_file` on a folder opens the gallery, so "show me what is in
that folder" and "play me the next episode" are both tool calls rather than
descriptions of which button to press.

**The local lane has it too, by a shorter road.** A model running in the window
emits a ```` ```player-tool ```` fence holding `{"action":…,"value":…}` and
`services/playerToolCalls.ts` hands it straight to the mounted pane — no
gateway, no run stream, because the pane is in the same renderer. It accepts
the same seventeen actions the MCP tool does, plus one the CLI lane gets as a
separate `player` tool: `status`, which reads what is showing and changes
nothing. A test asserts that is the *only* difference between the two lists. Its prompt block carries what the player is showing *right now*,
so "play it" needs no clarifying question, and says in as many words that the
player is not the Teminali Cut timeline: without that, a model asked to play an
open file reached for `video-tool`, read the timeline instead, and reported
that the file did not exist.

**The lane can put a question to you.** When a choice is genuinely yours — a
preference or a trade-off it cannot measure — the model emits an ```` ```ask ````
fence and `services/askToolCalls.ts` opens a picker above the composer:
stepped tabs for up to four questions, two to four options each, "Other" for
when it guessed the problem wrong. A single-select answer is one click. Your
answer goes back into the same turn, so the work continues rather than
restarting; dismissing it tells the model to pick a sensible default and say
which. It will not ask for anything it could look up — that is pinned by an
eval case, because a model handed a way to ask will otherwise ask for the
branch name instead of running `git`. This is `AskUserQuestion` parity for the
local lane; the Claude Code and Codex lanes are not offered that tool at all
when driven headlessly, so they cannot have it. Measured on
`frontier-qwen2.5-coder-14b-8k`: 0/3 before, 3/3 after.

It did not fit at first: with a file open in the player, the instruction block
was skipped and the lane could not ask. Shortening the block made it fit and
stop working. What was actually crowding it out was the editor tool catalogue —
3,395 characters of descriptions written for an MCP client, shipped to an 8k
window on every turn. Editor tools now carry a short form for the local lane
and keep the long one for Claude Code and Codex, which have room for it; the
catalogue is 2,238 characters and the lane can ask with a file open.

**A folder opens as a gallery.** Click any folder — in the tree, or through
the agent's `open_file` — and the **Gallery** panel shows what is in it as
cards: a video shows a frame of itself, an image shows itself, and everything
else wears the same icon the file tree gives it, so the two never disagree
about what a `.tsx` looks like. A card opens the thing it shows — a folder
navigates the panel, a video plays, anything else goes to the File panel — and
a file this app has no viewer for is dimmed rather than pretending. It is one
panel that navigates, with a breadcrumb back up, so clicking through a tree
leaves one tab and not six; with no folder chosen it shows the project root.

**A folder of videos is additionally a series.** Two or more video files
directly inside one folder number the video cards as episodes — the number read
out of the file name (`S01E04`, `Episode 12`, a leading `03`) — put a progress
bar under the ones started and a tick on the ones finished, and add one button
that resumes wherever the operator left off. Playing an episode fills the same
panel; the next one starts by itself unless that is turned off. Where the
operator got to in each file is remembered across sessions, for the two hundred
most recent.

The **Browser** panel is a real browser in the desktop app, not a frame in the
page. Each tab is an Electron `WebContentsView` with its own session, process
and history: Back, Forward, Reload and Stop drive the *page's* history, so a
redirect or a link the page followed is reflected in the toolbar and in the
address, which an iframe could never report because its history is cross-origin.
It also runs with web security on, sandboxed, with no preload and no access to
the workspace media scheme — none of which was true of a frame inside the
shell's own renderer. The omnibox still takes a bare port (`5173`), a host, or
a full URL, and still refuses `file:`, `javascript:`, `data:` and `blob:`, now
in both the renderer and the main process; anything that is only words becomes
a search with the chosen engine. Because the page is a layer above the window rather than part
of it, the panel hides it while a menu or a dialog is open and while another
tab is in front. `⇧⌘B` and the add-menu open another browser tab each time.
A browser build keeps the sandboxed iframe.

**Private tabs.** `More → New private tab` opens a tab on a separate in-memory
session: cookies and site data are cleared when the last private tab closes,
pages are not written to history, downloads are not added to the list, and the
tab is not reopened after a reload. The tab strip draws it with a masked-eye
glyph and the toolbar carries a `Private` pill. The file you download is still
saved where you put it, and the network still sees the traffic — the panel's own
home page says both. A page opened by the agent or by an artifact preview never
lands in a private tab.

**Import from another browser.** `More → Import from another browser…` brings
bookmarks and history over from Chrome, Brave, Edge, Chromium, Vivaldi, Arc,
Opera or Firefox. It lists the browsers that are really on this machine — a
browser is offered only when one of its profiles actually holds the files —
with each profile under the name you gave it in that browser, and you choose
which of the two lists to take. The other browser's database is copied before
it is read, so the import never opens the live file and can never write to it;
run it twice and the second run adds nothing. Your own bookmarks are never
displaced or renamed, and imported history cannot bury what you did here today.

**Safari** is listed but cannot be read: macOS protects `~/Library/Safari`
until the app is granted Full Disk Access, so it says that instead of failing.
**Autofill is not imported** — Teminali OS has no autofill store yet, so
there would be nowhere for saved addresses or cards to go, and the dialog says
so rather than offering a tick box that does nothing. macOS only for now.

**Passkeys do not work in the panel, and it now says so.** macOS grants the
platform authenticator — Touch ID — only to registered web browsers, so
`isUserVerifyingPlatformAuthenticatorAvailable()` is false here and a passkey
prompt silently does nothing — measured: the request stays pending for ever,
which is why the page just spins. When a page asks for one, the toolbar says so
and offers the two routes that work: another sign-in method on the page, or Open
in default browser. The request itself is ended after 25 seconds, so the page
falls back on its own; the wait is that long because a USB security key can
still answer and a person needs time to reach one.

**Inspect Element** is offered on a browser page only. The shell's own window
has none — its devtools are in the View menu (`⌥⌘I`).

What the browser remembers — bookmarks, history and downloads — is a gateway
store (`browser-data.json`, `TEMINALI_BROWSER_STORE`), not renderer state, so
the assistant can read it: the `teminali-workspace` MCP server gives an agent CLI
`browse` (show a page in the panel), `bookmarks`, `browsing_history` and
`downloads` pre-approved, and `bookmark`, which writes, behind the permission
prompt.

The panel's own side of that store is the **home page**, shaped like a new-tab
page: a search field, a row of round shortcuts built from the bookmarks — each
wearing the site's own favicon where it has one, and ending in **Add shortcut**
— then the recent pages, folded by address with a visit count and cut into
Today / Yesterday / Earlier, and the downloads with a "Show in Finder" on each
finished one. The field's icon is the **search engine**, and it is a button:
Google, Bing, DuckDuckGo, Brave Search or Perplexity, remembered across
restarts and used by the omnibox and the right-click menu's "Search … for" as
well. Home is a state rather than an address — the page behind
it stays loaded at its scroll and its history, and the `Home` button only hides
the view. The **star** in the toolbar bookmarks the page it is on. Visits are
recorded by one subscriber armed for the whole app, not by the pane, because a
tab loading in the background has no pane. Downloads use **Electron's own save
dialog** — the app never chooses a path — and "Show in Finder" reveals (never
opens) only a path main itself watched that dialog write, remembered across
restarts in `browser-downloads.json`. `More` also offers "Open in default
browser" and "Clear history".

It is also where you **drop** a file. Drag a row out of the Explorer, or a file
out of Finder or Windows Explorer, and it opens in the panel. A file from
outside the current project is never read across the workspace boundary: the
panel offers to switch the project to the folder holding it and opens it from
inside the new root, and a dropped *folder* is offered as a project directly.
Outside the desktop app the external half says it needs the desktop app rather
than half-working. A file dropped anywhere else in the window is refused
visibly — without that, Chromium would navigate the whole window to it, which
looks exactly like the app crashing to a blank page.

**Screen recording is not a panel.** It is a dialog (`⇧⌘8`), and the reason is
that a panel is somewhere you leave the app while recording is something you
do: a panel persists into the next session, sits in the tab strip, and splits
the window with the conversation you are not looking at while you pick a
display. It also wanted width the panel did not have — 568px before the
options rail can be a column, against the panel's 452px default. See
[Screen recording](#screen-recording).

Plus `⌘B` sidebar · `⌘L` chats · `⇧⌘E` explorer · `⇧⌘F` search · `⌘K`/`⌘P`
command palette · `⌘,` settings · `Esc` stop the turn. My Projects and Skills
are reached from the rail; neither has a shortcut. The media pool lives in the
video editor's own rail.

**A running turn can always be stopped.** `Esc` while the conversation has
focus — including from inside the composer, which is where the cursor actually
is — and a **stop** control on the activity strip that stays on screen for the
whole turn: before the first token, while tokens stream, and through a tool
call that takes a minute. Typing a follow-up no longer replaces the composer's
stop button with send; both are drawn, because they are two different actions.
Stopping aborts the request itself, so the gateway drops its upstream call and
an agent CLI is sent `SIGTERM` rather than being left running unattended; a
command waiting on approval is denied, any speech in progress is silenced, and
the partial reply is kept in the transcript and marked as cut short instead of
being passed off as a finished answer. This is the same stop on all three chat
surfaces — the main conversation, an agent tab and a side chat — so `Esc` in a
Claude Code tab stops that tab and settles its tool calls, not the chat beside
it.

**My Projects** is one list of both kinds — repositories and saved video
projects, newest first, with the current root marked. The gateway classifies
each directory from the marker file on every read, so the glyph is what the
folder is right now rather than what it was when it was last opened. Clicking
one opens it *by its kind*: a repository rebinds the workspace root every
workspace and terminal route reads, and a video project loads into the editor
without touching the root. The same list, capped at four, sits under the
composer on the empty chat screen.

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

The light lane insists on a model that can actually write code and drive a tool
fence; it falls back to a general chat model only when nothing installed can.
That distinction is catalogue data, and it was wrong: `llama3.2:3b` was declared
code-capable, so at 2.0 GB it was the lightest coder on this machine and won the
Flash lane in the picker and the Models panel. (The chat itself resolves through
`gateway/frontier-runner.js` profiles and never ran it — the two surfaces
disagreed, which is its own fault.) Matching was the second half: an installed tag
carries decoration the catalogue does not, so `qwen2.5-coder:14b-instruct` and
every `frontier-*` build fell into the unknown-model branch and lost the
capability data that puts them in a lane. `buildLibrary` now resolves a tag
through its `-instruct`/quantisation suffix and the `frontier-<base>-<size>-<ctx>`
shape, prefers a purpose-built `frontier-*` model over a stock pull of the same
weights, and takes the window from the `-8k`/`-32k` the Modelfile pinned rather
than the stock model's. Measured on this M4 Pro: Flash went from `llama3.2:3b`
to `frontier-qwen2.5-coder-14b-8k` (15 tok/s), the heavy lane from `gpt-oss:20b`
to `frontier-gpt-oss-20b-32k`.

**Context is budgeted as a share of the window, per lane**
(`src/services/contextBudget.ts`). The local lane's system prompt tokenised at
3,127 tokens — 38% of the 8,192-token window `frontier-qwen2.5-coder-14b-8k`
pins — before any history or the operator's own sentence, which is why a model
asked to drive the player answered in prose and emitted no fence. The prompt is
now assembled from named sections in priority order under 25% of the window,
history gets 30% newest-first with each message capped at 12%, and a tool
result 10%; what the window could not afford is reported in the turn's
telemetry rather than silently lost. Measured after on the same model and
prompt: 1,848 tokens, 23% — and the turn that exposed it, "play a beyonce
song" with the player showing a Beyoncé file, went from no `player-tool` fence
in two runs to a correct one in both, with prompt evaluation down from
13.7–25.1 s to 3.3–4.0 s. The lane now has a fixed eval — `npm run eval:local`,
seventeen turns graded by the engine's own parsers against the real model — and
scores 51/51 on it (three runs a case) at ~2,180 prompt tokens with the editor and player both
mounted; `studio/DESIGN.md` §3 records what its first day found. Claude Code
and Codex are not truncated by this —
they compact their own context — and receive the same budget shape from their
real window only so the ceilings provably never bind.

Mixture-of-experts models are budgeted separately: memory against the whole
file, speed against the `activeBytes` a single token actually reads. GPT-OSS 20B
is the first such entry — measured on an M4 Pro at **29.4 tok/s against
Devstral 24B's 6.0**, on 4 GB less resident memory, which is why it wins the
heavy lane on a 24 GB machine despite the smaller file.

**Agent CLIs.** Claude Code and Codex are not providers behind the chat box —
they are the CLIs already installed on the machine, spawned as real processes in
the real workspace with their own auth, tools and resumable sessions, driven
headless and normalised to one event shape. Neither may default to its most
permissive permission rung. A turn ends when the agent process exits: the
gateway gives its pipes 1.5 s to drain and then closes them itself, because a
grandchild that inherited them — an MCP server the agent spawned and left
running — would otherwise keep the turn "Working" for as long as it lived. The
studio, for its part, treats the gateway's `done` line as the end of the stream
rather than waiting for the socket to close.

Because they write to the working tree themselves, the studio recovers each
edit from their tool stream rather than being handed it: the file the agent
opens in a tab, updates as it is written, and lists in the accept/reject dock
above the composer, the same dock the chat pane uses. See
`server/agent-edits.js` and `studio/DESIGN.md` §3 for how a `before` is
recovered — and for the two cases where it is dropped rather than guessed.

**Hosted providers.** Anthropic, OpenAI and Google, each with a light lane for
everyday turns and a heavy lane for hard ones. The flagship of each (Opus 5, o3,
Gemini 2.5 Ultra) is listed and **never selected automatically**. Keys are
stored server-side at mode `0600` and are never returned to the renderer — the
API reports only whether a key exists and a masked hint.

### The screen assistant

Hold the global shortcut, or press the microphone in any composer. It looks at
your screen and either explains it or acts on it.

- **Modes:** `dictate` (into the composer) · `talk` (explains and points) ·
  `agent` (may click, drag, type, scroll, switch between and open
  applications). The default is **`agent`**.
- **Autonomy:** `guide` · `confirm` · `auto`. The default is **`auto`**, chosen
  by the operator on 2026-09-03; the two safer rungs are one switch away.
- **Opening applications.** A `launch` step starts an application, and a browser
  may be given an `http`/`https` address. `app` names an id — never a path,
  never a command — and the ids are **every application installed on this
  machine**: the curated entries in `src/services/assistant/apps.ts` first, for
  their spoken aliases and their `browser` flag, then every other `.app` under
  `/Applications`, `~/Applications` and `/System/Applications`, one vendor
  folder deep. **"The browser" means this application's own panel**: `browser`,
  `the browser` and `web browser` resolve to it rather than to Safari, and a
  web address goes there unless another browser is named. That step never
  reaches the gateway — the renderer opens the panel itself — so the panel is
  not in the launch allowlist and cannot be started as an application. No terminal is in it, and no Script Editor or Automator either —
  a shell prompt plus the `type` step is arbitrary code execution wearing an
  allowlist. A launch is always the last step of a plan, because what it opens
  has no window to plan against yet.
- **The chat pane has the same hands.** The coding agent in the chat pane is a
  real Claude Code process, and it is given a third MCP server — `screen`,
  beside `cut` and the permission prompt — with nine tools: `look`, `click`,
  `type`, `key`, `scroll`, `drag`, `launch`, `focus`, `wait`. It can open a
  site and fill in a form on your actual screen. No tool takes a coordinate:
  `look` returns element ids from the accessibility tree and every action names
  one, exactly as a plan step does. Only `look` is pre-approved — everything
  that touches the machine raises the same approval prompt in the agent tab
  that a shell command does, with the same "always allow" for the rest of the
  run. Attached only when Accessibility is actually granted, and only to Claude
  Code: Codex has no prompt this application can bridge, and a gate that cannot
  ask must not grant. It will fill in a login form but never type a password —
  that part it hands back to you.
- **The agent is told where it is.** It is spawned with a briefing
  (`server/agent-briefing.js`, via `--append-system-prompt`) saying it is a
  panel in Teminali OS rather than a terminal, that the operator may be
  speaking to it through the voice assistant rather than typing, and which of
  its tools came from this application. Without it the agent answered questions
  about itself wrongly and offered workarounds for problems it did not have.
- **Dragging.** A `drag` step presses on an element, walks the path, and
  releases — a path rather than a down-and-up, because a slider or a reorderable
  list reads the events in between and a two-event drag does nothing at all. The
  destination is either a second element (`to`) or a displacement in points from
  the first (`dx`/`dy`), never both, and both ends must land on a connected
  screen.
- **Switching applications.** A `focus` step brings an application that is
  *already running* to the front, addressed by bundle id where there is one and
  by display name where there is not. It never starts anything — that is
  `launch`, and it has a different cost — and like `launch` it ends the plan.
- **Coming back.** When a turn moves you into another application, the assistant
  decides whether to return here: it stays if the plan moved you there on
  purpose, comes back if something only this window can show needs reading, and
  otherwise returns you to wherever you were when you asked.
- **A much bigger pointer.** While a turn is running the overlay draws its own
  64-point cursor over the system arrow so you can follow what the assistant is
  doing. It exists only while the overlay is on screen, and changes nothing
  about your Mac's own pointer settings.
- **A vision model is never asked where anything is.** The screenshot is
  context; positions come from the macOS accessibility tree via the Swift helper
  in `native/macos/pointer/`. `PlanStep` carries no coordinate field on any
  variant, so a model-invented position is not representable in the protocol.
- The gateway re-checks every action against the observation it names: expired
  looks (90 s), unknown elements, disabled elements and a changed frontmost app
  are all refused.
- Vision runs locally on `qwen3-vl:2b`. Requires Screen Recording **and**
  Accessibility, which are detected and reported separately because they lose
  different things. The model thinks before it answers and cannot be told not
  to, so a described look takes 10–16 s warm (longer while the model loads) —
  `look` with `describe: false` is the fast path when the control names are
  enough. `look` means the screen and only the screen; the camera is a separate
  tool on a separate server, below.

**The camera.** An agent CLI also gets `mcp__teminali-camera__look_at_me`: one
photograph from the webcam, handed back as a picture rather than a description,
so the model that is reasoning is the one doing the looking. Nothing on that
server is pre-approved — it opens hardware pointed at a person — so every call
raises the permission prompt, which can be answered out loud. A cold look is
about 0.9 s to a usable frame (measured); the camera then stays warm for ten
seconds, so a follow-up look is ~31 ms, and `frames: 2–6` over up to five
seconds returns a sequence that shows movement. A machine with no camera gets a
sentence saying so, not a failed turn.

### Voice

Local by default: **whisper.cpp** for recognition, macOS `say` for synthesis. An
optional sidecar on `127.0.0.1:8321` upgrades either or both, and
[`voice-runtime/`](voice-runtime/README.md) is the one shipped in this repo:
Whisper, Kokoro-82M and an AudioSet sound classifier on CPU, started with
`npm run voice:serve`. Temy speaks with a woman's voice: Kokoro's `af_heart`
when the sidecar is up, and otherwise the best installed macOS voice with the
same preference — an Enhanced or Premium Ava, Samantha, Serena or Kate wins
over a man's voice across a region boundary, while a robotic one never does. Its synthesis streams clause by clause, so a long reply
starts speaking after its first clause rather than after all of it — measured
on an M4 Pro, a 35-word reply begins speaking at 0.29 s where the whole file
takes 1.97 s. The browser
speech engine is the always-available fallback. Each capability is routed
independently, so a sidecar serving only synthesis still leaves recognition on
the local tier. Push-to-talk dictation and
hands-free conversation with barge-in. Nothing reaches the chat unreviewed — every
utterance passes a repair pass the operator sees before it sends.

**Two gates are on by default: "Require my name" and "Only respond to my
voice."** Anything your Mac plays through the speakers reaches the microphone
as speech that is real, correctly transcribed and addressed to nobody in the
room — a prompt-injection path, not just noise. While *this app* is making
sound the assistant already needs naming; another app's audio is invisible to
it, and there is no cheap way to detect that (measured: `pmset` assertions go
stale, and CoreAudio reports the output device running even in silence). So
the name is required to open an exchange — not every turn in one — and speech
that does not match your enrolled voiceprint is ignored once you have recorded
one. Both are in Voice settings and both can be turned off. On macOS, Control
Center's **Mic Mode → Voice Isolation** handles the acoustic side and is worth
switching on alongside them.

Hands-free conversation behaves like a colleague over a working agent, not a
push-button: "keep going" and "how's it going?" do not cancel a run — the first
is acknowledged, the second is answered from what the run has actually done;
"stop" cancels it; a new instruction replaces it. The assistant narrates notable
steps in one short line ("running the tests"), summarises long replies for
speech instead of reading them in full, and filters its own voice out of the
microphone. It also filters out the rest of the app: while a video or a page in
one of the panels is playing, the microphone is hearing the speakers, so only a
turn that names the assistant ("Temy, pause it") is taken and the playback
cannot interrupt a spoken reply — the alternative, which the operator saw, is
the assistant answering a film. Speech that was not addressed to it is kept for ten minutes rather
than discarded, so "what did she just say?" has an answer; where the sidecar can
name sounds, so does "did you hear that car?" — bounded, never sent
anywhere, cleared when the session stops, and switched off with one toggle. Speech is paced for listening: short lines at the chosen rate
(default 1.15×), long passages up to 15% faster. Each of these is a setting in
the voice panel and is documented in `DESIGN.md` §6.1. The built-in voice is the
best macOS voice installed, chosen by quality tier rather than by list order:
Premium over Enhanced over ordinary, never one of the voices macOS ships as
jokes, and an Enhanced voice is preferred even across a region boundary. The
voice row in the panel says when only the compact voices are present and where
to download a natural one — System Settings › Accessibility › Live Speech (or
Spoken Content) › Voice, which installs it system-wide; Live Speech itself does
not need to be switched on.

While a conversation is live, a permission prompt is read out and can be
answered out loud: the assistant asks ("Claude Code wants to run npm test — say
yes to allow it, or no to refuse"), and "yes", "always" or "no" settles it. The
prompt keeps every button it had, so a click still works and is often faster; the
`say yes` hint only appears while something is actually listening. What counts as
an answer is deliberately narrow — a whole short utterance, never a word inside a
sentence — so *"yes and then push the branch"* reaches the model as an
instruction with the prompt still standing. See `DESIGN.md` §6.18.

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

**The exposed surface is an allowlist**, not the Cut's whole registry. Nine tools
of a fifteen-tool budget: `describe_timeline`, `patch_clip`, `set_effect_param`,
`list_media_pool`, `import_media_from_path`, `ffmpeg_process`, `perfect_captions`,
`generate_captions`, and `build_recording` — the recorder's auto edit, which builds
the take waiting on the review screen onto the timeline (the Tutorial Builder skill
in the Skills catalogue is this tool with a name and starter prompts). The ceiling is
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

**A project is a directory**, and saving is a File-menu command. `⌥⌘S` writes
`project.json` — settings, tracks, markers and the media pool — into a folder
you name once and it reuses after that; `⌥⌘O` opens one back. `⌥` and not `⇧`
because `⇧⌘S` and `⇧⌘O` are already the side chat and Codex, and a menu
accelerator silently takes the key away from the page. The commands live in the
native File menu for the recorder's reason: it owns its accelerator whatever
has focus, and this panel hands focus to a canvas, a timeline and a row of
numeric fields. `⌥⌘E` exports the sequence to a file, from the same menu.

Two limits are in the format rather than discovered later. **A saved project is
machine-local** — clips reference media by absolute `file://` path and nothing
copies the bytes, so the folder moved to another machine opens with its clips
pointing at nothing. And **a take recorded in a browser tab cannot be saved at
all**: its `blob:` URL dies with the page, so the save refuses by name instead
of writing a file that is already broken. A successful save or open records the
folder in My Projects without rebinding the workspace root.

**The camera is choreographed, not parked.** Three things move the inset
after a take, all of them keyframes on the camera clip rather than anything
baked into a picture: it is cut to a **shape** (the whole frame, a rounded
one, a square, or a circle — a circle squeezes the mask on one axis, because
an ellipse over a 16:9 layer is an oval); it **dodges**, crossing to the other
side of the frame when the pointer settles under it and coming back when the
pointer leaves; and it **takes the whole frame while you are explaining**.

That last one used to need a transcript, which is why it was absent. It does
not: the question is not "is there speech here" but "is the screen still the
subject", and the hands answer that better than the words do. Presenting
drives the interface — clicks, scrolls, a pointer going somewhere. Explaining
lets go of it. So the takeover is placed on input silence over a live
microphone, and the microphone is the half that keeps it honest — quiet hands
with no narration is someone who walked away, and a take whose camera has no
audio gets no takeover at all. It is bounded to match the weaker evidence: no
stretch past 12s, never more than 35% of the take, never the closing seconds.
See `src/video/engine/cameraChoreography.ts`; the numbers are tested against
the cases that break them in `tests/camera-choreography.test.mjs`.

A take recorded without a webcam skips all of it, and so does one where the
camera is switched off before the build.

**The build is chosen on the review screen, not in setup.** The rail beside the
take carries the arguments to the assemble — the **backdrop** (nine, drawn as
swatches painting their own gradient, one of which is None), **how the zoom
moves** (Glide, Cut, Ease, or None, which is no zooms at all), whether to
**include the camera**, the camera's **shape**, and the two choreography
switches above. They are asked here rather than before recording because none
of them touch the files: a backdrop you did not want costs one rebuild, where a
wrong frame rate costs the take. Every list is exported by the engine module
that honours it, so a new preset arrives in the picker with its own label.

A take with no webcam is not shown four dead camera controls — the group says
there was no camera and stops. The full-frame switch is drawn disabled when the
camera clip carries no sound, because that is the evidence the takeover runs
on. The answers persist, so the next take opens with them already given.

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

A **dialog**, not a workspace panel — see the panel table above for why.
Reachable two ways: **File → Record Screen…** and the **Record Screen** pill on
the empty-chat screen. There is no tab and no add-panel entry.

`⇧⌘8` is the File menu item's own accelerator, and it is the only binding: a
native menu accelerator fires whatever has focus — a terminal, a webview, a
text field — where a renderer key handler would be swallowed by all three.
Both entry points are idempotent, because pressing the accelerator twice must
not remount a recorder that is holding a running take
(`src/store/recorderDialogStore.ts`).

Dismissing the dialog mid-take does not abandon the take:
`recorderStore.close()` refuses while recording, and the floating bar — its own
`BrowserWindow`, fed by `recorder:publishState` — is what stops it while the
main window is hidden.

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

Takes land in `~/Videos/Teminali OS Recordings/<timestamp>/`, mode 0700 —
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

A take records what the **assistant** says as well as what you say. Its replies
are synthesised in the renderer and played at the speakers, so no microphone on
the machine can hear them — macOS has no loopback input at all — and the signal
is instead tapped from the voice engine's own output
(`src/services/voice/speechBus.ts`). **Assistant's voice**, under Sound on the
capture rail, is on by default; it is summed into the narration rather than
given a track of its own, and it is skipped when **System audio** is on, since
that loopback already carries the speakers.
`src/video/engine/capturePlan.ts` holds those rules.

The renderer half is `src/video/engine/screenCapture.ts` (the capture engine),
`src/video/store/recorderStore.ts` (phases, sticky settings, the fault
watchdog), `src/video/components/recorder/` (the recorder surface, source grid
and capture options) mounted through
`src/components/modals/RecorderModal.tsx`, and
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
present and pinned to `false`, and Go live is absent from the capture rail rather
than shown and inert. The tutorial skill is not on the rail either — it is the
build itself, listed in the Skills catalogue as **Tutorial Builder** and reachable
by an agent as the `cut` server's `build_recording` tool, which runs the same
`assembleRecording` the review screen's button runs.

**A screen clip ends where its frames did.** The take's duration comes from the
clock, but the screen file is measured back after conversion, and when it falls
more than 1.5 s short — the display stopped delivering frames while the take ran
on, as one did at 3:57 of a 10:04 recording on 2026-09-06 — the screen clip is cut
to the file and the build's notes say at what time. The camera and narration keep
going. The recorder also notes the moment a display or camera track stopped
delivering (`mute`), resumed, or ended before the take did.

### File ingestion

Dropped files are converted per kind rather than read as bytes: audio/video →
whisper.cpp · PDF → embedded text, OCR when scanned · office docs → `textutil` ·
images → downscaled for vision, plus OCR · archives → listing · data → structure
and a sample. Images: up to 4, PNG/JPEG/WebP, 1536px max edge.

### Releases and updates

The studio ships itself, out of **two repositories**. `teminali/teminali-os`
(`TEMINALI_SOURCE_REPO`) is private and holds the code, the tags and
`.github/workflows/release.yml`. `teminali/releases` (`TEMINALI_RELEASE_REPO`)
is public and holds nothing but the published releases and their assets. The
split exists because an update check runs with **no credential**: a private
repository answers an anonymous caller `404`, and the updater can only render
that as "this repository has no releases yet". Every build asks the public
repository, so an update check never needs a token.

Publishing (`/api/updates/publish`, the Release panel) is administrator-only and
drives typecheck → test → build → preflight → tag → CI → notes through the `gh`
CLI. It tags and pushes to the source repository, watches the workflow *there*,
and writes the notes onto the release in the public one. Checking for an update
runs on every install against the public Releases API with no credential. Installs are **full asset
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

How the downloaded asset becomes the running app differs by platform, and
`electron/main.cjs` (`updates:install`) is where it differs:

| Platform | Asset | What happens |
| --- | --- | --- |
| macOS | `.zip` | Expanded and swapped over the bundle in-process (`server/install-macos.js`); Gatekeeper never sees a LaunchServices request. |
| Windows | `.exe` (NSIS) | Opened, then the app quits 1.5 s later so the installer never has to kill it. The installer's finish page reopens the new build. |
| Linux, AppImage | `.AppImage` | `chmod 755`, then written over the running image at `$APPIMAGE` (a mounted image keeps its inode until exit). "Close and Reopen" relaunches that path. An unpacked Linux build is opened instead. |

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
| `voice-runtime/` | Loopback speech sidecar: Whisper recognition, Kokoro synthesis and AudioSet sound labelling on CPU, nothing leaving the machine. The only runtime with its own `package.json`, installed with `npm run voice:install` and started in development with `npm run voice:serve`. Its dependencies are 1.2 GB in a development tree (including the 474 MB model cache); the packaged app ships a filtered 97 MB of them as an extra resource and downloads the models on first run. See [`voice-runtime/README.md`](voice-runtime/README.md). |

---

## Getting started

```bash
npm install

npm run dev:full     # gateway + Vite renderer in the browser (gateway under
                     # node --watch, so an edit to server/ restarts it)
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
npm test            # 1680 tests, 0 failures
npm run eval:local  # the local lane against the real model — a score, not a pass/fail; needs Ollama
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

### How a release gets to `teminali/releases`

`.github/workflows/release.yml` runs on a `v*` tag: `verify` (the full suite,
on macOS) → `prepare` → three `build` jobs, one per platform → `release-notes`.

Two rules the workflow enforces, each learned from a release that broke:

- **The release is created once, by `prepare`, before any platform builds.**
  electron-builder creates the release itself when none exists for the tag, so
  three jobs reaching that point together all tried, and the losers died with
  `422 Published releases must have a valid tag`. On v0.0.1 and v0.0.2 that was
  a red mark on a job whose assets were already up; on v0.0.3 it was the entire
  macOS build. Now every build job only uploads. `prepare` is idempotent, so a
  re-run finds the release it already has.
- **Every `artifactName` spells `Teminali-OS`, never `${productName}`.** The
  product name has a space, and GitHub stores an asset with a space under a
  dotted name. electron-builder anticipates that for the artifact but not for
  its `.blockmap`, which lands as `Teminali.OS-…zip.blockmap`. A re-run then
  looks for the spaced name to overwrite, misses, uploads, and takes a
  `422 already_exists` — which is how v0.0.3's macOS job died after its DMGs
  were up. Uploaded names are unchanged by the fix; only the blockmaps lost
  their dot.

macOS in-app updates download the **`.zip`**, not the DMG (`server/updates.js`
— a `.dmg` can only be installed by a person dragging), so the `zip` target is
load-bearing. `latest-mac.yml` is not: nothing reads it. This app updates
against the GitHub Releases API, not electron-updater.

### What the asar can and cannot reach (`server/sidecar-paths.js`)

**v0.0.1 shipped with no working backend.** `server/speech-local.js` imported
`"../voice-runtime/lexicon.js"`. From `app.asar/server/` that is
`app.asar/voice-runtime/lexicon.js`, and `voice-runtime/` ships *beside* the
archive as an extra resource — onnxruntime's native binding cannot load from
one. The import threw `ERR_MODULE_NOT_FOUND` while `server/gateway.js` was
still loading, so `createGateway` never returned, nothing served `/api`, and
every panel reported **"Failed to fetch"**: no repositories, no chat, no
GitHub connect, and no update check either, since `/api/updates/check` is a
gateway route. A checkout cannot reproduce it — there the same specifier
resolves.

The rule, and why the two cases differ:

| Import | From `app.asar/server/` | Ships as |
| --- | --- | --- |
| `../../gateway/frontier-runner.js` | `<Resources>/gateway/…` | extra resource ✓ |
| `../../licence/format.js` | `<Resources>/licence/…` | extra resource ✓ |
| `../voice-runtime/lexicon.js` | `app.asar/voice-runtime/…` | **nothing ships there** |

`gateway/` and `licence/` sit *above* `studio/`, so `../../` lands in
`<Resources>` in a packaged build and in the repo root in a checkout. Both
work by the same path. `voice-runtime/` sits *inside* `studio/`, so no single
specifier can serve both layouts.

It cannot be fixed with a `files:` entry either: electron-builder drops any
`files` pattern whose source is also an `extraResources` `from:`, so
`voice-runtime/lexicon.js` was silently ignored and the built asar contained
no `voice-runtime` entries at all. `server/sidecar-paths.js` resolves it at
runtime instead — the in-package path first, then
`process.resourcesPath/voice-runtime` — which is the same rule
`electron/main.cjs` already uses to find `cli.js`. A missing lexicon now
returns null and the recogniser returns text unrepaired, rather than taking
the gateway down.

`tests/packaged-imports.test.mjs` models the packaged tree and fails if any
static import under `server/` lands somewhere neither the asar nor the extra
resources carry.

### A shim that rewrites its path must be unpacked (`asarUnpack`)

The four MCP shims are spawned as their own processes, so they must be real
files: nothing can spawn a path inside an asar. Each `*ShimPath()` rewrites
`app.asar/` to `app.asar.unpacked/`, and electron-builder only puts a file
there if `asarUnpack` names it. The rewrite and the entry live in different
files, and nothing tied them together — so **the camera shipped with the
rewrite and without the entry**. v0.0.2's packaged app had `screen`, `video`
and `workspace` under `app.asar.unpacked/electron/` and no
`cameraMcpStdio.cjs`, so the agent was pointed at a file that did not exist,
the server exited on start, and the model reported *"teminali-camera failed to
connect (Connection closed)"* — then answered questions about the operator
from screenshots, having never opened the webcam. A checkout cannot notice:
there is no asar, the rewrite is a no-op, and the file is where the path says.

`tests/asar-unpack.test.mjs` pairs the two halves in both directions — every
rewrite needs an entry, and every entry needs a rewrite.

### The installer wizard

Each platform's installer is dressed from `build/`:

- **Windows** — the assisted NSIS installer (welcome → install mode → folder →
  progress → finish). `build/installer.nsh` defines the welcome and finish
  pages (`customWelcomePage`, `customFinishPage`; the finish page keeps
  electron-builder's `StartApp` so a replaced build is still started with
  `--updated`). `build/installerSidebar.bmp` (164×314) and
  `build/installerHeader.bmp` (150×57) are the wizard's art; NSIS accepts only
  uncompressed 24-bit BMP3 and renders anything else as a black rectangle.
  The install is per-user, needs no administrator password, and creates Start
  menu and desktop shortcuts.
- **macOS** — the disk image window: `build/dmg-background.png` (660×400, with
  an `@2x`), the app at (180,190), the Applications link at (480,190), and the
  arrow drawn between them. Coordinates live in `electron-builder.yml`
  (`dmg.contents`) and in the art script, and must agree.
- **Linux** — an AppImage has no installer; the wizard is the desktop's. It
  needs FUSE (`libfuse2` on Ubuntu 22.04 and later).

`scripts/installer-art.sh` redraws all four files from `build/icon.png` using
the app's own palette from `src/styles/tokens.css`; run it after any change to
the mark and commit the output.

### Running on Windows and Linux

Nothing in `server/` is macOS-only by accident; what is macOS-only says so
(`machineSearchAvailability`, the pointer helper, `say`). Two things are
platform work rather than platform limits:

- **Finding a command.** `server/command-resolver.js` resolves a CLI name the
  way the shell would. On Windows an npm-installed `claude` is `claude.cmd`,
  CreateProcess finds only `.exe`, and Node refuses a `.cmd` without a shell —
  so a bare `spawn("claude")` reports "not installed" on every Windows machine
  that has it. The resolver walks PATH × PATHEXT; an npm shim is run under
  node directly (arguments verbatim, so a multi-line prompt survives), and any
  other batch file goes through `cmd.exe` with cross-spawn's escaping. Every
  agent, plan-probe and arena spawn goes through it. `server/bin-paths.js`
  appends each platform's usual tool prefixes to PATH — npm's, Claude Code's
  installer's, winget's on Windows; `~/.local/bin`, `~/.npm-global/bin`,
  `/snap/bin` on Linux.
- **Finding a tool.** `lookupCommand` in the same module walks PATH itself
  instead of spawning `which` — which Windows does not have. Both callers used
  the Unix one, so on Windows `fileCapabilities()` reported no video, no audio,
  no OCR and no archives however much was installed, and whisper.cpp was never
  found. It also fixes the macOS half: those probes ran with the bare
  environment, which for a Finder-launched app is launchd's PATH, so Homebrew's
  ffmpeg was invisible to file ingestion in every packaged build.
- **Startup.** `electron/main.cjs` sets the Windows AppUserModelId to the
  appId so a pinned shortcut and the running window are one taskbar button;
  takes the single-instance lock in packaged builds (a second launch focuses
  the first); and on Linux enables PipeWire capture for Wayland sessions and
  drops Chromium's sandbox **only** when running from an AppImage on a kernel
  whose AppArmor forbids unprivileged user namespaces (Ubuntu 24.04), which
  otherwise kills the app before its first window.

What stays macOS-only, and says so rather than failing: the screen assistant's
pointer helper, Spotlight machine search, `say` for local speech synthesis, and
Guardian's `vm_stat`/`pmset` telemetry. The recorder runs everywhere; on Linux
it warns that the floating bar cannot be excluded from the capture, because
`setContentProtection` does not exclude there. Hardware video encoding covers
VideoToolbox on macOS and NVENC/QSV/AMF on Windows; Linux encodes in software,
since VAAPI needs a render node the call sites do not have. The speech sidecar
runs on all three — `electron/main.cjs` hands it a resolved ffmpeg path, since
it decodes every utterance and a launched app's PATH rarely has one.

### Publishing across two repositories

`electron-builder.yml` publishes to `teminali/releases`, and the workflow runs in
`teminali/teminali-os`. A workflow's default `GITHUB_TOKEN` is scoped to the
repository it runs in, so it **cannot** create a release or upload an asset in
the other one — the build goes green and the upload does not happen. Add a PAT
with `contents: write` on `teminali/releases` as the `RELEASES_TOKEN` secret;
the workflow prefers it and falls back to `GITHUB_TOKEN` so a fork still builds.
The release-notes job passes `--repo teminali/releases` for the same reason:
without it the notes are written to the private release nobody can read.

That fallback is convenient on a fork and dangerous on a tag, so the build job's
**first step refuses to run** when `RELEASES_TOKEN` is missing and the ref is a
`v*` tag. Without it the fallback produces a green build that published nothing
— which is how the public v1.2.8 came to be assembled by hand — and a PAT
expires, so the same failure is one day away at all times rather than a
one-off. `workflow_dispatch` is exempt: the rehearsal path is allowed to build
without the token.

### Signing — wired, pending a certificate

There is no Apple Developer ID, so every build is **ad-hoc signed** by
`build/afterPack.cjs`, inside out and with `build/entitlements.mac.plist`
attached. That is what lets the assistant ask for Apple Events and Accessibility
at all; the hook fails the build rather than shipping a bundle whose signature
carries no entitlements.

The release workflow already passes `CSC_LINK`, `CSC_KEY_PASSWORD` and
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. An absent secret
arrives as an **empty string, which is not the same as absent** — and that
distinction is load-bearing. electron-builder reads `CSC_LINK` with
`v1 == null ? v2 : v1`, so `""` is a value: it is resolved as a certificate
path against the project directory, and packaging dies with
`<projectDir> not a file`. This failed the v1.2.0 macOS build twice, on a
public tag, before it was understood. The packaging step therefore `unset`s
both pairs when they arrive empty, and only then does electron-builder take
the ad-hoc path and skip notarization. The step pins `shell: bash`, because
Windows runners default to PowerShell and read the guard as a syntax error.
`tests/packaging-resources.test.mjs` asserts the guard is still there, still
runs before the build, and still has a shell that can parse it.

**Adding the secrets in repository settings is the whole switch-over; no file
changes** — non-empty values make the `unset` a no-op. The macOS variables are
scoped to the macOS runner, because `CSC_LINK` also feeds `signtool` on
Windows.

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
collects paths under the app directory. A platform block's `extraResources`
is **added to** the top-level list, not substituted for it —
`app-builder-lib`'s `getFileMatchers` reads both, and until the sidecar
shipped the macOS block repeated the gateway entry on the opposite belief, so
every macOS build copied the runner twice. Platform blocks now carry only what
differs by platform: the pointer helper and the sidecar's dependencies.

### The gateway in a packaged app

`npm start` runs three processes; a packaged app is one, and nothing in it used
to start the gateway. `electron/main.cjs` now starts it in-process — the gateway
is ESM inside an asar, which Node can import but cannot execute as a script.

Two top-level directories ship as `extraResources` because `server/` imports
them from outside this package: `gateway/` (the runner) and `licence/` (the
licence format and the plan registry). `licence/` holds only the verifying
half — `billing/`, which signs licences and talks to the payment rails, is a
separately deployed service and is never packaged, so no build of this app
carries the code that mints entitlements.

Each entry must carry its own `to:`. An import of `../../gateway/x.js` resolves
to `<Resources>/gateway/x.js` inside the asar, and only `to:` puts it there —
without one the directory's *contents* are copied to the resources root and the
import fails. This is not hypothetical: v1.2.0 was cut with a second entry
written above the first entry's `to:` and `filter:`, YAML read them as the
second's own, and the macOS build failed during packaging while Windows and
Linux published artifacts whose gateway could not load. `tests/packaging-resources.test.mjs`
now asserts that every entry names a destination and that every cross-package
import under `server/` has one.

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

### The speech sidecar in a packaged app

`voice-runtime/` ships under `<Resources>/voice-runtime` and the app starts
it. Its source comes from a top-level `extraResources` entry; its production
`node_modules` come from a second entry rooted at `voice-runtime/node_modules`,
one per platform block. The split is forced: electron-builder's copier skips a
directory named `node_modules` at the root of any `from:`
(`app-builder-lib/out/util/filter.js`, "filter the root node_modules") whatever
the filter says, and the first build with `node_modules/**` in the source entry
shipped nine `.js` files and nothing else. Per platform because
`onnxruntime-node` carries a binary for every platform, and each build keeps
only `bin/**/<platform>/${arch}`. The sidecar's own top-level `onnxruntime-node`
is not shipped at all — nothing imports it; `@huggingface/transformers` pins
`1.21.0` and nests its own copy, which is the one that loads. Source maps,
`.d.ts`, `.md` and the transformers `.cache` directory stay out, and so does
the web half of transformers.js — the `onnxruntime-web` package, the
`transformers.web` bundles and `ort-wasm-simd-threaded.jsep.wasm`. The sidecar
is a Node child process, so its package `exports` resolve the `node` condition
to `dist/transformers.node.mjs`, which requires `onnxruntime-node` and
`onnxruntime-common` and nothing else; the WASM backend those 91 MB exist to
drive is never selected. `tests/packaging-resources.test.mjs` fails if any
platform block stops excluding them.

`electron/main.cjs` spawns `<Resources>/voice-runtime/cli.js` under the app's
own Electron binary with `ELECTRON_RUN_AS_NODE=1`, the way the MCP shim runs,
so a packaged app needs no Node on the `PATH`; an unpackaged app never spawns
it (`npm run voice:serve` is the development sidecar). The port is taken from
`TEMINALI_VOICE_URL`, else `TEMINALI_VOICE_PORT`, else 8321, so the gateway and
the sidecar cannot disagree. If that port is already held — a development
sidecar, typically — no second one is started and the gateway talks to
whatever answers there. The child's stderr is relayed into `studio-main.log`
prefixed `Voice sidecar:`, its exit is logged, and `will-quit` sends it
SIGTERM.

The models are **not** in the bundle. transformers.js would cache them inside
its own package, which is inside the signed app; the packaged sidecar is
handed `userData/voice-models` instead (`TEMINALI_VOICE_CACHE`, which an
operator's own value overrides), so an update does not discard the download.
They download on first run, and `/status` — which the gateway already reads
and caches for 15 s — reports each model as it becomes ready; a cold sidecar
answers `{}` and the studio keeps the built-in engine until then. There is no
other progress surface. Measured with `du -sh` on this machine's cache:
`onnx-community/whisper-base` 76 MB, `onnx-community/Kokoro-82M-v1.0-ONNX`
311 MB, `Xenova/ast-finetuned-audioset-10-10-0.4593` 87 MB — 474 MB in all.
Kokoro was 88 MB and the total 251 MB until 2026-09-07, when synthesis stopped
being quantised: `fp32` is 2.3x faster than `q8` on Apple Silicon and grades no
worse, and the download is the only thing quantisation was buying
(`DESIGN.md` §6.24). `TEMINALI_TTS_DTYPE=q4` gets 291 MB at the same speed, and
`q8` is still there for 88 MB and the old latency.

Measured on the `--mac --arm64 --dir` build, `du -sh`, the same tree built
twice — once with the web exclusions and once with the config as it stood
before them:

| | `Resources/voice-runtime` | files | the `.app` |
| --- | ---: | ---: | ---: |
| Without the web exclusions | 195 MB | 1408 | 487 MB |
| With them | **97 MB** | **985** | **388 MB** |

The largest pieces that remain are `@huggingface` (42 MB, including the nested
`onnxruntime-node` for `darwin/arm64`), `kokoro-js` (29 MB, of which 27 MB is
voices) and `sharp` (16 MB).

That the pruned build still speaks was checked, not assumed: its
`cli.js` was spawned from `Contents/MacOS/Teminali OS` with
`ELECTRON_RUN_AS_NODE=1` against a seeded cache, and `POST /speak` returned
118 036 bytes of `audio/wav` with `/status` reporting both models ready.

Launched from that build with its own `--user-data-dir`, the sidecar came up
on the port the app was given and reported all three models ready from a
pre-seeded cache; SIGTERM to the app took it down with nothing left listening.

The release workflow installs the sidecar's dependencies before it packages:
`npm run voice:install` runs after `npm ci` in
`.github/workflows/release.yml`. Without it an artifact would carry the
sidecar's source with no `node_modules` beside it, the packaged sidecar would
exit at its first import, the app would log it, and voice would stay on the
built-in engine. That step has not yet run in CI, so no published artifact has
been checked for it.

One thing this does not yet do. `sharp` installs
only the host's platform package (`@img/sharp-darwin-arm64` is the only one
present here), so the macOS x64 artifact, cross-built on an arm64 runner, would
need that install to be told the target (`--cpu x64 --os darwin`) or its
sidecar fails the same way. The Windows and Linux entries are written but have
not been built here.

## Configuration

Everything is optional; every default is loopback.

| Variable | Default |
| --- | --- |
| `FRONTIER_GATEWAY_PORT` | `4310` |
| `FRONTIER_ALLOWED_ORIGINS` | `127.0.0.1`/`localhost` on ports 3000 and 3001 |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` |
| `TEMINALI_VOICE_URL` | `http://127.0.0.1:8321` |
| `TEMINALI_ASR_ENGINE` | `auto` — `local` or `sidecar` pins which recogniser listens |
| `TEMINALI_WHISPER_SERVER_PORT` | `8323` |
| `TEMINALI_CUT_MCP_URL` | `http://127.0.0.1:3888` |
| `FRONTIER_WORKSPACE_ROOT` | the repository root |
| `TEMINALI_RELEASE_REPO` | `teminali/releases` — public; published releases are read from here |
| `TEMINALI_SOURCE_REPO` | `teminali/teminali-os` — private; tags and the release workflow live here |
| `TEMINALI_RUNTIME_MODE` | `local` (or `api`) |
| `FRONTIER_AUDIT_PATH` | `benchmark-results/gateway-audit.jsonl`; `userData/gateway/` in a packaged app |
| `TEMINALI_LICENCE_STORE` | `benchmark-results/licence.json` (written `0600`) |
| `TEMINALI_BILLING_URL` | unset — no billing service, so the app runs as free |
| `TEMINALI_LICENCE_PUBLIC_KEYS` | unset — JSON `{"kid": "<PEM>"}`, staging and tests only |
| `FFMPEG_PATH` | unset — an explicit ffmpeg binary, tried before every search location |

Non-loopback values are rejected at startup rather than accepted and ignored.

### Finding ffmpeg

The recorder's remux and the media tools need an ffmpeg, and `findFfmpeg` in
`electron/mediaAccess.cjs` is the one place that looks for it. It tries
`FFMPEG_PATH`, then the install directories the platform's package managers
actually use — Homebrew (Apple silicon and Intel), MacPorts and `/usr/bin` on
macOS; `C:\ffmpeg\bin`, `%ProgramFiles%`, Chocolatey, Scoop and winget's Links
directory on Windows; the usual `bin` directories plus `/snap/bin` on Linux —
and only then walks `PATH`.

`PATH` is searched **last**, which is the opposite of what a shell does, for the
reason the list exists at all: a GUI app does not inherit the shell's `PATH`. On
macOS it gets launchd's, which has no `/opt/homebrew/bin`; on Windows it gets
whatever Explorer started with, so an ffmpeg installed since the last sign-in is
invisible. The fixed list is ordered by preference, and putting `PATH` first
would let an arbitrary earlier entry outrank a deliberate one.

`ffmpegInstallHint()` names the package manager the operator is actually likely
to have (`brew`, `winget`, `apt`), because sending a Windows operator to
Homebrew is worse than saying nothing.

### Exporting video

The Export button sits in the program monitor's header, beside the fullscreen
control, and **File → Export Video…** (`⌥⌘E`) opens the same dialog. It offers
three presets (YouTube, TikTok / Reels, Master), a resolution — the preset
names the SHORT edge, so 1080p on a vertical sequence is 1080 wide — a codec
(H.264, HEVC, ProRes), a GPU-encoder switch, and a range toggle that appears
only when the timeline has an in or out point. The save dialog is the OS one,
so it owns the overwrite question; declining to choose puts the file in the
Videos folder.

`src/video/engine/exportPipeline.ts` drives it, and does two things the
window-shaped editor this was ported from does not have to:

- **The preview stands down.** `seekVideosForFrame` parks the same `<video>`
  elements the program monitor draws from, so `useProgramLoop` yields while
  `isExporting` is set, exactly as it yields to the fullscreen player. Two
  callers and the file holds whichever wrote last.
- **The loop yields to paint.** It spends at most 12ms between frames before
  handing the thread back through `requestAnimationFrame`, raced against a
  60ms timer because a minimised or occluded window stops animating. A render
  that froze the thread would freeze the terminal and the agent beside it, not
  just the editor — the editor is a panel in this app, not the app.

Preflight refuses two things outright rather than encoding them: media that
tainted the canvas (`toBlob` throws several thousand frames in) and sources
that will not decode, which the compositor draws as a grey gradient that would
land in the file looking like a deliberate shot.

`src/video/engine/exportPlan.ts` holds the arithmetic — output size, the
render window, the audio collection with its solo, mute and range rules — with
type-only imports, so `tests/video-export-driver.test.mjs` runs it under plain
`node --test`. The solo gate is `audioEngine`'s and not the compositor's:
solo is counted over audio tracks and then applied to every track, so soloing
a narration track silences a screen recording's own audio in the export as it
does on playback.

Progress, cancellation and the dialog all live in `useProjectStore`, so an
export an agent started shows in the same dialog, with the same working Cancel
button, as one a person started. Hiding the dialog does not stop the render;
the header button keeps the percentage while it runs.

When it finishes, the dialog says so and stays: a tick, the full path, and
**Show in Finder** (**Show in Explorer** on Windows, **Show in folder**
elsewhere), with *Export again* to return to the form. The same button rides
the finish toast, for the case where the dialog was hidden. Both reveal
through `videoProject:reveal`. Because the result is read from the store, an
export an agent ran — or one that finished while the dialog was closed — ends
on the same screen.

`electron/videoExport.cjs` keeps one ffmpeg per export with `image2pipe` on
its stdin. The renderer draws each frame to an off-DOM canvas and sends it as
one complete JPEG — `image2pipe` finds frame boundaries by scanning for JPEG
markers, so a partial write corrupts the stream from that point on.

| Channel | Does |
| --- | --- |
| `export:choose` | The OS save dialog, which owns the overwrite question |
| `export:start` | Opens a session; returns `{sessionId}` or `{error}` |
| `export:frame` | Writes one JPEG; waits only when the pipe is full |
| `export:material` | Writes `blob:`/`data:` bytes into the session's temp dir |
| `export:finish` | Mixes audio, muxes, returns where the file went |
| `export:cancel` | Kills ffmpeg and removes the temp directory |

`export:material` is not an edge case: a take opened straight from the
recorder is made of `blob:` URLs, which exist only in the renderer's memory
and which ffmpeg cannot open. The copies go in the session's own working
directory, so `finish` and `cancel` already delete them.

Audio never goes down the frame pipe. `export:finish` mixes it in a second
ffmpeg pass straight from the source files, so audio already on disk is not
re-encoded through a canvas. Sources are probed first: one unreadable URL
would otherwise fail the whole filtergraph and ship a silent file with nothing
to say about why, so `finish` returns a per-clip `audio` report instead.

The mux caps `-t` at the video's own duration and never uses `-shortest`,
which cuts to the shortest *input* — a short music bed once truncated a
16-second sequence to 5.5 seconds.

`electron/exportFilters.cjs` holds the pure argv and filtergraph builders,
separately from anything that spawns a process, so `tests/video-export.test.mjs`
can assert the strings without a binary. Hardware encoders are chosen by
`electron/hardwareEncoder.cjs` (VideoToolbox on macOS, NVENC/QSV/AMF on
Windows) and are given a bitrate rather than a CRF, which means nothing to
them.

### The Pro entitlement

`TEMINALI_BILLING_URL` being unset is the ordinary state for a development
checkout, and it resolves to the **free** plan rather than to an error. Free
carries the local lanes — Flash, Max and the built-in voice — so a machine that
has never seen a billing service is a working editor, not a locked one.

Pro carries two capabilities, and they behave differently on purpose:

| Capability | What it unlocks | Without it |
| --- | --- | --- |
| `frontier.escalation` | Frontier Auto's escalation to Claude Sonnet, and the `claude-sonnet` / `claude-opus` profiles | **Refused.** `POST /api/frontier/resolve-mode` answers `402 PLAN_UPGRADE_REQUIRED` with the capability and plan in `details` |
| `voice.vibevoice` | The local speech sidecar | **Not gated since 2026-09-05** — granted to every plan, because on Windows there is no built-in engine to fall back to. The downgrade path below still exists and still reports `gated: "voice.vibevoice"` if the capability is ever withdrawn |

The difference is the cost, not the policy. Escalation spends money per turn
against a hosted API and has no local substitute, so a free caller is refused.
The sidecar runs on the user's own machine and whisper.cpp plus the system
voices sit underneath it, so a free caller is served the ordinary tier rather
than losing their microphone. `frontier.max` stays free for the same economic
reason the local lanes do: it burns the user's own electricity.

Sign-in is a device-code flow — a desktop app has no redirect URI worth
trusting. `POST /api/entitlement/sign-in` returns a code to type on another
device, `POST /api/entitlement/sign-in/poll` waits for it to be claimed, and
`GET /api/entitlement` reports the current plan together with the capability
catalogue the upgrade screen renders from.

All of that surfaces in the **Usage panel**, above the agent-CLI plan headroom
and labelled apart from it: the two answer different questions, and a reader
who conflates them would think upgrading here raised a Claude Code limit. The
section lists every capability with a tick or a lock, offers sign-in when there
is no session, and offers the price list when — and only when — some plan on
sale carries a capability this licence lacks. That test is on capabilities, not
on the plan name, so adding a tier needs no edit to the component. A card price
opens Stripe in a browser; a mobile-money price takes a phone number, pushes a
prompt to the handset and polls the order until it settles, then refreshes the
licence itself. A build with no `TEMINALI_BILLING_URL` shows the capability
list and says so, rather than offering a button that cannot work.

The licence is an Ed25519 token verified locally against a key baked into the
build, so Pro survives with no network: it is refreshed well before expiry, and
honoured for a grace window past expiry (`licence/format.js` — 7-day token,
14-day grace). Past grace it silently becomes free. The plan/capability
registry is `licence/entitlements.js`, and adding a capability to a plan is an
edit to that one file.

The service on the other end is [`billing/`](../billing/README.md) — a
Cloudflare Worker with a D1 database, deployed separately and never packaged.
It runs the device flow, takes money on two rails (Stripe for cards, Lipia for
mobile money) and signs the licence. It is not deployed yet, and until its
public key is pasted into `BAKED_PUBLIC_KEYS` in `server/licence.js` — still
empty in this checkout — no build honours any licence and every machine
resolves to free.

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
- [`../billing/README.md`](../billing/README.md) — the billing Worker: routes,
  the two payment rails, and how to stand one up.

## Licence

This repository is private and ships no `LICENSE` file. No licence is granted.

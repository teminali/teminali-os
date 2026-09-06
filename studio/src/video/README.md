# `src/video` — the ported Teminali Cut editor

55 files, ~21k LOC, lifted from `teminaliCut/src/` with **the Cut's directory
layout preserved exactly**. That is the point of this folder: both apps stay
alive, fixes will be synced between them for months, and matching paths make
that a diff rather than archaeology. The manifest is
`teminaliCut/.claude/handover/video-slice-files.txt`.

The slice references `electronAPI` **zero times**, which is why it mounts in
this renderer unchanged. One of the 55 is not TypeScript: `engine/pitchWorklet.js`
is loaded at runtime by `new URL('./pitchWorklet.js', import.meta.url)`, so
neither `tsc` nor `vite build` fails when it is absent — the first port shipped
without it and the only symptom was a console error and a preview that could not
pitch-shift. If you re-derive the manifest, non-`.ts` assets are the class of
file to check for by hand. Import, export and recording did not come across —
those are the parts that genuinely need the Cut's 80 IPC channels.

Mounted by [VideoPane.tsx](../components/workspace/panels/VideoPane.tsx). Driven from the
chat through [videoToolCalls.ts](../services/videoToolCalls.ts) — see **P2** below.

## Do not tidy these files up into `src/`

`components/ui/Primitives.tsx`, `components/ui/Controls.tsx`,
`components/ui/icons.ts` and `hooks/useMeasure.ts` collide by name with Code's
own `src/components/ui` and `src/hooks`. Everything staying under `src/video/`
is what prevents that. Moving a file out breaks the sync story and the name
isolation in one go.

## The three seams

**1. Tokens.** `video-tokens.css` declares the 46 CSS variables the Cut's sheet
has that Code's `src/styles/tokens.css` lacks, scoped to `.video-workspace`.
The 37 the two systems share are *not* redeclared, so ported components inherit
the host's values. Its most visible consequence: Code runs `--r-sm: 6px` /
`--r-md: 8px` where the Cut runs 8 / 10, so ported controls render 2px tighter
here than they do in the Cut. That is accepted — the shell wins.

Redeclaring a host name with a *different meaning* is the failure mode this
seam invites, and it happened twice. `--accent-ink` meant "text on an accent
fill" (#151515) to the host and #f0f0f0 here; `--focus-ring` is a bare colour to
the host and a full shadow list here. Both would have broken any host component
rendered inside `.video-workspace` — near-white text on a green button, and a
focus ring that resolved to invalid CSS and vanished. The first is deleted, the
second renamed `--focus-shadow`. **Shadow a host token only to change its value,
never its type or its role.**

**2. Component classes.** `video-components.css` carries the 63 hand-written
classes the slice reaches for (`.pro-btn`, `.editor-clip`, `.seg-item`,
`.well`, …), mechanically extracted from `teminaliCut/src/index.css` and
prefixed with `.video-workspace`. Its own header records the three deliberate
changes made during extraction. Both sheets are imported from
`src/index.css`, not from `VideoPane.tsx` — `@apply` only resolves in the file
carrying the `@tailwind` directives.

**3. Tailwind families.** `tailwind.config.js` gained the Cut's `spectrum.*`,
`lane.*` and `line.*` colours, the `squircle-*` radii, the `ui-*`/`micro` type
steps, its elevation and duration names, and three keyframes. Every one of
those is **additive**; no existing entry was repointed.

### The one place the ported files were edited

Five class names in `components/ui/Primitives.tsx`, because `panel` and
`control` already mean something else in this repo's spacing scale:

| the Cut | meant | in Code `-panel`/`-control` would be | rewritten to |
|---|---|---|---|
| `px-panel`, `pt-panel` | 12px | `var(--panel-w)` = **452px** | `px-3`, `pt-3` |
| `px-control`, `pl-control`, `gap-control` | 8px | `var(--control-h)` = **26px** | `px-2`, `pl-2`, `gap-2` |

Tailwind's numeric scale is identical in both repos (`3` = 12px, `2` = 8px), so
these render exactly as they do in the Cut. The non-colliding names from the
same family — `hair`, `tight`, `section`, `group`, `page`, `bar`, `disc` — were
added to the config instead and need no edit.

## What the pane does NOT bring across

`hooks/useKeyboardShortcuts.ts` was deliberately left in the Cut. It binds
Space, S, I, O, L, the arrows and more on `window`, which inside Code would
hijack those keys for the whole IDE, not just the panel. Every one of those
actions has a button in the ported UI, so nothing is unreachable — but the
editor is mouse-only here until that handler is re-scoped to fire only while
the video panel holds focus.

## The pane's proportions are the Cut's own numbers

`VideoPane.tsx` reads them off `teminaliCut/src/store/layoutStore.ts`:
inspector **296px** (`DEFAULTS.inspectorWidth`), timeline **291px**
(`DEFAULTS.timelineHeight`, and its splitter's reset value), monitor floor
**280px** (`.editor-program`'s `min-w-[280px]`).

Those add to **576px**, and this workspace panel opens at **452px** — so the
inspector cannot be a permanent column here the way it is in the Cut. Under
576px it collapses to a tab on the band's right seam and returns as an overlay
over the monitor. Measured clean (zero non-scrolling overflow) at 736px, 948px
and 1020px; at 452px the pane itself is correct but `PreviewPlayer`'s own
monitor and transport bars clip, because the Cut never runs that column below
~670px. The tab strip's expand button (452 → 736) is the intended answer.

## P2 — the chat edits the timeline

`mcp/toolRegistry.ts` is a **reduction of the Cut's 6,230-line file of the same
name to three tools**: `describe_timeline`, `patch_clip` and `set_effect_param`.
Same path, same exports (`KERF_TOOLS`, `getTool`, `executeTool`,
`getToolManifest`), same Zod schemas — so adding a fourth is a copy-paste out of
the Cut, and syncing is a diff. It cost one dependency, `zod ^3.24.2`, pinned to
the range the Cut declares.

Two things the Cut's `executeTool` does are gone, because neither store came
across: it logs every call to `useMcpStore`, and it calls `followToolCall` so
the Cut's own UI follows the agent's work. Their absence costs nothing here —
the tools write to the stores the mounted components render from.

Nothing in this folder knows about the chat. The wiring lives in the host:

| file | what it does |
|---|---|
| [`services/videoToolCalls.ts`](../services/videoToolCalls.ts) | the protocol: parse a `video-tool` fence, run the calls, build the observation the model reads next turn. The shell counterpart is `agentCommands.ts` and the two are shaped alike. |
| [`services/frontierEngine.ts`](../services/frontierEngine.ts) | `EngineCapabilities.videoTools` / `.runVideoTool`. Injected, never imported: the engine must not know a video panel exists. A boundary test enforces that. |
| [`services/aiService.ts`](../services/aiService.ts) | the host adapter for the in-renderer chat. |
| [`services/videoToolBridge.ts`](../services/videoToolBridge.ts) | the same tools, served to the agent CLIs over MCP — see **The MCP bridge** below. |

Those two are the only files that import this registry, and they are the two
trust boundaries: the chat runs in this renderer, the CLIs do not.

**There is no approval gate on these tools**, unlike shell commands. A command
can delete a file; these three write to two in-memory Zustand stores that
nothing persists, each call is exactly **one** entry on the undo stack, and the
panel is on screen while it happens. Import and export are the tools that will
need a gate, and they are P3/P4.

`aiService` used to intercept every prompt matching
`/video|timeline|silence|beat|caption|track/` and answer it with one hardcoded
silence-split against the Cut running on port 3888, reported as "completed and
verified" whatever had been asked. That intercept is gone. `MCPRemoteSyncService`
stays — talking to a *separate* Cut is a different feature and still a supported
one.

## The exposed surface is an allowlist

`getToolManifest()` is built from `EXPOSED_TOOLS`, not from every tool defined
in the file, and `TOOL_BUDGET` caps it at 15. This is the only part of the
design that costs tokens, so the numbers are measured rather than guessed:

| | chars | ~tokens |
|---|---:|---:|
| the three tools' descriptions | 912 | <1k |
| their full manifest, schemas included | 1,798 | ~450 |
| the Cut's **115** descriptions | 34,660 | ~8.7k |
| the same with their schemas | — | 15-20k |

That cost is paid on every request that advertises the panel, and it is
identical whichever transport carries the call: a function pointer in this
renderer, an IPC hop, and the shim's stdio pipe all move the same bytes past
the model. So a tool copy-pasted out of the Cut is **not** in front of a model
until someone adds its name to `EXPOSED_TOOLS` and accepts the cost. The
un-listed remainder stays callable in-process and is refused over MCP, which is
where import and export will want an approval gate before they are listed.

**A tool says itself twice.** Alongside `description` a tool may carry a
`brief`: the same capability in one line, for the local lane's system prompt
only. The long form is written for an MCP client with room for it — Claude Code
and Codex read it and are deliberately ungoverned — while the local lane reads
the whole catalogue into an 8k window, where the nine exposed descriptions came
to **3,395 characters, 43% of its entire system-prompt budget**, and crowded
out the block that lets the assistant ask the operator a question.

Shortening `description` would have made the manifest worse for the lanes that
can afford it, and truncating it mechanically would have deleted the parts that
carry the weight — `patch_clip`'s dotted-path examples, `ffmpeg_process`'s "the
operator is asked", the paragraph above about what `full` costs. So the short
form is written by hand and lives in the same object as the long one, where the
two cannot drift. `getToolManifest()` carries both and an MCP client reads only
`description`; `videoToolSummaries()` in `services/aiService.ts` prefers
`brief`. Catalogue: **2,238 characters**. The guard is `editor-patch-clip` in
`evals/local-lane.mjs`, which asks for a rotation by clip id and therefore only
passes if the dotted-path examples survived.

`describe_timeline` answers in **summary** by default for the same reason: a
tool result does not go away, it is re-sent on every later turn of the
conversation. Summary on the seed project is 2,367 chars against 4,865 for
`detail:"full"` — the model asks the question to learn clip ids, and rarely
needs the rest. Effect ids, keyframe counts, speed, blend mode, clip text,
markers and the media pool are what `full` adds; a flag absent from a summary
track (`muted`, `locked`, `solo`) means false.

## The MCP bridge

The three tools reach the **Claude Code** and **Codex** engines too, and those
run as real processes with no access to this renderer's stores. The chain:

```
agent CLI → electron/videoMcpStdio.cjs → 127.0.0.1:3899/rpc → electron/videoRpc.cjs
          → electron/videoToolBridge.cjs → IPC → services/videoToolBridge.ts → executeTool
```

| file | ported from | what it does |
|---|---|---|
| [`electron/videoMcpStdio.cjs`](../../electron/videoMcpStdio.cjs) | `teminaliCut/electron/mcpStdio.ts` | newline-delimited JSON-RPC over stdio; owns no state. |
| [`electron/videoRpc.cjs`](../../electron/videoRpc.cjs) | `electron/rpcServer.ts` | 127.0.0.1 only, per-launch token, three methods. |
| [`electron/videoToolBridge.cjs`](../../electron/videoToolBridge.cjs) | `electron/toolBridge.ts` | main's pending table and the IPC hop. |
| [`server/video-mcp.js`](../../server/video-mcp.js) | `electron/agentBackends.ts` (the two `prepare` blocks) | finds the bridge, renders the spec into each CLI's dialect. |

Four notes, each of which is a decision rather than an accident:

- **Not `teminaliCut/src/mcp/cli.ts`.** That file — the one the handover named —
  is the Cut's *first* stdio server, and it imports the tool registry directly,
  so it edits an empty store in its own process and reports success. The header
  of `toolBridge.ts` exists to say so. `mcpStdio.ts` is the one that works.
- **Port 3899, not the Cut's 3888.** Both apps are meant to run at once, which
  is the whole hedge behind the phased port. `TEMINALI_VIDEO_RPC_PORT` moves it.
- **No `--strict-mcp-config`.** The Cut passes it because its agent exists to
  edit video and the operator's own MCP servers are noise. Here `claude` is the
  operator's general coding agent, and dropping the servers they configured
  themselves would be a regression they could not explain. `--allowedTools
  mcp__cut` is passed instead, because headless `claude -p` has no TTY to
  approve a tool call on and would otherwise refuse the first one.
- **The token is published in a file, not an environment variable.** The
  gateway spawns the CLIs, and in development it is a *separate* process from
  Electron main, so it cannot be handed a token from main's memory — and
  putting one in main's environment would leak it into every child process the
  operator's agent goes on to spawn. `$TMPDIR/teminali-os-video-bridge.json`,
  mode 0600, written only by the instance that actually holds the port, and
  removed on quit. A file whose pid is gone is treated as absent, so a stale one
  costs nothing.

`electron/videoRpc.cjs` takes its bridge as an argument instead of importing
it, which is what lets [`tests/video-mcp-bridge.test.mjs`](../../tests/video-mcp-bridge.test.mjs)
drive the real shim, as a real child process, against the real RPC server under
plain Node. Only the IPC hop is faked there; the rest was verified against the
running app.

## Still to come

- **P3** — media import. Designed but not built: the approval gate, the
  staging order, and three findings that change its scope are in
  [P3-import-gate.md](./P3-import-gate.md). No tool touches the disk until
  that gate exists.
- **P4** — export (`export:*`, `render:*`). Until then, export stays in
  Teminali Cut, which is why that app is still shipping.

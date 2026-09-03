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

**1. Tokens.** `video-tokens.css` declares the 47 CSS variables the Cut's sheet
has that Code's `src/styles/tokens.css` lacks, scoped to `.video-workspace`.
The 37 the two systems share are *not* redeclared, so ported components inherit
the host's values. Its most visible consequence: Code runs `--r-sm: 6px` /
`--r-md: 8px` where the Cut runs 8 / 10, so ported controls render 2px tighter
here than they do in the Cut. That is accepted — the shell wins.

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
| [`services/aiService.ts`](../services/aiService.ts) | the host adapter, and the only file that imports this registry. |

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

## Still to come

- **P3** — media import (`dialog:openMedia`, `ffmpeg:process`).
- **P4** — export (`export:*`, `render:*`). Until then, export stays in
  Teminali Cut, which is why that app is still shipping.

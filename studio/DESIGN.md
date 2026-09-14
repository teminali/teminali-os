# 🎨 Teminali Design System (TDS) — Canonical Contract & Component Governance

> **Canonical System Contract for Teminali Suite & Autonomous AI Agents**
> Ecosystem: **Teminali OS**, **Teminali Cut**, **Teminali Guardian**, and all generated web apps.
> Mandate: reproduce **Cursor's Obsidian Dark** exactly. Every UI change MUST be made at the token
> or primitive level so it propagates everywhere at once.

---

## 0. The token sheet is the only source of truth

`studio/src/styles/tokens.css` holds every colour, size, radius, duration and
curve in the system. **Every value in it was sampled pixel-for-pixel out of
Cursor's own agent window** (macOS, 2× retina). A comment reading `measured`
means that hex came off a screenshot; anything else is an interpolation chosen
to keep a ramp monotonic between two measured stops.

**No component may contain a raw hex, a raw px radius, or a raw duration.**
Tailwind is bound to the sheet in `studio/tailwind.config.js`, so tokens are
reachable as ordinary utilities:

| Role | Utility | Token |
| --- | --- | --- |
| Canvas / chat / right panel | `bg-frame-mid` · `bg-panelbg-mid` | `#151515` |
| Sidebar | `bg-rail-mid` | `#181818` |
| Composer, user bubble, inputs | `bg-surface` | `#212121` |
| Buttons, chips, inline code | `bg-surface-raised` / `bg-surface-chip` | `#262626` |
| The +/mic discs in a composer | `bg-surface-control` | `#313131` |
| Sidebar row — hover / selected | `bg-surface-hover` / `bg-surface-active` | `#242424` / `#252525` |
| Off switch track (only) | `bg-surface-track` | `#6b6b6b` |
| Sidebar ↔ canvas divider | `border-edge-chrome` | `#282828` |
| Table and card edge | `border-edge` | `#262626` |
| User-bubble edge, outline pills | `border-edge-strong` | `#313131` |
| Composer edge (brightest in the window) | `border-edge-popover` | `#3a3a3a` |
| Code block and shell card edge | `border-edge-code` | `#1c1c1c` |
| Headings, `strong`, active labels | `text-ink-bright` | `#f0f0f0` |
| Chat paragraphs | `text-ink-prose` | `#cbcbcb` |
| Sidebar rows, icons, secondary | `text-ink-muted` | `#b8b8b8` |
| Timestamps | `text-ink-soft` | `#9f9f9f` |
| Section labels, tool lines | `text-ink-faint` | `#989898` |
| Placeholders | `text-ink-placeholder` | `#6b6b6b` |
| Emphasis / send button — **the brand** | `text-accent` / `bg-accent` | `#00bf63` |
| Text on an accent fill | `text-accent-ink` | `#151515` (7.5:1) |
| Focus ring on the composer | `--lit-accent-top` + `--focus-ring` | `#00bf63` + 14% wash |
| The Update pill | `bg-action text-action-ink` | `#00bf63` on `#151515` |
| Links, hostnames — deliberately *not* the brand | `text-info` | `#86aee4` |
| Chat reading column | `max-w-composer` | `760px` |
| Empty-state composer | `max-w-composerEmpty` | `608px` |

Motion is one curve — `--ease: cubic-bezier(.2,.7,.2,1)` — at three speeds
(`duration-fast` `.1s`, `duration-ds` `.15s`, `duration-slow` `.2s`).

**One surface is calibrated against something other than the app's greys, and
it says so in the sheet.** `--player-*` is the media player's chrome, which
sits over a frame of film — a snowfield in one shot and a night interior in the
next. Every other token here is measured against a known ground, and a control
bar tuned for `#181818` disappears over the first bright frame. So that block
is defined against **black**: a flat scrim (`--player-scrim`), marks as white
at fixed alphas (`--player-ink`, `--player-track`), and one hue —
`--player-accent`, the brand green, on the played span of the scrubber and on
whichever pill is currently doing something, because "this is ours and this is
live" means there what it means everywhere else. `--player-glass` is the
floating family: the pills in the top corner, the episode drawer on the left
edge, the menus. One white alpha with a blur behind it covers a bright frame
and a black one, which is the same argument as the rest of the block. The two
edge scrims are §1's one sanctioned gradient — see §3 — and nothing else here
gets one. Reach for these only over picture; a component that used
`--player-ink` on a panel would be putting pure white on grey, which is not in
this system's range.

### Typography

- UI **and** chat: the platform face (`font-sans`). Cursor ships no custom UI
  font; rendering in the system face is what makes it feel like part of the OS.
- Code, telemetry, keycaps: `font-mono`.
- Scale: `text-2xs` 11 · `text-xs` 12 · `text-sm` 13 (sidebar and chrome) ·
  `text-md` 14 (chat body and headings).
- **Code sets its own size.** `--code-font-size` (12px) is read by every code
  surface — the Prism container, the markdown code block, inline code — and is
  *not* part of the ramp above. Settings > Appearance moves the two
  independently, because growing the chrome is not a request for larger
  snippets. `--text-code` is the code text **colour**, and predates it.

---

`border-edge-code` is the one border that does **not** follow "the fill it sits
on, lightened by roughly 0x10". A transcript stacks code and shell cards one
after another, and at a full step the run of edges reads as a ladder of bright
rectangles down the page — the operator sees the frames before the code. Against
the `#151515` sunken fill it is barely a step, which is the intent: the darker
fill defines the block and the hairline only closes the shape.

## 1. Zero-Slop Design Principles

**Cursor is achromatic and flat. We keep the flat, and take back one hue.**
Five greys carry the whole interface; the DukaBot green — `#00bf63`, the logo
green from that product's own palette — carries the brand, and nothing else is
tinted. Internalise these five and the rest follows:

1. **No gradients.** Not on the window, not on the sidebar, not on a button, not
   as a floor glow or a top light. Every surface is one flat fill. A vertical
   wash across the canvas blurs the one tonal step that matters (the sidebar
   sitting 3 values above it), which is the whole structure of the shell. One
   exception, and it is written down rather than assumed: the media player's
   two edge scrims (§3). They sit over an arbitrary image, not over a known
   grey, and a flat plate opaque enough to carry white text there cuts a
   visible band out of the film.
2. **No edge lighting.** Depth is a flat 1px border, one step lighter than the
   fill it encloses, identical on all four sides. No brighter crown, no inner
   catch, no fade around the corner, no contact shadow. `--lit-*` still exists
   only so the `.lit` classes in `index.css` resolve to that flat hairline.
3. **No decorative colour.** Red means destructive, amber means warning, blue
   (`--info`) means "this navigates somewhere" — and the brand green means
   *this is ours and this is live*: the accent, the primary button, the Update
   pill (`--action`), the composer's focus ring, a usage bar (`--chart`). That
   is the entire chromatic budget. Everything outside it is grey, and an
   emphasised glyph that is not one of those roles is *brighter* than its
   neighbours, never a different hue.

   Two things that look like exceptions and are not. `--accent-code*` stays
   achromatic: inline code is not a brand surface, and tinting it would make
   every backtick look like a link. Syntax highlighting reads `--syn-*`, never
   `--accent` — an operator is code, not chrome.

   `--success` (`#65c466`) remains its own, softer green. It is close to the
   brand hue and that is a live tension: "exit 0" and "this is Teminali" now
   rhyme. Left as-is deliberately rather than collapsed into one green, because
   a run that succeeded and a button you can press are not the same statement.

   **The video workspace pays for this twice.** Track lanes are the one place
   the system permits colour as *data* — video blue, overlay purple, text pink,
   audio green, effect teal — and the audio lane is `#65c466`, the same softer
   green. While the accent was achromatic every lane cleared it on hue. Now the
   accent is green and the audio lane is green, and they separate only on
   saturation and on shape: a lane wears full strength as a 2px spine, the
   accent appears as a wash (`--accent-soft`) or a hairline (`--accent-line`).
   That holds today. It is the weakest joint in the palette, and re-hueing the
   audio lane — not de-greening the accent — is the fix if it ever stops
   holding.

   The green alphas in `.video-workspace` are **not** the host's. Green carries
   far less luminance than the near-white it replaced, so the ported 0.10 /
   0.28 alphas left a selected clip and a focus wash invisible on that
   subsystem's deeper planes. Measured over `--chrome` #181818: white at 0.10
   lifts 10.1 L\*, green needs 0.16 to lift 11.5; white at 0.28 reaches 2.28:1,
   green needs 0.45 to reach 2.43. Matching a colour across two grounds means
   matching what it *does*, not the number that produced it.
4. **A card is recessed, not raised.** Cursor inverts the usual convention: an
   inset card (Getting Started) is *darker* than the sidebar around it, while a
   raised control (composer, message bubble) is lighter than the canvas. Both
   read correctly because the border does the work.
5. **A section label is not chrome.** Sentence case, body size, one step down
   the ramp, separated by space. Never uppercase mono, never ruled off. The one
   exception is the Explorer's workspace root, which is uppercase in Cursor too.
6. **Native controls are reset, once,** in `index.css`. Never patch at a call site.
7. **Solid light fills take dark text** (`text-frame-mid` / `text-action-ink`).
8. **State is legible.** If the machine is doing something, say which thing, in words.

---

## 2. Component primitives (`studio/src/components/ui/`)

Import from here rather than writing ad-hoc markup:

* **`Button`** — `primary` · `secondary` · `ghost` · `danger` · `tab` · `pill`
* **`Badge`** — status and model pills
* **`Card`**, **`Modal`**, **`Input`**, **`SegmentedTabs`**, **`CodeSnippet`**
* **`Menu`** — the one floating popover (add-panel menu, browser omnibox)
* **`Primitives`** — `Kbd`, `InlineCode`, `Chip`, `IconButton`, `TrafficLights`,
  **`DialogCloseButton`**, `EmptyState`, `StatusDot`, `SectionLabel`,
  **`SidebarRow`**
* **`Setting`** — the settings row family: `SettingGroup` (a tracking-wide
  label over a card that owns the hairlines between its rows), `SettingRow`
  (label + description left, control right), `SettingToggle`, `SettingSelect`,
  `SettingStepper`, `SettingSlider`, **`SettingList`**. Every row on every
  settings screen is one of these. `SettingList` is the exception to the
  label-left/control-right shape and is deliberately full width: it holds a list
  rather than a value — removable chips over one add field — and twenty
  executables truncated into the right-hand column would hide exactly the
  characters that tell two entries apart. Removal takes one click and no
  confirmation, because every entry in one of these lists is a permission the
  operator granted and taking one back should not be harder than giving it. Two
  users: the agent allowlist and the voice wake words.
* **`BrandGlyph`** — the third-party and own app marks, used unmodified. Its
  `blend` prop drops the mark's own tile: these are *app icons*, and the
  Teminali one is a green figure on a pure black rounded tile (measured — `#000`
  at full alpha, only the corners transparent). Right in a Dock, wrong where the
  mark sits on the page rather than on a badge. `screen` is exact for that
  rather than approximate — screening pure black leaves the backdrop untouched —
  and it is for dark surfaces only.

The `Setting` family exists because each settings row used to be written by
hand: `VoiceSettingsPanel` carried a private `Row`, `Toggle` and `Select`, the
General screen wrote its own, and the two had drifted in padding, type scale and
what a disabled control looks like. The voice panel now renders through the
shared family and its four sections are `SettingGroup` cards — Engine, Language,
Who may speak, Conversation. Every settings screen is on this family as of
2026-09-10: Screen Assistant, Local Models & Weights and the GitHub block were
the last three writing their own rows (`docs/SETTINGS_AND_CHROME_PLAN.md` §2.2,
and §3 below for what changed shape). Two rules the family enforces
rather than asks for: the card owns the dividers, so a row never draws a bottom
border and the last row leaves no hairline hanging; and `SettingSlider` always
renders its number, because a track without a readout is a guess.

`SidebarRow` is every clickable line in the sidebar — nav item, repository,
conversation. Its measurements are not approximate: a 30px row on a 31px pitch,
inset 8px from each edge, 8px corner, a 16px glyph whose box starts at x=14, and
the label at x=38. Rows differ only in whether they carry an icon (`indent`
aligns one that does not) and what sits on the right.

### Governance law

> Whenever updating any UI in the Teminali suite:
> 1. Check whether a primitive already exists in `src/components/ui/`.
> 2. If it needs improving, **improve the shared primitive** so the change propagates.
> 3. Never create a one-off styled button, modal or tab switcher in a page.
> 4. Never introduce a colour that is not in the token sheet. If a genuinely new
>    role is needed, add the token first — and prefer an existing grey.
> 5. The only permitted raw hexes are third-party brand marks — the language
>    colours in `FileTree`'s file glyphs, the git orange, the npm red. They
>    identify someone else's product and are not ours to re-theme.
> 6. **Do not reintroduce the ember.** `#ff8a4d` was an earlier brand accent.
>    It is gone on purpose. The accent is the DukaBot green and only that; a
>    second brand hue is the single fastest way to look like two products.

### Legacy palette map

The pre-redesign code is swept onto tokens by role, not by hue:

| Was | Now |
| --- | --- |
| `blue` · `sky` · `cyan` · `indigo` · `orange` | `accent` (the brand green) |
| `emerald` · `green` · `teal` | `success` |
| `red` · `rose` | `danger` |
| `amber` · `yellow` | `warning` |
| `purple` · `violet` · `fuchsia` | `reason` (now grey) |
| `gray`/`slate`/`zinc` on `text-` | the `ink-*` ladder |
| `gray`/`slate`/`zinc` on `bg-` | the `surface-*` ladder |
| `gray`/`slate`/`zinc` on `border-` | the `edge-*` ladder |
| `bg-white/[0.0x]` washes | a flat `surface-*` step |

---

## 3. Shell architecture (`studio/src/`)

```
StudioTitleBar    window controls (side by platform) · sidebar toggle · title · IDE · Video Editor · panel tab strip
├── SidebarDock      ActivityBar (48px, always) + one 212px panel
│   ├── ActivityBar    New Chat · SIDEBAR_TABS glyphs · Customize
│   └── Sidebar        the selected view · SidebarFooter
│       └── view       StudioSidebar (chats) · Explorer · GlobalSearchView
│                      · Skills
├── StudioChat       empty state (brand mark) / transcript · ChangeReviewDock
│                    · Composer (voice lives here) · AssistantHud
└── WorkspacePanel   terminal · browser · canvas · side chat · file · guardian
                     · Claude Code · Codex · usage · benchmark · release
                     · video editor
RecorderModal        the screen recorder, app-level — a dialog, not a panel

AssistantProvider    wraps the shell; one session, reachable from every composer
AssistantBridge      renders nothing — keeps the tray, hotkey and overlay in step
MediaConsentModal    the media approval gate's prompt; App.tsx's modal layer
VersionControl       bottom-right, fixed: the running version, updates, rollback
```

The **empty state carries the mark**: `BrandGlyph brand="teminali"` at 52px
with the product name beneath, stacked above the repository/host pickers, the
composer and the pill row. Cursor leaves that space bare and can afford to —
you already know whose window you are in. This one departs on purpose, and
departs only that far: a flat mark and a line of `text-ink-muted`. No orb, no
headline, no illustration, no gradient. The two ambient orbs that used to live
here are not coming back.

**There is an activity rail, and it reverses an earlier decision knowingly.**
This section used to argue the opposite: Cursor's agent window has one sidebar
and one structural seam, and a 48px rail beside a panel puts two. That is still
true and it is still a cost. What was paid for it (`3ba5b55`) is width. Labelled
rows priced the sidebar at 260px because the switch had to fit the word
"Customize"; glyphs cost 48 and let the panel open at 212 — the same 260px of
shell, with the labels' width handed back to whatever the panel is showing. Five
destinations fit the switch without wrapping; Media was the fifth until it
moved into the video editor's rail (below), and four fit with room to spare.

**`IDE` and `Video Editor` sit together in the title bar's right group**, split
by a 1px `bg-edge-strong` hairline —
because they are the same verb — take this conversation somewhere it can be
worked on. They differ in where they go, and say so: the IDE leaves for another
application and wears the external-link arrow, the editor opens a panel here and
wears that panel's own glyph and accelerator (`⇧⌘V`), and the rule is a divider
rather than a label. It calls `focusOrOpen`, so
pressing it twice focuses the editor already open rather than stacking a second.

One list, `SIDEBAR_TABS` in `sidebar/ActivityBar.tsx`, not the old
`PRIMARY_NAV` / `WORKSPACE_NAV` pair: Chats (⌘L) · Explorer (⇧⌘E) · Search
(⇧⌘F) · My Projects · Skills. New Chat sits above it and Customize below, both
gestures rather than destinations. `ACTIVITY_BAR_WIDTH` is exported because the
title bar lines its edge up with the rail; `DEFAULT_SIDEBAR_WIDTH` is 212 in
`App.tsx`, under `frontier_sidebar_width_v2` — the key is bumped because a 260
saved for the old panel would have made the new dock wider, not thinner.

**The rail stays when the panel collapses.** That is the difference between
collapsing and closing: with the glyphs still on screen, a dismissed sidebar is
one click from open on any view, instead of depending on the title bar.

Cursor's fourth row, "Automations", is still absent because nothing here
schedules recurring work, and a tab that highlights itself and shows nothing
teaches the operator that tabs in this list might not do anything. **A glyph
earns its place by having a view behind it**; at 48px the label is one hover
away, which costs no pixels, where a label in the layout costs 212 of them.

**My Projects is one list of two kinds** (`sidebar/ProjectsPanel.tsx`, and the
capped four-pill row under the empty composer in `chat/StudioChat.tsx`; both
read `hooks/useProjectLibrary.ts`). Two lists side by side was the alternative
and it was rejected: an operator looking for the thing they had open on Tuesday
does not remember which of the two editors it belonged to, so a split makes
them guess before they can look. The glyph carries the kind and the *click* is
what differs — a repository goes through `/api/workspace/open`, which rebinds
the root every workspace and terminal route reads; a video project goes through
`/api/workspace/projects/remember`, which rebinds nothing, because a timeline
is not a workspace and opening one must not repoint the file tree at the folder
that holds it. The kind itself is never stored: the gateway re-classifies each
directory from its marker file on every read, so a folder that stops being a
video project stops being offered as one.

`⌥⌘S` / `⌥⌘O` save and open a video project, in the **native File menu** rather
than in the video pane's chrome, for the reason the recorder's `⇧⌘8` gives: a
native menu owns its accelerator whatever has focus, and this pane hands focus
to a canvas, a timeline and a row of numeric fields. `⌥` and not `⇧` is a
correctness constraint, not taste — `⇧⌘S` and `⇧⌘O` are already the side chat
and Codex in `App.tsx`'s shortcut handler, and a key the menu takes is a key
the page stops hearing, with no error anywhere.
`tests/video-project-bridge.test.mjs` asserts that collision cannot come back.
`⌥⌘E` joins them for **Export Video…**, in the same menu and for the same
reason, and it opens the dialog rather than starting a render: the menu cannot
know whether the sequence has anything in it, and an accelerator that spawns
ffmpeg on a keypress is one nobody can undo.

**The export dialog is scoped to the pane, not to the window.** It draws its
scrim inside `VideoPane` and sets `aria-modal="false"`, because the render is a
question about the video and blacking out the terminal and the agent to ask it
would stop the work the export is part of. Hiding it leaves the render running,
which is why the program header's Export button wears the percentage while one
is: a running render with nowhere on screen is one nobody cancels. The whole of
its state — progress, phase, telemetry, the cancel handler — lives in
`useProjectStore`, so an export an agent started is shown and cancelled by the
same dialog as one a person started.

**A render takes the video elements, it does not share them.**
`seekVideosForFrame` parks the same `<video>` cache the monitor draws from, so
`useProgramLoop` yields while `isExporting` is set exactly as it yields to the
fullscreen player, and the loop hands the thread back through
`requestAnimationFrame` every 12ms. The editor this was ported from owns a
window and may freeze for the length of a render; this one is a panel, and a
frozen panel is a frozen IDE.

**An export lifts background throttling, and puts it back.** Chromium clamps a
backgrounded page to roughly one task per second, and `canvas.toBlob` returns
its encoded frame through one of those tasks. Measured on a 1664x1080 frame:
**12ms with the window in front, 1023ms behind it** — the render is unchanged,
the callback is simply held. That is the ordinary case rather than the edge
one, because the dialog itself says hiding it leaves the export running. So
`export:start` calls `setBackgroundThrottling(false)` on the webContents that
asked, and finish and cancel alike put it back, refcounted on `sessions.size`
beside the power lock that was already there. An IDE idling behind another
window should still be throttled; an IDE rendering should not. With the lock
in place a 741-frame export measured 7.6 fps occluded against 7.4 fps focused
— the gap is gone, and what remains is the per-frame IPC, not the window state.

**A finished export ends on the file, not on the settings it was started
from.** The dialog kept its result in one grey line at the foot of the form —
"Last export · reveal" — which is where an exported file goes missing: the
operator never chose the destination, "your Videos folder" is not a path, and
the notice that names it lasts 3.2 seconds. So a completed export now holds the
dialog: a green tick, the whole path wrapped rather than truncated, and
**Show in Finder** / **Show in Explorer** / **Show in folder** — named for the
platform, because "Finder" on Windows is a button nobody presses. *Export
again* returns to the form, *Done* closes.

The result is read from `useProjectStore` rather than from the call that
started it, so an export an AGENT ran ends the same way, and so does one that
finished while the dialog was hidden — reopening shows it. It reveals through
`videoProject:reveal`, the transport's existing `shell.showItemInFolder`,
because an export is one more file on disk and does not need a channel of its
own. The finish toast carries the same button (`Toast.action`, at most one, and
taking it dismisses the toast) on a 9-second life rather than the default 3.2:
with the dialog hidden the toast is the only surface the export ever gets, and
a notice that expires before it can be pressed is a taunt.

**Media is no longer a sidebar tab.** It was one, and this document argued at
length that it had to stay: a workspace panel is mounted only while it is open,
a sidebar tab always is, so the import gesture and the approval gate that takes
consent from it were said to need the tab's lifetime.

**That argument was wrong on its facts, and the code already said so.** The
gate's subscriber is not `MediaPanel` — it is `MediaConsentModal`, which
`App.tsx` mounts in its modal layer at the top level, and whose own header
comment gives the reason in as many words: `WorkspacePanel.tsx` mounts the video
panel conditionally while the tool bridge is registered at module load in
`main.tsx`, so the prompt must live above both. The gate's lifetime never
depended on the sidebar. What the tab actually held was the operator's *import
gesture* (`sidebar/MediaPanel.tsx`, `bring()`) — a convenience, not a safety
property.

**So the pool lives in the video editor's rail only** (`VideoPane.tsx`), by the
operator's explicit call. It is the *same component* reading the same
`mediaPool` out of `timelineStore`, so there is still exactly one implementation
of the import gesture, and CapCut's reasoning applies: the library belongs where
you reach for a clip. The cost is real and worth naming — importing now means
opening the video panel first, where before it was one glyph away from any view.
See `src/video/P3-import-gate.md`.

Panel state is its own store (`store/panelStore.ts`) because it is pure view
state; chat and session state stay in `store/studioStore.ts`. Which sidebar view
is selected lives in `App.tsx` beside the sidebar geometry, because the global
shortcuts (⇧⌘E / ⇧⌘F, ⌘B, ⌘L) drive it. The panel shortcuts live beside them and
mirror the add-panel menu exactly, so the menu doubles as the shortcut reference
and the two cannot drift apart.

**The version is a control, bottom right** (`components/updates/VersionControl.tsx`).
The shell has no status bar, so it is `fixed bottom-2 right-3 z-40` — over the
canvas and the workspace panel, under the modal layer — and the version string
itself is the button. That placement is deliberate: "which build is this" is
asked from wherever you happen to be, and on an ad-hoc signed application it is
the first question worth asking when the assistant stops seeing the screen,
because every update clears its permission grants. Floating chrome has to answer
for what is under it: the video editor's timeline is the one pane that draws
content into that corner, so it reserves the 30px strip the control occupies
(`video/components/timeline/Timeline.tsx`) rather than letting a lane render
beneath it. Move the offset and that reservation moves with it.

Behind it: **Update to X** (which opens `UpdateModal`, where the release notes
are), **Check for updates**, and **exactly one** previous release to roll back
to. One, not a catalogue — the regression a rollback is for arrived in the
update just installed, so the build below it is the one that answers, and a
longer list invites landing on a version nobody is testing. A rollback is
confirmed in place before it runs and names what it costs. `UpdateModal` says
what the install does **on the platform showing it**: macOS and a Linux
AppImage are replaced in place and reopened; Windows hands over to the
installer and quits, and the modal says so. The Apple-permissions warning is
rendered on macOS only — it is not true anywhere else. There is **no update
banner**; the announcement is a dot on this control and the pill in
`SidebarFooter`, both reading the one `useUpdates` check so they cannot
disagree. In a browser the rollback rows are absent rather than dead — replacing
the bundle needs the desktop bridge (`no dead affordances`, below).

### The file tree's open folders (`sidebar/FileTree.tsx`, `store/treeExpansion.ts`)

Which folders are open is store state — `expandedPaths: Set<string>` in
`studioStore`, keyed by workspace-relative path — not a `useState` on each row.
That is what lets something other than a click open a folder: `revealPath`
expands every ancestor of a path and stamps a `revealTarget` that the matching
row scrolls itself to. The agent's `reveal` tool drives exactly this; §5 has the
bridge. Booting open on top-level `src` and `studio` survives the move as
`DEFAULT_EXPANDED_PATHS`, and because those are paths rather than names a nested
`studio/src` stays shut. Changing the workspace root clears the set — paths from
the old tree open nothing in the new one.

### Every surface that streams an agent must subscribe to it

The gateway wires `reveal`, `open_project` and the edit watcher for **every**
agent CLI turn, whichever surface started it. What differs is who is listening,
and a tool whose event nobody subscribes to is worse than an absent tool: the
model is told it worked, sees nothing change, and goes looking for another way.

The chat had `onPermission` and neither of the other two. Asked to open a
project it fell back to the only route left to it — driving the app's own UI by
pointer, through the screen assistant — and spent eleven steps and two click
approvals to arrive at "the sidebar is still showing the repository list rather
than a file tree, so I can't tell whether that switched the workspace". It was
clicking at its own window because the tool built for the job was silent.

`StudioChat.tsx` now subscribes to both, with the same handlers `AgentPane` has
had all along. `tests/engine-boundary.test.mjs` pins both halves — the adapter
forwarding the callbacks and the chat supplying them — because either alone is
still silence. `ArenaPane` remains deliberately unsubscribed: its contestants
work in sandboxes and must not move the operator's tree.

### The browser's home page (`panels/BrowserHome.tsx`, `utils/siteMark.ts`, 2026-09-06)

It opened onto the right three things and showed them as one thing: three
undifferentiated lists of 28-pixel rows in a narrow centred column, every row
wearing the same grey glyph, and every row putting its host at the far right
with `ml-auto` — so a page titled "hello world - Google Search" had the words
"hello world" floating a hand's width away from it, attached to nothing.

The three sections are shaped by how they are used. **Bookmarks are a target
grid**: they are the reason to open this page, they are aimed at rather than
read, and a tile is a bigger target than a row. **History is a list**, scanned
in order, with its two useful fields — where, and how long ago — beside the
title rather than across the page from it; only the age goes right, because
only the age is genuinely a column. **Downloads are a status**, so one still
arriving shows a determinate bar — and only when the total is known, since a
bar faking progress against an unknown size is a lie the operator would use to
decide whether to wait. The search field is given the width and height to be
the first thing found, rather than being a row-sized box above three lists of
rows.

**The mark on every row is derived, not fetched.** A list where every row wears
the same glyph is one nobody scans; the icon is the only part the eye finds
before it reads. The obvious source is `google.com/s2/favicons?domain=…`, which
would mean this application quietly telling Google every site the operator has
ever kept — for an app whose browser store is on disk precisely so nobody else
holds it, that is not a trade worth making for an icon. So `utils/siteMark.ts`
derives the site's own initial on a hue hashed from its hostname: deterministic,
offline, and stable, so the same site is the same colour in every list. Its
`relativeAge` is now also what the sidebar's chat rows use, so two lists cannot
describe the same span of time differently. Tested in
`tests/site-mark.test.mjs` (5), including that short hostnames a naive
character sum would collide — "npm" and "mdn" — are spread apart.

#### The shape is a new-tab page (2026-09-06, later)

The top of it is deliberately Chrome's: a mark, one search field, and a row of
round shortcuts under it. Not for the resemblance — that arrangement is one a
person opening a browser already knows how to use, and a home page whose layout
has to be learned is one that gets skipped in favour of typing in the bar. The
tokens, type scale, hover states and focus ring are this document's; only the
arrangement is borrowed.

Three consequences worth writing down:

- **The shortcut grid is always drawn**, even with nothing kept, because its
  last cell is "Add shortcut" and that is how the first one gets made. The old
  `EmptyState` branch is gone: an empty grid with one `+` in it explains itself
  better than a paragraph saying the page is empty.
- **A shortcut wears the site's own favicon**, asked of the site itself at
  `/favicon.ico` and falling back to the derived mark when there is none. So do
  the rows of the recent list — a trail of coloured letters is a list you read,
  a trail of favicons is one you recognise.
- **One disc for every site mark**, in the grid and in the lists alike. The
  grid holds sites and it holds "Add shortcut", and that cell has no hostname
  to hash a colour from — so while each tile wore its own hue, the odd one out
  was the button that is always there. The disc is the neutral chip
  (`surface-chip` on `border-chrome`) everywhere, and the hue survives where it
  still does work: the letter, for a site whose icon did not load. The rows are
  `items-center`, not `items-baseline`: an image has no baseline, so a row
  whose mark is a favicon sat a pixel off from every word beside it. This
  is a deliberate narrowing of the rule above, not a reversal of it: the site
  the operator bookmarked already knows they visit it, while the favicon
  service that was refused is a third party told the whole list at once. A page
  that points elsewhere with `<link rel="icon">` keeps its letter, because
  finding that out means loading the page.
- **The field's icon is the search engine, and it is a button** — the logo
  alone, with no disc behind it. A shortcut is a tile and the coloured disc is
  what makes a grid of them read as one grid; the engine's mark is the icon of
  the field it sits in, and a circle behind Google's own round logo is a ring
  around a ring. A magnifying
  glass says a search is coming; the engine's mark says where it is going,
  which is the part an operator might want to change. Google, Bing,
  DuckDuckGo, Brave and Perplexity (`utils/searchEngines.ts`), persisted in
  `store/searchStore.ts`, and read by all three surfaces that search: this
  field, the omnibox's first suggestion, and the right-click menu — which is
  built in main and is told the choice over `browser-view:search-engine`,
  because it cannot read a store. Main refuses anything that is not an https
  prefix. Switching engines does not rename the tabs already open:
  `addressLabel` recognises a search URL from any engine in the list.

The field carries its focus on the pill's own edge (`lit-focus`), not on the
input inside it — the rule in §0 that a text field's ring belongs to its
container, which this page was breaking by drawing a box inside a box.

Tested in `tests/browser-search.test.mjs` (8): every engine is an https `q=`
prefix, an unknown persisted id falls back rather than blanking the field, the
menu in main names the chosen engine, an engine arriving over IPC that is not
https is refused without clearing the choice, and a favicon is only ever asked
of the site itself.

#### The recent list folds, and says when (2026-09-06, later)

The fold is **two passes, because one page has more than one address.** By URL
first, which collapses one navigation's title storm and keeps the title it
ended with; then by that title *and host*, which collapses the same video
listed four times, once per `&list=` and `&t=` the site appended while it
played. The host is in the key because a title is not unique — two sites both
have a "Home" and a "Sign in" — and an untitled page has only its address to be
identified by. The newest address wins, so opening the row goes where the
operator last was.


Six identical rows — same title, same host, six ages — because a session spent
watching four videos leaves the same sign-in page interleaved between them, and
the gateway's fold only catches a repeat *at the head* (one navigation
reporting itself as start, stop and title). `foldRecent` folds by address for
display, keeps the newest stamp and the title that came with it, and puts the
count beside the host: `accounts.google.com · 6 visits`. The stored history is
untouched — the assistant still reads every row — and the limit now counts
**pages** rather than visits, so ten rows are ten different things.

`visitDay` cuts the list into Today / Yesterday / Earlier. Three buckets, not a
date per row: twelve pages from one afternoon do not need twelve dates, and the
age already answers the only case where "how long ago" is interesting. The list
is also narrower than the page, because the age is the one field that is
genuinely a column and a column at the far edge of a wide panel is a number
attached to nothing.

#### Private tabs (`utils/privateBrowsing.ts`, 2026-09-06)

A private tab is a tab on another Electron session — `teminali-browser-private`,
unprefixed and therefore in memory — and that is the whole mechanism; the rest
follows from it. Opened from the panel's More menu as a *new* tab rather than
as a switch, because a view cannot change session and "make this one private"
would mean discarding the page the operator is looking at without being asked.

Four promises, each one rule in one file:

| Promise | Where it is kept |
| --- | --- |
| Cookies and site data live in memory, cleared when the last private tab closes | `electron/browserView.cjs` — `PRIVATE_PARTITION`, `clearPrivateSession` |
| Pages are not added to history | `utils/browserRecording.ts` — `visitOf` returns null for a private state |
| Downloads are not added to the list | `utils/browserRecording.ts` — `downloadAction` drops a private `done` |
| The tab is not reopened after a reload | `utils/privateBrowsing.ts` — `persistablePanels` filters it out of `partialize` |

The privacy flag is read from **main's** state rather than from `panel.private`:
main owns the session and the tab is only what asked for it. The tab strip
draws `EyeOff` instead of the globe, because on a strip where inactive tabs are
unlabelled icons a private tab that looked like every other tab is the one
place a page must not be opened by accident. The home page for a private tab
shows the search field and a plain list of what the mode does and does not do —
including that the downloaded file is still on disk and that the network can
still see the traffic — and *not* the shared bookmarks, history and downloads,
which under the word "private" would be the opposite of what it says.
`openBrowserAt` never reuses a private tab: whatever asked for that page — an
artifact preview, the agent — did not ask for it to be private.

Tested in `tests/browser-private.test.mjs` (11).

#### Importing from another browser (`server/browser-import.js`, 2026-09-06)

A new browser starts empty, which is honest and is also why nobody opens it
twice. **More › Import from another browser…** reads the lists another browser
already keeps on this machine and folds them into the same store the panel
already uses (`server/browser-data.js`).

It lives in the gateway rather than in main or the renderer for the reason the
store does: the agent has to be able to read what was imported, and the gateway
is the only process both the panel and an agent CLI's shim can reach.

| Decision | Why |
| --- | --- |
| The database is **copied** before it is opened | Chrome and Edge are normally running and hold their own database open. The copy — with its `-wal` sidecar — also means an import can never write a byte into another browser's profile. |
| Time is converted **inside SQL** | Chromium stores a visit as microseconds since 1601, e.g. `13432985205915271`. That is past `Number.MAX_SAFE_INTEGER`, and `node:sqlite` throws `ERR_OUT_OF_RANGE` the moment such a column is read into a JS number. Every query divides it to seconds first. Bookmarks' `date_added` is a *string* for the same reason and is divided as a `BigInt`. |
| Discovery is **evidence, not a vendor list** | A browser is offered only when a profile directory really holds a `Bookmarks` or a `History` file. On this machine four vendors have an Application Support folder containing nothing but `NativeMessagingHosts`, left by extensions; none is a browser anyone could import from. |
| The renderer names a **source and a profile**, never a path | Turning those into a location on disk is `browser-import.js`'s job alone, and a profile id is one directory name — no separator, no `..`. |
| Safari is listed **unavailable, with its reason** | `~/Library/Safari/History.db` is TCC-protected: reading it answers `unable to open database file` however correct the SQL is, until the app has Full Disk Access. Measured, not assumed. Hiding Safari would only make the operator wonder where it went. |
| **Autofill is not offered at all** | This browser has no autofill store, so importing saved addresses and cards would move sensitive data into a void. The dialog says so in the footer rather than showing a tick box that does nothing. |
| Bookmarks **append**, history **merges as a timeline** | The operator's own bookmarks are never displaced or re-dated by an import, and an address already kept is skipped rather than duplicated. History is concatenated, deduplicated by address keeping the later visit, sorted newest first and cut to `MAX_HISTORY` — so an import cannot bury what the operator did here today under a year of somebody else's visits. |
| The dialog is a **`Modal`** | It opens from the browser panel, and `services/browserView.ts` hides the native view on exactly `[role="dialog"], [role="menu"]`. A hand-rolled backdrop would have no `role="dialog"`, so the page would paint straight over it. The same fault the command palette had. |

Chromium bookmarks are plain JSON and need no database at all; Chromium history
and both Firefox lists are SQLite, read with `node:sqlite` — **bundled by
Electron 44 (Node 24.19.0), measured in the Electron runtime**, so no native
module and no new dependency. Both lists are capped at `IMPORT_LIMIT` (500),
which is what the store can hold; Edge's history on this machine is 40 MB and
nothing would read the rest.

The result is reported with numbers in it, because "imported" alone is the
least useful word available: an import that added nothing because everything
was already kept has to read differently from one that found nothing to read.

Tested in `tests/browser-import.test.mjs` (22) and `tests/browser-data.test.mjs`
(7 of its 17 cover the merge).

#### Passkeys, and the silence that read as a bug (2026-09-06)

Signing in to Google with a passkey did nothing: no fingerprint dialog, no
error. Measured in this app rather than guessed — `PublicKeyCredential` is
defined, `navigator.credentials.get` is a function, and
`isUserVerifyingPlatformAuthenticatorAvailable()` answers **false**. macOS gates
the platform authenticator behind
`com.apple.developer.web-browser.public-key-credential`, an entitlement Apple
grants to registered web browsers and to nothing an Electron app can claim. The
limit was not fixable here. **The silence was.** (It became fixable four days
later, by a different route — see below.)

**The request never ends on its own.** Measured again in an Electron harness
against a real https page, with the probe installed: `credentials.get({publicKey})`
stays **pending** — eight seconds in, no resolve, no reject, no dialog. That is
the whole of what the operator experiences: the page spins for ever, because it
is correctly waiting for an authenticator that is never going to answer. So the
probe ends it. Where no platform authenticator exists and the caller supplied
no `signal` of its own, it attaches one and aborts after `PASSKEY_ABORT_MS`
(25s) — long enough to find a USB security key and touch it, since that path
can still work, and short enough that the page recovers by itself. Re-measured
after the change: `rejected:AbortError`, which is a rejection every sign-in
page already knows how to handle.

`PASSKEY_PROBE` is injected on `dom-ready`, wraps `credentials.get`/`.create`
in the page's own world, calls through untouched, and prints a sentinel only
when the platform authenticator really is absent. Main reads that line off
`console-message` — the view has no preload precisely so someone else's page
has no bridge to find, and a string main happens to recognise is not one — and
publishes `passkey: true`, cleared on the next navigation. The toolbar then
says one line with the two routes that do work: another sign-in method on the
page, or Open in browser. Tested in `tests/browser-private.test.mjs`: the probe
stays silent when an authenticator exists, never changes what the page asked
for, ignores a password request, and installs once however many times it is
injected.

#### Touch ID passkeys, and the signature that decides (2026-09-10)

The entitlement Apple withholds is for the *system* passkey provider — the one
that reaches iCloud Keychain. Electron 44 supplies a different authenticator
that needs no such grant: `app.configureWebAuthn({ touchID })` implements a
platform authenticator against this Mac's Secure Enclave, with the credentials
in a named keychain access group. `electron/webauthn.cjs` turns it on inside
`whenReady`, awaited — until it is called
`isUserVerifyingPlatformAuthenticatorAvailable()` answers false, and a page
that asked a moment too early would be told there is no authenticator by a
build that has one.

**The group is the whole feature, and it is read rather than composed.** macOS
grants an app only the keychain groups its *signature* claims, and the group
carries an Apple team ID (`<TEAM_ID>.os.teminali.app.webauthn`) that exists
only as a CI secret. `codesign` does no `$(AppIdentifierPrefix)` substitution —
measured: an entitlements plist signed with the macro and dumped back returns
the literal `$(…)` text; the substitution is Xcode's. So `build/afterPack.cjs`
composes the group from `APPLE_TEAM_ID` at pack time and writes
`build/entitlements.mac.generated.plist`, which both signing routes then use;
at startup the app reads the group back out of its own signature with
`codesign -d --entitlements :-`. The signature is the only authority that
cannot disagree with macOS, so a build that shipped without the entitlement
leaves Touch ID **off** rather than enabling an API that would fail later,
silently, when the first credential is stored. `electron/webauthnGroup.cjs`
holds the pure string work; `tests/webauthn-group.test.mjs` pins both ends of
the round trip.

**The ceiling, stated rather than discovered:** Touch ID only. Not iCloud
Keychain, not Windows Hello, not hybrid/QR phone passkeys, not USB security
keys. Credentials are device-bound and do not sync. A development run has no
passkeys — an unpackaged app is Electron's own bundle — and neither does an
ad-hoc build, whose code identity changes with every install. **The probe above
stays exactly where it is**: on macOS it self-silences (the availability check
returns early), and on Windows and Linux, where there is still no platform
authenticator at all, its notice is still the honest answer.

**One passkey per site is the easy case.** When `credentials.get()` matches
several, Electron stops on the session's `select-webauthn-account` and holds
the page's promise open until a callback answers — and a session with *no*
listener cancels the request outright, so the chooser is not decoration. It
travels on the existing `browser-view:state` channel as `webauthn`, is drawn by
`BrowserPasskeyModal` (a `Modal`, so `role="dialog"` hides the native view the
way §3 requires), and comes back on one narrow channel keyed by request id — a
stale id settles nothing, which is what makes a second click harmless. Every
exit settles the callback exactly once: a choice, a dismissal, a navigation, a
closed tab, or a 120-second timeout. An unanswered chooser is not a stuck
dialog; it is a page that never hears back.

### One microphone, and no reserved emptiness between turns (2026-09-06)

**The panel chats no longer offer the microphone.** Every surface that mounts a
`Composer` builds its own `VoiceEngine`, and there is one microphone — only one
engine can hold it (§6.18 relies on exactly that when it decides which engine
speaks a permission prompt). A mic button on an agent panel was therefore not
only a second copy of a control: it was a second door to a device that was
already answered elsewhere, and pressing it stopped the conversation the
operator was having. `showVoice` is `false` in `AgentPane` and `SideChatPane`,
and it gates the live orb as well as the button — a panel drawing an orb would
be narrating a conversation it is not in.

**A hidden row still reserves its height.** The telemetry line under a settled
reply was in flow at `opacity-0` until hover, so every finished message carried
a strip of empty space that nothing ever drew in; stacked with the block's own
bottom padding, that was most of the gap between one message and the next. It
is absolutely positioned into the padding now, so it costs no layout height and
nothing moves when it fades in — the padding it overlays is the same space it
used to consume, and the block's `gap` came down with it.

### The title bar's two editors, and the line under a reply (2026-09-06)

**`Editor`, with the glyph on the right.** The control read "Video Editor" with
a leading clapperboard, next to `IDE ↗` — a three-word label with a left icon
beside a three-letter one with a right icon, two shapes in a strip that wants
one. It is `Editor` followed by the clapperboard now, built the same way as its
neighbour: the word, then the glyph that says where it goes. IDE's arrow means
another application; the clapperboard means a panel here, and it is the only
thing distinguishing two neighbours that would otherwise both just say
"editor". `PANEL_DEFAULTS.video.label` carries the rename, so the panel tab and
the title bar cannot disagree.

**The telemetry line is one string, not five boxes.** It was five flex children
with `gap-2` between every value *and* every separator, so each middot floated
eight pixels clear on both sides and — in a column this narrow — every field
was its own wrappable box: "Claude / Code", "44,409 / tok", a two-line row
inside an `h-5`. `utils/messageTelemetry.ts#telemetry` assembles the fields and
the row renders them joined, so it truncates as a whole with the full text in
its `title`. A field nobody measured is dropped there rather than rendered
empty, which is what makes doubled and trailing separators impossible — zero is
one of those, since a reply reporting `0 tok` is reporting a number nobody
counted. The copy and retry buttons moved back beside the numbers instead of
being pushed to the far edge by a spacer: a control a whole column away from
the thing it acts on is one the eye has to hunt for. Pinned by
`tests/message-telemetry.test.mjs` (4).

#### The overflow button opens panels, not a search box (2026-09-06, later)

The `⋯` beside IDE opened the command palette. The operator, with it and the
tab strip's `+` circled together: *"that 3 dots menu and the plus icon on the
right pane's tab bar should show the same thing, that dialog does not serve a
search purpose — we already have search on the left main tab bar."* Both true:
the sidebar carries search as a whole view, so this was a second door to it
wearing a glyph that says nothing about search, and the one thing a `⋯` in the
title bar is actually good for is the thing the strip's `+` cannot do while the
panel region is hidden — open a panel.

Both now render `addItems`, the same list built once, so the two entry points
cannot drift into offering different panels. They do **not** share
`isAddMenuOpen`: one flag driving two anchored popovers draws both at once, so
the overflow button keeps its own open state. ⌘K and ⌘P still open the palette,
and so does the chat's own workspace affordance.

### The command palette is a list, not twenty cards (`modals/CommandPaletteModal.tsx`, 2026-09-06)

The operator: *"this dialog has the worst design."* It was, and every fault in
it is a rule in §1 or §2 being broken rather than a matter of taste:

| It did | The rule |
| --- | --- |
| Every row a `lit` hairline box with `shadow-sm` | §1.2 — depth is a flat border, and a row is not a card to enclose |
| A hand-rolled row of filter pills | §2 governance — `SegmentedTabs` exists |
| Hand-rolled badge and shortcut chips | §2 — `Chip` and `Kbd` exist |
| Uppercase mono category headers | §1.5 — a section label is sentence case, body size |
| Four green glyphs per screen | §1.3 — the accent is a role, not a decoration |
| A red `MacCloseButton` floating over the search field | §1.3 — red means destructive |
| Its own fixed-position backdrop | §2 — `Modal` is the primitive, and it is what makes `role="dialog"` true |

That last one was a bug, not only a duplication: the browser panel hides its
view while a `[role="dialog"]` is open (`isOverlayOpen`), and a palette that
was a bare `div` would have been painted over by any browser page behind it.

The rows are 32px, flat, one line. The subtitle sits **beside** the title
rather than under it, and the right-hand column carries only what is genuinely
a column — the age, the shortcut, or the return arrow marking the row Enter
opens. Agent rows used to put `workspace · timestamp` in a chip at the far
right while the workspace was already the subtitle: the same fact twice, the
second copy a hand's width from what it described.

### Right-click (`electron/contextMenu.cjs`, 2026-09-06)

The operator: *"the editor does not have context menus, for copy and other
things."* It read as the editor being unfinished. It was the whole application
missing something: **Electron ships no context menu at all** — not a reduced
one, none — so right-clicking a field does nothing anywhere until the app
builds the menu itself. The editor, the composer, the terminal, the file tree
and every page in the browser panel were all equally without one.

One handler on every `webContents` this app owns, rather than a React menu per
surface, for three reasons in order of weight. **Roles, not handlers:**
`{ role: "copy" }` is the operating system's own copy, respecting the focused
element, the platform shortcut and the clipboard permissions a renderer shim
does not have — a drawn menu would get `paste` wrong outright, because a
renderer cannot read the clipboard unprompted. **The browser panel is not in
our document:** its pages are separate `webContents` layered above it, so
nothing the renderer draws can appear over one. **Spelling comes free:**
Chromium already knows the misspelled word and its suggestions, and
`params.dictionarySuggestions` is unreachable from the renderer.

The menu is built per invocation from `params`, because what is under the
cursor decides it. The suggestions for a misspelling go **first**, above Cut
and Copy: it is the one thing the operator right-clicked *at* rather than near.
Back, Forward and Reload appear only on a browser page — the shell's own window
has one document, so offering them there would be a control that does nothing
(§2). A search from a selection opens in the operator's own browser panel, not
in Safari, and it names the engine the operator chose — the preference lives in
the renderer and is published to main over `browser-view:search-engine`, which
refuses anything that is not an https query prefix.

**Inspect Element belongs to the browser panel and to nothing else.** It used to
be offered on any surface in an unpackaged build (`allowInspect:
!app.isPackaged`), which meant a right-click on a chat message offered to open
the renderer's devtools — a developer's affordance shown to a person using the
app. It is now `allowInspect: true` on browser pages, where the document really
is someone else's and inspecting it is an ordinary browser feature that reaches
nothing of the app's own, and `false` on the shell window, whose devtools are
still one ⌥⌘I away in the View menu.

`contextMenuTemplate` is pure and takes plain `params`, so the shape of the
menu is checkable — `tests/context-menu.test.mjs` (9) and
`tests/browser-search.test.mjs` pin the editing roles,
the suggestions-first ordering, that a read-only pane offers no `paste`, that a
right-click on nothing still offers something true (an empty menu is the bug
this replaced), and that no two separators ever sit together.

`electron/*.cjs` needs a **full application restart**, not a reload.

### Search means search (`search/GlobalSearchView.tsx`, `utils/globalSearch.ts`, 2026-09-06)

The operator: *"now we have to make our real search mega — able to cover all
things that could be searched on the platform."* The box said "Search across
all" and answered only with lines inside text files. A chat they had, a page
they kept, a file by its name, a panel, a skill, a project — all unreachable
from the one field in the app that is *called* search.

**Ten sources, one field.** Panels, skills, projects, workspace files by name,
files and folders elsewhere on the machine, file contents, chats and what was
said inside them, bookmarks, history and downloads — then a last row that takes
the query to the web, because "it is not in here" deserves an answer that does
not require retyping the words somewhere else.

**Only two lanes cost anything.** Eight sources are already in memory: the panel
list and the skills are constants, the chats and the browser's three lists are
stores this app keeps, and the filenames are one tree fetched once on mount.
Matching them is a pass over arrays and needs no debounce, which is what makes
the scope tabs instant — they narrow what is *drawn* rather than searching
again, so their counts are true rather than a promise about a search that has
not run. Content search (the gateway walks the workspace) and the machine lane
(a spawned process) keep their debounce and their abort.

**A group answers for its members.** Typing "skill" found nothing, because no
skill is *called* skill — the word is in none of their names, taglines or
descriptions, and a search that fails the most obvious question asked of it is
one nobody trusts with a harder one. `scoreKind` lets the section name match:
"skill" lists the skills, "panel" the panels, "bookmark" the bookmarks. Only
the small enumerable kinds — "file" would return six arbitrary files out of a
thousand, which is noise wearing the shape of an answer — and it scores below
the weakest text tier, so a file actually named `skill.ts` still wins.

**The ranking is predictable, not fuzzy** (`utils/globalSearch.ts`). Four tiers
— equal, prefix, word start, contains — and a length term small enough that it
can only settle ties, never lift a candidate into the tier above. Subsequence
matching reads as clever until `gls` matches forty things and buries the file
actually called `gls.ts`; a search box is worth typing into twice only if the
first answer is where you expect it. Multi-field candidates score as their
**best** field rather than the sum, so a long path full of coincidences cannot
outrank the thing the operator named. Pinned in `tests/global-search.test.mjs`
(8), including that ranking is stable within a score — two equally good answers
keep the order their sources were asked in rather than swapping as you type.

Administrator-only panels are omitted for everyone else, the same check the tab
strip's add menu makes: a row that always refuses is §2's dead affordance.

#### Files on the machine (`server/machine-search.js`, 2026-09-06)

*"Can it also search files and folders from my Mac or Windows?"* Yes on macOS,
and the reason it is not simply "yes" is the reason it is fast: the workspace
search is a walk, and a home directory is not walkable — hundreds of thousands
of entries, and a search that takes eleven seconds is one nobody uses twice. So
this asks the index that already exists, **Spotlight**, through `mdfind`.
Windows and Linux have no index that can be assumed present (`dir /s` and
`find` are the walk this exists to avoid; Everything and `locate` are
installations, not guarantees), so they are told so in one line under the
results rather than given something slow that looks broken.

Four bounds, each one a rule:

- **No shell string.** `mdfind` is spawned with an argument array, so a query
  containing a quote or a semicolon is a query. A query that starts with `-`
  is refused before the spawn, because no quoting stops a leading dash being
  read as a flag.
- **`-onlyin $HOME`.** "My files" is what was asked for, and it keeps `/System`
  and every mounted volume out of the answer.
- **Killed at 2.5s, capped at 40 rows.** A `stat` per row is the cost of saying
  file-or-folder, and forty is already more than a person reads.
- **It reads nothing.** The result is a path, a name and a flag. Opening one
  goes through the same boundary a dropped file does — the project moves to the
  folder holding it and the file is opened from inside the new root — because
  nothing outside the workspace root is read across it. Same policy, same code
  (`services/workspaceDrop.ts`).

`tests/machine-search.test.mjs` (7) drives the whole path with an injected
spawn: that a hostile query stays one argument, that a hung process is killed
rather than left running, that a missing `mdfind` is "nothing found" rather than
a thrown error, and that a file deleted since the index was written is dropped
instead of shown.

### Every row in the sidebar does something (`sidebar/StudioSidebar.tsx`, `sidebar/FileTree.tsx`, 2026-09-06)

The operator, with the whole repository list circled: *"I do not know if these
on the sidebar are chats or what, but all I know when I click on them nothing
happens. Also clicking on the files has to open them on the right file pane."*
Four separate dead clicks, one cause each.

**A repository row had no `onClick`.** It could not have had one: `repositories`
was reduced to a list of *names*, so the row had no path to open. It carries the
`ProjectEntry` now, from the same `useProjectLibrary` the composer's recents row
and My Projects read, and opens the project the way `ProjectsPanel` does —
video projects bring the editor up first, because the load reports through the
video pane's own toasts. A group with no project behind it (chats stamped with a
repository that is no longer in the list) stays a heading and is not pressable,
which is the honest shape rather than a fifth dead row.

**The Filter and Open-a-project buttons had no handlers.** Filter is real now;
it matches a repository on its own name *or* on any chat filed under it, because
filtering a tree by the branch alone hides the thing being looked for. The
second is a **New chat** button, which is what the panel actually lacked.

**A chat row moved the highlight and left the transcript alone.**
`switchSession` loaded the incoming session's messages only when it had some, so
opening an empty chat kept the previous conversation on screen; and nothing
wrote the outgoing one back, so leaving a chat discarded it. Both rules are
`utils/chatSessions.ts#applySessionSwitch` now — pure, shared by `switchSession`
and both history arrows so they cannot drift, and pinned by
`tests/chat-sessions.test.mjs` (3). An empty session is a real answer: it is a
conversation nobody has started.

**And the three chats were invented.** "Project analysis & Landing page",
"Coffee shop website build", "General architecture & UI exploration" — titles of
work nobody in this app had done, each with an empty `messages` array. The same
fiction the fourteen seeded editor tabs were, and worse than decorative: they
taught the operator that the panel's rows do nothing. The seed is one real
"New chat" now and `newChatSession` is how the list grows, stamping each new
conversation with the current root's folder name so it lands under its
repository rather than under "No Repo".

**A clicked file is the same file the agent opens.** `FileTree` called
`openFile`, which adds an editor tab and nothing else — so clicking a file while
the video editor or the browser held the right-hand side put it in a panel that
was not on screen. It calls `showFile` now, the same route `mcp__teminali-workspace__open_file`
takes: the panel first and unconditionally, then the tab.

### A project row you can act on, and the one control that touches the disk (`sidebar/StudioSidebar.tsx`, `electron/projectTrash.cjs`, `electron/main.cjs`, 2026-09-10)

Two asks, one of which turned out to be a missing capability rather than a
missing control. The operator: *"we need at least 4px margin between the items
on the sidebar of projects, also we need an action menu to show up when user
hover on the project tab. and do not just design that action menu — wire it
completely, for example our platform does not have an option to delete project
is there?"*

**The rows were flush.** `space-y-1` on the group: 4px between a project and its
chats, and between one chat and the next. A dense list with no rhythm reads as a
block of text rather than as items, which is most of why the panel looked
inert even after every row in it became pressable.

**The menu sits over the row, not inside it.** `SidebarRow` is a `<button>`, and
a button inside a button is not something a browser will render — so the ⋯ is an
absolutely positioned sibling, revealed on `group-hover` and on
`group-focus-within` so the keyboard reaches it too. It stays visible while its
own menu is open, or dismissing the menu by clicking the button it belongs to
would fight itself. Only a row with a real `ProjectEntry` gets one: a heading
over chats whose repository is gone has nothing to open, reveal or throw away,
which is the same honest shape the section above chose for pressability.

Five items, all wired, because the panel was rebuilt once around the rule that
every row does something and a menu is where that promise is easiest to break:
Open, Reveal in Finder, Copy path, Remove from Teminali, Move to Trash. The two
that need the desktop shell are **disabled rather than hidden** in a browser
build, so the menu has one shape everywhere and an unavailable thing says so
instead of leaving the operator to infer it from an absence.

**There was no delete in this product at all.** `workspaceService.forgetProject`
had existed the whole time with nothing in the interface calling it — tidying
the list was possible and unreachable — and nothing anywhere could remove a
project from the disk. Both exist now, and deliberately as **two verbs**:
"Remove from Teminali" forgets it and does not touch the disk; "Move to Trash"
is the only control in Teminali OS that takes something off it.

Everything about that second verb is arranged around being the only one:

1. **It trashes, it does not delete.** macOS keeps a Put Back, and that is the
   whole distance between a bad click and a lost afternoon.
2. **The confirmation is raised in the main process, not the renderer.** *A
   dialog the renderer draws is a dialog a later refactor can decide not to
   draw.* This one sits on the path to `shell.trashItem` and cannot be gone
   round — the renderer cannot trash anything without the operator having
   answered a real dialog.
3. **What may go is a rule, not a branch.** `electron/projectTrash.cjs` is pure
   and returns the sentence to show or null, the same shape as
   `subtitleFileToLoad` and for the same reason: the IPC handler around it needs
   a live Electron and a real Trash, so a test on this machine can reach the
   judgement and nothing else. It refuses *upward* — a project may live
   anywhere, so what is checked is the other end: nothing at or above the home
   folder, not the disk root, and nothing relative, because a relative path
   resolved against whatever directory main happens to be standing in is how a
   delete lands somewhere nobody chose. `/Users/teminali-backup` is not the home
   folder, which is precisely the case a `startsWith` without a separator gets
   wrong.
4. **Trashing then forgets.** A list still offering to open a folder that is in
   the Trash is a list that lies, and the next click reports a path that is no
   longer there.

`tests/sidebar-actions.test.mjs` (7) pins the *arrangement* rather than the
behaviour, since neither React nor the Trash can be exercised here: that main
consults the rule before `shell.trashItem` and not after, that the renderer
raises no confirmation of its own and imports no filesystem module, that
trashing forgets, and that no item has an empty `onSelect`.
`tests/project-trash.test.mjs` (10) is the rule itself. The source-level test is
the one that will still be true in a year — the property it guards is exactly
the kind a harmless-looking refactor inverts.

### Showing a file is its own action (`store/studioStore.ts` — `showFile`)

`reveal` scrolls the tree and `openFile` records which file is current. Neither
is what a person means by "show me this file", and until `open_file` existed
nothing an agent could call put one in front of the operator — which is the rest
of the answer to the pointer-driving above: *"it was supposed to open files
explorer and select a file and show it on the right panel files panel."*

`showFile(path)` is those three things in one place, and the order matters. It
reveals, so the tree opens to the row; it opens the **file panel** on that path,
because the panel is the surface that actually renders a file — it reads the
path itself and it is the only one that can show an image or a PDF; and it then
reads the file into a tab, which is what makes the tree row read as selected.
The panel is opened *unconditionally* and the read is allowed to fail: when it
does, the panel is already showing and has somewhere to put the reason, whereas
a tab opened with no content would claim the file is empty. It takes the same
route a click takes, under the same limits, so an agent-opened file and a
clicked one are the same file. A click in the tree still keeps its own path
through `FileTree`, which owns a spinner and an error line this cannot reach.

### A dropped file is a project decision (`services/workspaceDrop.ts`)

The file pane takes a drop from two sources, and it tells them apart rather than
guessing. An Explorer row sets a private type — `application/x-teminali-path` —
carrying a path that is *already* workspace-relative, so an internal drop needs
neither the Electron bridge nor a comparison against the root. `text/plain` rides
along for anything outside this app that can only take a string, and is never
what the pane reads: a filename dragged out of a text editor would otherwise be
mistaken for one of our own rows. Folders are not draggable in the tree at all,
because the pane has nothing to do with one.

A Finder drop carries only `Files`, and `File.path` was removed in Electron 44,
so the absolute path comes from `webUtils.getPathForFile` through the preload
bridge the media panel already owns. In a browser dev build there is no bridge,
and the external half says it needs the desktop app instead of throwing.

Then the boundary rule, which is the whole point of the module. **A file outside
the current root is never read across the workspace guard.** `server/workspace.js`
refuses `..`, absolute paths and symlinks, and nothing here goes around it: a
drop from outside becomes an *offer* to switch the project to the folder holding
the file — the same `openProject` road a My Projects click takes — and the file
is opened only afterwards, from inside the new root. A dropped folder is offered
directly, because a folder is a project and never something the pane could show.
A drop that mixes inside and outside opens what the project already contains and
counts the rest, since switching would close the very tree the inside file came
from.

`services/dropGuard.ts` is the other half, and it is armed in `main.tsx` before
the first render. Chromium's default for a file dropped on a page that did not
claim it is to **navigate to that file** — in Electron that replaces the entire
application and reads as a crash to a blank page. The guard refuses every
unclaimed drag on the window, visibly (`dropEffect = "none"`, so the cursor says
so while the file is still in the air). It knows to stay out of the way by the
platform's own signal: a real drop zone accepts a `dragover` by calling
`preventDefault`, and the guard runs last, so `defaultPrevented` already
distinguishes the composer, the media panel, the timeline and the file pane from
the chrome around them. Overriding `dropEffect` on a claimed drag would stop
Chromium delivering their `drop` event at all.

### A spreadsheet is drawn, not decoded (`services/sheetPreview.ts`, `panels/SheetPreview.tsx`)

An `.xlsx` arrives as base64 like a PDF does, and becomes a grid. ExcelJS parses
it — chosen over SheetJS because the npm `xlsx` package is frozen at 0.18.5,
the release covered by CVE-2023-30533, and the vendor's current builds ship only
from their own CDN; a registry dependency with an ordinary supply chain was the
operator's call. It is imported **dynamically** and by nothing else: it is close
to a megabyte, the bundle already trips Vite's 500 kB warning, and a reader who
never opens a spreadsheet must not pay for one. `tests/sheet-preview.test.mjs`
pins the dynamic import.

What lives outside the parser is what would otherwise be untestable in a
component. A formula cell shows its *result*, because a grid of `=SUM(B2:B9)` is
not a view of the data; an error cell shows `#DIV/0!` rather than looking empty;
rich text, hyperlinks and dates each have one reading, and an unknown shape is
blank rather than `[object Object]`. The grid is bounded at **200 × 50** — the
same 8 MB file can hold a hundred thousand rows, and drawing that hangs the
window — and what is cut is stated on the tab strip, since a viewer that quietly
shows two thirds of the data is worse than one that refuses.

Legacy `.xls` is BIFF, a different format ExcelJS does not read, and the pane
names the conversion that fixes it rather than saying "unsupported". The server
predicate is untouched on purpose: an `.xls` that is really an HTML table is
sniffed as text by `server/workspace.js` and opens in the editor, and narrowing
`BINARY_PREVIEW_EXTENSIONS` would have refused it before the sniff ran.

### Video and audio are streamed, not read (`server/workspace-media.js`, `electron/workspaceMedia.cjs`, `services/workspaceMedia.ts`)

A film cannot travel `/api/workspace/file`: that reader returns one JSON
document under an 8 MB cap, and a `<video>` seeks by asking for byte ranges.
Nor can it travel any gateway URL — every workspace route sits behind the
bearer gate, a media element cannot carry a bearer header, and the one way
round that is the session token in a query string, which is the token in every
log. So the desktop app registers its own scheme, **`teminali-media://`**, and
main answers it from disk.

The answer is decided in `server/workspace-media.js`, a pure function of
(root, path, request) so it is node-tested: the **same** `resolveWorkspacePath`
guard and the same lstat refusal of symlinks and folders as the JSON reader,
then HTTP Range by hand — 206 with `Content-Range` for a satisfiable range,
416 for a start past the end, 200 for no range, `Accept-Ranges: bytes` on all
of them. Chromium opens with `bytes=0-` and learns from the 206 that it can
seek; a 200 plays but the scrubber is dead. There is no size cap: the cap is
the JSON reader's. An escape, a missing file, a folder and a symlink all answer
404, because the scheme is reachable from any page the window frames and
"that exists but you may not" is worth withholding.

The scheme is privileged before `app.ready` with `stream: true` and
**`supportFetchAPI: false`**: nothing can `fetch()` it, our own code included;
only media elements load it, which is all the pane needs. The URL's host is a
**nonce minted per launch** and handed only to the preload bridge, which only
the main frame has — the window runs with `webSecurity: false` and the browser
pane frames arbitrary sites, so a scheme any page could spell would be a scheme
any page could read. Main also checks that a root announcement comes from the
main window and names an existing directory.

Two roots, one honest answer each. A packaged app runs the gateway in main's
own process and reads `gateway.config.workspaceRoot` live — no IPC and no
second copy. `npm start` runs the gateway as a sibling process main cannot see,
so the renderer, which learns the root from `/api/workspace/projects`, repeats
it over `workspace-media:root` (`syncWorkspaceMediaRoot`, armed in `main.tsx`);
the gateway's root wins whenever there is one. The renderer never sees a root
in a URL: it asks `window.teminali.workspaceMedia.url(encodedPath)` and points
an element at the result, or — in a browser build, where the bridge is absent —
says playback needs the desktop app, the same shape as the drop bridge.

**Only a root the gateway has named is repeated, and the element waits for it.**
The store opens on a hardcoded `workspacePath`; the gateway, meanwhile,
remembers the last project across restarts, so at boot the tree is one
project's and the shell's idea of the root is another's. Panels are persisted
and media panes are restored, so the first thing a cold start did was ask for a
file under a root the operator had not opened — a 404 no element retries, and
under a root that happened to hold a file of that name, the wrong file played.
Three things close it: `App.tsx` adopts `projects.current.path` at mount, which
is the only place the shell learns which project the gateway is actually bound
to; `setWorkspacePath` raises `workspaceRootConfirmed`, and
`syncWorkspaceMediaRoot` announces nothing until it is raised, so main answers
`WORKSPACE_ROOT_UNKNOWN` rather than serving from a guess; and `FilePane` keeps
a media pane loading while the root is unconfirmed instead of pointing an
element at a root that is about to change. `announceRoot` is `sendSync`: a
media request travels Chromium's loader, not the IPC pipe, so an asynchronous
`send` is not ordered against the element that follows it.

**Admitting the formats is the gate.** `MEDIA_EXTENSIONS` in
`server/workspace.js` (`.mp4 .webm .m4v .mov .mp3 .m4a .wav .ogg .flac`) joins
`isViewableWorkspaceFile`, so the tree lists them and the agent's `open_file`
opens them; the JSON reader refuses them with `WORKSPACE_FILE_STREAMED`,
before the size cap, so a two-gigabyte file is not reported as "too large".
`tests/workspace-media.test.mjs` pins the renderer's table to that set — a
format admitted by one side and not the other is a tab that opens onto
nothing.

It **was** Chromium's player and nothing more — H.264 and VP9 video; AAC, MP3,
Opus, FLAC and WAV audio — with a `.mov` holding ProRes answered by a sentence
naming the codec. That paragraph is now history: `MEDIA_EXTENSIONS` covers
every container ffmpeg reads, the protocol has a second answer that transcodes
live, and the pane draws its own controls with subtitle tracks in them. See
"Every format ffmpeg reads" and "A folder of videos is a series" below. What
still holds is everything above this line: one path guard, byte ranges by hand,
the nonce, and no second reader for a file the JSON route already serves.

### A folder is a gallery, and a folder of videos is a series (`panels/GalleryPane.tsx`, `panels/MediaPlayer.tsx`, `services/workspaceGallery.ts`, 2026-09-06)

*"if i have selected folder with multiple video open it as if i'm looking at
netflix tv series episodes gallery"* — and then, once it existed for films:
*"implement the gallery view not just for videos but for all files, this will
make it uniform since we use the same file pane for all of them."*

**Every folder opens the same way, because the gesture is the same one.** The
operator clicked a folder and expects to see what is in it. What differs is how
a card is drawn and what opening one does, and that is a single classification
— `entryKind`, eight values named after *the viewers this app has* rather than
after mime types — not a second panel for pictures and a third for films. A
video shows a frame of itself, an image shows itself, everything else wears the
same glyph the file tree gives it, so the two surfaces never disagree about
what a `.tsx` looks like. A click opens the thing: a folder navigates the
panel, a video in a series plays in it, anything else goes to the File panel,
which is the surface that renders a file. A card with no viewer behind it is
dimmed and says so, which is the rule this grid shares with every other surface
here.

**One panel that navigates, not one per folder.** Panel identity for this kind
is the kind alone (`store/panelStore.ts`), so clicking through six folders
leaves one tab rather than six, and `focusOrOpen` moves it. A breadcrumb is the
way back up, and an empty path is the project root — a real destination, drawn
from `studioStore.files` directly rather than refused.

**Two or more videos directly inside a folder additionally make it a series.**
Not a heuristic about names, not a marker file: a count,
`SERIES_MIN_EPISODES`, spelled in `services/workspaceGallery.ts` for the
renderer and in `server/workspace.js` for the gateway, with a test asserting the
two are equal. They have to agree because both sides answer the same gesture —
a click in the tree, and the agent's `open_file` — and a folder one side calls
a series and the other calls a folder is a tool describing something the
operator is not looking at. The series is a *layer*: the same grid and the same
cards, plus the resume header and numbers on the video cards. Subfolders are
not descended: a season folder is its own series, and a project folder with two
renders three levels down is not one.

**The gallery is a pure function of the tree.** `studioStore.files` already
holds what the sidebar drew, so `galleryOf` reads the folder out of it and
nothing is fetched. The gallery therefore cannot disagree with the Explorer,
and the whole of `workspaceGallery.ts` — classification, ordering, titles,
episode numbers, sidecar matching, the resume rule, the SubRip conversion — is
pure and pinned by `tests/workspace-gallery.test.mjs` (26). Ordering is
numeric-aware, because the sort every other implementation of this gets wrong
puts episode 10 before episode 2.

**A preview is the real thing, or a glyph.** A folder of films has no artwork.
Rather than draw a placeholder that pretends to be one, a video card mounts a
`<video preload="metadata">` seeked a few seconds in and lets Chromium paint
what it lands on; a container it cannot demux paints nothing and the card falls
back to its episode number. An image card reads its own bytes through the
reader every other picture in this app comes through, under
`THUMBNAIL_MAX_BYTES` — a gallery of forty photographs should not read forty
files before it can draw, and past the cap the card keeps the glyph it would
have had anyway. Only the first twelve load eagerly; the rest wait for an
`IntersectionObserver`.

**Where the operator got to is the state that matters** — for the series half.
`store/playerStore.ts`
keeps `positions` keyed by path, written every five seconds while playing and
on unmount, pruned to the 200 most recent. It drives three things at once: the
bar under a started card, the tick on a finished one (`WATCHED_RATIO`, 0.9),
and the single button in the header — the episode left in the middle, else the
one after the last finished, else the first. Resuming something all but over
would drop the operator on the credits, so that one starts again.

**The player is ours because Chromium's is a closed shadow tree.** `controls`
gave seeking, volume and fullscreen for free, and cost four things this pane
owes: subtitles from a sidecar file, an embedded stream, or a file the operator
hands it; a timeline that survives a live ffmpeg transcode; an agent that can
press play; and chrome that gets out of the way of the picture. None can be
done to a shadow root from outside. `runCommand` is one implementation of every
control — the buttons, the keyboard and `player_control` all call it, so
"pause" cannot mean three things.

**The chrome is over the picture, and it leaves.** The first cut put a fixed
grey strip under a letterboxed video, and the operator's verdict was the right
one: *"the player design is not top tier… i need it 4x better, more cinematic
and clean controls."* The video now fills the pane and the controls float on
it, drawn from the `--player-*` tokens §0 describes. **And it had never once
left** until 2026-09-10: `time` was in the idle effect's dependency list, so
every `timeupdate` — four a second — tore down the pending countdown and
started a new one, and a 2.6s timer restarted every 250ms never expires. The
bar hid only when playback *stopped*, which is the one moment it should stay.
It restarts on `awake` now, bumped by pointer activity and throttled to one
bump per 200ms, because what the countdown is waiting for is the operator
going still, not the playhead moving. `tests/workspace-gallery.test.mjs` reads
that dependency list as text: nothing else can catch it, since the broken
version typechecks, renders, and passes every other test. The two scrims are §1's
one sanctioned gradient: a flat plate dark enough to carry white text over a
snowfield is also dark enough to cut a visible band out of the film, and this
is the only surface in the app whose background is an arbitrary image. While a
video plays and the pointer is still, the bar, the title and the cursor all go;
movement, a menu or a pause brings them back. Audio keeps its chrome always:
there is nothing to get out of the way of.

**Four corners and a rail** (2026-09-10), after a reference design the operator
handed us. Top-left is the film's name, set large and light. Top-right is the
close button and, while it is true, the live-transcode badge — and nothing
else. It carried a resolution pill for a day: the reference stacks *selectable*
renditions there (2160p/1440p/1080p) and we cannot have one, because nothing
here streams, so it became a label reading the file's real height off ffprobe.
The operator's verdict was right and is the general rule — *"we do not need the
video quality tag"* — a label that never changes and answers no question a
viewer is asking is just one more thing on top of the film. Bottom-left is transport, bare
glyphs with no plate behind them, which is why that corner reads as three marks
on the picture rather than three widgets: back ten, play, forward ten, then the
clock. The reference's ⏮/⏭ are the two **seeks**, not the two episodes — a seek
is wanted on every file and an episode only on some. Bottom-right, behind a
divider, are the settings chosen once and then left: volume, subtitles, speed,
fullscreen. The rail runs the full width beneath both, unbroken by numbers.

**The clock is scaled to the film, not to the longest film there could be.**
`00:02:35 / 00:16:08` is nineteen characters, ten of them a zero standing in
for an hour a sixteen-minute file does not have — and in a narrow pane the
slashes were break opportunities, so it stacked onto three lines and shoved
the transport sideways. `formatClock` prints `2:35 / 16:08` under an hour and
`1:02:35` over it, unpadded at the lead, `whitespace-nowrap`. Screen readers
still get full `hh:mm:ss` through `aria-valuetext`, where an unambiguous unit
beats a short one. When a pane is narrower still, the transport and its clock
hold their size and the **Subtitles pill truncates** — it is the only control
in the bar whose width is text rather than a glyph, so it is the only one that
can give up room without giving up a target.

**A series gets a drawer on the left edge**, with a vertical tab where the
reference puts X-Ray, and its own prev/next in the header. It replaced a pill
at the bottom centre that opened a modal over the middle of the frame — over
the very thing you were choosing between — and the two floating chevrons that
used to sit over the picture are gone with it. Where the reference shows a
face, an episode row shows its number in the same circle: a folder of episodes
has no faces, and the number is what identifies one.

The scrubber is a **real `<input type="range">` kept transparent over a track
this pane draws**. A div with a drag handler would have looked the same and
been unreachable by keyboard and by a screen reader; a bare range input cannot
show a buffered span, a hover time or a track that thickens under the pointer.
Layering keeps both. The same pattern gives the volume slider, which opens on
hover rather than holding its width in the bar for a control most operators set
once.

**The window's bottom-right corner belongs to shared chrome.** `VersionControl`
is `fixed bottom-2 right-3` at z-40, above anything a panel draws — the video
editor's timeline has reserved that strip since it shipped, and the player,
being the second pane to draw content that far down, put the version pill
straight on top of its fullscreen button. It reserved it *horizontally* at
first, indenting the right end of the controls row. The full-bleed rail ended
that: the lowest thing in the corner is now the rail, and no right-indent short
of shortening the rail would clear it. So `VERSION_BADGE_LIFT` raises the whole
bar off the bottom edge instead — 8px of `bottom-2` plus the badge's 22px plus
4px of air — which clears the badge for the rail and the controls row alike and
costs the rail nothing. Only when windowed: a fullscreen element is rendered
alone, so nothing of the app's is over it. A test pins the reservation against
the badge's own position, because the two are one measurement in two files.

**The timeline is virtual, and that is not an optimisation.** In `direct` mode
the element holds the file and seeks by byte range. In a transcode ffmpeg is
writing fragmented MP4 into the response: `duration` is `Infinity` and
`currentTime` is how long *this stream* has been running, not where in the film
we are. So the pane keeps `offset` — the second the current stream started at —
every position it shows or publishes is `offset + currentTime`, and a seek
rebuilds the element at a new offset rather than moving a playhead that means
something else. The duration comes from ffprobe, which read the container's own
header.

**Subtitles come from three places and are labelled by which.** A sidecar is
matched on the video's base name, optionally followed by a language
(`Episode 1.en.srt`), whose tag becomes a language name through
`Intl.DisplayNames`; `Episode 10.srt` must not attach to `Episode 1.mp4`, which
is the test that matters. SubRip becomes WebVTT in the renderer — the header,
the decimal comma, `<font>` tags, `{\an8}` positions and the `X1:` coordinate
suffix some rippers write, all of which a VTT parser would otherwise show as
literal text. Streams inside the file are written out by ffmpeg on demand.
Bitmap subtitles (PGS, DVD) are pictures and are not offered. The chosen label
is remembered in the store, so the next episode comes up in the same language.

The third place is the one VLC has and this lacked, and the operator said so:
*"i was not able to add subtitle file on the video like on vlc."* A `.srt` or
`.vtt` **dropped on the picture**, or picked from **Add subtitle file…** in the
menu, becomes a track immediately. It never touches the gateway: the OS hands
the renderer the file's *bytes* with the gesture, so there is no path to
resolve, no workspace boundary to argue about, and a subtitle sitting on the
Desktop works exactly as one inside the project does. The drop handler stops
propagation ahead of both the window guard and `FilePane`'s own drop target —
a file dropped on a playing video means subtitles, not "open this instead".
`isSubtitleFileName` admits only the two formats `subtitleToVtt` can genuinely
convert, and `subtitleFileRefusal` names the rest: an `.ass` accepted and then
shown as an empty track would leave the operator debugging their file.

`.srt` and `.vtt` joined `TEXT_EXTENSIONS`, so a subtitle file is also
editable, and appears in the gallery as the document it is — which is the point of a sidecar, and the reason the file version
wins over an embedded stream of the same name.

### Every format ffmpeg reads (`server/media-probe.js`, `electron/workspaceMedia.cjs`, 2026-09-06)

*"can we have our player support mkv and all other video formats?"*

The old answer for a `.mkv` was that the tree did not list it, and for a ProRes
`.mov` a sentence naming the codec and an ffmpeg line to run by hand. Both were
honest and both were the wrong answer to "play this file".

**ffprobe decides, before an element is pointed anywhere.**
`POST /api/workspace/media/probe` returns what the file holds and a `plan`:
`direct` (Chromium plays it as it is), `remux` (the streams are fine, the
container is not — rewrap into fragmented MP4), `transcode` (re-encode
whichever stream Chromium cannot decode) or `unplayable` (no ffmpeg, and here
is `brew install ffmpeg`). Getting this wrong in the cheap direction — always
transcoding — would put an encoder in front of every MP4 in the workspace, so
the native lists are explicit. 10-bit H.264 is the trap worth naming: its codec
is on the native list and Chromium cannot decode it, so the pixel format is
part of the decision.

**The transcode is a second answer on the same protocol.** `?transcode=1` on a
`teminali-media://` URL spawns ffmpeg and hands its stdout back as the response
body — a 200 with no `Content-Length` and `Accept-Ranges: none`, because there
is no file. `-ss` goes *before* `-i` so a seek is a demuxer seek rather than a
decode of everything preceding it, and `frag_keyframe+empty_moov+default_base_moof`
is what lets the element start before the stream ends; a plain MP4 writes its
index last and cannot be streamed. Subtitle and data streams are dropped (`-sn
-dn`): subtitles reach the player as text tracks, never burned into the
picture.

**Every child is owned.** The element hanging up — a seek, a closed pane, the
next episode — kills the encoder through the request's `signal`, and
`will-quit` kills whatever is left. A two-hour film would otherwise keep
encoding for an operator who has moved on.

`findBinary` looks in the `PATH` **and** in both Homebrew prefixes, because a
Finder-launched app inherits launchd's `PATH`, which has neither — the same
landmine `ELECTRON_RUN_AS_NODE` sets elsewhere in this document.

`tests/media-probe.test.mjs` (14) pins the plans and the argument lists.

### A second engine, spoken to rather than linked (`electron/mpvProcess.cjs`, 2026-09-10)

The section above is the transcode path's design, and it is also its own
indictment. A `<video>` element plays what Chromium was built to decode; for
everything else the app re-encodes on the way past, which is why
`MediaPlayer.tsx:51-63` has a mode whose `duration` is `Infinity` and whose
timeline is `offset + element.currentTime` rather than a position — and why on
a machine with no ffmpeg an MKV does not play at all.

mpv plays it. **This file is the transport to mpv and nothing else:** find the
binary, spawn it idle with a JSON IPC socket, speak that protocol. It draws
nothing, embeds nothing, and owns no window.

**Nothing spawns it yet, and no build ships mpv.** This is the plan's B1, the
IPC layer, landed on its own on purpose: the transport is byte-identical
whether the engine is a spawned binary or a linked `libmpv`, so it could be
written and tested before B0 chose between them. B0 has since chosen — LGPL,
built here; see "The licence is LGPL" below. `findMpv` looks in a bundled
`<Resources>/mpv/` before the install directories so shipping a copy later is a
file drop, but nothing puts a file there today — on a clean machine it returns
null, exactly as `findFfmpeg` does.

- **No `node-mpv`.** Last published six years ago, and being IPC-only there is
  nothing in it that is not in this file. Owning ~300 lines beats depending on
  an unmaintained wrapper for the same 300.
- **`mpvCommand` is a table, and it is the third place `PLAYER_ACTIONS`
  appears.** `tests/mpv-ipc.test.mjs` asserts every action in the contract is
  answered here, so an action cannot be added to
  `services/playerControl.ts` + `server/player-state.js` and silently do
  nothing under mpv. It returns an **array** of mpv commands — `restart` is a
  seek *and* an unpause — and `null` when the question is not mpv's.
- **`next`, `previous`, `episode` and `episodes` return null on purpose.** mpv
  has a playlist; it is not the pane's episode list, which is a scanned folder
  with titles and watched fractions. Mapping one onto the other would make
  `episode 3` mean different files depending on what had been loaded. Series
  navigation stays with the pane, which then loads a file into mpv.
- **Every seek carries `exact`, and that is a measured decision.** mpv's
  default is a keyframe seek. Driven against a real mpv 0.41 and an x265 clip
  with a 10-second GOP, `seek_by -3` from 8s landed at **0** and `+5` from
  there at **10**; with `relative+exact` the same two commands land at 5 and
  10. The contract is in seconds and the pane's `<video>` seeks exactly, so a
  decode from the preceding keyframe is the right thing to spend — and B2's
  whole point is an assistant finding a described moment and going to it.
- **A subtitle label that matches no track is a refusal, not the first track.**
  Resolution is exact-then-substring, the same two steps `MediaPlayer.tsx`
  does, so the assistant does not learn one rule per engine.
- **Volume 0 sets `mute` too**, because the pane does, and `muted` is a field of
  the snapshot the agent reads back. Two engines disagreeing about what volume
  0 means would make the same question have two answers.
- **The socket's whereabouts are published the way the video bridge's are** —
  a `teminali-os-mpv-bridge.json` in the temp directory, read back through
  `runningMpv`, whose pid check is what makes a file left by a crash
  survivable. A socket file outlives its process; connecting to a dead one
  hangs rather than fails.
- **Framing is tested, because getting it wrong hangs rather than throws.** A
  chunk that splits an object mid-way keeps its remainder; a line that is not
  JSON is dropped rather than allowed to poison the stream behind it; every
  request outstanding when the socket closes is failed. A promise that never
  settles is how a dead player becomes a frozen turn.
- **No `--vo` is chosen here.** Under B1 mpv opens its own window, which is what
  makes the transport drivable before an embedding exists. B3 is where video
  output changes, and it changes in this file.

`tests/mpv-ipc.test.mjs` (38) covers the mapping, the track list, the
discovery order, the framing and the endpoint file, and drives `MpvIpc` against a socket that
answers the way mpv's does — so request correlation, mpv's error string and
property events are exercised on a real socket rather than asserted about.

It has also been driven **against a real mpv 0.41** by hand, on an HEVC/AC-3
Matroska with an embedded SubRip track — the file the `<video>` path has to
transcode — and every step of the contract held: a 20.006s duration, the codecs
reported as `hevc`/`ac3`, the track list, exact seeks, the clamp on `rate`,
`mute` following volume 0, `sid` off and on, mpv's own error string on the
error path, a PNG out of `screenshot-to-file` (which is what `player_frame`
will need), 24 property changes across all nine observed fields, and the
endpoint file appearing and being removed with the process. That run is what
found the keyframe seek. It is a hand check and not in the suite: it needs an
mpv installed, and CI has none.

B2's four additions were driven against the same real mpv 0.41 on 2026-09-10,
on a synthesised 25fps Matroska with three chapters and two titled audio
tracks — the properties a film has and a test fixture usually does not. All
thirteen checks held: `frame-step` moved frame 75 to 76 and `frame-back-step`
returned it to 75 without unpausing, contract `chapter 2` arrived at mpv
chapter 1 at exactly 2.000s and `chapter 1` at 0, `aid` selected by number, by
exact label and by substring, a label matching nothing refused rather than
falling back, and `seek_by -3` from 5s landed on 2.000. Until that run the four
were a table asserted against itself.

### The licence is LGPL, and that is what makes B3 possible (B0, 2026-09-10)

mpv is GPL by default and can be built LGPLv2.1 (`-Dgpl=false`) against an
LGPL FFmpeg. Teminali OS ships **the LGPL build, made here**, for mpv and for
ffmpeg alike. The decision is B0 of the plan, and it was blocking B3.

**The argument is not really about licence text; it is about macOS.** `--wid`
takes an `NSView` pointer and a pointer is process-local, and
`addChildWindow` joins two windows of the *same* process — so on macOS no
application can embed another process's window without private API. Every
mpv-based Mac player, IINA included, links `libmpv` in-process for exactly
this reason. B3 on macOS therefore ends in a link, whatever it starts as; and
linking a *GPL* `libmpv` would make Teminali OS — sold, and closed — GPL. GPL
is only viable for a product that promises never to embed properly on the Mac,
which is the opposite of what B3 is for.

LGPL is thus the one choice that never has to be made twice:

- **B1's transport does not change.** The binary is spawned and spoken to over
  JSON IPC exactly as `mpvProcess.cjs` already does. Windows and Linux get
  `--wid` against that spawned process, which is what the plan wanted first
  anyway to prove the transport.
- **macOS links the same LGPL `libmpv` later** through the render API, with no
  second licensing decision and no change above `MpvProcess`.
- **Dynamic linking is what LGPL §6 asks for**, and a replaceable `.dylib`/
  `.dll` beside the app satisfies the relink right without shipping our source.

**Playback loses nothing.** The decoders are LGPL FFmpeg's, `libass` is ISC,
and the plan's acceptance case — HEVC video, DTS audio, embedded ASS — is
unaffected. What an LGPL build drops is GPL-only optional code the player does
not use.

**Encoding is where it cost, and the bill was paid on 2026-09-11.** `libx264`
and `libx265` are GPL-only, and they were the software fallback in five places.
Against an LGPL ffmpeg those names are `Unknown encoder`.

The fix was not to write `libopenh264` in five places instead — that is the
same mistake facing the other way, since a developer's Homebrew ffmpeg does not
have it. **No call site names an encoder.** Each states what it wants — a
quality, a speed, whether latency matters — and `electron/hardwareEncoder.cjs`
(pure, the only table) decides against what `electron/encoderProbe.cjs` found
in the binary that will run: hardware if the caller allows it, then `libx264`,
then `libopenh264`; `libx265` then `libkvazaar` for HEVC.

Two things that were not obvious until it was done. **The encoder name is not
the hard part — the flags are:** `-preset`, `-crf` and `-tune` are x264/x265
private options, openh264 has no constant-quality mode at all, and ffmpeg fails
a run on an unrecognised private option rather than ignoring it, so quality is
translated per encoder family and a CRF becomes a bitrate scaled by frame
height. And **deciding by capability dissolves the ordering rule** this
paragraph used to end with: bundling and swapping no longer have to happen in
the same turn, because each half is correct on its own.

Hardware still covers most of it — VideoToolbox on macOS, NVENC/QSV/AMF on
Windows — and Linux still has no entry in that table, so a Linux machine
without a hardware encoder now gets openh264 rather than nothing. An HEVC
request nothing can satisfy degrades to H.264 and drops the `hvc1` tag with it.

The build flags, what each excludes, and what has to ship beside the binaries
are in `docs/MEDIA_LICENSING.md`.

### The picture is a window, not an element (`electron/mpvView.cjs`, B3, 2026-09-10)

`mpvProcess.cjs` spawns the engine and speaks to it; it draws nothing. This is
where the picture goes, and it is different on every platform.

**Windows and Linux embed the spawned process.** mpv's `--wid` takes a native
window handle and reparents its video output into that window, filling its
client area. Electron exposes exactly one native handle,
`BrowserWindow.getNativeWindowHandle()`, so what mpv is handed is a
`BrowserWindow` of our own: frameless, unfocusable, black, drawing nothing,
parented to the shell and positioned over the player pane's rectangle. It
cannot be a `WebContentsView` — what the browser panel uses — because a
`WebContentsView` has no handle to give. It must not be the shell's own window
either: mpv fills whatever it is handed, which would put video over the entire
application.

**macOS refuses, and that refusal is the design.** `--wid` there is an `NSView`
pointer, meaningless outside its own process, and `addChildWindow` is
same-process only. `canEmbedSpawned` is false on darwin and `embedArgs` returns
null rather than passing a number that would address nothing. The Mac's path is
a linked `libmpv` through the render API into a Metal view — a native addon,
not yet written — which is the fact that decided B0's licence above. Until it
exists the Mac keeps the `<video>` element, and every `mpv-view:*` call answers
`{ ok: false, reason }`.

**The rectangle was solved once already.** `services/browserView.ts` measures
and clamps it (`measureBrowserViewBounds`), decides when an overlay means hide
(`isOverlayOpen`), and `browserView.cjs` converts CSS pixels to
device-independent ones (`scaleBounds`). All three are imported, not copied.
The one thing added is the final offset from a rectangle inside the window's
content area to one on the screen, because a `BrowserWindow` is placed in
screen coordinates where a `WebContentsView` is placed in its parent's. A child
window also does not follow its parent when the shell is dragged, and the
renderer has no reason to report a rectangle that did not change in its own
coordinates — so the parent's `move`, `resize`, `hide`, `show`, `minimize` and
`restore` are listened to and the last rectangle re-applied. Without that,
dragging the window leaves the video behind, floating over the desktop.

**One embedded player, and a second panel is refused.** `--wid` is fixed at
spawn, so a second panel means a second process, a second window and two
hardware decode pipelines. The first panel to ask owns the engine; a second
gets a sentence the pane can draw, rather than having the engine silently taken
from the panel the operator is watching.

**Input is mpv's to decline.** It is started `--input-cursor=no` and
`--input-vo-keyboard=no` so the video output answers neither mouse nor
keyboard — the pane owns every control the operator sees, and a second,
invisible set of bindings answering differently is the failure being avoided.
`--osc=no` and `--osd-level=0` stop mpv drawing its own transport controls and
status messages over the pane's. The container window is additionally set to
ignore mouse events so a click on the video reaches the document beneath it.
`--vo` is deliberately not pinned: mpv's default already resolves to `gpu` on
both platforms, and naming it would turn a machine where `gpu` fails into a
black rectangle instead of a fallback.

**What is tested, and what a Mac cannot answer.** The decisions are pure and
covered by `tests/mpv-view.test.mjs` (22 tests): the handle read at both
pointer widths and returned as a string, because a handle is not promised to
fit in the 53 bits a JavaScript number keeps exactly; the argument list, whose
every option was checked against `mpv --list-options` on 0.41 rather than
remembered; a guard that no embed option is one `mpvArgs` already sets, since
mpv takes the last of a repeated option; the screen rectangle; and when the
window is hidden. **The window itself is Windows and Linux behaviour and this
repository is developed on a Mac, where none of it runs.** Two things are
therefore hand checks that have *not* been performed, and must be before B3 is
called done, on a real Windows or Linux machine:

1. Video appears in the pane's rectangle, follows it through a resize and a
   window drag, and disappears when the panel is switched away from or a modal
   opens.
2. **A click on the video reaches the pane.** mpv creates its own child window
   inside the container, which the container's ignore-mouse-events setting
   cannot speak for; `--input-cursor=no` is the second line of defence, but
   whether the click actually falls through is not knowable from here.

**The chrome stops floating, because it cannot be seen if it does.**
(`panels/useMpvView.ts`, `services/mpvView.ts`, 2026-09-10.) The pane's
controls are `position: absolute` over the picture — a scrim, a title, a
scrubber — and that works for a `<video>` because both are the same document
and the stacking context settles it. An embedded mpv is not in this document:
it is a native child window above the whole of it, so a control drawn over the
video is drawn *behind* it. `setIgnoreMouseEvents` answers the click and says
nothing about the stacking, which makes the button reachable and invisible —
worse than either failure alone. So where mpv holds the picture the auto-hide
is off and `embeddedPictureBounds` hands it the band between the top and
bottom bars rather than the whole pane. The picture is smaller than the pane by
exactly the chrome, and nothing is drawn where it cannot be seen. The bars are
observed as well as the pane, since a title that wraps to two lines moves the
video. **This was found by writing the renderer, not by reading the code**, and
it is the reason the pane is a fork rather than a substitution.

**What the renderer does and does not hand over yet.** `useMpvView` asks for
the engine, hands it an absolute path — mpv has no workspace root and no
protocol handler, and an *unconfirmed* root is not one, so until the gateway
has spoken there is no path and the element keeps the picture — reports the
rectangle, relays what mpv says about itself, and gives the engine back on
unmount. Commands go through `runCommand` as they always did: it forwards the
playback half to the engine and still runs its own switch, which is what keeps
the volume slider and the pause glyph honest with no element to read them off.
`fullscreen`, `next`, `previous`, `episode` and `episodes` stay with the pane,
which owns the layout and the series. A `load` that fails falls back to the
element rather than showing black, on the grounds that a picture beats a
reason.

**The tracks are the engine's, and the pane stopped building its own (B4,
2026-09-10).** mpv chooses a subtitle by its own `sid` out of the file, and the
pane's tracks were WebVTT blobs it built from the sidecars beside it — two
lists with nothing in common, which is why B3 published `subtitles` in
`unsupported`. They are not reconciled; one of them is gone. mpv is spawned
with `--sub-auto=exact`, which is word for word the rule `subtitleTracksFor`
already applies to the folder — the siblings whose base name is the video's,
optionally followed by a dot and a language — so it opens the same files the
pane found, without being told about them. `initMpvView` then observes
`track-list` and `sid` and pushes them up the existing `mpv-view:state`
channel as `tracks` and `subtitleId`; `playerTracks` in `mpvProcess.cjs` turns
mpv's list into `{ id, label, language, selected, external }`, labelling each
track by the same three-step rule the pane names a probed stream by. While
embedded the pane builds no WebVTT at all — it does not read the sidecars and
does not run ffmpeg over the file's own subtitle streams — and its menu, its
snapshot and the agent all read mpv's list. `subtitles` and `audio_track` are
in `ENGINE_ACTIONS` accordingly, and `runCommand` sends that list back as the
command's context so `mpvCommand` can resolve "english" to an `sid`. Which
track is *on* is mpv's answer, by the same rule as position: the pane keeps
only the operator's preference.

**The remembered language is re-asked for, because mpv chose first.** mpv opens
a file in its own subtitle — `--sub-auto` and whatever the file marks default —
and only then reports `track-list`, so the pane's preference and the engine's
selection can be compared only after the fact. `subtitleToRestore`
(`services/mpvView.ts`) is that comparison and the pane sends `subtitles` when
it answers a track. It is a named rule rather than four lines inside the effect
because it is the only part a Mac can execute: the effect around it never runs
here. It answers null in three cases and each would be a bug rather than a
no-op — nothing remembered, since `null` is what turning subtitles *off* stored
and re-applying over it would turn them back on every episode; nothing
matching, since mpv's own choice beats none and "the first track" is how a
Swahili preference becomes silent French; and **already selected**, since the
answer to the command is a new `sid` arriving back as the next
`engineSubtitleId` — comparing against what is on is what makes the exchange
settle rather than repeat.

**A subtitle file dropped on the pane now reaches mpv too (2026-09-10).** What
arrives with a drop is bytes, and mpv opens files by path, so while embedded
this used to be refused with a sentence saying to put the file beside the video
instead. The path was already reachable: `webUtils.getPathForFile` is on the
bridge as `media.getPathForFile`, put there because the media gate needs a human
gesture to produce an absolute path before anything may consent to one — and a
file dropped on the picture is exactly that gesture. `subtitleFileToLoad`
(`services/mpvView.ts`) asks it and returns either the command or the sentence;
`mpvCommand` turns the command into `sub-add <path> select <title>`.

The title is sent rather than left to mpv because `trackLabel` would otherwise
name the track after the file with its extension still on, while the pane's own
WebVTT path takes it off — the same file remembered under two names depending on
which engine drew it, which is the one disagreement `subtitleToRestore` cannot
settle. The pane sends the label it is about to remember, so there is one name.

`subtitle_file` is the only case in `mpvCommand` that is **not** in
`PLAYER_ACTIONS`, and that is the design rather than an omission: every other
action is a verb an assistant may ask for, while this one carries an absolute
path. In the contract it would hand a model `sub-add` against any file on the
disk. `tests/mpv-ipc.test.mjs` pins it *out* of the list, so completing the
contract by adding it fails the suite, and `playerToolCalls.ts` refuses the name
before it could arrive. The format check moved ahead of the engine fork in the
same edit: mpv accepts `sub-add` on anything and then shows an empty track, so
an `.ass` is now refused in the same words whichever engine has the picture.

**Not run.** `canEmbedSpawned` is false on darwin, so the branch that calls
`subtitleFileToLoad` has never executed. What is tested here is the rule and the
command table; the drop itself is Windows/Linux behaviour.

### One action list, two engines (`services/playerControl.ts`, `server/player-state.js`, 2026-09-10)

The contract above gained four actions the day mpv could answer them:
`frame_step`, `frame_back`, `chapter` and `audio_track`. Both lists changed in
one commit, as `tests/player-state.test.mjs` insists, and `mpvCommand` answers
all four — a frame step is mpv's own `frame-step`, a chapter is its `chapter`
property counting from 0 where the contract counts from 1, and an audio track
is `aid`, named the same two-step way a subtitle track is or numbered outright.

The interesting half is the engine that *cannot*. Chromium plays a container's
first audio track and offers no way to choose another; it reads no chapters;
and it can only step a frame where ffprobe could say what the frame rate is.
The tempting answer — a second, shorter list for the pane — puts one action in
two contracts and is exactly the drift the mirrored-list test exists to catch.

So the difference is **data, not a list**: `PlayerSnapshot.unsupported` is what
this engine cannot do to *this* file, each with the sentence the agent gets
instead, and `unsupportedReason` is the gateway spending it before the command
is emitted (409 `PLAYER_ACTION_UNSUPPORTED`). The pane recomputes it per file —
audio has no frames, a transcoding stream has no frame index, a file ffprobe
could not read has no frame rate — and the gallery publishes it too, because
nothing is playing there at all.

**It is per engine as well as per file, as of B4.** Where mpv holds the picture
the list is nearly empty: it steps a real frame without being told the frame
rate, reads the file's chapters, and chooses an audio or subtitle track by its
own number, so four of the sentences above are the element's limits and not the
file's and are not published. What survives is the one limit that is still
true of any engine — a track can only be chosen out of a list, so a file whose
`track-list` reports no subtitles publishes `subtitles`, and the same for
`audio_track`. This is what "data, not a list" was for: the same contract, a
different answer per playback, and nothing added to either engine's action
list to say so.

### The assistant can watch the film (`player_frame`, `services/playerFrame.ts`, 2026-09-10)

`player` says where the position is and `player_control` moves it. Neither is
*seeing* the film, and the gap showed: asked what happens in a scene, the model
had a filename and a number of seconds. `player_frame` is the third channel —
one frame of what is on screen, handed over as a real MCP image block the way
`browserMcpStdio.cjs` hands over a screenshot, with the sentence `player` would
give taken at the frame's own position, because a picture with no timestamp
under it is a picture nothing can seek from.

It is the third round trip of the same shape as the camera's and the browser
panel's, for the same reason: the gateway is a plain Node process with no
picture in it, so `requestPlayerFrame` puts an event on the run's one-way
stream and waits for the window's own POST. Two things are deliberate. The pane
**registers** its element rather than this being a `querySelector("video")` —
a window holds several video elements, one per clip in the editor's compositor,
and "the first one" would photograph the wrong surface. And the frame is
`image`, singular, at every step, pinned by `tests/player-frame.test.mjs`:
the camera's path says `images` in the window and `image` in the resolver,
which is why `look_at_me` never once worked until the gateway hop was
corrected to `images` (2026-09-10) and `tests/camera-frame.test.mjs` was given
the round trip and the forwarding to hold.

Pre-approved, with `player` and `player_control`. It photographs one thing —
the file the operator opened, in the pane they are watching. The camera looks
at *them* and asks; a screenshot has everything else they have open in it; a
frame of their own video reveals nothing the position already reported does
not imply. The alternative, a prompt each time the model wants to check what a
scene shows, makes "find the bit where they arrive" not worth asking.

**Under mpv it is `screenshot-raw`, and nothing above the pane changed (B4,
2026-09-10).** That was the prediction when this was written and it held: the
gateway, the round trip, the word `image` and the pre-approval are all
untouched. What changed is one fork inside the pane. A registered source may
now hand over an `engine` capture instead of an `element`, and while mpv holds
the picture it hands over exactly that — `element` goes null on purpose,
because the frame is in another process on a window `drawImage` cannot read and
`querySelector` cannot find. `capturePlayerFrame` tries the engine **first**;
testing the element first would answer "No video is open" about a film that is
playing, which the agent would then repeat to the operator. The order is
asserted in `tests/player-frame.test.mjs` rather than run, because it cannot run
here.

Main does the encoding (`mpv-view:frame` in `electron/mpvView.cjs`): mpv's
`screenshot-raw` reply is a raw bitmap in the JSON, and
`nativeImage.createFromBitmap(...).resize().toJPEG()` turns it into the same
1280px JPEG the canvas produces on the element path. No ffmpeg, no second
decode, no temporary file. The flag is `video`, not `subtitles`: the question is
what is on screen, so a burned-in caption belongs in the answer.

The reply needs three corrections before it is a picture, and **all three
produce an image rather than an error**, which is why they are a pure
`packBitmap` in `mpvProcess.cjs` with four tests in `tests/mpv-ipc.test.mjs`
rather than four lines at the call site. `stride` is bytes per row and may
exceed `w * 4` — handing the padded buffer over with only a width shears the
frame diagonally. `bgr0`, mpv's default and the only format asked for, leaves
the fourth byte **zero**, and a transparent bitmap encodes as a black JPEG.
And the byte order must already be BGRA, which `bgr0` and `bgra` are and `rgba`
is not; that one is refused rather than silently swapping the operator's blue
for red. A sheared, black or inverted frame all look like a working feature in
a log, and the model cannot tell any of them from a dark scene.

The bridge method is `mpvView.frame` in `preload.cjs`, which is another
thread's file — so `tests/mpv-view.test.mjs` asserts that every `mpv-view:*`
channel the preload invokes has a handler in main. `ipcRenderer.invoke` on an
unhandled channel does not throw in main; it rejects in the renderer, the pane
falls back, and a mistyped channel becomes a feature that quietly never works.
The hook answers `frame: null` where mpv does not hold the picture — and equally
on a packaged build whose preload predates the method — so the pane has one
thing to test rather than two.

**Not run.** `canEmbedSpawned` is false on darwin, so on the machine this was
written on `engine` is always null and every capture is still the element's.
Everything in these four paragraphs is Windows and Linux behaviour with tests
covering the arithmetic and the decisions, not the picture.

### The player, as a tool (`server/player-state.js`, `services/playerControl.ts`, 2026-09-06)

*"make sure all its controls are accessible by the ai agent."*

Two one-way channels, and no handle on the element anywhere but in the pane.

**Up:** the pane publishes a `PlayerSnapshot` — what is showing, playing or
paused, position, duration, volume, speed, which subtitles exist and which is
on, the whole episode list when a series is open. The store gets every one; the
gateway gets one a second, and one *immediately* for anything discrete, so an
agent that just asked for a pause does not read the frame before it. The
gateway keeps exactly one, bounded and typed by `sanitisePlayerSnapshot`: a
snapshot is data from the renderer, and an unbounded string in it would be an
unbounded string in the gateway's memory.

**Down:** `player_control` is checked by `parsePlayerCommand` and put on the
run's own NDJSON stream — the same channel `reveal` and `open_file` use, alive
exactly as long as the turn. `PLAYER_ACTIONS` is spelled on both sides and a
test asserts the lists are identical, because an action the gateway accepts and
the pane ignores is a tool call that reports success and does nothing. Every
refusal is a sentence naming what was wanted (`\`seek\` wants \`value\` as a number
of seconds`), because the reader is a model that will try again; a code is a
dead end.

**`player_control` is pre-approved, and it is the only tool on that list whose
name is a verb.** The line has always been between showing and changing, not
between quiet and loud: it acts on a file the operator opened, in a pane they
are looking at, and writes nothing. A prompt in front of every pause would make
it not worth calling, which is the behaviour it exists to replace — an agent
asked to pause a video otherwise reaches for the pointer.

**`open_file` on a folder is the gallery.** The gateway emits `open-folder`
for any folder, counts the videos with the renderer's own threshold, and says
in the result which of the two the operator is now looking at — "a series of 14
episodes, `player_control` starts one" or "a gallery of its contents". Those
are different next moves for a model, and a single flat "opened" would leave it
guessing.

### The other lane reaches the same player (`services/playerToolCalls.ts`, 2026-09-06)

*"we have to make it able to control the built in player completely."*

The section above is the agent CLI lane. The local lane had none of it, and the
failure was not that it declined — it is that it did not.

Asked to play a file open in the viewer, the local model had exactly three
executors (`frontier-run`, `video-tool`, and `path=` fences), so it reached for
the only video-shaped one it had, called `describe_timeline`, read back the
Teminali Cut timeline, and told the operator there was no `Instagram.mp4` in
their project — while the file sat paused in the next pane. **A model given no
tool for a thing does not say it cannot; it grabs the nearest-sounding tool and
reports the wrong answer with confidence.** That is the argument for wiring a
capability rather than documenting its absence.

`runPlayer`, `playerActions` and `playerState` join `EngineCapabilities` on the
same terms as the editor tools: injected, so the engine still knows nothing
about panes. The host's executor is one line — `dispatchPlayerCommand` reaches
the mounted pane through the listener the CLI lane's events also land on, so
both lanes drive one player and there is no second implementation to drift.

Three things are deliberate:

- **The prompt carries the live state.** `playerState()` is read when the
  prompt is built, so the model sees *"paused at 0:01 of 1:44"* and answers
  "play it" instead of asking which file. This is the same grounding argument
  the transcript notice makes in §6.
- **The prompt names the confusion it exists to prevent.** The block says the
  player is not the timeline, and `buildPlayerToolEvidence` says it again on
  the way back. Twice, because the wrong tool was *plausible*.
- **The executor waits for the player to move.** `play()` resolves before the
  element is playing and the pane republishes on the media event, so reading
  the store straight after a dispatch reports the state the command was meant
  to change. `settledPlayerState` waits for the next publish and gives up after
  600 ms, since an already-paused file produces none.

**The verbs alone were not enough.** Shipped without a read action, the first
thing the operator saw was a loop: the model asked for `{"action":"status"}`,
was refused, apologised, and asked again — six times, 66 seconds, no answer and
nothing spoken until it was over. The CLI lane splits reading (`player`) from
acting (`player_control`); one fence has no room for that, so `status` is a
local-lane action and `LOCAL_PLAYER_ACTIONS` is `PLAYER_ACTIONS` plus exactly
that one — the test asserts the difference is exactly one, in that direction.
Its aliases (`state`, `current`, `describe`, `get_state`) are accepted rather
than corrected, because every refusal costs a whole round trip on a 9 t/s model.

`progressNarration.ts` grew a `player.*` case in the same change. The generic
fallback said *"Using player dot seek by"* — the interface describing itself
instead of narrating — and these are the only tool calls whose result the
operator can also *see*, so the words have to match what the pane is doing.

A malformed fence comes back as a sentence — `"seek" needs a numeric "value"`
— for the reason the gateway's refusals do: the reader is a model that will
try again, and a code is a dead end. A mistyped tag (```` ```player_tool ````,
```` ```player ````) is executed anyway; a ```` ```json ```` block never is.

Tested in `tests/player-tool-calls.test.mjs` (18), including a parity test that
reads `server/player-state.js` and asserts the fence accepts exactly the
actions the gateway does.

Tested in `tests/player-state.test.mjs` (11) and in `server/gateway.test.js`,
where the wiring is: a folder opening as a gallery and saying whether it is a
series, a snapshot published and read back, a command with nothing playing
failing as a sentence.

### A tool says itself twice (`video/mcp/toolRegistry.ts`, 2026-09-07)

Every editor tool now carries an optional `brief` beside its `description`, and
the two are for different readers.

`description` is written for an MCP client: Claude Code and Codex reach these
tools through `services/videoToolBridge.ts`, they have large windows, and they
are **deliberately ungoverned** — nothing truncates their context. So those
descriptions are long on purpose and say everything a caller could need.

The local lane reads the same tools into an 8k system prompt. Everything below
was measured at the **nine-tool** surface; the four editor commands voice needs
took it to thirteen on 2026-09-12, where the short forms total **2,178**
characters against **4,470** for the long ones. The ratio is what the decision
rests on, not the absolute figure. Measured at nine:
**3,395 characters, 43% of the entire system-prompt budget**, on every turn
whether or not the operator has a timeline open. That is what pushed the ask
block out of the prompt on any turn with a file open in the player.

**The obvious fix — shorten `description` — is the wrong one**, because it
makes the manifest worse for the lanes that have room for it in order to help
the one that does not. And truncating it mechanically ("keep the first
sentence") would have deleted precisely the load-bearing parts: `patch_clip`'s
dotted-path examples, `ffmpeg_process`'s "the operator is asked" and "slower
than real time", `describe_timeline`'s account of what `detail:"full"` costs.

So a tool states its own short form, written by hand, sitting in the same
object as the long one so the two cannot drift. `getToolManifest()` carries
`brief` alongside `description` and an MCP client never notices it exists;
`videoToolSummaries()` in `services/aiService.ts` prefers it. The catalogue is
**2,238 characters**, and `ask` fits.

The guard is `editor-patch-clip` in the eval, added *before* the trim and
baselined at 3/3: it asks for a rotation by clip id, which only succeeds if the
dotted-path examples survived the shortening. It is still 3/3, as is
`timeline-describe`.

### The lane can ask a question (`services/askToolCalls.ts`, `components/chat/AskOperatorPrompt.tsx`, 2026-09-07)

*"popup with a tree of options and stepped tabs."*

The fourth fence, and the first one that suspends a turn on a person rather
than a machine. `frontier-run`, `video-tool` and `player-tool` all act on
something and hand back a result; `ask` stops and waits for the operator.

**Measured before it existed: 0/3.** Asked in so many words for options to pick
from, the lane replied *"Here are a few common approaches: 1. Monolithic…"* and
ended the turn. The options were fine. There was nothing to click, and an
answer typed into the next turn arrives having lost the question that produced
it. After the prompt block: **3/3**, and the whole eval went 36/36 (12 cases)
to **48/48** (16 cases) — measured on `frontier-qwen2.5-coder-14b-8k`, three
runs a case.

This is `AskUserQuestion` parity for a lane that cannot be given the real
thing. Measured in an earlier session, Claude Code driven headlessly is offered
40 tools with `AskUserQuestion` and `ExitPlanMode` both **absent** — so the CLI
lanes cannot get this by wiring, only the local lane can, and the local lane is
also the one `evals/local-lane.mjs` can grade. That is why it went first.

Four things are deliberate:

- **The second paragraph of the prompt block is the one that earns it.** A
  model handed a way to ask will ask for what it could have measured. So
  `ask-not-for-knowable` pins *"what branch am I on?"* to a `git` call and not
  a question; it was written before the tool, scored 3/3 before and 3/3 after,
  and exists to fail if the block ever tempts the model into a modal.
- **A dismissed picker still produces an observation.** Returning nothing would
  end the exchange in silence — the one outcome worse than a wrong guess, since
  the operator clicked away and the work simply stopped. `buildAskEvidence`
  tells the model to pick a default and say which one.
- **The gate never remembers.** `createAskGate` is a deliberate copy of
  `createApprovalGate`'s contract rather than a generalisation of it: that gate
  remembers an executable, and an answer to *"which database?"* in one exchange
  says nothing about the next. What they share is the guarantee both exist for
  — the promise always settles, so a pending question cannot stall a turn.
  `stop()` cancels this gate as well as the approval one, which is the bug the
  approval gate shipped with and does not get to repeat.
- **The picker is one click when the model asked one thing.** A single-select
  answer advances to the next unanswered tab, and the last one submits. Tabs
  appear only for more than one question, because a single tab is a label
  pretending to be navigation. "Other" is always there, because the options
  came from the model's guess at the problem and the operator is the one who
  knows it guessed wrong.

**It did not fit at first, and the two failed attempts are the interesting
part.** On an 8k window with a file open in the player there were 411
characters left when this block was reached, and the block is 1,174 — so
`assemblePrompt` skipped it and the lane could not ask on any turn with a file
open. `ask-with-player` pinned that at **0/3**.

*First attempt, wrong:* trim `completeness` and `multi-agent`, which drop on
every turn anyway. It would have freed nothing. The drop rule is a **skip, not
a truncation** — `assemblePrompt` passes over a section that does not fit and
keeps going, so a later small section still ships and `conversational` survives
on the very turns `ask` is dropped. Both of those rank *below* `ask` and were
already being skipped. A comment in `systemPrompt.ts` asserted the truncating
version until 2026-09-07, and a handover repeated it.

*Second attempt, also wrong:* shorten the block. Rewritten to 389 characters it
fits beside the player — and scores **0/3 anyway**, the model listing options in
prose with the rule in front of it. It also took `ask-explicit-choice` from 3/3
to 0/3 with no player involved. What the short version had dropped was the
clause binding the rule to the failure it prevents ("instead of listing options
in prose"), the promise that the answer returns mid-turn, and the worked example
with real descriptions. **Length is not fungible with content in a prompt
block** — the same lesson `[SAY, THEN DO]` taught from the other direction.

*What worked:* the section actually crowding it out was the **editor tool
catalogue at 3,395 characters**, written for an MCP client and shipped verbatim
to a lane with an 8k window. Tools now carry a `brief` (see §3, "A tool says
itself twice") and the catalogue is **2,238**. `ask` fits alongside the player,
`ask-with-player` is **3/3**, and both editor cases held. The block kept every
word.

Tested in `tests/ask-tool-calls.test.mjs` (16).

### A question with no answer channel (`services/systemPrompt.ts`, `components/chat/CursorMarkdownRenderer.tsx`, 2026-09-07)

Observed, in the operator's words: *"the assistant asked to say yes or no to
refuse for command but there was never a prompt to click yes or no or always,
and even when i said yes, nothing happened"*.

Nothing was broken in the gate. The model had asked **in prose** — a sentence
in the reply offering to run something if the operator agreed. Prose is not a
channel: `createApprovalGate` never had a request, so no prompt was drawn, and
the word "yes" typed into the composer is a new turn, not an answer. The mandate
told the model it had full access and never told it not to ask for permission
anyway, so item 3 of `[FULL COMPUTER ACCESS & AUTONOMOUS ACTION MANDATE]` now
does: **never ask permission to run a command**, because whatever genuinely
needs a decision is gated by Teminali and drawn as a real prompt with buttons.
Every later item renumbered; the fence contract is unchanged.

Adjacent, from the same screenshot: a streamed `---` was drawn as a full-width
rule across the transcript. Models emit thematic breaks out of markdown-file
habit, and in a column where message blocks already separate themselves it is a
line that divides nothing. `CursorMarkdownRenderer` still *parses* the rule — so
the dashes never surface as a stray paragraph — and renders nothing for it.

### An edit is not a rewrite (`services/systemPrompt.ts`, `services/liveEditProtocol.ts`, 2026-09-07)

A path block is applied by **overwriting the file**. That is right for a file
the model just wrote and destructive for one it has seen a fragment of, and the
window makes the second case the common one.

`edit-long-file` is the measurement. The model is shown line 42 of an 812-line
`server/config.js` — a `grep -n` and a `wc -l`, in the evidence format the
engine really returns — and asked to change that default. **Baseline 0/3**: all
three runs answered with a two-line `path="server/config.js"` block. That is
not a formatting preference. `commitEdits` calls
`WorkspaceService.writeFile(edit.path, edit.content)` with no size guard, so
committing it deletes 810 lines of the operator's file and says it saved them.

**A rule in prose bought nothing.** "A path block REPLACES THE WHOLE FILE …
edit it in place" was added to the `base` section — 297 characters, +67 prompt
tokens, and the same three replies byte for byte. **0/3.** It was reverted.

**Showing the shape worked**, as it did for `[SAY, THEN DO]` and against the
same instinct to explain. `[TO CHANGE A FILE YOU HAVE NOT SEEN IN FULL]` states
the consequence in one line and then demonstrates the edit. Its example uses a
different file and a different value from the fixture, so the case cannot be
passed by copying it.

**The first example was itself unrunnable, and the eval caught it.** It showed
a `python3 - <<'EDIT'` heredoc; `parseAgentCommands` splits a fence on newlines
with no heredoc awareness (`agentCommands.ts:222`), so that block would have
executed as five separate commands — a bare `python3` reading EOF, then three
shell syntax errors, and nothing edited. The case failed the run that copied
it, which is the right verdict for a command that cannot run. The example is
now one line of `python3 -c`.

**Pooled across four sessions, 16 of 19 observed runs at temperature 0.15** —
3/3 and 2/3 when the case was introduced, 2/3 twice on re-measurement, then 2/2
and 5/5 at `ccd7a60`. The 7 of 7 at `ccd7a60` were isolated and uncontended;
the earlier thirds were not. So the prompt is not the guarantee. `isTruncatingRewrite`
is: the applier refuses a block that keeps under half of an existing file of 25
lines or more, and reports which numbers it refused on. Both thresholds are a
judgement and are written down where they live. Below the floor, "rewrite the
whole file" is an ordinary request and the model can hold the file in its
window; above it the costs are asymmetric — a refused rewrite is one more turn,
an accepted truncation is unrecoverable work.

Eval **51/51** over 17 cases, three runs each, up from 48/48 over 16. Tested in
`tests/live-edit.test.mjs` (10).

### A fetched page is markup until it is read (`services/readablePage.ts`, `services/agentCommands.ts`, 2026-09-07)

The local lane could fetch a web page and learn nothing from it. Asked to read a
named URL, the model does the right thing without prompting — the eval's
`web-fetch-url` case scored 3/3 the first time it ran — but `curl` returns an
HTML document, and `runAgentCommands` kept only the head of it. That pass was
hollow: the lane ran a correct command and was handed the `<head>`.

Measured on `https://nodejs.org/en/about/previous-releases`:

| | chars | "LTS" found |
| --- | ---: | ---: |
| raw document | 295,973 | — |
| raw, first 4,000 chars (what the model saw) | 4,000 | **0** |
| after `htmlToText` | 5,683 | 8, first at offset 481 |

So the fix is in the pipeline, not the prompt. `looksLikeHtml` decides on the
first 200 chars whether output opens as an HTML *document*; only then does
`htmlToText` strip `<script>`, `<style>` and `<noscript>` bodies whole, turn
block ends into newlines, decode entities and squeeze. Output that merely
*contains* markup — a JSON string, an XML feed, a grep hit in a template — is
passed through byte for byte, because rewriting what the operator asked for is
the same class of mistake as overwriting a file the model had seen one line of.

Two consequences worth stating plainly rather than discovering later:

1. **The read ceiling had to become content-aware.** The decision to stop
   reading is made while the command streams, long before there is anything to
   strip, so an HTML document accumulates to `HTML_CEILING_CHARS` (512,000) and
   everything else still stops at the caller's `maxOutputChars`. That bound is
   what keeps a fetch from becoming a memory bug.
2. **It was a large improvement, not a complete one.** The lane's real allowance
   is `toolResultChars` — 2,621 chars on an 8k window, 10,485 on 32k. On 32k the
   whole page arrived even then; on 8k the prose arrived and the site's furniture
   ate the budget ahead of it. Dropping that chrome is the next section, and it
   was built the way this one asks for — against a measurement, on a corpus, not
   as a guess bolted on here.

This costs **zero prompt tokens**: measured, the eval's prompt stayed at 2,189
tokens across the change. That is the point of fixing it here. The window, not
the tool count, is this lane's constraint, and the `ask` block is already
dropped on a player turn.

**There is no credential-free web search from this machine.** Measured
2026-09-07: `html.duckduckgo.com` and `lite.duckduckgo.com` return 403 to curl;
`api.duckduckgo.com` returns 200 with 0 bytes for a real query;
`searx.be/search?format=json` returns an HTML block page; `s.jina.ai` returns
401. The eval's `web-search-open` case is therefore a known gap left red on
purpose — closing it needs an operator-supplied API key, which is a product
decision. `r.jina.ai` (read a URL, no key) does work and is the fallback if
local stripping proves insufficient.


### The page is not the site (`services/readablePage.ts`, 2026-09-07)

Stripping tags was half the job. What came back was the whole *site* — top nav,
sidebar, footer, cookie line — with the page somewhere inside it, and on an 8k
window the lane's 2,621-char allowance was spent on furniture before the answer
began. Three rules, each measured against a corpus of six real pages fetched
2026-09-07, rather than against the one page that started this:

1. **Take the page's own word for where it is.** `<main>`, then `<article>` —
   every match, so an index of posts does not collapse to its first entry — then
   `role="main"` for documents that predate the element. A root thinner than 200
   chars is not believed: a client-rendered page ships an empty `<main>`, and
   trusting it would turn a thin result into an empty one, so the whole document
   is used instead.
2. **Drop the furniture.** `<nav>`, `<aside>`, `<footer>` and `<header>`, each
   matched to its *balancing* close tag — these nest, and a non-greedy regex
   ends the outer element inside the inner one. `<header>` is on the list only
   because the `<title>` is prepended separately; the two rules are a pair, and
   dropping `header` without the prepend would lose the heading.
3. **An attribute value is not prose.** `<[^>]+>` ends at the first `>`, so a tag
   carrying one inside a quoted attribute ended early and spilled the rest of the
   value out as if it were the page's own words. Wikipedia's `data-mw` payloads
   hold whole templates: 1,274 chars of raw wikitext arrived ahead of the lead
   paragraph. A quoted run may not contain `<`, so an unbalanced quote fails near
   where it started instead of swallowing the document, and the old catch-all
   still runs behind it.

The offset at which the answer appears, before and after:

| page | before | after | against a 2,621-char cut |
| --- | ---: | ---: | --- |
| nodejs.org release list | 1,590 | 1,208 | fits, both |
| MDN `Array.prototype.map` | 2,421 | 304 | fits, both |
| Wikipedia "Node.js" | 4,446 | **1,441** | now fits |
| docs.python.org `json` | 8,048 | 7,290 | still outside |
| github.com `nodejs/node` | 4,080 | **1,865** | now fits |
| blog.rust-lang.org 1.83.0 | 211 | 92 | fits, both |

Five of six now carry the answer into the model's window, up from three. The
sixth is not a chrome failure and is not one to chase: that page genuinely spends
7,290 chars of prose before the sentence asked about, which no amount of
stripping moves — the window is the limit there, not the reader.

Still **zero prompt tokens**: the eval's prompt is 2,189 before and after, and
`web-fetch-url` stays 3/3.


### Three capabilities measured, and deliberately not built (`evals/local-lane.mjs`, 2026-09-07)

The lane had four capability gaps queued: structured Read/Write/Edit/Grep,
subagents, todo/plan, and an MCP client. Each was baselined before anything was
built, as CLAUDE.md requires. Three of them turned out not to be gaps
(frontier-qwen2.5-coder-14b-8k, 8k window, 3 runs a case):

| case | score | what it means |
| --- | --- | --- |
| `search-repo-wide` | 3/3 | `grep -rn` is already a command; a search tool buys nothing |
| `plan-multi-step` | 3/3 | it held all four steps of a four-step task |
| `wide-audit-scoping` | 3/3 | it scoped a deliberately wide read without being told to |
| `read-before-edit` | **0/3** | it overwrote an unseen file with an invention, every run |

So three tool blocks were not written. On a lane whose constraint is window,
that is the finding: a block costs characters on every turn, and `assemblePrompt`
pays for it by dropping another section. This was measured in the same session —
adding 188 characters to one block evicted the entire `multi-agent` section and
made the prompt *smaller* (2,177 -> 2,056 tokens) and the lane worse
(`edit-long-file` 2/3 -> 0/3, recovered on revert).

The MCP client is not baselined and is not claimed either way: with no server
configured there is nothing to call, so a case would only grade the model's
willingness to invent one.

`read-before-edit` stays red on purpose, as `web-search-open` does. It grades
the model's half, and prose did not move it; the fix belonged in the applier,
which already refused a truncating rewrite but not a same-size invention —
`isTruncatingRewrite` needs a 25-line base and a block under half of it, so an
invented 6-line script over a real 20-line one was committed. That guard was
built the next session; see "A file nobody read is not a file you may
overwrite" below. The case stays red, because the applier cannot change what
the model writes — only what reaches disk.

### A fence is not always one command per line (`services/agentCommands.ts`, 2026-09-07)

`parseAgentCommands` split a run fence on newlines and classified each line as
its own command. A heredoc therefore did not merely fail — it *ran*. Measured
on this repo before the fix, a four-line edit

```frontier-run
python3 - <<'EDIT'
import pathlib
p = pathlib.Path('server/config.js')
p.write_text(p.read_text().replace('3000', '4310'))
EDIT
```

parsed as **five** commands: a bare `python3` reading a stdin that would never
close, three python statements handed to the shell, and the terminator. Five
approval prompts, and nothing edited.

This is why [TO CHANGE A FILE YOU HAVE NOT SEEN IN FULL] teaches a cramped
one-line `python3 -c` form. The prompt was working around a parser bug, and
paying prompt characters to do it — the comment at `systemPrompt.ts` recorded
the workaround and named `agentCommands.ts:222` as the cause, for three
sessions, without the cause being fixed.

`fenceCommands` now groups a fence the way a shell would. Three constructs
continue a command onto the next line: a heredoc (`<<`, `<<-`, quoted or bare
delimiter), a trailing unescaped backslash, and an unclosed quote. State is
tracked by scanning the line, not by regex, so `<<` inside a quoted string
opens nothing, a `#` at a word boundary ends the scan, and `<<<` stays a
herestring — the run of `<` is counted, because advancing one character at a
time reads the tail of a `<<<` as a heredoc opener.

Two properties worth keeping:

- **A multi-line command is still classified by its riskiest line.** `segments`
  already splits on `\n`, so a heredoc *body* is classified as a command too. A
  body holding `rm -rf /` is blocked. That is deliberate and conservative: a
  body is an obvious place to hide one, and refusing to write a suspicious
  string costs a turn.
- **An unterminated construct stays joined** rather than being torn apart. One
  approval for one broken command is safer, and truer to what was asked, than N
  fragments that each run. Fences only reach this function closed
  (`closedFenceEnd`, `frontierEngine.ts:452`), so this is the rare case.

`edit-long-file` measured 2/3 after the change, unchanged from before it: the
model on this lane does not reach for a heredoc on its own, so the fix does not
move the score. It removes a way to lose the operator's file when it does.

### A file nobody read is not a file you may overwrite (`services/liveEditService.ts`, `services/agentCommands.ts`, 2026-09-07)

The `read-before-edit` case above is 0/3 and destructive: asked to add a flag to
`scripts/deploy.sh`, the local lane never opens the file and answers with a
whole-file `path=` block holding a script it invented. Committing that does not
edit the operator's deploy script, it replaces it.

Prose was measured against this and failed — 188 characters into
`[TO CHANGE A FILE YOU HAVE NOT SEEN IN FULL]` scored 0/3 unchanged while
evicting the `multi-agent` section and dropping `edit-long-file` to 0/3. So the
guard is in the applier, next to `isTruncatingRewrite`, which does not cover
this shape: it needs a 25-line base and a block under half of it, so a
six-line invention over a real twenty-line script passed.

**`commitEdits` refuses a whole-file overwrite of an existing file this
conversation has not seen.** Three things count as seen, and all three are
facts rather than judgements:

- **It was read out loud on the shell.** `pathsSeenInToolCalls` walks the
  conversation's `frontier.run_command` tool calls and keeps the paths named by
  a *completed* one whose binary prints a file: `cat`, `head`, `tail`, `nl`,
  `bat`, `sed`, `awk`, `less`, `more`. A command that errored counts for
  nothing — `cat` on a path that does not exist exits 1, which is exactly the
  case being caught.
- **It is the file the operator has open** (`activePath`). They are looking at
  it, so the edit is the one they asked for and the one they can watch land.
- **The assistant wrote it earlier this conversation.** Having written the
  bytes, it knows them; without this every scaffold answer's second edit would
  be refused.

`grep` and `rg` are deliberately absent, and so are `wc`, `ls` and `stat`.
`grep -n verbose scripts/deploy.sh` prints the one line that matched, and a
model that has seen one line of a file has no business overwriting all of it —
that is the failure, not the fix. The consequence is a guard that errs toward
refusing: a path wrongly left out costs one more turn, a path wrongly included
costs the operator's file. The refusal names the way out
("Read it first (`cat scripts/deploy.sh`), then edit it."), because a refusal
the model cannot act on just buys another guess.

A file that does not exist yet is created, never refused — there is nothing to
destroy. The set is cleared when the chat session changes, so a new
conversation cannot overwrite on the last one's evidence.

`safeRelativePath` became the exported `normalizeWorkspacePath` so that a path
read on the shell and a path written in an edit block normalise to the same
string; `./scripts/deploy.sh` and `scripts/deploy.sh` were otherwise two
different files to the guard.

The eval score does not move and is not expected to: `read-before-edit` grades
what the model writes, and the applier changes only what reaches disk. Tested in
`tests/live-edit.test.mjs` (13, up from 10) and `tests/agent-commands.test.mjs`
(49, up from 45). One incidental fix made the first of those possible at all:
`liveEditService.ts` and `workspaceService.ts` imported their neighbours without
a `.ts` extension, which Vite resolves and `node --test` does not, so nothing had
ever unit-tested the applier.

### A cold start is not a slow model (`utils/messageTelemetry.ts`, `services/frontierEngine.ts`, 2026-09-07)

`loadDurationMs` was measured on every local turn and read by nothing. It is the
part of the turn Ollama spent loading weights, and without it the row under a
first reply says `31.4s` and reads as a slow model — which sends the operator to
tune the wrong thing.

The row now says `31.4s (24.8s load)`, but only when that changes the meaning of
the number: at least a second of load, and at least a fifth of the turn. A warm
model reports milliseconds, and printing those is the noise this row was
already narrowed to avoid. `loadWorthNaming` holds the rule and
`tests/message-telemetry.test.mjs` pins it.

Only the local lane has a cold start; an agent CLI reports zero and the field is
dropped like every other unmeasured one.

### The lane the operator is talking to can look at the screen (`services/screenToolCalls.ts`, `services/systemPrompt.ts`, `services/frontierEngine.ts`, 2026-09-07)

The screen assistant was reachable two ways: by an agent CLI, over the run-token
bridge in `server/gateway.js`, and by the operator's own clicks. It was not
reachable by the Studio chat's local lane — the lane the operator is usually
talking to. So "what's this error on my screen?" went to something that cannot
see the screen, and was answered by guessing, or by a shell command hunting for
a log that may not exist.

`screen` is the fifth fence in the family, shaped like `ask`, `player`,
`video-tool` and `frontier-run`: an explicit opt-in tag, a forgiving list for a
half-remembered one, execution through an injected capability, and the real
observation handed back before the model answers again. It has one action,
`look`. There is no acting counterpart — a local model that can click is a
different decision from one that can look, and the ladder in §5 is where that
decision belongs.

**Measured, as CLAUDE.md requires** (frontier-qwen2.5-coder-14b-8k, 8k window,
2 runs a case):

| | passes | note |
| --- | --- | --- |
| baseline, 23 cases | 43/46 | five sections already dropping on a player turn |
| with the block, 25 cases | 46/50 | `screen-look` 2/2, `screen-not-for-repo` 2/2 |

The percentage fell from 93% to 92% and that is not a regression: the two extra
failures are `read-before-edit`, red by design (below), and `wide-audit-scoping`,
which the same run settled at **5/5** on a re-measure. The number that matters is
that **the 23 existing cases were byte-identical in prompt tokens** — 2186 for
`wide-audit-scoping` in both runs. The block costs them nothing because it is
opt-in: `canSeeScreen` is false unless the host actually has an eye, so a
machine without Accessibility never hears about a fence whose every call would
fail, and never pays window for it.

`screen-not-for-repo` is the case that guards the cost. The block that buys the
win is the same block that can hijack every turn, so a sentence of it is spent
on what *not* to look at, and the eval grades a repository question going to
`frontier-run` rather than to a screenshot.

What reaches the model is `summariseScreen`, not the assistant's own
`observationBlock`: that one is written for a 120-element inventory, and this
lane has 8k. The summary keeps the frontmost application, the window title, the
scene description and the first twelve *named* controls — an element with
neither a label nor a value tells the model nothing and costs it a line. When
the list is cut it says so, because a model told "12 elements" while looking at
a summary of 300 will report an absence it never observed, which is the same
invention this capability exists to remove.

One look a turn, and one per reply. The display does not change enough between
two replies in the same turn to be worth a second screenshot's window.

### An agent's thread belongs to the chat, not to the mount (`utils/chatSessions.ts`, `store/studioStore.ts`, `components/chat/StudioChat.tsx`, 2026-09-07)

An agent CLI keeps its own resumable session, and the chat hands its id back on
the next turn so the agent sees one continuous conversation rather than a series
of one-shots that have each forgotten the last.

That id lived in a `useRef`. A ref dies with the mount, so the thread was lost
by anything that remounted the chat column, by switching to another chat and
back, and by restarting the app — the operator's conversation continued and the
agent's did not. It now lives on the `ChatSession` itself, which is persisted,
so the two end together.

Persisting it introduced a mismatch the ref could not have: a stored id can
outlive the agent that made it. `agentSessionKey` — `engine:model` — is stored
beside the id, and `resumableAgentSession` offers the id back only when that key
still matches the agent selected now. A Codex thread cannot be resumed by Claude
Code; resuming the wrong one fails the turn outright, while starting fresh only
costs the agent its memory, so every uncertain case resolves to null: no agent
selected, no such chat, no thread yet, or a thread belonging to another agent.
Forgetting a thread clears the key with it, so a stale key can never match.

The rule is pure and lives in `utils/chatSessions.ts` beside `applySessionSwitch`
— the store and the component both call it, and `tests/chat-sessions.test.mjs`
pins it, because none of the four ways of losing the thread were visible in the
UI: the agent simply answered as though the conversation had just begun.

### The browser panel is a view, not a frame (`electron/browserView.cjs`, `services/browserView.ts`, `panels/BrowserPane.tsx`)

The panel used to be an `<iframe>` in the shell's own renderer, and that
renderer runs with `webSecurity: false` — the file pane needs it to draw local
previews. A page the operator typed the address of was therefore a page loaded
with the shell's protections relaxed around it, in the same process as the
conversation. It was also a page whose history could not be read: an iframe's
`history` is cross-origin, so **Back and Forward were a list the pane kept
beside the frame**, not the page's own. A redirect, a link, an in-page route
change — none of them reached the toolbar.

It is now an Electron **`WebContentsView`**: its own web contents, its own
process, and its own session (`persist:teminali-browser`). It does not inherit
the window's `webPreferences`, so the page runs *with* web security, sandboxed,
with no node and **no preload** — there is no bridge in it to find. It cannot
reach `teminali-media://` either: that scheme is handled on the default
session, and this view is not on it. That closes the exposure the media
protocol's nonce was defending against, which was framing arbitrary sites in
the privileged renderer; the nonce stays, because the shell's own document is
still `webSecurity: false`.

Back, Forward, Reload and Stop are now the page's own
(`webContents.navigationHistory`), reported back to the toolbar over
`browser-view:state` along with the title and the loading flag. The omnibox
shows where the page **is**, not where it was sent.

What a view costs is that it is an OS layer above the document. It cannot be
positioned by CSS and nothing in the page can be drawn over it, so:

* the pane's viewport is an **empty box** whose rectangle is measured and sent
  to main (`browser-view:bounds`), clamped to the window — a view does not clip
  to the page, so an unclamped rectangle paints over whatever is beside the
  window;
* bounds are CSS pixels and a view is placed in DIPs, so main scales them by
  `webContents.getZoomFactor()`;
* the view is **hidden** whenever the app draws over it — any `role="dialog"`
  or `role="menu"` in the document, which is every overlay the primitives can
  open — and whenever the pane unmounts, which is what switching tabs looks
  like from inside it;
* closing a tab must end a page while switching tabs must not, and the pane
  cannot tell those apart because both unmount it. Only the store knows, so the
  reaping is a subscription to `panelStore` armed in `main.tsx`, beside the
  media root sync;
* and a mount asks for a view (`browser-view:ensure`) rather than for a
  navigation. The view outlives the pane, so loading the panel's stored address
  again on every mount would reload the page on every tab switch — at the
  address the tab was opened with, not the one the operator had reached, and
  with the history reset. An existing view is left alone and re-announces its
  state to the new toolbar.

Two guards, deliberately duplicated. `normaliseAddress` refuses `file:`,
`javascript:`, `data:` and `blob:` in the renderer; `isAllowedUrl` refuses
everything but `http(s)` in main, on navigation *and* on `will-navigate`, so a
page cannot walk the panel somewhere else. A window the page opens is denied
and either loaded in the same view or handed to the real browser.

A browser build has no bridge and keeps the iframe, sandbox attribute and all.

**Words are a search.** `normaliseAddress` used to answer "That does not look
like an address" to anything that was not a port, a host or a URL; it now
routes it to `searchUrl` (`SEARCH_ENGINE`, Google) and flags the result
`search: true`. The scheme refusals above it are unchanged — `javascript:` is
refused, not searched for. `addressLabel` names a tab by its host, or by the
query when the address is a search.

**Any number of browser tabs.** `⇧⌘B` and the add-menu call `open`, not
`focusOrOpen`, and `panelStore.matches` no longer folds browsers into one —
a browser tab is its own page with its own history, like a terminal is its
own shell. `services/browserNavigation.ts` (`openBrowserAt`) is how the rest
of the app puts a page in one: it updates the store *and* asks the bridge to
navigate, because the view outlives its pane and a store update alone reaches
no view whose tab is not in front. The artifact preview and the agent's
`browse` both go through it.

**What the browser remembers lives in the gateway** —
`server/browser-data.js`, one JSON file (`browserStorePath`,
`TEMINALI_BROWSER_STORE`) holding `{ bookmarks, history, downloads }`, on the
`projects.js` pattern: sanitise every row on read, atomic tmp+rename on write,
http(s) only, history capped at 500. It is there rather than in the renderer
so the agent can read it: the `workspace` MCP server offers `browse`,
`bookmarks`, `browsing_history` and `downloads` pre-approved and `bookmark`
behind the prompt (it writes). `browse` is a `workspace` event on the run
stream (`action: "browse"`) handled in both `AgentPane` and `StudioChat`.
`services/browserDataService.ts` is the renderer's client and
`store/browserStore.ts` the renderer's *cache* of it — never a source of truth:
every mutation goes to the gateway first and adopts the list it answers with.

**Home is a state, not an address.** `BrowserPane` keeps a `home` flag that
overrides `shown`; while it is set, `visible` is false, so the view — an OS
layer nothing can be drawn over — hides and `BrowserHome` is drawn in the box
it would have covered. The page behind stays loaded, at its scroll, with its
history; navigating to a blank page instead would have thrown that away every
time the operator glanced at their bookmarks. `go()` and an externally
delivered `panel.url` both clear the flag. The home page's search box always
searches (the omnibox is the one that guesses); the omnibox's first suggestion
says so out loud when what is typed is words.

**History is recorded once for the whole app**, by `watchBrowserHistory`
(`services/browserHistory.ts`) armed in `main.tsx` beside
`reapClosedBrowserViews` and `watchBrowserAudio`. Never by the pane: the pane
unmounts on a tab switch while the view goes on navigating, so a tab loading in
the background would record nothing. It dedupes per view on `(url, title)`,
because one navigation reports itself at start, at stop and again when the
title arrives.

**Downloads: main chooses nothing.** `session.fromPartition(PARTITION)` gets a
single `will-download` listener inside `initBrowserViews` — one, not one per
tab, since every tab shares that session. Nothing calls `setSavePath`, so
Electron shows its own save dialog and the operator makes the only decision
that matters. Progress is IPC (`browser-view:download`) and stops in
`browserStore.active`; only a `done` event reaches the gateway, via
`watchBrowserDownloads` (`services/browserDownloads.ts`). `done` is a separate
field from `state` because an `interrupted` mid-flight can still resume, and
`cancelled` — what dismissing the save dialog reports — is dropped rather than
recorded. **Reveal, never open:** `browser-view:reveal-download` answers false
for any path main did not itself watch that dialog write, so the renderer has
no directory-listing oracle over the disk; the set is persisted to
`browser-downloads.json` under `userData/gateway` so a Reveal that worked
yesterday still works today. `browser-view:open-external` is the one way out of
the panel, behind the same http(s) line every other entry point draws.

The rules that decide what gets written down — `visitOf`, `visitKey`,
`foldVisit`, `downloadAction` — live in `utils/browserRecording.ts`, pure and
dependency-free, because a rule that can only be exercised by driving Electron
is a rule nobody exercises. The subscriptions are the wiring around them.

**Take screenshot, clear, and the bookmark bar** (2026-09-10). Three gaps the
panel had against a real browser's chrome, all in `More`:

* **Take screenshot** is the operator's picture, and it is deliberately not the
  agent's. `page_screenshot` gives a model a **jpeg of the viewport** sized for
  a turn's context; this asks the same CDP layer for a **full-page PNG**
  (`browserCdp.cjs` `screenshot({ fullPage: true, format: "png" })`), because
  this one ends as a file somebody opens at 200% to read the small print.
  Nothing on the agent's path can ask for PNG — `browser-agent.js` has no field
  it could travel in. Main saves it through **Electron's own save dialog**, the
  same posture downloads take, and the path it hands back is passed to
  `remember()`, so "Show in Finder" reveals a file main watched itself write.
  A screenshot taken in a private tab is revealable for the session and is not
  written to `browser-downloads.json`, exactly like a private download.
  `dataUrlBytes` refuses anything that is not a base64 png or jpeg, because that
  string decides the contents of a file the operator named.
* **Clear cookies / Clear cache** run on **both** partitions.
  `clearDataPlan(kind)` is the whole decision and it is pure: `cookies` →
  `clearStorageData({ storages: ["cookies"] })` plus `clearAuthCache()` — a
  stored Basic-auth credential is the same promise as a session cookie — and
  `cache` → `clearCache()`. Nothing else is reachable through the channel; in
  particular `history` is **not**, because history is a gateway file the
  assistant reads rather than session state, and it is still cleared through
  `browserStore.clearHistory`. Three plain menu items rather than one "Clear
  browsing data…" dialog: each is one sentence long. Because none of the three
  changes anything on screen, each one says so afterwards in a **notice strip**
  — the same shape as the passkey notice, dismissible, and the strip the
  screenshot's path and its Reveal are drawn in too.
* **Show bookmark bar** is a strip under the toolbar wearing the home page's
  own `Mark` (exported from `BrowserHome` rather than drawn twice, so a site is
  the same colour on both surfaces). It is drawn *above* the viewport box, not
  over the page — nothing can be drawn over the page — so it takes height from
  the rectangle reported to main and the resize observer moves the view down.
  The flag is app-wide and persisted in `store/browserPrefsStore.ts`, not in
  `browserStore` (which holds nothing on disk on purpose) and not per tab (a bar
  in one tab and not the next reads as a bug). Off by default, and **not offered
  on a private tab**, for the reason its home page shows no bookmarks either.

Tested in `tests/browser-view.test.mjs` (6): the scheme refusals on both sides,
the zoom scaling, the malformed-rectangle refusal, and the clamping; in
`tests/browser-data.test.mjs` (10): the store's refusals, the visit folding,
the caps, the history search, and which browser tools are pre-approved; and in
`tests/browser-panel.test.mjs` (19): what counts as a visit, the title in the
dedupe key, the cache's fold and cap, in-flight versus finished downloads, the
dropped `cancelled`, the two halves of the reveal guard, the recent list's
folding, the screenshot filename a page cannot steer, what `dataUrlBytes`
refuses, and what each clear covers.

### What the workspace will open (`server/workspace.js`, `panels/FilePane.tsx`)

One predicate answers "is this text?" — `isTextFile` — and the tree, the reader,
the writer, the delete path and search all ask it. They read the extension table
separately before, which was survivable only while an extension was the whole
answer; the moment a file could qualify by its **name** they would have
disagreed, and a disagreement here means the dock offering a reject that cannot
run. `TEXT_FILENAMES` is what admits `.gitignore`, `Dockerfile`, `Makefile` and
their kind. `.env` is deliberately absent: it is text, but it is the one text
file whose contents are usually secrets.

A second predicate, `isPreviewFile`, marks what is readable **as bytes only** —
images, `.pdf`, `.xls`/`.xlsx`. Those come back base64 under a real mime type,
appear in the tree, and are never writable: `writeWorkspaceFile` still refuses
them, so nothing can overwrite a picture with utf8 and no dock row is ever
offered for one. `.svg` stays on the text side, because it is markup an operator
is more likely to edit than to look at.

`FilePane` turns base64 into one object URL and shows it — an `<img>` for an
image, an `<iframe>` for a PDF, which in the desktop app is Chromium's own
viewer (paging, zoom, find, print, and no dependency to keep current). That
viewer is a plugin and is **off by default**: `plugins: true` in
`electron/main.cjs` and this pane have to move together, because without the
flag the frame renders blank rather than failing. A third predicate,
`isStreamableWorkspaceFile`, marks video and audio: viewable, listed, opened by
`open_file`, and refused by this reader in favour of the streaming protocol
above. The 8 MB read cap is unchanged and applies to the reader only.

Tested in `tests/workspace-files.test.mjs` (14) and
`tests/workspace-media.test.mjs` (16).

### The conversation surface (`components/chat/**`)

A turn is read in a fixed order, and the components are laid out to enforce it:
**what it did**, then **what it said**, then — only on hover — **what it cost**.

| Piece | File | What it is |
| --- | --- | --- |
| Process inspector | `chat/ProcessWatcher.tsx` | The live activity strip above a reply, and the stop control. |
| Activity naming | `services/activityGroups.ts` | Pure: a call's glyph, its row text, and the file it touched. |
| Turn | `chat/MessageBlock.tsx` | Prompt, reply, code cards, hover telemetry. |
| Code card | `chat/FileActionCard.tsx` | A 28px row that opens onto the code. |
| Waiting line | `chat/ThinkingIndicator.tsx` | The gap before the first token. Carries no stop. |
| Interruption | `services/interruption.ts` | Pure: what a stopped turn looks like, and when `Esc` means stop. |
| Review dock | `chat/ChangeReviewDock.tsx` | Accept / reject what was written to disk, by the chat pane or by an agent CLI. |
| Markdown | `chat/CursorMarkdownRenderer.tsx`, `services/markdown.ts` | Blocks and inline tokens. No `innerHTML`. `scale` picks the surface: `panel` here, `stage` on the voice screen. |
| Composer | `chat/Composer.tsx`, `chat/AttachmentStrip.tsx` | The prompt field and what is attached to it. |
| Pending set | `store/changeStore.ts`, `services/changeSet.ts` | The changes, and the arithmetic behind them. |

**One row per call, in the order they happened (2026-09-06).** This used to
fold consecutive calls of one kind into a single row — "Ran 6 commands",
"Explored 3 files, 1 search" — on the argument that twelve rows is a wall. It
is, and the wall turned out to be the point: folding put two clicks between the
operator and "what is it doing right now?", which is the only question this
strip exists to answer. Holding it beside the same run in an editor's agent
panel, the operator: *"it is always like this on vscode, antigravity, but not
here."* So `groupActivity` is gone; `classifyCall` still decides which glyph a
row wears and `describeCall` still writes its text, but nothing is merged and
the order the assistant read, ran and edited in survives exactly.

**A row opens onto `in` and `out`.** The arguments and the result, each under
its own caption — an unlabelled pair of grey blocks makes the reader work out
which is which every time. A failed call labels its second block `error` and
tints it, so the outcome is legible without opening anything else.

**`result` means the same thing in all three lanes: what came back
(2026-09-06).** The fold above and `describeToolCall` (§6) are the two readers
of `ToolCall.result`, and they were being fed different substance depending on
which lane ran the tool. Both agent CLIs put a tool's real output there —
Codex's `aggregated_output`, Claude Code's `tool_result` content, converged by
`emitCall` in `services/agentCliService.ts`. The local lane's shell runner sent
only `exit 0 · 412 ms` and kept the output for the model's next turn, so in
the lane the operator uses most the `out` fold showed a status line, and the
narrator's failure check — which reads the output text precisely because an
exit code is not the whole truth — had nothing to read. Measured on a run
that exits 0 while printing `2 failed, 8 passed`: the fold showed
`exit 0 · 900 ms` and the assistant said *“Tests passed.”*
`runAgentCommands` (`services/agentCommands.ts`) now leads with the exit line
and follows it with the output, capped at the lane's tool-result allowance (see
**The context budget** below); the same run now shows the failure and says
*“Tests failed — looking at that.”* The exit line is kept and leads because it
is worth knowing and no lane carries it otherwise. `videoToolCalls.ts` and
`playerToolCalls.ts` already put a real result in the field and are unchanged.
Pinned end to end — emitter through narrator — in
`tests/agent-commands.test.mjs`.

**The context budget** (`services/contextBudget.ts`). Every character Teminali
puts in front of a local model is a share of the window that model actually
has, never a constant. The measurement that forced this, taken on
`frontier-qwen2.5-coder-14b-8k` by asking it to tokenise its own prompt: the
assembled system prompt was **3,127 tokens — 38% of an 8,192-token window** —
before one message of history, the operator's sentence, or a tool result. Six
history messages at the old 4,000-character cap could add another ~5,000
tokens, so the window overflowed before the prompt being answered was even
appended. Asked to play a song with the player fence wired, the model answered
in prose and emitted no fence: there was no room to think in.

The mechanism is one module and per-lane calibration. `budgetFor(engine,
windowTokens)` derives four limits from the window — system prompt 25%,
history 30%, any single message 12%, one tool result 10%, the rest left for the
answer — at a chars-per-token rate that was measured, not assumed (4.63 on the
real prompt; tool output is planned at a pessimistic 3.2). The local lane's
window is `selection.contextTokens`, the `-8k`/`-32k` its Modelfile pins.
`assemblePrompt` takes the system prompt as **named sections in priority order**
and drops whole sections from the tail when the budget is spent — never
mid-sentence, because a model follows the half it can see — and reports what it
dropped in `InferenceTelemetry.contextBudget`. `fitHistory` keeps turns newest
first within their share, clamping each on its own so one pasted file cannot
evict the turns around it. The ranking is written down in
`frontierEngine.ts`: the operator's contract and the live state of any mounted
surface are `required`; the concise doctrine outranks the long mandate that
says the same thing; the visual house style is last because it matters only
when authoring UI and was costing every "play that song" turn 1,858
characters. Measured after, same model, same prompt: **1,848 tokens, 23%** at
8k with five sections dropped; at 32k everything fits at 11%.

And the turn itself, re-measured the way the failure was found — the same
model, a two-message history, the player showing *Beyoncé — Halo.mp4*, and the
prompt "play a beyonce song", twice each. **Before: no `player-tool` fence in
either run** — one narrated "I'm playing Halo.mp4" with nothing sent to the
player, the other ran `ls /path/to/media/pool/Beyoncé/*.mp4`, a path it
invented. **After: a `player-tool` fence in both**, the second the ideal
`episode 1` then `play`. Prompt evaluation fell from 13.7–25.1 s to 3.3–4.0 s,
because there was half as much prompt to evaluate; that is the speed cost the
old prompt was charging every local turn.

**The CLI lanes are deliberately not governed.** Claude Code and Codex compact
their own context against their own windows; a cap sized for an 8k local model
would starve a 200k one and discard detail the agent's own compactor kept. So
they get the same shape of budget from their real window — `governed: false`,
every ceiling more than four times the largest local window's — and nothing in
`agentCliService` truncates. One mechanism, not two, and on those lanes it is a
number they can be asked for rather than a knife. Pinned in
`tests/context-budget.test.mjs`.

**The local-lane eval** (`evals/local-lane.mjs`, `npm run eval:local`). "Better
results" has no completion date without a fixed set and a number, so the lane
has one: twenty-five turns, from play/pause/louder and what's on the timeline
through disk space, a git branch and a live price, to writing a file, editing a
long one, fetching a page, asking the operator for a choice, *not* asking for
something measurable, and looking at the screen — each graded by the code's own
parsers, so a fence the harness accepts is one the engine would have run. The
prompt is `composeSystemPrompt` (`services/systemPrompt.ts`), the function the
engine calls, pulled out of the engine for exactly this reason: a copy would
drift. The editor tool list is the real manifest, bundled by esbuild because
`toolRegistry` drags in the ported editor. Two runs a case by default, the
engine's own sampling, and the model's actual reply printed beside every
failure. It is a measurement, not a test — it never fails the build unless
asked to with `--gate`.

Its first day paid for it three times. At 77% it showed the player's
"RIGHT NOW" line never named the **title** inside a series (so "what's
playing?" had no answer) nor the **volume** (so "turn it up a bit" from 80%
got a guess of 75%); `describeLivePlayer` now states both. At 91% the one
failure was a refusal of "what's the bitcoin price right now?" with *"I don't
have real-time data access"* — the sentence the 3,138-character mandate
forbids, which no longer fits an 8k window once the editor and player are both
mounted — so a `[LIVE DATA]` section carries that one rule at a tenth of the
length, ranked where it fits. And then the surprise: giving the prompt 25% of
the window instead of 22% made the score *fall* to 71%, because the section
that newly fitted was the step-explanation mandate, and the model obeyed it
literally — *"I'm pausing the playback"*, *"I'll use a real-time API call"* —
and ended the turn with no fence. The sentence had become the action. It is
now `[SAY, THEN DO — IN THE SAME REPLY]`, with the whole shape shown and the
rule that a reply with no fence has done nothing. **36/36** after that — twelve
cases, three runs each — at ~2,130 prompt tokens, 26% of the window, with both
surfaces mounted. (Four cases have since been added with the ask contract and
the catalogue trim; the current figure is **48/48** over sixteen.)

The strip is **open while the turn is live and closes when it settles**. During
the turn it is the only thing to look at; afterwards it is a footnote under the
answer.

**Telemetry is hover-revealed.** Engine, tokens, duration and cost are all
measured and all real; none of them is what anyone is reading, and six fields
under every reply at full contrast is what made the column feel like a log.

**The waiting sweep is monochrome.** `.text-shimmer` in `index.css` runs
`--text-soft` through `--text-bright`. It was a cyan → violet → amber gradient,
which made a background process the brightest object in a window whose entire
palette is five greys.

**A long block collapses instead of burying the answer.** A directory listing
comes back as eighty bullets and pushes the sentence that followed it off the
screen. `CursorMarkdownRenderer` renders the first 8 of a list over 12 items,
and the first 8 rows of a table over 12, behind a "Show N more items" toggle —
the thresholds are `LIST_COLLAPSE_AT` / `TABLE_COLLAPSE_AT` in that file, and
they are set so an ordinary prose list of steps or options is never touched. A
toggle on a five-item list is friction for nothing. Expansion is keyed by block
index, so a block the reader opens stays open as later blocks stream in. Code
blocks were already capped, by `CodeSnippet`'s 200px scroll.

**A short block opens; a long one stays a card.** Collapsing every settled
fenced block was right for a rewritten file and wrong for the common case: a
one-line command arrived as a card reading "bash · 1 line · Expand", which hid
the only thing the reader wanted. `SHORT_SNIPPET_LINES` in `ui/CodeSnippet.tsx`
is 6 — at or under it the block opens and stays open, above it the card wins,
and a manual toggle still beats both.

**Intraword underscores are not emphasis.** `mature_romance_skill_v3.zip` is a
filename, not three italic runs with the underscores eaten. The inline pattern
in `services/markdown.ts` guards `_` with a word-boundary lookaround, per
CommonMark; `*` is left alone, where intraword emphasis is legal.

**The composer is a pill only while it is one row high.** A pill's radius is
half its height, so a follow-up bar that gained an attachment card or a wrapped
second line turned into a lozenge. `Composer.tsx` derives `pill` from the
measured field height and the attachment count, and falls back to `rounded-2xl`
the moment the bar grows. The collapsed bar is unchanged.

### Temy, the face of the voice assistant (`voice/VoiceOrb.tsx`, `utils/orbExpression.ts`, 2026-09-06)

The operator, watching it while they talked to it: *"when i speak make her look
like he is listening instead of showing his mouth move, how can his mouth move
and i'm the one talking."* They were right, and the cause was structural. The
orb has one `level` prop that carries the microphone while the operator is
heard and the synthesiser while Temy speaks, and the state says whose it is —
and the first version ran an "equaliser" on the mouth in hearing mode. The
operator's own words came back to them as Temy's lips.

**Whose sound is it** is now the rule the whole face is built on, and it lives
in `utils/orbExpression.ts` — pure, dependency-free, and pinned by
`tests/orb-expression.test.mjs` (4): `mouthFor("hearing", 1)` equals
`mouthFor("hearing", 0)`, for every state but `speaking`. Only Temy's own
voice may reach the mouth. The operator's voice shows in the **aura** — a
radial glow behind the face, smoothed with a fast attack and a slow release
so it reads as breath rather than flicker — and nowhere on the face itself.
Each state therefore has its own tell, and they do not share body parts:

| state | the tell |
| --- | --- |
| idle | a slow breath (`orbBreathe`, 4.2 s), a blink every 4.5 s, and now and then the eyes wander off and come back |
| listening | the same, a little brighter, eyes forward |
| **hearing** | the face leans in (`rotateX(-3.5°)`, scale 1.035), the eyes widen to 1.1 and hold still on the operator — the pointer is ignored for gaze — the mouth closes, the blink slows to every 6.5 s, and the aura breathes with the operator |
| thinking | a thin arc orbits behind the face (`orbThink`, 2.4 s), the eyes go asymmetric the way a person's do looking for a word; the arc stops the instant there is an answer |
| speaking | phonemic visemes from the caption, gated at `SPEECH_FLOOR` (0.035) and sized by Temy's own level; the aura pulses with it |

Breath is a CSS animation on an outer layer, drift a CSS animation on the layer
outside that, and posture an inline transform on the innermost, so the three
never fight over `transform`. Drift (`orbFloat`, 5.6 s, a period that does not
divide the breath's) runs only while `breathFor` returns `breathe` — a listener
who keeps bobbing is not listening, and speaking and thinking have motion of
their own.

#### Nonsense never reaches the chat: three layers, one model call (2026-09-06)

The operator said *"How are you?"* and the transcript read **"Bagaimana anda
lakukan?"** — fluent Indonesian, a translation of what they had actually said.
*"make sure it never sends nonsense to the chat… ignore any text that is purely
nonsense or hallucinated language."*

Every existing filter passed it, and each was right to: it does not repeat, it
is not an artefact phrase, every word is pronounceable, and the recogniser was
confident. It was wrong for exactly one reason, and that reason had been
arriving with every result and being thrown away — whisper reports the language
it decoded, and `onResult` named the parameter **`_language`**.

The gate is now three layers, cheapest first, and only the last one costs
anything:

| layer | catches | cost |
| --- | --- | --- |
| `plausibility.ts` — repetition, dominance, artefact phrases, coherence, confidence | loops, subtitle credits, gibberish, empty rooms | free, synchronous |
| `plausibility.ts` — **foreign language** | a fluent sentence in a language the operator does not speak | free, synchronous |
| `addressing.ts` — the classifier's **NONSENSE** verdict | noise decoded into real words, *in the right language* | a round trip already being paid |

**The foreign-language rule rejects outright, and is deliberately not softened
by confidence.** The doctrine at the head of `plausibility.ts` applies here more
than anywhere: the recogniser is not unsure when it hallucinates, it is
confident — measured, a "tk tk tk" loop decoded at a mean token probability of
0.893, better than the real sentence beside it. Language detection on a short
utterance is the least reliable thing whisper does, and a sentence in a language
the operator does not speak is not something they said, however sure the decoder
was.

The bias against false rejection lives in the *expectation* instead of in a
threshold. `expectedLanguages()` returns the pinned language setting when there
is one — an exact answer, and the setting under which the recogniser cannot
disagree at all, since a recogniser that is told the language reports the
language it was told. On `auto` (the default, and the only setting where this
can happen) it returns `navigator.languages`: the operating system's own ordered
list of what this person reads and speaks. That is why the rule can afford to
reject outright — the list is the operator's, not a guess. An unknown language
or an unknown expectation rejects nothing.

**The model layer costs no extra latency.** The addressing classifier already
ran on every utterance the cheap signals could not place, so `NONSENSE` joins
`ASSISTANT` / `PERSON` / `UNCLEAR` on a round trip that was being paid for
anyway — no second call, and no cost at all on the turns the deterministic
layers have already settled. The word list is closed and the answers are single
words on purpose: a small local model asked for one of four tokens is fast and
hard to derail. `parseClassifier` checks `NONSENSE` first, so a model that leads
with its verdict and then explains — *"NONSENSE — not addressed to the
assistant"* — is not read as the word it happened to mention second.

Pinned by `tests/voice-plausibility.test.mjs` (20) and `tests/voice.test.mjs`
(54): a confident Indonesian decode is refused at every confidence from 0.2 to
1.0; `en` passes against `en-US` and `sw-KE` against `sw-TZ`, so region tags
never cause a false rejection; and an unknown language rejects nothing.

**Still open.** The default language setting is `auto`, which is the only
configuration where the recogniser can decode a language the operator did not
speak. Pinning it is one click in voice settings and removes the failure at its
source rather than filtering it afterwards.

#### One pair of ears: the second recogniser that heard everything twice (2026-09-06)

The operator, having said it once: *"How are you doing? How are you doing?"* —
*"how did it hear me twice?"*

`reopen()` awaits `asr.listen()`, and every caller tests `!this.session?.active`
**before** that await. Two reopens racing the same gap therefore both pass the
test, both open a recogniser, and the second assignment to `this.session`
orphans the first. Nothing stops the orphan: it keeps running on the same
microphone with its handler still pointing at `onResult`, so one utterance
arrives as two finals — and `onResult` builds a turn by *appending* finals, so
the sentence is written down twice. `finishSpeaking()` reopening while the
`setState("listening")` subscriber reopens is one such pair; there are six call
sites and no mutual exclusion between any of them.

`webSpeech.ts` already guards this exact symptom, and its comment quotes the
same doubled sentences — but `finalsDelivered` is per-session and cannot see a
second session. **Two ways to hear double, two guards.** `reopen()` now refuses
to re-enter while one is in flight, aborts whatever session it is about to
replace so nothing outlives the assignment, and — since the state can change
while a recogniser opens — abandons a session that arrives after voice mode was
switched off, which used to bring the microphone back up with no reference held
to close it.

**No transcript-level de-duplication was added, deliberately.** Collapsing a
final that repeats the one before it would also collapse an operator who
genuinely said "no no", and the fix for two recognisers is one recogniser.
`approvalIntent.ts` collapses a repetition only because a doubled "yes" gates a
permission prompt, where the trade is worth making.

Not covered by a test: the engine needs `window`, an `AudioContext` and live
providers, and there is no harness that constructs one — every voice test
imports pure modules. `stillWanted()` is a method rather than an inline
`this.state !== "idle"` because the compiler narrows a `this` property from the
guard at the top of `reopen` and never widens it across the `await`, so inline
the post-open check compiles as dead code — precisely the case it exists for.

#### The composer's engine trigger wore Max's padlock (2026-09-06)

The operator, on the composer: *"why do we have a lock icon instead of a model
icon on the prompt input field?"* `ModelPicker` keys a glyph per profile —
`flash` a `Zap`, `auto` `Sparkles`, `max` a `Lock` — and the composer's trigger
drew a hardcoded `Lock` next to whichever profile was actually selected. Max's
padlock is real and earned (*"Locked until safety qualification"*); Flash and
Auto were wearing it for nothing, and a padlock on the engine you are currently
running reads as *unavailable*.

The map is exported as `PROFILE_ICONS` and the trigger reads from it, so there
is one place a profile's glyph is chosen rather than two that can disagree.

#### Speaking begins when a clause is audible, not when we decide to speak (2026-09-06)

The operator: *"on some occasions if not all, the chatbot starts talking before
the voice is starting to get heard."* Structural, and on every turn that had an
immediate acknowledgement. Each of the four speak paths — greeting, reply queue,
its built-in fallback, and `speakAside` — called `setState("speaking")` and
`setDucked(true)` *before* `await tts.speak(...)`, and `speak()` does not
resolve until the sidecar has rendered and scheduled the first clause. The HUD
announced speech, the orb wore its speaking face, and other audio ducked, for
the whole of that request.

`SpeakOptions.onStart` already existed and both providers already fired it on
the first scheduled clause; nothing passed one. `beginAudibleSpeech()` is now
that listener, and it is the only thing that sets `speaking`. **The state says
what the operator can hear, not what we intend** — the render window is
thinking, and is shown as thinking. `resumeSuspendedSpeech` follows the same
rule.

Two guards had to move with it, because the window is no longer `speaking`:
the playback watchdog also accepts `speechPending`, or a synthesiser that never
answers would never be given up on; and the greeting's failure path returns to
`listening` from `thinking` as well.

**A barge-in during that window used to be lost.** `dropSpeech()` cancels
`this.synthesis`, which is null until `speak()` resolves — so a reply the
operator had already talked over began playing the instant its render landed.
`speechEpoch` is bumped by every drop, and a `speak()` whose epoch is stale by
the time it resolves cancels its handle instead of speaking it.

#### The body is a ball (2026-09-06)

The body was a squircle: the app-icon tile, drawn a second time. A tile is a
logo and sits still. A ball has a side facing you, so everything the face
already did — leaning toward the pointer, widening at the operator, wandering
off and coming back — now reads as a head turning rather than as a card being
nudged. **The mark itself is untouched**: the same `> _ <` at the same
coordinates, held at `scale(0.93)` and travelling 1.12× the gaze so it reads as
painted on a curved front face rather than as a decal on a flat one.

Sphericity is carried by light *on* the body, in four layers under the face —
drop any one and the ball flattens back into a shaded circle:

| layer | what it does |
| --- | --- |
| body | a key light fixed at the upper left, falling through `#43434a` to black |
| bounce | a dim white return off the surface below, so the lower edge does not die into the page |
| occlusion | darkness gathering from 60 % of the radius outward |
| specular | a blurred hotspot plus its sheen, offset by `-tilt × 0.55` — the light stays in the room while the head turns, and that counter-motion is most of what separates a sphere from a disc |

Gradient ids are namespaced per instance off `useId()`. Two orbs are on screen
at once — the composer's and the HUD's — often in different states, and shared
ids let whichever mounted last repaint the other in its emotion.

**Nothing is drawn around the edge, and the glow is for sound.** The operator,
in three passes: the green halo, then the white rim, then the black shadow —
*"remove the borders from the orb completely, not just the green even the
white… if you really want to keep the glow use a white glow, but not too
light."* All three are gone. A stroke around a sphere is a circle drawn on top
of it, and it flattens the ball it was meant to finish; a glow that is on in
every state says nothing when it comes on. What remains is one dim white halo
behind the body, fixed and stateless, which is the only thing keeping a black
ball off a `#151515` page — and the coloured **aura**, which is now rendered
only while `hearing` or `speaking`, so its arrival *is* the signal. Idle,
listening and hover are the bare ball; thinking keeps its orbiting arc and
nothing else. `auraFor` is unchanged — it still answers *how much glow for this
level*, and the component answers *whether there is a voice to show at all*.

**The pointer is an eye, not a hand.** The face tracks the cursor and leans
toward it slightly when hovered. The earlier version also dodged, hopped and
jumped away from a pointer that came close — charming once, and a control that
runs from the click it exists to receive breaks the first rule of controls
(§2, *no dead affordances*). Gone; `hoverMode` and `jumpOffset` with it.

#### Nothing listens while idle, so the orb stopped saying it did (2026-09-06)

The orb's badge read *Say "Hey Temy"* while the voice conversation was idle,
and the operator reported it did not work. It could not: nothing holds the
microphone open before a conversation starts, so the phrase reached no
recogniser. Worse, `goToSleep` — the one-minute inactivity exit — said "just
say 'Hey Temy' when you need me" and then called `stop()`, so the last thing
Temy said before going deaf was an invitation to talk to her.

Every idle-state promise is gone: the badge is "Tap to talk", the orb's title
says what clicking does, and the sleep lines point at the orb. **The wake word
itself stays**, because it is a different thing that does work — one of the
signals in `services/voice/addressing.ts` that decides whether live speech was
addressed to Temy rather than to someone else in the room or to a video the app
is playing. Removing that would reopen the loopback problem; removing the
badge only stops the app claiming a capability it does not have (§2, no dead
affordances).

### Stopping a turn (`services/interruption.ts`, 2026-09-06)

Reported as "I cannot interrupt the chatbot on the go … it is either weak or
just broken". It was both, in four separate places, and none of them was the
transport: the gateway has always cancelled its upstream when the client's
fetch aborts (`abortContext`, `abortWhenClientLeaves` in `server/gateway.js`)
and `server/agent-cli.js` has always `SIGTERM`ed the CLI on `AGENT_ABORTED`.
What was broken was every route to that abort.

**The control has to outlive the first tool call.** The stop button lived in
`ThinkingIndicator`, which `MessageBlock` mounts only while
`calls.length === 0 && !content.trim()` — so it vanished the instant a token or
a tool call arrived, which is precisely when a run becomes worth stopping. A
turn sitting at *Working · 2 steps · 25s* had no stop anywhere on screen. It
now belongs to `ProcessWatcher`, the one strip that is rendered for the whole
of a live turn; `ThinkingIndicator` is the waiting vocabulary and nothing else.

**Stop is never traded away for send.** While streaming, the composer's disc
became "interrupt and send" the moment anything was typed into the field — so
starting to draft the correction removed the only other way to stop. Both are
drawn now, stop first.

**`Esc` was refused exactly where it is pressed.** The shell's handler ignored
the key whenever the target was an `INPUT` or `TEXTAREA`. The composer *is* a
textarea, it is autofocused, and it keeps focus after a prompt is sent. The
guard was aimed at the fields that are *not* the chat — the terminal's command
line, a search box — so the question is not "is this a field" but "is this the
chat", which the surface's own root element answers. `interruptsRun` holds the
rule: not while an IME is composing, not when something nearer already claimed
the key (which is how the `/` and `@` menu keeps `Esc` for closing itself), and
otherwise inside the chat surface, or anywhere that is not a text field. The
wiring — where the keystroke landed, and the listener's life — is
`hooks/useInterruptKey.ts`, which listens only while its surface is streaming,
so an idle tab cannot swallow `Esc` from a live one.

**One routine, not four.** `send`'s pre-empt, the voice host's `interrupt`, the
stop button and the stream's own abort path each carried their own copy of the
same three lines, and they had drifted. They are one `stop` in `StudioChat`
now, in a fixed order: retire the turn id, abort, cancel the approval gate,
clear `isStreaming`, patch the message, silence the voice. The gate call was in
none of the copies — a run blocked on `CommandApprovalPrompt` kept the prompt
on screen and left `createApprovalGate`'s promise unresolved for good.

**A stopped turn tells the truth about itself.** `interruptTurn` keeps what
arrived — it is real work — sets `cancelled` (a field that had been declared in
`types/index.ts` and never once written), and settles every tool call still
reporting `running` to `error` with "Stopped by the operator." The strip reads
its glyphs straight off `status`, so a call left running was a spinner that
turned forever under a finished turn. `MessageBlock` draws one quiet line —
*Stopped — this reply is incomplete.* — under a partial answer; a turn that
produced nothing says `Interrupted.` as its content instead, because an empty
assistant message is what the *next* turn carries into the model's history.

**Three chat surfaces, one stop.** The main conversation is not the only place
a run streams: an agent tab (`workspace/panels/AgentPane.tsx`) and a side chat
(`SideChatPane.tsx`) each drive their own. Both used to stop with a bare
`patchLast({ isStreaming: false })` — no settle, so an agent tab stopped
mid-tool-call left its strip spinning; no `Esc`, because the shell's listener
was gated on the main chat's `isStreaming` and scoped to its column. Both now
hand `interruptTurn` to `patchLast` (widened to take an updater, the same shape
the store's `updateLastMessageInEngine` takes), release `abortRef`, and call
`useInterruptKey` with their own root. `tests/interruption.test.mjs` asserts
all three call the hook and that none keeps a `keydown` listener of its own.

### Accept and reject (`chat/ChangeReviewDock.tsx`, `store/changeStore.ts`)

The assistant edits the working tree directly — that is the point of it — so
review here cannot mean staging a patch that has not landed. It means the edit
is on disk, it is listed above the composer, and one click puts the file back.

* **`before` is captured once.** `liveEditService` already reads a file before
  it writes it, to play the edit back against; it now emits that content with
  the commit (`onCommit`). Two successive edits to one path collapse into one
  reviewable change whose `before` is still what was on disk when the turn
  started, so a reject restores the file the operator actually had — not the
  state halfway through the turn. Tested in `tests/change-review.test.mjs`.
* **Accept cannot fail, and it is the default in every direction.** The bytes
  are already written; accepting is the operator saying they have seen them.
  Ignoring the dock keeps the change, closing the app keeps it, and a set that
  outgrows its budget keeps it. Nothing here un-writes a file except `reject`,
  which the operator asked for by name.
* **The set is bounded, and overflow is an accept** (`trimChanges`,
  `MAX_PENDING_CHANGES` = 100, `MAX_PENDING_BYTES` = 32 MB). Both sides of every
  change are held in full so a reject can be exact, so an unreviewed session
  would otherwise grow without limit in the renderer. The oldest rows age out —
  their bytes stay on disk, only the offer to revert them goes — and the dock
  says how many, including after a "reject all" that would otherwise read as a
  clean slate it is not. One change larger than the whole budget is still shown.
* **Reject decides before it destroys** (`planReject`, tested). A row describes
  a transition: `before` became `after`. Reject is only meaningful while the
  second half is still true, so the file is re-read first and compared against
  `after`. If it has moved on — the operator saved over it, a later agent turn
  touched it, git checked something out underneath — the reject is **refused**
  and says why, because `before` is no longer the state immediately prior to
  what is there, and writing it would silently discard whatever came after. The
  write that follows is conditional on the mtime just read (`expectedModified`,
  409 from the gateway), which closes the gap between the read and the write. A
  file the assistant *created* that is already gone needs no write at all; a
  file it *edited* that has since been deleted is re-created, which destroys
  nothing.
* **Reject is a real write.** It restores `before`, or calls
  `POST /api/workspace/delete` when the assistant created the file — blanking a
  file the operator never asked for is not a restore. A row disappears only
  after the disk agrees; a reject that fails leaves the row and says why. One
  runs at a time, and every row's buttons are disabled while one is in flight:
  two in parallel would each read the disk before the other wrote it. `Reject
  all` reports every refusal, not just the last — each reject clears the
  previous one's error on its way past.
* **A dirty tab is never closed or written over by a reject.** Its buffer is the
  operator's own unsaved text; discarding that to undo the assistant would trade
  one loss for another.
* **An edit that lands the file back on its original content is not a change**
  and drops out of the set.
* **Nothing is persisted.** A `before` snapshot is only true of the disk it was
  read from. Restoring one across a restart, over whatever the operator did in
  between, would be the worst kind of confident wrong.
* **The set is workspace state, not conversation state.** One store backs every
  surface, so the dock is mounted above every composer — the main chat
  (`chat/StudioChat.tsx`), the side chat and the agent tabs
  (`panels/SideChatPane.tsx`, `panels/AgentPane.tsx`, both `width="fill"`) —
  and shows the same rows in each. A change made in one pane cannot be walked
  past by typing in another. The dock renders nothing when the set is empty.
* **Agent CLIs are in it too, by a different road** (`server/agent-edits.js`).
  The Frontier engine authors its edits and hands both sides to
  `liveEditService`. Claude Code and Codex write in their own process and only
  *tell* us afterwards, so the pair is recovered from their tool stream instead:
  a watcher beside the CLI's stdout reads the file in the same tick the tool
  line is parsed, reads it again when the tool settles, and puts an
  `{ type: "edit", path, before, after, existedBefore, size, modified }` event
  on the run's own NDJSON stream. `panels/AgentPane.tsx` and `chat/StudioChat.tsx`
  both record it with `origin: "agent"` and open the file, so the edit appears
  in the editor as it does for a change the chat authored itself. Reading on the server is the earliest snapshot anyone
  can take, and it is still a race — so it is checked rather than trusted:
    * `Edit` and `MultiEdit` are literal substitutions and therefore
      *invertible*. If the snapshot no longer contains `old_string` the write
      won, and `before` is reconstructed by undoing the edit on the result. An
      edit is exact either way.
    * A reversal that would be a guess is refused: `new_string` empty (the
      insertion site is gone from the result) or appearing more than once
      (which copy the tool wrote is unknowable). The change is dropped rather
      than shown wrong — a bad `before` looks like a clean diff and, on reject,
      writes a file that never existed.
    * `Write` replaces the whole file and has no inverse. A lost race there
      yields `before === after`, and that is dropped rather than listed as an
      empty diff.
    * Only paths `writeWorkspaceFile` would accept are watched — a row promises
      that reject restores the file, and anything outside its text set is a
      promise the dock cannot keep. Paths outside the workspace root are never
      watched at all. Files whose whole name is their extension (`.gitignore`,
      `Dockerfile`) were a standing gap here and are now admitted by name; an
      image or a PDF still is not, because it is readable but not writable.
    * 1 MB a side, not the workspace API's 8 MB: both sides travel the stream.
  Tested in `tests/agent-edits.test.mjs` (30) and end to end over a real spawn
  and a real file in `tests/agent-cli.test.mjs`.

### Agent tabs (`server/agent-cli.js`, `panels/AgentPane.tsx`)

Claude Code and Codex are not providers behind the chat box. Each is the
operator's own CLI, spawned as a real process in the workspace with its own
auth, its own tools and its own resumable session, driven in headless mode:

```
claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
codex exec --json --sandbox <mode> -C <cwd> <prompt>
```

Both streams are normalised to one event shape so a turn from either renders
with the same `MessageBlock`, tool timeline and telemetry footer as a local one.

Three rules, each of which cost a real debugging session to learn:

1. **Never add `claude --bare`.** It forces `ANTHROPIC_API_KEY` auth and fails
   outright for a subscription login.
2. **stdin must be closed, not inherited.** Both CLIs block on a pipe nothing
   will be written to.
3. **Take Claude's text from the `stream_event` deltas only.** The settled
   `assistant` message repeats the same prose; counting both doubles the reply.

**Model selection.** Neither CLI has a models endpoint — no `claude models`, no
`codex models`, and a bogus `--model` is rejected without the valid set being
printed. `server/agent-models.js` therefore assembles the list from the three
sources that are actually true: the CLI's documented aliases, the operator's own
config read at runtime, and **what the CLI reported it resolved**, harvested from
every turn's `system.init` and remembered. The picker labels which of those a
value came from, because a value we shipped must never be shown as one we
observed. This is not pedantry — the shipped guess for `haiku` was
`claude-haiku-4-5` and the CLI actually resolves it to `claude-haiku-4-5-20251001`.

The permission selector in the pane header is not decoration. These agents edit
files and run commands in a real repository, so how much they may do without
asking is the most consequential control on the surface: it stays visible, and
neither agent may ever default to its most permissive rung. `tests/agent-cli.test.mjs`
asserts that.

### Benchmark arena (`server/arena.js`, `panels/ArenaPane.tsx`)

Frontier against a challenger on the same task, each in its own sandbox, judged
by the agent that is not competing. Administrator-only: it runs agents that
write code and spends real money.

Three properties carry the whole thing:

1. **Isolation.** Each contestant gets a private copy of the *current* working
   tree — not HEAD, which on a dirty repo is a different codebase. ~3 MB and
   785 ms, with `node_modules` symlinked so tests actually run. Each sandbox is
   its own `git init`, deliberately not a worktree of the real repository: an
   agent loose in a worktree can damage the operator's `.git`; a fresh init
   cannot reach it.
2. **The watcher is the operator's choice, and self-grading is disclosed.**
   Either agent may judge, including one that is competing — the subject under
   test is Frontier, and locking the operator out of their preferred judge costs
   more than the bias does. When the watcher is also a contestant the run is
   marked `self-graded` on the verdict, and the watcher's brief tells it plainly
   that one of the diffs is its own.
3. **The diff is ground truth.** The transcript is what an assistant *claims* it
   did; `git diff` in its sandbox is what it did. The watcher is handed both and
   told which wins when they disagree.

The admin gate is enforced in the gateway, not the renderer — `requireAdmin`
guards every `/api/arena/*` route. Hiding the panel is a courtesy.

### The Teminali plan (`server/licence.js`, `panels/EntitlementSection.tsx`)

Top of the Usage panel, above the agent-CLI headroom, and labelled apart from
it. The two are adjacent because both are "what am I allowed", and separated
because they are bought from different people: this one is what the operator
bought from us, the one below is what is left of a subscription bought from
Anthropic. Stacked without labels, the obvious reading is that upgrading here
raises a Claude Code limit.

Three rules hold the component together, and each of them exists because a
paid-feature gate is exactly the code that rots into a lie:

1. **The feature list is never written in the component.** The capability
   catalogue arrives on `GET /api/entitlement`, which reads it from
   `licence/entitlements.js` — the same registry the gates enforce. A list
   typed into JSX is a list that silently stops matching the product. The test
   in `tests/entitlement.test.mjs` fails the file if a capability label appears
   in it as a string literal.
2. **Whether to offer an upgrade is a capability question, never a plan name.**
   The section offers a paid plan exactly when some plan on sale carries a
   capability this licence lacks. Adding a tier — Team, a trial, lifetime —
   needs no edit here, and a user who already holds everything a plan offers is
   never shown an upsell for it.
3. **A failure is never an upgrade prompt.** Every read fails to null and the
   whole section renders nothing. Telling an offline subscriber they are on Free
   is worse than telling them nothing.

The two rails answer in different shapes, and the difference is surfaced rather
than smoothed over, because it decides what the user does next: a card price
opens Stripe's hosted checkout in a browser and the panel says to come back and
refresh; a mobile-money price takes a phone number, pushes a prompt to the
handset, and polls the order every four seconds until it settles — then
refreshes the licence itself, because the money landing *is* the moment the
entitlement changed. Sign-in is the device-code flow: a code to type elsewhere,
polled at the interval the service asked for and never faster than 2s. That
poll stops on the first definite answer — granted, denied, expired, or a code
the service no longer knows — and keeps going only for the failures that a
later tick could plausibly fix.

A build with no `TEMINALI_BILLING_URL` still draws the capability list and says
plainly that it has no billing service, rather than offering a button that
would fail. That is the ordinary state of a development checkout, and the free
lanes need no account.

### Plan headroom (`server/plan.js`, `panels/UsagePane.tsx`)

A different question from the ledger below, so a different source. The ledger is
what this machine has spent; this is what the account has left — a number only
the provider knows.

Both halves come from the CLI rather than from the provider's API, because the
CLI already holds the operator's credentials and this process has no business
borrowing them out of their keychain entry:

- **Windows ride the turn.** `claude -p --output-format stream-json` emits a
  `rate_limit_event` carrying `unifiedWindows`; `normaliseClaude` lifts it into
  a `limits` event, and the gateway records it while streaming the turn. It
  costs no extra request, because that stream was already being parsed.
- **The account** is `claude auth status --json`, cached for a minute because it
  is a process spawn rather than a read.

Three things the panel has to say out loud rather than imply:

1. **A reading is stamped, never presented as live.** These windows move only
   when a turn runs, so the panel prints "as reported at 14:32". A bar with no
   timestamp claims a freshness it does not have.
2. **An empty meter is explained.** No windows means either "no turn yet" or
   "this login has no plan behind it" — an API-key turn emits nothing. Those are
   different states with different fixes, and the panel distinguishes them.
3. **Codex reports an account and no headroom.** `codex exec --json` emits no
   rate-limit event; its limits travel over the `codex app-server` protocol,
   which the studio does not speak. Drawing an empty Codex meter would read as
   "nothing used" rather than as "not knowable here", so none is drawn. (Its
   `login status` also prints to stderr with an empty stdout — observed, not
   assumed.)

This is the one place in the panel where colour stops meaning magnitude: past
90% a window's fill leaves `--chart` for `--danger`, because at that point the
number is no longer a measurement being read but a limit about to interrupt.

### Usage (`server/usage-ledger.js`, `panels/UsagePane.tsx`)

Append-only JSONL, one line per turn, aggregated on read. A running total in a
JSON blob has to be read-modify-written on every turn and loses one when two
finish together; an appended line cannot.

Two rules the panel exists to honour:

1. **The parts sum to the whole.** Per-model tokens include that model's cache
   reads and writes, so the per-model table adds up to the headline total. A
   dashboard whose parts do not reconcile is not trusted again.
2. **An unreported cost is null, never zero.** Codex bills against a ChatGPT
   subscription and returns no figure. Rendering that as `$0.00` claims the turn
   was free, so every bucket carries `costReported` and the panel says
   "not reported" instead.

Charts follow the `dataviz` skill: form chosen by the data's job (stat tiles for
averages, columns for the week, a table with magnitude bars for models — never a
dual axis), one validated hue (`--chart`, checked for chroma floor and 3:1
contrast on the dark surface rather than picked by eye), marks capped at 24px
with a 2px surface gap, and text on ink tokens so a label never wears the data
colour. Empty days are drawn as zero rows: dropping them compresses the axis and
makes a quiet week look busy.

### Video editor (`panels/VideoPane.tsx`, `src/video/**`)

**The editor is a panel, so its layout is a function of the panel's width — not
the window's, and not a designer's guess.** It opens at 452px beside a chat
column, the tab strip's expand button runs it out to the edge of the vertical
tab rail — `--panel-w-expanded` is `calc(100vw - var(--shell-left-inset))`, not
the flat 736px it was — and the panel edge drags to anything. While expanded the
chat is hidden rather than crushed, and stays mounted. Dragging short of that,
the chat keeps a `--chat-min-w` floor of 420px.

**That floor is enforced on every route to a width, not just on the drag.** The
store clamped `setWidth`, which is the only route it can see; a width restored
from a session on a wider window, and a window dragged narrower afterwards, both
arrive without passing through it. The shell does not scroll, so what runs past
the right edge is not awkward to reach but gone — 684px of the editor, its
inspector and meters and the end of its timeline, measured off-screen after
narrowing a 1600px window to 900px. `clampPanelWidth` is therefore applied where
the width is *rendered*, and the store keeps the width the operator chose, so it
comes back when the room does — the rule the splitter and the inspector's
minimize already follow. It measures `[data-chat-column]` and the gutter to
`[data-workspace-panel]` rather than deriving them: `--shell-left-inset` stops at
the sidebar's edge and counts neither splitter, and those two 2px gutters were
exactly what a derived clamp still spilled. The CSS variables remain the
pre-paint fallback. A media query would answer about the display while the editor
lives in a third of one; a 452px panel on a 5K monitor is the *narrowest* case
and `@media` would call it the widest.

So the pane measures itself with a `ResizeObserver`, resolves a tier through
`src/video/hooks/useDensity.tsx`, publishes it on a context, and stamps it on
the root as `data-tier` / `data-vtier` for the stylesheet. **One measurement,
one answer.** The four ad-hoc width checks that preceded it — the pane's own
two-column minimum, `ClipBlock`'s 72px, `TrackHeader`'s 46px, and the toolbars'
none at all — were four thresholds measured against four different boxes, and
they could not agree. The visible consequence was the panel drawing a toolbar
built for 1200px: "Delete" clipped to "Du", the zoom slider under its own
readout, the Add-track button off the end.

| Tier | Width | The upper band |
| --- | --- | --- |
| `xs` | < 460 | monitor only; library and inspector are summoned, the inspector as a bottom sheet |
| `sm` | 460–639 | monitor only; both visit as side overlays |
| `md` | 640–899 | monitor │ inspector; the library visits |
| `lg` | ≥ 900 | library │ monitor │ inspector — the desktop editor |

`data-vtier` (`short` < 460, `mid`, `tall` ≥ 680) is independent, because a pane
can be wide and short and a 291px timeline in a 360px-tall pane leaves no
monitor at any width.

**Nothing is removed at any width; only the number of clicks changes.** That is
the whole of the mobile lesson and it is enforced, not intended:
`TimelineToolbar` is a *list* of 12 tools, each declaring the tier from which it
earns a seat on the bar, and `onBar` / `inMenu` are complements over that list —
so a tool that leaves the bar is in the overflow menu by construction, carrying
its label and its shortcut. `tests/responsive-layout.test.mjs` asserts the
partition is total and that split, delete and snap keep their seats at every
width. The same folding applies to the monitor's five overlay switches (one
`Eye` button with the on-count as a badge, below `lg`) and to the track gutter,
which drops 160px to 62px by moving the lane name to a tooltip and solo/lock
into the row menu it already had.

**Labels are the first thing bought with width and the first thing sold.** They
appear at `lg` only. Icons never leave.

**The tightest tier gets bigger controls, not smaller ones.** `--h-xs` / `--h-sm`
/ `--h-md` step up under `[data-tier='xs']`. A narrow pane is the one being used
in a hurry or on a touch display, and shrinking a 22px target because the pane
shrank is exactly backwards; the buttons could afford it because they had
already stopped carrying labels.

**The band and the timeline are separated by a real splitter** (`.editor-splitter`
— 6px of grab, 1px of line, arrow keys, double-click to reset). The height was
derived from the pane's before, which is defensible at 291px on a desktop and
useless in a 380px panel where the only two useful answers are "mostly monitor"
and "mostly lanes". A dragged height is kept and only ever clamped, so a choice
made when the panel was tall cannot strand the monitor when it is short.

**The transport is a two-row grid, and the play button is the centre of it.**
The row had been one line of three groups — timecode, transport, marking — and
at `md`/`lg` that is 527px of content in a 320–324px row: all three groups
overlapping by 15–16px. The rails take the pane's extra width, so the monitor
column stays ~480px at both tiers and the master meters take 159px of it, which
is why the two *wider* tiers were the ones that broke and `xs`, where the meters
are hidden, was fine. The fix is `'time actions' / 'transport transport'` at
every tier, with a 336px floor under the transport so the meters yield first;
they shrink to ~105px and stay visible. The play disc is then centred in the
pane to within a pixel at all four tiers, measured in the running app rather
than reasoned about — an earlier diagnosis of this same row was argued from the
markup and was simply wrong. **The disc's colour is constant brand green**: the
icon alone carries play/pause, and an older build that turned it accent only
while playing was saying the same thing twice.

**Play at the end replays.** `useProgramLoop` finishes a pass by parking the
playhead exactly on the end and clearing `isPlaying`, so flipping the flag back
on from there was undone on the next frame and the button looked dead once a
project had run through. `togglePlay(programEndMs)` rewinds to `inPointMs ?? 0`
first. The end is passed in rather than read, because `timelineStore`
deliberately does not import `projectStore`.

**The transport's keys are bound, because they were already promised.** Every
button in the row named a shortcut in its `title` — Space, Home, End, ← / →, M,
I, L — and not one of them was bound anywhere in `src/`; the affordance rule
above forbids exactly that, so `video/hooks/useTransportShortcuts.ts` now binds
the eight the buttons name and nothing more. `O` for the out point is the
standard partner of `I` and is deliberately absent, because no control offers
it. Each key calls the same thing its button calls — `stepPlayheadByFrames` is
shared with `PlaybackControls`, not reimplemented — so the two paths cannot
drift. That step counts in *frames*: adding `frames * (1000 / fps)` is the
obvious version and is wrong at 30fps, because the store rounds the playhead to
whole milliseconds and `formatTimecode` then floors 33ms against a 33.333ms
frame, so one press of → moved nothing. Both inputs had that bug. The listener is on `window`, since a freshly opened editor has focus on
nothing and a subtree listener would hear nothing; `WorkspacePanel` mounts one
pane at a time, so while the hook lives the editor *is* the workspace. It stands
down for modals, typing targets and `<select>` (which is what leaves the rate
picker's own arrow keys alone), for focus outside the pane, and for anything
with a modifier, so the shell's ⌘-shortcuts still land.

**The summon bar sits in the monitor's header, not on the stage.** Below `lg`
the library and inspector are summoned rather than seated, and their buttons had
been laid over the picture. Beside the `Program` label there is 179px of free
space at `xs`, 279 at `sm` and 120 at `md` for a bar of 147/147/81px. The
alignment shelf's `:has(.editor-summon-bar)` lift went with it.

**The inspector can be put away at every width, through that one control.**
Wide enough to seat the inspector is not the same as wanting it — a 296px rail
is 296px the picture does not get, and the editor at full width is where someone
watches rather than tweaks. So `Edit` is drawn at every tier, unlike `Media`,
and only the mechanism behind it changes: seated, it clears
`inspectorSeated = canSeatInspector && !inspectorMinimized`; summoned, it opens
the overlay. The overlay stays gated on `!canSeatInspector`, so a minimised
column never summons a sheet over the space it just gave back. The choice is
kept across a trip down through the narrow tiers and back — except that widening
with the overlay open spends it, since that is a request to see the inspector,
not to hide it. At `lg` the header is effectively full, so the toggle is drawn
icon-only wherever the inspector is seated and the format strip beside `Program`
truncates to pay for it. `tests/responsive-layout.test.mjs` holds the shape.

**The transport is centred on the picture, not on what is left of the row.**
It is centred within `.editor-transport-row`, but that row is the flex child to
the *left* of the master meters, so its centre was the bar's centre minus half
the meters — the play disc sat under the picture's left-of-centre. The bar now
carries a mirror of the meters on its other side as
`.editor-program-transport::before`, sharing their width, shrink and 88px floor
so the pair narrow together. A pseudo-element rather than a spacer `<div>`,
because `> :first-child` and `> :last-child` in the same layer still have to
mean the transport and the meters; an added element would have moved the 336px
minimum onto the spacer. At `sm`/`xs` the meters are `display: none` and so is
the mirror, or it would push the transport right by the error it removes.

**The mirror is the meters' width, held as one token.** It first shipped as a
literal `159px` against meters that measure `119px`, which did not centre the
disc so much as mirror the error — measured at 21px to the *right* of the
picture, where it had been ~85px to the left. Both sides now read
`--transport-meters-w`, so there is no second number to drift. Measured after:
0–1px off centre at every panel width from 700 to 1716.

**The meters are gated on the bar's own width, not on the tier.** `data-tier` is
the *pane's* width, but the transport bar gets only what the seated library and
inspector leave behind: at `lg` with both seated it is 439px, and at `md` 339px,
where the tier gate still says the meters may stay. Their 88px floor plus the
mirror's plus the transport's 336px minimum needs 564px, and the bar does not
clip — below that it painted its own controls and the meters straight over the
inspector column beside it, measured at 111px of spill at `lg` and 211px at
`md`. `PreviewPlayer` measures the bar with `useMeasure` and sets `data-narrow`
below `TRANSPORT_METERS_MIN`; the stylesheet then drops the meters and the
mirror together, which is what `sm`/`xs` already do through the tier gate.
*Not yet solved:* at a 339px bar the transport's own 336px minimum still
overflows by 11px, which moves the disc 12px off centre. That floor predates
the mirror and needs the two-row grid `sm`/`xs` use, not a wider gate.

**The alignment shelf holds alignment.** It floats over the stage whenever
something is selected, and it had grown to fourteen icons — six align, two
distribute, then flip H, flip V, fit-to-frame and reset. The last four are
*transform* actions on a shelf named for alignment, which is what makes them the
ones to demote: they answer a question about one layer, not about how several
sit together, and three of the four already have a twin in the Transform
inspector — both flips and reset (the inspector's `Fit to frame` is the `fitMode`
select, a different mechanism). They now live behind a single `⋯` that opens the editor's own anchored menu
(`useAnchoredMenu` → `ContextMenuItem[]`, the same pattern the timeline toolbar's
overflow uses), so eight icons cover the picture instead of fourteen. Nothing is
removed at any width — only the click count changes — and
`tests/responsive-layout.test.mjs` fails if any of the four grows a button back
or drops out of the menu.

**The track gutter is wider than the tier minimum** — 76 / 120 / 150 / 176px
across the four tiers. It was cut to the narrowest legible width when the
folding rules were written, which is the right instinct applied one step too
far: the gutter is where the operator aims, not merely where the name is read.

**Two surfaces the slice had always talked to are now drawn.** `uiStore` has
carried `contextMenu` and `toasts` since the port and eleven call sites push to
them — every track and clip right-click menu, and the entire result path of beat
detection. Nothing subscribed, so right-click opened the browser's own menu and
a failed analysis reported success by saying nothing. `video/components/ui/Overlays.tsx`
renders both, and it renders them *inside* `.video-workspace` because the classes
they wear are scoped to it.

### The preview's frame budget (`hooks/useProgramLoop.ts`, `engine/compositor.ts`, `engine/videoEngine.ts`, 2026-09-10)

Reported from the running app on Windows, and not only on weak machines: a
recording lands on the timeline and the webcam clip lags, freezes, or goes
black — the screen clip with it. Every finding below is measured on an M4 Pro
through CDP against the production build, drawing one frame of the shape a
recording actually produces (backdrop, screen, cursor, camera, grade) and
sustaining it in a rAF loop. **An M4 Pro is not the machine this was reported
on; the ratios are the point, not the absolutes.** A laptop iGPU fills several
times slower, and the frame rates below land in single figures there — at which
point the renderer's main thread is saturated, the `<video>` elements it also
has to service are never scheduled, and a camera clip shows black. It was
never a video bug. It was a budget.

**Motion blur was the whole cost, and the canvas size was not.**

| one preview frame | sustained |
| --- | --- |
| 2560×1662, motion blur ×4 — as it shipped | **42.9 fps** |
| 2560×1662, blur accumulator off | **120.7 fps** |
| 1600×1040, motion blur ×4 | 38.3 fps |

The accumulator is why. It renders the clip once per sample into a full-size
scratch canvas, clears that canvas between samples, and adds each one in with
`lighter` — four samples is thirteen full-frame operations where the rest of
the frame needs five. It is also correct, and three earlier attempts at it were
not (see the note in `compositor.ts`), so it is kept exactly as it is and
simply not *asked for* while somebody is working.

`RenderQuality` is that ask. `full` is the picture as the file will hold it and
is what `exportPipeline` and `frameCapture` get **by omission** — the parameter
defaults to it, so neither file changed. `draft` is the picture as an operator
needs it while cutting, and today it gives up exactly one thing, because
exactly one thing measured. What is lost is a smear on a moving zoom: a matter
of finish, not of framing, timing or grade. Nothing decided at the timeline
depends on it.

**It is said on screen.** A `Preview · motion blur off` chip sits on the stage
whenever a clip in the project actually asks for blur. An operator who is not
told will read the difference as the export having invented something, and §1.8
is the rule: if the machine is doing something, say which thing, in words.

**The canvas is sized to the screen, not to the sequence.** It was
`project.width × project.height` — a 3024×1964 laptop take becomes a 2560×1662
sequence, so 4.25 million pixels were composited into an element being looked
at inside `MAX_CANVAS_WIDTH`, 960 CSS px at the widest tier. Two thirds of
every pixel was discarded by the browser on the way to the screen. It now
follows `viewport.displayWidth × devicePixelRatio`, capped at 2× and never
above the sequence's own size, and the compositor's existing
`canvasWidth / project.width` scale does the rest — export has always relied on
that path to render a 1080p sequence at 4K, so this is the same road in the
other direction. Measured in the running app: an 870×489 backing store where it
used to be 1920×1080, five times fewer pixels per layer. **Its benefit could
not be measured on this machine** — the table above shows resolution moving
nothing — because an M4 Pro is not fill-rate bound. It is kept for the machines
that are, and that is a reasoned bet rather than a measurement.

Hit-testing and the gizmo are untouched by it: `viewToCanvas` and `canvasToView`
work in project coordinates off `viewport`, and never read the element's
`width`/`height`.

**A seek narrower than a frame is a seek storm.** `syncVideo`'s paused branch
re-seeked whenever the element sat more than **20 ms** from the playhead —
shorter than a frame at any rate this editor supports. A long-GOP screen
recording seeks to the nearest decodable frame; ask for 4.100 and it answers
4.400, which is instantly "wrong" again, so the next tick re-seeks, and the one
after that. The element never leaves `seeking`, `getVideoFrame` therefore
returns the held frame forever, every seek fires `onseeked` → a full-resolution
readback and a `generation` bump that forces a repaint — and the picture never
moves. That needs no slow machine to reproduce, and it is the other half of
"the footage gets stuck".

Two guards, and `shouldScrubSeek` is a pure exported function so both are
provable rather than asserted by regex (`tests/recorder-preview-cost.test.mjs`).
The tolerance is one frame at 60fps. More importantly the entry remembers
`requestedTime`: asking for the same position twice can only produce the answer
it already gave, so it is not asked — which makes it safe at any tolerance,
including a wrong one.

**Three more, each small and each free.**

- `el.ontimeupdate` called `updateLastFrame`, which is a full-resolution
  `drawImage` — **4.21 ms** at 2560×1662 — about four times a second per
  element, for a held frame that is only ever READ while seeking, which
  `onseeked` already covers. The handler is gone and the held canvas is capped
  at a 640px long edge; it is a stand-in for a few frames, not a copy.
- The video cache had no upper bound. Every clip ever passed under the playhead
  kept a `<video>`, its decoder and its buffers for the life of the page — which
  is the shape of "it got slower the longer I used it" across several takes in
  one session. Idle entries are released past a soft limit of six.
- `ScopesOverlay` called `getImageData(0, 0, source.width, source.height)` on
  the program canvas — the whole frame, 17 MB on a screen recording, eight times
  a second, each one a hard GPU stall — and asked that canvas for a
  `willReadFrequently` context, which is a request to take it off the GPU for
  the life of the page. Its own comment claimed to downsample and the code never
  had. It now scales the frame onto a 160×90 scratch and reads 57 KB off that;
  the scopes were sampling at 160×90 either way.

**Measured and left alone, which is worth writing down.** `interpolateKeyframes`
is O(n) over a clip's keyframes per property per frame, and the cursor clip
carries up to 1,840 of them. That reads like a problem and is not: **0.022 ms
per frame**, 1.3 ms per second of playback. No index, no binary search, no
`WeakMap` cache. The timeline is likewise clean — `Playhead` subscribes to
`playheadMs` alone and re-renders one `translateX`, and `Timeline` reads the
store imperatively inside a subscription rather than through a selector.

### What the editor costs while you work in it (`timeline/ClipBlock.tsx`, `engine/audioEngine.ts`, 2026-09-10)

The frame budget above is what a preview frame costs. This is the other
half — what an INTERACTION costs — and it is where the editor's own
sluggishness lived.

**A drag wrote to the store on every pointer event.** `pointermove` was
wired straight to `moveClips`, and every one of those is a zustand `set`
through immer: a new `tracks` array, so `Timeline` re-renders, so every
`ClipBlock` under it re-renders, and `useProgramLoop`'s revision counter
bumps and forces a canvas repaint. On a high-poll pointer that is several
of those per frame, and on a long timeline each one is hundreds of React
reconciliations to draw a frame that will be drawn once.

Measured in the production build over CDP, dispatching forty
`pointermove` events inside one tick onto a real clip and reading the
clip's own geometry back:

| | clip's `left` |
| --- | --- |
| during that tick (40 events) | **unchanged** — no store writes |
| one frame later | 120px — one write, at the newest position |
| after release | 120px — committed |

**Forty events, one write.** The pointer handler now only records where
the pointer is; a rAF pass turns the latest position into one update.
Coalescing rather than throttling, deliberately: the frame that lands
always uses the newest position, so the clip never trails the cursor. All
three drags do it — move, trim and fade — because all three called a
store action out of the listener. Each flushes its pending position
before closing its transaction, or a release landing between two frames
would commit the position from one frame ago.

**And every clip re-rendered when any clip changed.** `ClipBlock` is
`React.memo`'d now, which works precisely because of the history model
above: immer's structural sharing means a clip nobody touched keeps its
identity across the write that moved its neighbour, so `a.clip === b.clip`
is a real test rather than always-false. `track` is compared field by
field rather than by identity — a track object is rebuilt whenever ANY
clip on it changes, so comparing the reference would re-render every
sibling of the clip being dragged and give most of the win back. The
comparator covers exactly the seven fields the component reads, and a
test enumerates them, because a memo comparator that misses a field is a
stale render rather than a slow one.

`ClipBlock` also subscribed to `selectedClipIds` — a new array on every
selection change, so clicking one clip re-rendered all of them. What it
needs from that array is one bit, and the drag handler reads the full
list imperatively from `getState()`, which is where a list belongs: it is
wanted at pointer-down, not at render.

**The audio graph had the video engine's two bugs, independently.**

- *The same seek storm.* `sync`'s paused branch re-seeked whenever an
  element sat more than **50 ms** from the playhead. A compressed stream
  seeks to a packet boundary, so an element told to go to 4.100 may
  answer 4.180 and be wrong for ever — re-seeked sixty times a second,
  permanently `seeking`, audible as a clip that will not scrub.
  `shouldParkSeek` is the same shape as `shouldScrubSeek`: one frame of
  tolerance, and a `requestedTime` memo so a position the decoder has
  already answered is not asked again.
- *The same unbounded cache, and worse.* A voice is an `<audio>` element,
  a `MediaElementAudioSourceNode` and a whole per-clip filter chain.
  `sync` paused the ones that fell out from under the playhead and
  released **none** of them, so scrubbing across a hundred-clip timeline
  left a hundred decoders and a hundred filter chains alive for the life
  of the page. Idle voices are released past a soft limit of eight.

**Plus one that was pure waste.** `setTargetAtTime` schedules an
automation event every time it is called, and `sync` runs every frame —
so a voice sitting at a constant level scheduled sixty events a second to
hold still, and every voice NOT under the playhead scheduled sixty more
to stay at zero. Both are now conditional on the target having actually
moved.

**Measured and left alone.** The undo history is already right: it holds
references rather than clones, relying on immer's structural sharing, and
the comment above `snapshot` records the 2.4s-at-400-clips it used to
cost. `collectSnapPoints` walks every clip on the timeline but runs once
per drag, at pointer-down, not per move. `Timeline` reads the playhead
imperatively inside a subscription, and `Playhead` is an isolated
component re-rendering one `translateX`.

### Export throughput: the seek is the render (`engine/exportPipeline.ts`, `engine/videoEngine.ts`, 2026-09-11)

**Tiers 1 and 2 are implemented (2026-09-11); tiers 3-4 are not.** The export now
decodes sequentially where it can — `sequentialPlan.ts`, `sequentialDecode.ts`
and the frame override in `videoEngine.ts` — and still encodes through JPEG to
ffmpeg — and, where WebCodecs will take the codec, encodes there too and hands
ffmpeg an elementary stream to copy. The figures below under "Measured"
describe the pipeline these replaced, not the one that ships; see "Tier 1, on
real footage" and "Tier 2, measured" for what it is now. Tiers 3-4 remain a
decision recorded, not a capability.

**One caution on every number in this section.** A seek harness is easy to get
wrong: `requestVideoFrameCallback` will resolve
against the frame already on screen rather than the seek, which reports
11,000 fps and is how an early version of this measurement got a 9x-optimistic
figure for the old path. The real-footage table below waits on `seeked` alone
and asserts both that `currentTime` landed and that the pixels changed.

**What ships today.** The export dialog has two speed switches, both defaulting
on: `superSpeed` (`ExportDialog.tsx:470`) batches 8 frames per IPC write, runs 8
writes in flight, ping-pongs two canvases, drops JPEG quality to 0.82 and hands
ffmpeg `-probesize 32 -analyzeduration 0 -threads 0`; `hardware`
(`ExportDialog.tsx:526`) lets `hardwareEncoder.cjs` pick `h264_videotoolbox` on
macOS, NVENC/QSV/AMF on Windows. Both are real. Both tune the wrong stage.

**The pipeline they tune.** Per output frame the exporter pays: a random-access
`currentTime` seek on an `<video>` element (`videoEngine.ts:575`) → `drawImage`
→ `canvas.toBlob('image/jpeg')` (`exportPipeline.ts:170`) → an `arrayBuffer`
copy → an IPC hop → ffmpeg **decoding that JPEG again** → H.264 encode. Three
codec round-trips where one is needed, and a generation of JPEG loss the user
never asked for.

**Measured**, Electron 44 / Chromium, this machine, a 1920×1080 H.264 clip at 30fps
with GOP 250, 600 frames (20s) — the harness drives the real `seekTo` logic:

| stage | fps | wall clock | share of export |
| --- | --- | --- | --- |
| **current: seek + drawImage + JPEG(0.82)** | **17.8** | **33.7s** | 100% |
| — seek + drawImage alone | 22.4 | 26.8s | **80%** |
| — JPEG(0.82) encode alone | 104 | 5.8s | 17% |

**Twenty seconds of video takes 33.7 seconds to export — 1.7× slower than
realtime — and 80% of that is the seek.** The encoder both switches fight over
is 17%. Turbo's ping-pong canvases and 8-deep write queue are optimising a
sixth of the problem while the other four fifths sits in `seekTo`.

**Why the seek costs that.** A delta frame is only decodable from the preceding
keyframe, so setting `currentTime` to frame N decodes from N's keyframe forward
and throws away everything before N. At GOP 250 the decoder does up to 250
frames of work to deliver one. The literature calls this decode amplification
and puts it at 30–300× for sporadic access; measured here against the same file
it is **87×** — sequential decode does 1953 fps where the seek path does 22.4.
The exporter already walks frames in strict order, so it is paying random-access
cost for a purely sequential access pattern.

**The replacement, measured end to end** on the same file and machine, decoding
through `VideoSampleSink.samplesAtTimestamps()` (WebCodecs `VideoDecoder`, each
packet decoded at most once for monotonic timestamps) and encoding through
WebCodecs `VideoEncoder`:

| stage | fps | wall clock |
| --- | --- | --- |
| sequential decode + draw to canvas | 1953 | 0.31s |
| WebCodecs `VideoEncoder` h264, hardware | 197 | 3.0s |
| **full: decode + draw + hw encode** | **230** | **2.6s** |
| full, plus muxing a playable MP4 | 224 | 2.7s |

**33.7s becomes 2.7s — 12.6×** — and the output is a valid 600-frame, exactly
20.000s, 11.1 Mbps H.264 High MP4. For reference, ffmpeg on the same file and
machine decodes all 600 frames in 0.283s and does decode+`h264_videotoolbox`
in 2.75s: the replacement is at the machine's ffmpeg-class ceiling, in-process,
with no JPEG and no IPC.

#### Tier 1, on real footage — measured 2026-09-11

The numbers above use `testsrc2`, which is synthetic and decodes unlike
anything a user owns. Repeated against real 1080p30 H.264 (84.9s, GOP ~128,
64 MB), 600 frames, each mode in its own cold Electron process so no run warms
the next:

| path | fps | 600 frames |
| --- | --- | --- |
| **old: seek + JPEG** | **12.2** | **49.3s** |
| old: strict seek alone, no encode | 11.9 | 50.6s |
| **tier 1: sequential decode + JPEG** | **125.1** | **4.8s** |
| tier 1: sequential decode alone | 1046 | 0.57s |

**10.3x on real footage, from tier 1 alone** — better than the synthetic clip
predicted, because the seek dominates real footage even harder than it
dominates `testsrc2`. Note the second row: the encode is nearly free beside the
seek, which is why the two old rows are within 3% of each other.

**This inverts what is expensive.** Decode is now 0.57s of a 4.8s render and
JPEG is the other 4.2s — the stage that was 17% of the problem is now ~88% of
it. Tier 2 is therefore worth more after tier 1 than it was before, and is the
next thing to build: removing the JPEG round-trip should take 4.8s toward the
~1.5s the WebCodecs measurements suggest.

#### The four tiers, in payoff order

1. **Sequential decode instead of per-frame seek.** — **implemented
   2026-09-11.** One `VideoSampleSink` per source, driven by
   `samplesAtTimestamps`, which decodes each packet at most once for a
   monotonic timestamp list. This is 80% of the win and the only tier that
   changes the architecture rather than the plumbing. The export loop's
   existing in-order walk is what makes it possible; the preview keeps the
   `<video>` pool and the seek path, which is the right tool for scrubbing.

   The compositor was not touched. `getVideoFrame` in `videoEngine.ts` is the
   only place it reads video pixels, so the decoder publishes through a frame
   override in front of that, and `compositor.ts` never learns which decoder
   produced a frame — the same shape `gpuStage` already uses to stay invisible
   to the export path.

   **The fallback is per source, decided before the first frame.**
   `planSequentialDecode` walks the whole export once and drops a source back
   onto the seek path if any clip of it is reversed, if two of its clips are
   visible at the same instant (the override holds one frame per URL), or if
   its demands ever step backwards. Opening can fail too — an undecodable
   codec, a URL that will not range-request — and that also costs one source,
   not the export. `tests/sequential-plan.test.mjs` covers the decision; it
   takes a demand function rather than a timeline, so it runs with no DOM and
   no media.
2. **WebCodecs encode instead of JPEG → IPC → ffmpeg.** — **implemented
   2026-09-11**, `webcodecsEncoder.ts`. Deletes the JPEG encode, the IPC copy,
   ffmpeg's JPEG decode and the 0.82 generation loss in one move. ffmpeg keeps
   the muxing and the audio, fed H.264 it can `-c:v copy`. ProRes, a browser
   build and any codec the UA refuses keep the JPEG path — the encoder is
   built before the session starts and `frameFormat` tells the main process
   which contract this export is using.

   **There is a way back.** `localStorage['teminali.export.legacy'] = '1'`
   forces an export onto the seek-and-JPEG path. Both tiers depend on what a
   machine's decoder and encoder accept, and a wrong guess produces a bad file
   rather than an error, so the switch exists for a user whose hardware
   disagrees with this one — and it is what makes an honest A/B possible on a
   real project: same timeline, same machine, one flag apart.
3. **Smart rendering.** A stretch of timeline with no effect, no transform and
   a codec/resolution/frame-rate match against the source is a stream copy, not
   a re-encode — Premiere ships this under that name and it is lossless as well
   as near-instant. For the common case this editor actually serves, trimming a
   screen recording, it makes export close to free.
4. **Segmented parallel encode.** Split at keyframe boundaries, render N
   segments in N workers, concat. Scales with cores and is how cloud renderers
   get their numbers — but it multiplies a per-frame cost that tiers 1–3 have
   already removed, so it is last, not first.

#### The decoder is a dependency, and it has a licence

The tiers above name `VideoSampleSink.samplesAtTimestamps()` without naming what
provides it. That is **mediabunny** (1.56.1, **MPL-2.0**) — a pure TypeScript
demuxer/muxer over WebCodecs: no WASM blob, no native module, and no runtime
dependencies, its only two being `@types/*` for the WebCodecs DOM definitions.
The browser bundle is 673 KB minified. The sequential-decode row above was
measured through it, not through a hand-rolled `VideoDecoder` loop, and the
figure is partly its pipelining — it decodes ahead and reuses one packet across
every output frame that maps to it. A port that swaps it for mp4box.js or a
bare decoder has to re-measure rather than inherit the number.

**It is not installed, and nothing MPL ships today.** The obligation attaches to
what is distributed, not to what a design document names — the same reasoning
`docs/MEDIA_LICENSING.md` already applies to the GPL encoders living inside a
user's own ffmpeg. MPL-2.0 is file-level copyleft: it asks that the library's
own files stay MPL and that modifications *to those files* be published, and it
does not reach this product's source, which is what makes it a safe shape to
depend on beside an LGPL ffmpeg. When tier 1 lands it becomes a shipped
component like any other: named on the About surface off the manifest, with its
licence text copied into `licences/` and checked rather than attempted.

#### Tier 2, measured — 2026-09-11

Same real 1080p30 source, 600 frames, cold Electron process:

| stage | fps | 600 frames |
| --- | --- | --- |
| tier 1 only: sequential decode + JPEG | 125.1 | 4.8s |
| **tiers 1+2: decode + WebCodecs encode** | **187** | **3.2s** |

**49.3s to 3.2s in the harness — 15.4x.** Against the app's real exporter this
is an overstatement; see "End to end, through the app's own exporter" below,
where the same change measures **6.1x** because the shipped seek path is
faster than the strict baseline used here. The encode stage itself
went 4.2s to 2.6s; the rest of tier 2's value is not on this clock at all,
because it also deletes ffmpeg's JPEG decode and re-encode in the other
process, and a generation of lossy recompression.

Quality improved, which is the point worth making twice: **SSIM 0.994977,
PSNR 45.46 dB** against the source, where the section's own figure for the
JPEG pipeline is 0.9930 and 41.9 dB. 600 encoder chunks for 600 frames — the
`latencyMode: 'realtime'` request did keep B-frames out, which is what makes
an elementary stream safe to time from the input flag.

**Two bugs this build shipped into the harness before measurement caught them,
both silent:**

1. **`-r` is an INPUT option.** Written as `-f h264 -framerate 30 -i pipe:0`
   the flag does not take and the demuxer uses its own default: 600 frames
   muxed as **1.74 seconds** instead of 20, playing 11x fast, while
   `nb_frames` read a correct 600. `-r` must precede `-i`.
2. **Forcing `-color_range pc` is wrong, and SSIM cannot see that it is.** A
   canvas is full-range sRGB so `pc` looks right; measured, the encoder emits
   LIMITED range and writes `tv`/bt709 into the VUI itself. Forcing `pc` makes
   the container contradict the bitstream and a player renders it washed out —
   and the forced and unforced muxes scored an **identical** SSIM 0.994977 and
   PSNR 45.46 dB, because those filters compare decoded YUV and never read the
   range tag. This is the same class of failure as the colour landmine below,
   caught the second time by `ffprobe` rather than by a metric. **Verify colour
   with `ffprobe`; a quality score is not evidence.**

#### The compositor is not the new floor — measured 2026-09-11

Removing the seek was expected to promote compositing to the bottleneck, and
this section said so for most of a day. It does not. Measured in Electron on
this machine, drawing into a 1920x1080 context:

| frame content | fps | per frame |
| --- | --- | --- |
| one full-frame layer | 25,263 | 0.04ms |
| three layers + rotate/scale, alpha, a filled bar and 64px text | 9,717 | 0.10ms |

A busy composited frame costs **~0.1ms against the encoder's 4.3ms** — about
62ms across a 600-frame render, which is why the end-to-end 3.2s matches the
sum of its stages. Compositing would have to get ~40x slower to become the
bottleneck again.

**Two ways to mismeasure this, both of which happened here first.**
`requestAnimationFrame` is vsync-locked: a sustained-frames loop reported
120.9 and 120.1 fps for the one-layer and four-element frames, which is the
display's refresh rate and not a property of either. And `performance.now()`
around `drawImage` measures command SUBMISSION, not execution. The table above
runs the draws back to back with a single `getImageData` after the batch, so
the GPU has to finish what was queued before the clock stops.

**This machine is bandwidth-rich.** An Intel iGPU will pay materially more for
fill rate, so read 0.1ms as a lower bound on what compositing costs elsewhere
rather than as a number every user gets. A timeline with GPU transitions is
also a different case: `gpuStage` uploads the canvas and reads it back, which
`shaders.ts` already records as expensive enough to make one effect slower
than its 2D equivalent.

#### End to end, through the app's own exporter — measured 2026-09-11

Everything above is per-stage in a harness. This is `runExport` in the
production build, driven over CDP on a scratch profile, writing a real file:
the demo project's timeline with its video clip pointed at local 1080p30
footage, 600 frames, `superSpeed` and `hardware` on, the two paths one
`localStorage['teminali.export.legacy']` apart.

Every run restores the timeline from one pristine snapshot first. Without
that the driver's own mutations carried between runs, and the first version of
this table was measured on four subtly different timelines.

| codec | path | wall clock | bitrate | SSIM vs source |
| --- | --- | --- | --- | --- |
| **H.264** | **tiers 1+2** | **4.7s** | 5.4 Mbps | **0.9544** |
| H.264 | legacy | 24.4s | 10.9 Mbps | 0.9317 |
| HEVC | tiers 1+2 | 24.9s | 11.1 Mbps | 0.9329 |
| HEVC | legacy | 24.4s | 11.2 Mbps | 0.9319 |

**~5x on H.264, at better quality — and that is the number to quote, not the
15.4x this section reported from the harness.** H.264 is the default and
almost every export. HEVC is deliberately unchanged; see below. The harness overstated it by measuring a baseline the product does
not ship: it waited on `seeked` ALONE, where `videoEngine.seekTo` races
`seeked` against `requestVideoFrameCallback`. That race is about twice as fast
— 24.4s against the harness's 49.3s for identical work — so the real pipeline
was never as slow as the strict measurement implied. Both files came out
correct: 600 frames, 20.000s exactly.

Compositing again proved cheap: text and overlay tracks cost 283ms across 600
frames, which agrees with the 0.1ms-per-frame floor measured separately.

#### HEVC keeps the old pipeline, whole — measured 2026-09-11

It does not survive either half of the rewrite, and the reason is not known.

Through the WebCodecs encoder, HEVC ignored the bitrate it was handed: asked
for 12 Mbps at 1080p it produced **698 kbps** and SSIM 0.818, where H.264 from
the same frames at the same request gave 5.4 Mbps and 0.954.

Holding it off that encoder was not enough. On the new DECODE with the old
ffmpeg encode — the same `hevc_videotoolbox`, the same arguments, differing
only in how frames reached it — HEVC still came out at 3.7 Mbps and SSIM
0.851 against the old path's 11.2 Mbps and 0.932. H.264 across that same pair
moved the other way (0.954 against 0.932), so "the new decode is softer" does
not explain it, and nothing else here does either.

So `exportPipeline.ts` routes HEVC down the legacy path entirely. Verified
back to parity: 24.9s and SSIM 0.9329, against the old path's 24.4s and
0.9319. HEVC users get no faster, and nothing worse. **An export is the one
artefact a user cannot cheaply re-render, which is why an unexplained 0.08
SSIM is a blocker rather than a note.**

**Quality is better, and the old path was not delivering wrong frames.**
Against the same source through the same timeline, range-normalised: tiers 1+2
score **SSIM 0.9649**, legacy **0.9426**.

**The trap that nearly produced a false alarm.** Compared WITHOUT normalising
range, legacy scored Y 0.5736 while its chroma stayed at 0.988 — which reads
exactly like an exporter emitting stale frames, and was written up as one for
several minutes. It is not: the legacy path writes `yuvj420p`/full range and
tiers 1+2 write `yuv420p`/limited, and ffmpeg's `ssim` compares raw planes
without converting, so a range difference lands almost entirely on luma. **A
luma-only SSIM collapse with healthy chroma is a range mismatch until proven
otherwise.** Normalise both sides before believing any of it.

**That range difference is a real behaviour change**, not only a measurement
artifact: an export that used to be full-range is now limited-range. Both are
correctly tagged and both display the same — the mean level moved 0.23 of 255
across 300 frames — but anything downstream that assumed `yuvj420p` will see
`yuv420p` now.

**How this was driven**, since it is the only way to time a real export:
`main.tsx` exposes `window.__videoExport` — `runExport` plus the two video
stores — beside the existing `__studioStore`, on the same not-dev-gated terms,
because the build worth measuring is the production one. The export otherwise
ends at a native save dialog CDP cannot reach; `runExport` takes an explicit
`outputPath` and skips it.

#### Landmines, measured

**Colour management is not free, and getting it wrong is invisible until
someone looks.** The first working WebCodecs build scored materially *worse*
than the JPEG pipeline it replaced:

| output vs source | SSIM (all) | PSNR avg |
| --- | --- | --- |
| current pipeline (JPEG 0.82 → H.264) | 0.9930 | 41.9 dB |
| WebCodecs path, as first built | 0.9700 | 24.8 dB |
| the same file, compared after correcting range | 0.9853 | — |

PSNR varying only between 24.69 and 25.64 across the whole clip is a constant
offset, not compression noise, and the V channel was the worst of the three at
0.947 — the signature of a range/matrix conversion, not a weak encoder. The
source was untagged, the canvas round-trip re-emitted it as `tv`/bt709, and the
levels were squashed. **Pin range and matrix explicitly on the way out.** A
naive port of this ships a washed-out export that no test catches.

**`CanvasSource` silently fell back to software OpenH264** rather than
VideoToolbox in the muxing run — visible only as a stray `[OpenH264]` line on
stderr. Ask for `hardwareAcceleration: 'prefer-hardware'` and assert what came
back; a silent software fallback is a 2× regression that looks like nothing.

**The fallback path stays.** WebCodecs decodes what WebCodecs decodes; live
capture has nothing to seek, image sequences have no packets, and an exotic
source will fail `canDecode()`. Every tier above must degrade to the current
seek-and-JPEG path per source, not per export.

**The rAF paint budget becomes more important, not less.** The export yields to
`requestAnimationFrame` every `PAINT_BUDGET_MS` so the panel does not freeze the
IDE around it (`exportPipeline.ts:23-33`) — a deliberate trade of throughput for
an app that stays usable. At 230 fps that yield is a proportionally larger share
of the budget, which is the argument for moving the whole loop onto a worker
with an `OffscreenCanvas` so the UI thread stops being the render thread.

**Caveats on the numbers above.** The source is synthetic (`testsrc2`), which
compresses unlike camera footage; the JPEG-only and encoder-only rows re-encode
one canvas repeatedly, so their throughput is real but their bitrates are not
representative; and the "current pipeline" quality row is an ffmpeg emulation of
the JPEG path at `-q:v 6`, not a Studio export. Re-measure against real footage
before quoting any of it as a product claim.

### Screen recorder (`modals/RecorderModal.tsx`, `src/video/components/recorder/**`)

**Not a panel kind — a dialog**, and the change is the design. A workspace
panel is somewhere you *leave the app*: it persists into the next session, it
holds a slot in the tab strip, and it splits the window with a conversation
you are not reading while you choose a display. Recording is none of those. It
is started, watched and finished, and then it is over. So `panelStore` no
longer has a `recorder` kind, `PanelKind` is twelve rather than thirteen, and
the persisted-state `migrate` at version 2 drops a `recorder` tab left in a
stored session — without it that tab falls through `WorkspacePanel`'s default
case and opens an empty *file* pane wearing the label "Record Screen".

Open state lives in `store/recorderDialogStore.ts`, one boolean, deliberately
**not persisted**: a modal is something you are doing, and restoring a session
straight into one nobody asked for is the failure the panel had. It is a store
rather than `App` state only because the two openers are far apart in the tree
— the File-menu listener in `App.tsx` and the pill in `StudioChat.tsx`.

Reachable two ways: **File → Record Screen…** and the **Record Screen** pill on
the empty-chat screen, which carries a filled record dot in `--danger` — the
one red in the palette, and what makes it readable as the recorder beside a
neighbour that is only words. `⇧⌘8` is the menu item's accelerator and the only
binding — a native accelerator fires whatever has focus, where a renderer key
handler is swallowed by a terminal, a webview or a text field. (It was
previously a `PANEL_DEFAULTS` label with *nothing* bound to it; the menu item
that was supposed to own it did not exist. Both halves are real now.) `open()`
is idempotent, because the accelerator can fire over a dialog already holding
a running take. The pill it replaced advertised `⇧Tab`, which nothing bound.

**A stop that never returns wedges the recorder for the life of the page.**
Reported from the running app: nothing recorded at all, and every attempt
answered *"This take is already being finished"* on a screen headed *"The
recording did not start"*. One session explains all of it. `stopCapture` marks
the session `finishing` before it awaits the recorders and only reaches
`session = null` after, so any await that does not end strands it — and two
did: `MediaRecorder.onstop` never fires for a recorder whose source track has
already ended (the captured window closed, the display slept), and `stop()` on
one the browser has torn down throws instead, from inside the promise
executor. With the session stranded `isRecording()` stays true, so the toggle
routes every later press to stop, stop reports the take is already finishing,
and start reports one is already running. Only *Back to setup* — which calls
`cancelCapture` — or a reload gives it back.

Both doors are now shut. `stopped()` races `onstop` against `STOP_TIMEOUT_MS`
(4s) and treats a throwing `stop()` as a stop that finished; `recorderStore`'s
`stop` catches anything out of `stopCapture` and calls `cancelCapture(false)`,
which releases the session and **keeps the files** — a failed finish must not
also delete what was recorded. What a fired timeout costs is the last chunk of
one track; what it saves is every recording after this one.

**The bridge the whole recorder runs on had never been published.**
`electron/screenRecorder.cjs` registers fifteen `recorder:*` handlers and owns
the capture, the vault, the remux and the floating bar — and nothing in
`electron/main.cjs` required it, while `electron/preload.cjs` put no `recorder`
key on `window.teminali`. `bridge()` in `src/video/engine/screenCapture.ts`
reads exactly that key, so in the packaged app it returned `undefined` and the
recorder took the browser fallback: one synthetic `web:screen` source named
"Browser Display / Window / Tab", and **`Windows (0)` on a desktop full of
windows**. `main.cjs` now calls `initScreenRecorder(() => mainWindow)` after
`createWindow` and `shutdownScreenRecorder()` on `will-quit`; the preload
exposes the verbs and the two pushes (`recorder:command`, `recorder:state`).
`tests/recorder-bridge.test.mjs` asserts the three files agree — every handler
reachable, every push heard, every verb typed — because each was individually
correct while the feature was dead.

An empty **Windows** tab in a browser now says so, rather than "No other
windows are open." A browser cannot enumerate windows at all; its own picker
offers them when the take starts.

`RecorderModal` is the same wrapper `VideoPane` is, and for the same reason: the
ported UI wears `.video-workspace`-scoped classes, and the recorder store's
fault watchdog — the one warning that can save a take recording nothing —
pushes to the video `uiStore`, whose toast surface only renders inside that
scope. Outside it the recorder is not slightly off; it is unstyled and silent.

**The setup screen is a stage over a picker, and a rail of three tabs.**
The shape that shipped was a three-column grid of thumbnails beside five
stacked groups of switches, and the report on it was exact: *too cheap, the
live settings are too far, not clear enough*. Three separate faults, and each
one is a layout decision rather than a styling one.

- **Two thirds of the left half was black.** A one-display machine has one
  thumbnail to show in a grid built for nine. `CaptureStage` spends that space
  on the one question the rail could never answer in words — what the frame
  will look like — by showing the chosen source large with the camera
  composited at the corner and size the build will actually use. `BR` and `24%`
  are not answers a person can picture; a bubble sitting in the corner it will
  sit in is. The corner is chosen by clicking the corner (the four hotspots are
  invisible until the stage is hovered, because this is a preview first and a
  control second), and the same choice is in the rail as a picture of the frame
  for the keyboard and for anyone who never hovers.

  Two clocks, and the caption says which is which: the camera is a real stream,
  the screen behind it is the last frame `desktopCapturer` handed us. This
  surface answers *what will the frame look like*, not *what is on my screen
  right now*; the picker's refresh control re-asks the second question.

  The camera preview MOVED here rather than being added — the rail used to run
  its own `getUserMedia` on the same device for a 288px thumbnail that proved
  the lens worked and said nothing about framing. One stream, one place.

- **Depth is the wrong axis for a 288px rail.** Live stream was the fourth
  heading below the fold and Auto edit the fifth, so the footer announced
  "Live: YouTube" in red while the controls that said so were three scrolls
  away. The three groups answer three different questions — what the FILE will
  contain, where it is going while it happens, what the BUILD makes of it — and
  only the third is changeable after the take, so they are tabs. The strip
  carries the state that used to be invisible: a red dot when the stream is
  armed, a count of the Auto edit switches that are on.

- **The footer's chips are doors, not labels.** Each one opens the tab that
  owns it, summoning the rail first when the surface is too narrow to seat it.
  The tab is `RecorderPanel`'s state rather than the rail's for exactly that
  reason.

- **An armed stream with no key never reaches ffmpeg.** `liveReadiness` is
  exported from `CaptureOptions` and read by both the rail and the start
  button, so the two cannot disagree; `begin()` does not check, and a take that
  fails at the encoder spends a recording to learn something the dialog already
  knew. A custom endpoint is exempt from the key requirement — it may carry one
  in the path — and the presets are not, because every one of them fails
  silently without it.

- **The picker is a strip with a filter.** Past about six windows the title is
  how anybody finds one, not the picture, and twenty-one thumbnails in a
  three-column grid is a scroll hunt. Arrow keys walk the row, Enter commits the
  first match, and the selection is scrolled into view — a filter whose result
  you then have to reach for the mouse to commit is half a filter.

The corner picker in the rail is 80×50 with 30×17 blocks on a 5px inset. That
is measured, not chosen: at 72×42 the two rows met in the middle and the widget
read as two tall bars rather than as the four corners of a frame.

**The dialog is what finally gives the layout its width.** The Cut's shape puts
the capture surface beside a fixed 288px options rail, which needs 568px before
either half works, and the panel opened at 452px — so the recorder's most
common surface summoned its rail as an overlay. At `size="xl"` the rail seats.
Both paths are kept and still measured rather than assumed (`max-w-5xl` is a
ceiling, and a narrow window is narrower than it): seated at ≥568px, summoned
below it through `VideoPane`'s own `editor-side-overlay is-right` and
`editor-overlay-scrim` rather than a second overlay mechanism.

**That paragraph was true of the layout and false of the app**, for as long as
the dialog existed. `RecorderModal` returns `null` while it is shut, so the box
`useMeasure` was told to watch did not exist when the hook mounted — and the
hook attached its `ResizeObserver` in a mount-only effect. It measured nothing,
kept `0×0` for the life of the component, and the width every rule above reads
was zero. Measured on the running app: dialog 1024px, pane 1024px, density tier
`xs`, rail **not** seated, capture options behind the summon button with room
for them four times over. That is the shape the report described as "the webcam
options are so hidden".

The fix is in the hook, not the dialog: the observing effect now runs after
every render and re-attaches when `ref.current` changes hands, guarded by an
`observed` ref so the per-render cost is one comparison. Re-measured: pane 1024,
tier `lg`, rail seated, `Options` button gone. `PreviewPlayer` and `VideoPane`
use the same hook and were never wrong only because their boxes exist at mount
— the guard is in `tests/responsive-layout.test.mjs`, and it was confirmed to
fail against a mount-only effect. The review rail
(320px) stacks under 600px instead of overlaying — a summary reads fine
stacked. The dialog is given a fixed `h-[78vh]` so the surface does not resize
as the phase changes, which would move the Start button under the cursor.

`Modal` gained one prop for this: `bodyClassName`, replacing rather than
extending the default padded scroll box. The recorder owns its whole surface
and lays out its own footers; 16px of modal padding and an outer scrollbar put
a second scroll region around it.

**Mount is `open()`, and it is guarded.** `open()` resets the phase and clears
the take, which is right when opening to record and catastrophic mid-take: a
recording started from the File menu and then dismissed with Escape would be
forgotten by the one surface that can stop it. So the recorder calls `open()`
only when `phase === 'setup' && !take`. Unmount calls `close()`, which itself
refuses while a take is running — which is what makes dismissing the dialog
mid-take safe rather than destructive, with the floating bar carrying the stop
control while the main window is hidden.

**A take owns the machine, so everything else stands down** (2026-09-10).
`screenRecorder.cjs` calls `setBackgroundThrottling(false)` and hides the main
window for the duration of a take, and both are right: the capture lives in that
renderer and a throttled rAF would drop its frames. The consequence was not:
every OTHER loop in the renderer inherited the same reprieve, and the expensive
one is the programme loop, which went on compositing the LAST take at full rate
behind a window nobody could see while the encoder for the next one wanted the
same GPU. `PreviewPlayer` now yields through `countdown`, `recording`, `paused`
and `processing`, exactly as it yields to an export.

**The live compositor rendered four times more frames than it broadcast.** Its
rAF loop called `render()` once per vsync — 120 times a second on a ProMotion
display, 144 on a gaming laptop — to feed a `captureStream(30)` that samples
thirty. Three quarters of every composite was encoded by nobody, during the one
activity that already has an encoder, a screen capture and a camera to serve.
It is rate-limited to the target interval now, with a tenth of an interval of
slack so that a vsync which does not divide evenly into the target rate does not
drop every other frame. The interval watchdog keeps its own schedule; it exists
for when rAF stops.

**And it composited the display rather than the broadcast.** The canvas took the
screen track's own dimensions, so a 3024×1964 laptop pushed 5.9 million pixels a
frame into an encoder the operator had set to 4.5 Mbps for 1080p — fill rate,
encoder time and upstream bandwidth spent on pixels the service scales away.
`broadcastHeightFor` reads the height back off the bitrate, because the rail
offers the two as one choice (720p·2.5M, 1080p·4.5M, 1440p·8M) and a second
control would be a second place for the answer to disagree with itself.

**A chunk is wrapped on arrival, not copied.** `recorder:chunk` did
`Buffer.from(p.bytes)`, which allocates and memcpys; `Buffer.from(buffer,
offset, length)` views the bytes IPC already handed over. At the 3s timeslice a
screen chunk is several megabytes, so this was a multi-megabyte allocation and
copy on the main process, twice a second across the two streams, for bytes that
are written and dropped. `TIMESLICE_MS` itself is deliberately NOT changed:
3000ms is what made the Windows chunk ordering correct (see `tail`, above), and
a throughput guess is not worth reopening a corruption bug.

**A take stopped from the bar had nowhere to land** (2026-09-10). Reported
against a capture of Teminali OS's own window: close the dialog, stop from the
bar, and the recording is "gone, not saved anywhere". Two independent faults,
and neither of them lost a byte — the files were in
`~/Videos/Teminali OS Recordings/<timestamp>/` the whole time.

**The recorder had a second, dead idea of whether it was on screen.**
`recorderStore` carried an `isOpen` boolean, and `stop()` set it to `true` so
the review would come back to the front. That was correct while the recorder was
a workspace panel. It became a dialog, visibility moved to
`store/recorderDialogStore`, and **nothing read the flag again** — it was
written in four places and read in none. So a take stopped from the bar with the
dialog shut finished into a `review` phase (or an `error` one) that no mounted
component was rendering: no review screen, no *Open on the timeline*, no way to
reveal the folder. From outside, indistinguishable from the take being thrown
away.

The flag is gone, so `recorderDialogStore` is the only answer to that question,
and `App.tsx` subscribes to the recorder's phase and opens the real dialog on
the edge into `processing`, `review` or `error`. `processing` is in that list on
purpose: a slow remux should show its progress bar rather than appear at the
end. It lives in the shell rather than in the store because everything under
`src/video/` is workspace-agnostic, and a reach from there into the shell's
dialog store would be that boundary's first exception — the same reason
`onOpenedOnTimeline` is a callback.

**And `hideWindow` was hiding the subject.** The switch exists to keep Teminali
OS out of a capture of the DISPLAY. Point the recorder at Teminali OS's own
window and it hides what is being filmed: macOS delivers no frames for an
ordered-out window, so the take records nothing at all — no chunks, an empty
file, and a remux that fails on it.

Only main can tell which window is ours: `getMediaSourceId()` is a
`BrowserWindow` method, and matching on the window's TITLE from the renderer
would break the first time it carried a file name. So `recorder:sources` tags
that one source `isSelf`, the rail disables the switch and says *"Not while
Teminali OS is what you are recording"* rather than leaving it on and ignoring
it — a control that silently does nothing is worse than a missing one — and
`recorder:begin` now receives the `sourceId` and refuses the hide itself. The
renderer's half is the explanation; main's half is the guarantee, because a
stale source list must not be able to cost somebody a take.

`ToggleRow` gained `disabled` for this, in the shared control rather than at the
call site.

**The floating bar is the one recorder file outside `src/video/`.**
`components/recorder/RecorderBar.tsx` renders in its own transparent,
always-on-top window — `setContentProtection(true)`, so it is not *in* the
recording it controls — loaded from this same bundle at `?window=recorder-bar`
(`main.tsx` branches on it, and skips the video tool bridge there so the two
windows do not race the same channel). Being its own window means no
`.video-workspace` above it, so it wears only Tailwind utilities and
`tailwind.config.js` tokens, and it stamps `html.recorder-bar-window` on mount
to make the page transparent — a body painted with the editor ground would put
a hard-edged dark square behind the rounded pill. It is a second renderer with
no access to the store: one `recorder:state` message in, one command out.

**Review promises nothing it cannot do.** It offers **Open on the timeline**,
and what that builds is what the **Auto edit** group on the capture rail says it
will: zooms pushed in on real clicks, a drawn pointer, a cinematic frame, click
ticks. Every switch there is honoured by an engine module that ships —
`cursorZoom`, `cursorLayer`, `cinematicLook`, `sfxEngine`, `recordingSound` —
and turning all six off leaves `RAW_ASSEMBLE`, which lays down screen, camera
and narration and stops. Either way the whole build is one history entry, so
there is nothing to undo piecemeal.

**The Auto edit tab is the only one that is not final.** Camera, Sound and
Quality describe the FILE being written and are settled the moment the take
stops. Auto edit describes what the build makes of that file, which can be
turned off and rebuilt — and the tab says so at the top, because a switch
believed to be destructive is a switch nobody touches. That is why it is a
separate tab rather than more rows under Capture.

What Review still cannot offer is everything decided from the WORDS: the camera
taking the whole frame during a spoken pause, opening on a spoken introduction,
and captions. All three read a TRANSCRIPT and this app ships no speech model, so
they are absent from `AssembleOptions` rather than pinned to `false` — the Cut's
`alignToSpeech` returns null on an empty transcript, so they would be inert, not
conservative. Go live has since arrived and is the rail's second tab. The tutorial skill is not
a rail control at all: it is the build, listed in the Skills catalogue as Tutorial
Builder and exposed to agents as the `cut` server's `build_recording` tool
(`src/video/mcp/toolRegistry.ts`), which calls the recorder store's
`openOnTimeline` — the review screen's button, for a caller that is not a person.

Review also cuts the screen clip to the FILE when the file is materially shorter
than the clock (`SCREEN_SHORTFALL_TOLERANCE_MS`, 1.5 s, in
`src/video/engine/recordingProject.ts`). The clock is authoritative for the take;
the file is authoritative for where the frames stopped, and a display that stops
delivering while the take runs on would otherwise hold its last frame to the end
with the pointer still moving over it. The note names the time. `screenCapture.ts`
watches both capture tracks for `mute`, `unmute` and `ended` and writes the time
of each into the take's warnings, capped at six lines.

**The panel switch is the pane's decision, not the recorder's.** Everything
under `src/video/` knows about tracks and clips and nothing about which tabs the
shell has open, so `RecorderPanel` takes an `onOpenedOnTimeline` callback and
`RecorderModal` — app-side already — is what closes itself and calls
`focusOrOpen({ kind: "video" })`.
Reaching for `panelStore` from inside `src/video/` would have been that
boundary's first exception.

**The convert step reports itself.** `RecorderPanel`'s `processing` phase was a
spinner and a paragraph, which is a promise that something is happening with no
claim about how much — and on a take that finishes in five seconds, a motionless
screen for five seconds reads as a hang. Measured on a real 6m18s, 397MB take
from this machine: the probe is 0.07s and the stream copy is 5.0s, so the
complaint was never the remux's speed, it was the silence.

Three things changed, and only the third is cosmetic:

- **`convertProgress.cjs`** is a pure parser for `ffmpeg -progress pipe:1
  -nostats`, sitting beside `remuxPlan.cjs` for the same reason — the failures
  here are silent ones. `out_time_ms` is ffmpeg's own misnomer and holds
  MICROseconds, and a progress block arrives in whatever pieces the pipe felt
  like, so the reader carries the whole open block forward rather than the
  trailing half-line. `recorder-convert-progress.test.mjs` proves both,
  including at every byte boundary of a block.
- **The two streams convert in parallel.** `recorder:finish` looped `await
  toMp4(...)` over screen and camera one after the other, which doubled the wait
  on a two-source take for no reason anybody watching a spinner could have
  guessed. They are independent files.
- **A real bar**, fed by `recorder:convert` — a send channel, not a sixteenth
  handler — through `preload`'s `onConvert` and `screenCapture.onConvertProgress`
  into `recorderStore.convert`. It is ffmpeg's own position in the take, it is
  capped at 99% while `+faststart` rewrites the file (a pass that reports
  nothing, and a full bar that has stopped moving reads as hung), it says
  *Copying* or *Re-encoding* because those have very different costs, and when
  the duration is unknown it stays indeterminate rather than inventing a number.
  The explanatory paragraph stays: it is the part that says why there is a wait.

**The handover to the editor says what landed.** Pressing *Open on the timeline*
on the review screen builds the project, closes the dialog and focuses the video
panel — three things that, done silently, are indistinguishable from nothing
happening, because the panel the operator is left looking at is one that may
already have been open. `recorderStore.openOnTimeline` now calls `announce`,
which pushes a success toast built from the `AssembleReport` (`6:18 ·
1920x1080 · 3 clips`, plus zooms, sound clips and a split narration when the
build produced them) followed by at most two of the build's notes.

The toasts go through the shared `uiStore` rather than the dialog's own overlay,
which is what lets them outlive the dialog: the same store backs `<Toasts />` in
`RecorderModal` and in `VideoPane`, so a toast pushed while the dialog is
closing finishes its life inside the editor — beside the timeline it is
describing. Two notes and not all of them, because a stack of advisories buries
the one line that says the take arrived; the rest stay on the recorder's
`warnings` for the next review screen.

The click itself was kept. Making the build automatic on finish would have
removed the review screen, and with it the discard button and the per-take
assemble settings — a real loss to fix a problem that was only ever silence.
teminaliCut keeps the same click for the same reason.

#### The recorder says only what is true of the machine it is on (`src/video/engine/platformCopy.ts`, 2026-09-06)

The recorder's capabilities differ per platform and its copy did not. Two
strings asserted macOS facts everywhere:

- Asking for system audio on Linux produced *"System audio loopback is
  supported natively on Windows. On macOS, microphone narration is
  recorded."* — a Linux operator told what macOS does, and promised narration
  even with no microphone selected.
- The "Draw the pointer" hint read *"A macOS screen capture does not contain
  the cursor"* on Windows and Linux too, where nobody here has observed
  whether the captured frames already carry one.

`platformCopy.ts` holds both as pure functions taking the platform
explicitly, so they are testable without a renderer
(`tests/recorder-platform-copy.test.mjs`). `systemAudioWarning` names the real
platform and returns null on Windows, which can serve the request; it promises
the microphone only when `micDeviceId` is set. `cursorHint` keeps the measured
macOS sentence for macOS and elsewhere warns about a doubled pointer rather
than asserting an unmeasured fact.

**What is still unmeasured:** whether a Windows or Linux desktop capture
contains the cursor. `drawCursor` therefore still defaults to on from
`TUTORIAL_ASSEMBLE` on every platform, which on those two may draw a second
pointer over a real one. The default is left alone deliberately — changing it
would trade a doubled cursor for a missing one on the strength of a guess. It
needs one observation on each platform, not a reasoned answer (§2, no dead
affordances; and the repo rule against writing what was not measured).

#### A take now contains the assistant's half of the conversation (`src/services/voice/speechBus.ts`, `src/video/engine/capturePlan.ts`, 2026-09-06)

A tutorial recorded while talking to the assistant had only one voice in it.
This read as an audio bug and was not one: the replies are synthesised in the
renderer and played at the speakers, so **no input device on the machine ever
hears them.** On Windows the system-audio loopback happens to catch them; on
macOS there is no loopback input at all, so there was no device an operator
could have selected to fix it. Nothing was dropped — the signal was never
offered to the recorder.

So it is taken where it already exists. `speechBus.ts` puts one unity-gain node
in front of `destination`, and every speaking path connects to that instead:
the streaming clause player and the whole-file `<audio>` element both. A tap
(`MediaStreamAudioDestinationNode`) becomes the bus's second consumer, and its
track is what the recorder mixes in. A bus is needed because a tap cannot hang
off `destination`, which has no output to read back from.

Three rules, each of which fails silently and so is tested
(`tests/recorder-assistant-voice.test.mjs`, 18 tests):

- **The tap hands back a clone.** The recorder stops every track it opened when
  a take ends; stopping the tap's own track would end the tap for the life of
  the renderer, and the *second* take would record silence.
- **System audio suppresses the tap.** That loopback already carries the
  speakers, so taking both would put every reply in the file twice.
- **The microphone and the assistant are one narration.** They are summed onto
  the same track, so a volume, a cut or `detachNarration` lifting the voice off
  the camera clip takes the reply it was answering with it. Which clip that is
  follows the microphone: the camera when there is a face to stay in sync with,
  the screen clip — the one clip a take always has — when there is not.

`planSound` in `capturePlan.ts` holds all three as a pure function, so the
rules are testable without a media stack; `startCapture` only executes the plan
it returns. **Assistant's voice** is a `ToggleRow` under Sound in
`CaptureOptions`, defaulting **on**: a tutorial with the assistant talking and
no reply in the file is the defect the setting exists to prevent. The cost of
that default is a silent audio track on a take where nothing ever speaks.

**What is deliberately not done:** the assistant does not get its own recorder
and its own file. The recorder factory requires a video track and knows only
`'screen' | 'camera'`, and MediaRecorder writes one audio track per file, so a
separate assistant track would mean a third recorder kind, a third file in the
main process, and take-import changes. Mixing into the narration was chosen
over that; independent volume for the assistant is what it costs.

### Two menu bar items

`electron/tray.cjs` (Guardian) and `electron/assistant-tray.cjs` are separate
`Tray` instances on purpose. They answer different questions — what the machine
is holding, and whether the assistant can see your screen — and folding them
together would put the answer to either one a submenu away. Both rasterise their
glyph into a template image rather than shipping an asset, so a packaged build
has nothing to lose and one buffer is correct in a light and a dark menu bar.

Guardian draws three telemetry bars. The assistant draws the product mark — the
`‹ _ ›` out of `build/mark.svg`, its geometry copied into
`assistant-tray.cjs` rather than loaded, for the same no-asset reason. It sheds
the mark's black plate and its green on the way in: a template image carries
shape in alpha alone, so the plate would render as a solid block filling the
item. `tests/assistant-tray.test.mjs` pins that — colour channels empty, both
scale factors present, and the glyph mirror-symmetric and inside its margins,
which is what a mis-scaled copy of those numbers would break.

Both read their data by importing the server module directly rather than calling
the gateway: the main process is already Node, and a status item that stops
working whenever the gateway restarts is broken exactly when someone is most
likely to look at it.

The assistant's item can be turned off, from **Settings › General › Menu Bar
Icon**. macOS offers no way to hide a `Tray`, so off destroys it and on builds a
new one — affordable precisely because of the no-asset rule above: there is no
image to reload and nothing to restore but the mirrored state, which the
renderer owns anyway. `setVisible` returns the *settled* visibility rather than
the request, and `AssistantBridge` writes that back into the preference, so a
build where the `Tray` will not construct cannot leave the switch reading true
over an empty menu bar. Hidden also means idle: the 20-second permission poll
stops, because the only thing it feeds is a menu that is no longer there. The
row is absent altogether in a browser build, where the bridge is undefined —
the same rule that keeps every other unbacked row off these screens. Turning it
off removes the item and nothing else; the global shortcut and the in-window
panel are untouched, and the row's own copy says so.

The preference lives in the renderer's persisted store, which the main process
cannot read: the item is built at `whenReady`, seconds before the renderer has
mounted and can say what was wanted. That gap used to show — an operator who
turned the icon off watched it appear and then vanish on every cold start.
`main.cjs` now keeps a one-key cache of that boolean in
`userData/shell-chrome.json`, reads it before attaching, and hands it in as
`initialVisible`; a hidden attach constructs no `Tray` at all, so there is
nothing to flash. The renderer stays the authority — its push on mount
overrides the cache, and the cache only ever records the visibility that
*settled*, which is the same value `AssistantBridge` writes back into the
store. Two copies of one boolean is the cost; a cache that could disagree with
the store would be a second opinion, and this one cannot. It is the first
preference the main process persists, and deliberately not a store: one boolean
does not need one.

A hidden attach skips the probe that a visible one performs, so nothing is
known about whether this platform can build a `Tray` until the first
`setVisible(true)` — which answers with what actually happened, as before. The
teardown was tightened in the same edit: the permission modules are imported
asynchronously and start the poll when they land, so a tray destroyed before
that landed used to leave a 20-second interval running against an item that no
longer existed. `destroy()` now closes that window.

`registerAssistantHotkey` returns early when the accelerator it is handed is
the one already registered. Three callers reach it on a cold start — main.cjs's
own startup call, the renderer pushing the operator's setting, and StrictMode
invoking that effect a second time in dev — and honouring each literally called
`unregisterAll()` twice for no change, leaving a window where the shortcut did
nothing and printing two log lines claiming a registration that had already
happened. Measured 3 registrations before, 1 after. A *failed* attempt is still
retried rather than remembered: another application may have released the
combination since.

### Dialogs

Every dialog goes through the `Modal` primitive — raised `--surface` behind the
brightest hairline, one close control, sentence-case title at body size. A
dialog that draws its own backdrop and its own header is how the Skills modal
ended up in uppercase mono with two close buttons and a broken template literal.

**A dialog closes in the dialect the window does** (`ui/Primitives.tsx` —
`DialogCloseButton`, `useChromeStyle`). Every dialog drew `MacCloseButton`
unconditionally, so an operator who had set Appearance > Window Chrome to
Windows got three flat caption buttons on the title bar and a macOS traffic
light on every dialog in the app. Two dialects in one window is not a style, it
is a bug you look at all day. `DialogCloseButton` resolves the setting and draws
the macOS disc, the Windows caption ✕ or the GNOME circle; `MacCloseButton`
survives as the macOS branch of it, and a call site that names it directly is a
call site the setting cannot reach — which `tests/recorder-dialog-ui.test.mjs`
asserts against.

What transfers is the **dialect, not the placement**. `CHROME_SIDE` governs the
title bar, which is what that setting's description is about; a dialog has no
minimise and no maximise, is not draggable chrome, and its control stays where
the dialog's own layout puts it. `Modal`'s header is `items-stretch` rather than
`items-center` for one of the three: the Windows caption button is a 46px
rectangle hard against the corner taking the header's full height, and a
centred one with a gap around it is the pixel-level tell that it was drawn by an
app.

`useChromeStyle` is the store-subscribing half of `services/appearance.ts`,
which deliberately knows nothing about the store so the recorder-bar window can
call `resolveChromeStyle` too. Having both means a change in Settings repaints
every dialog at once rather than at the next reload.

`MediaConsentModal` is the one dialog nothing in the shell opens. It subscribes
to the media approval gate's singleton and appears when a tool asks to read a
path the operator has not granted — which means it is mounted in `App.tsx`'s
modal layer rather than beside the feature that raises it, because the caller
may be an agent CLI in another application and the video panel may be shut. It
shows the **resolved** path, never the requested one, and offers three answers:
allow this file · allow this folder for the session · deny. There is no "always
allow" — no grant survives the session.

### Menus are keyboard-driven

`hooks/useMenuKeyboard.ts` is the one implementation; every popover uses it.
Four details are the whole difference between a menu that feels native and one
that fights you:

- **Nothing is highlighted until a key is pressed.** Opening with row 0
  pre-selected means a stray Enter picks something.
- **Movement wraps**, and **disabled rows are skipped** rather than merely being
  un-clickable — landing on a dead row and pressing Enter should never be a
  silent no-op.
- **Hover and the arrows share one highlight**, so using the mouse after the
  keyboard never leaves two rows looking selected.
- **Listeners capture**, because a menu over a focused textarea must take the
  arrows before the field scrolls its own caret.

The model picker spans three groups, so it derives one flat row list in render
order and each group renders against that index. Building it any other way makes
the arrows disagree with what the eye sees.

**Its height is measured, not a `vh` fraction.** The menu is `bottom-11` off the
composer and grows upwards from that fixed edge, so a viewport fraction cannot
know how much room is above it: on the empty chat the composer is vertically
centred, and `max-h-[62vh]` put the first rows — Frontier Flash and the group
above them — off the *top* of the window, where scrolling cannot reach them
because the scroll container itself has gone off screen. `maxHeight` is now read
from the menu's own `getBoundingClientRect().bottom` after layout, less 16px of
air, and re-read on `resize`. The bottom edge does not move when the height
changes, so a single reading is stable.

Rows are 24px on 20px group headers in a 284px column — the density a menu of
this length needs to be read rather than scrolled.

**The voice composer mounts the same picker** (`TemiVoiceStage.tsx`), because
removing the Teminali OS chat removed the only place the engine could be
chosen while Temi is the surface. The trigger sits in the composer pill left of
the microphone and reads the current selection — an agent's own label, or the
Frontier profile name with its glyph.

Mounting it was not enough to make it real. `TeminaliAgentBridge.delegateTask`
resolves its engine as `options.engine || activityStore.activeEngine ||
store.agentSelection?.engine || …`, and `activeEngine` always holds a value
(`"codex"` by default), so the store selection a picker writes was unreachable.
The stage now pushes the picker's choice into the activity store, one direction
only — the picker leads, the pane's engine chip follows — so choosing Claude
Code in the composer delegates to Claude Code rather than silently to Codex.

### Composer triggers

`/` mounts a skill, `@` attaches a file. Both live in
`utils/composerTrigger.ts` because the two rules that make them feel like an
editor rather than an interruption are worth testing:

1. **A trigger only opens at a word boundary.** The `/` in `src/App.tsx` and the
   `@` in `user@host` are punctuation. A menu that opens on those is the single
   most irritating way to get this wrong.
2. **While the menu is open, the keyboard belongs to it.** Arrows move, Enter
   and Tab accept, Escape dismisses — otherwise Enter sends a half-written
   prompt instead of picking the highlighted row.

The placeholder had advertised both for months with nothing behind either.

### No dead affordances

Five rules that a January audit had to enforce retroactively, so they are
written down now:

1. **A control that does nothing must not look like a control.** The empty
   state's pickers carried a chevron and no handler for months. `Picker` now
   requires `onSelect` for the chevron to render at all, so the shape of the
   control always matches what it does.
2. **A nav row must lead somewhere.** "Automations" set an `activeView` that
   nothing rendered — it highlighted itself and showed nothing. It was removed
   rather than pointed at an unrelated surface. `PRIMARY_NAV` carries a row only
   when there is a view behind it.
3. **Never render data the app invented.** `FILE_CONTENTS` held hardcoded copies
   of six files, seeded two editor tabs on boot, and was the fallback whenever
   any file was opened — so the editor could show text that was not what was on
   disk. Gone. A tab with no content yet is empty and fills in from the real
   file.
4. **A status is measured or it is not shown.** The General settings screen had
   a hardcoded green "Connected" badge and the line "Running locally at
   http://127.0.0.1:4310 · Ollama connected", neither of which was ever read
   from anything — and the port is not even fixed, since a taken 4310 moves the
   app to an ephemeral one. It now probes `/api/health` and renders
   Checking / Connected / Degraded / Unreachable, with the address the renderer
   is actually talking to.
5. **A claim about where data goes is load-bearing; get it right.** The same
   screen asserted "100% Local Execution · Zero Telemetry Exfiltration — your
   codebase, prompt context, and file mutations never leave this machine",
   unconditionally. False: the Claude Code, Codex and cloud lanes send prompt
   context to their providers, which is what those engines are. Somebody could
   have picked an engine on the strength of it. The card now separates what is
   true per lane from what is true of the app itself (no analytics; the update
   check asks GitHub for a version number and sends nothing about you).

Four controls went the same way in that sweep — Tips, Window Restoration,
System Notifications, Completion Sound — each a `useState` read nowhere else,
for features that were never built: there was no rotating-tips surface, no
Electron `Notification` anywhere in the app, no completion-sound player, and no
notion of the three restoration modes. Rule 1 says remove, not fake.

Three of those four are back (2026-09-10), and the distinction matters: they
were **built**, not restored. `services/notifications.ts` posts the
notification and synthesises the chime, and the store drops the editor tabs on
rehydrate when the restore preference is off — so each row now moves something.
Tips stayed deleted, because there is still no rotating-tips surface to switch
off.

The settings rail was the largest surviving instance, and it is now closed
structurally rather than by another sweep (`settings/SettingsPage.tsx`,
2026-09-10). It advertised seventeen categories and rendered five: the content
was a ternary chain over `activeCategory` whose final `else` drew the General
screen, so Profile, Appearance, Plan & Usage, Teminali OS and Browser
highlighted themselves and showed General. Worktrees, Tab Autocomplete, AST
Indexing and Cloud Agents had no backing code anywhere in `src/` or `server/`,
and Docs was an inert link to a documentation site that does not exist.

The rail and the content pane are now derived from one `panes` registry whose
entries require a `render`, so a category with no screen behind it cannot be
written down. The two rail entries that hand off to another modal — Skills &
MCP, Benchmark Qualification — are a separate `kind: "action"` and can never be
selected as content. Five panes remain: General, Local Models & Weights, Git &
PRs, Voice & Conversation, Screen Assistant. The others return one at a time as
their pane is actually built, in the order set out in
`studio/docs/SETTINGS_AND_CHROME_PLAN.md` §5 — which is also where the
adopt/adapt/reject call for every row lives.

Settings is a page, not a dialog (`settings/SettingsPage.tsx`, `App.tsx`,
`store/studioStore.ts`, 2026-09-10). The fixed 1040×680 box over a dimmed
backdrop is gone: the shell renders the page in place of the sidebar and
workspace, under the title bar, so the window controls stay where they are and
the page reflows with the window — a 240px rail, then one column capped at
880px. `⌘,` opens and closes it, Escape and the rail's `← Back` return the
workspace exactly as it was, and `settingsView: { open, category }` lives in
`studioStore` rather than an `App.tsx` `useState`, so the open pane is shell
state. The category persists across a reload; `open` does not, because a reload
should return you to your work rather than to the screen you were configuring
it from.

The title bar goes quiet while the page is open (`layout/StudioTitleBar.tsx`,
2026-09-10). "Under the title bar" was true of the geometry and false of the
controls: the bar kept driving a workspace that was no longer on screen, so
`Editor` opened a video panel behind Settings, the tab strip switched panels
nobody could see, the session arrows walked chat history in the dark, and `⌘B`
jogged the bar's own divider over a hidden sidebar. Worse, that divider sat at
`ACTIVITY_BAR_WIDTH + sidebarWidth` — 260px by default — against a 240px rail,
so the one line the two regions share had a 20px step in it. With
`settingsView.open` the bar now renders only the window's own business: the
control cluster, the drag region and double-click to zoom, with the left region
taking `SETTINGS_RAIL_WIDTH` so the border continues into the rail's. The
constant is exported from `SettingsPage.tsx` and consumed by the bar, because a
Tailwind `w-60` is not a number another file can agree with. Back or Escape
restores the full bar, sidebar width and open panels included.

The rail's search matches rows, not only category labels. Each pane declares
the rows it contains, an entry that matched on its contents lists which rows
matched, and typing "interrupt" finds the switch on the voice screen without
knowing which category it was filed under. The declared rows are row labels and
are renamed in the same edit as the row — a search that offers a row which is
not on the screen is the same class of lie as a rail entry with no pane.

The Appearance pane (`settings/AppearancePane.tsx`, `services/appearance.ts`)
is the first deleted category to return. Its rows all change something the
operator can see the instant they move: the store writes through
`applyAppearance`, which sets CSS custom properties and root classes on
`document.documentElement`, so there is no Save button and no preview that
lies. It is not a React module on purpose — the recorder window renders in a
second renderer with no access to the studio store, and `resolveChromeStyle`
has to be readable there.

One row Cursor has is deliberately absent:

- **Theme.** This build has exactly one. `tokens.css` is a measured dark
  palette with no light or high-contrast counterpart, so a theme picker would
  be four options and one outcome. It returns when a second palette exists.

**Window Chrome** is the row that took the longest to earn its place. It was
built, then pulled, then shipped: `appearance.chromeStyle` and
`resolveChromeStyle` persisted for a step during which the title bar still drew
macOS traffic lights on every platform, and a picker offering Windows and Linux
would have advertised a capability the shell did not have. It returned with the
clusters, which is the same rule the Theme row is waiting on.

`layout/WindowChrome.tsx` draws all three dialects, to measurements taken off
the reference windows rather than chosen:

| Dialect | Cluster | Behaviour |
| --- | --- | --- |
| macOS | three 13px discs, 10px gap, **left** | glyphs on hover only; lights dim to 45% when the window is not key |
| Windows 11 | three flush 46px caption buttons, **hard right**, full caption height | `--chrome-win-hover` wash; close takes `--chrome-win-close` with a white glyph |
| Linux (Adwaita) | three 24px circles, 6px gap, 6px inset, **right** | symbolic glyphs at rest, as GNOME draws them; close is not red at rest |

The Windows buttons take the full 40px caption height rather than the 32px of a
default Windows title bar, because on Windows the buttons take the caption
height — a 32px button in a 40px bar leaves an 8px strip at the very corner
that hover does not fill, which is the one pixel-level tell that these are
drawn by an app.

Which end of the bar each takes is `CHROME_SIDE`, and what each costs in width
is `CHROME_CLUSTER_WIDTH`; both live in `services/appearance.ts` beside the
resolver, not in the component, because `StudioTitleBar` has to reserve from
them and the recorder window has no React tree of ours to read a component
constant from. `tests/appearance.test.mjs` pins both — a flipped side renders
the cluster on top of the panel tab strip, and a width that drifts from what
the component draws overflows the space its own bar reserved.

`electron/main.cjs` runs `frame: false` on every platform, so none of this is
native integration: there is no `titleBarStyle`, no `titleBarOverlay` and no
per-platform `BrowserWindow` branch. That is also why the override is offered
at all — a macOS operator can pick the Windows bar, which is the only way three
dialects are testable on one machine.

The accent control is the one with real teeth. `--accent-ink` was the constant
`#151515`, which was only ever safe because `--accent` was the constant
`#00bf63`; once the hue is the operator's it is not, and dark ink on a blue
accent at the brand's lightness measures **1.52:1**. So `solveAccent` picks the
ink per fill and, where neither ink clears 4.5:1 — a narrow band around orange
and teal, **12.6% of the hue x intensity space** — walks the fill darker until
one does. Hue 151 at intensity 100 is untouched: lightness 37.5%, fill
`#00bf63`, dark ink, **7.51:1**, which is the figure the token sheet already
claimed. The accent ramp moves as offsets from that stop so it keeps its shape
rather than collapsing onto one value.

Code size and UI size are separate controls reading separate tokens
(`--code-font-size`, added in this work, against the `--text-*` ramp): an
operator who grows the chrome has not asked for larger snippets. Note
`--text-code` is the code text *colour* and predates it — the near-collision is
why the size token is named the way it is.

The audit that found these is reproducible: build the import graph from
`main.tsx` and anything unreachable is dead; grep `<button` for tags with no
`onClick`; and diff the `/api/` strings in `src/` against the routes
`server/gateway.js` actually serves.

**General, Profile, Licence & Usage and Git & PRs** are the second wave of
panes (2026-09-10), and between them they took the settings rail from five
screens to eight. All four are built out of the `ui/Setting.tsx` row family, all
four declare their rows for the rail search, and each is a `.tsx` pane in
`settings/` with its state in a `.ts` service — the split `AppearancePane`
established, for the reason the tests need it.

**About is the tenth pane, and the only one whose absence was a licence
breach** (`settings/AboutPane.tsx`, `services/aboutService.ts`,
`server/about.js`, 2026-09-11). The installers now carry an FFmpeg we built
ourselves under LGPL-2.1, and §6 of that licence is met only when the shipped
components are named with their versions and the corresponding source is
offered — `docs/MEDIA_LICENSING.md` calls this surface the shipping blocker for
exactly that reason. It is not one of the screens
`docs/SETTINGS_AND_CHROME_PLAN.md` §5 queues up; it arrived from the licence,
not from the settings plan, which is why it is last in the rail rather than in
that document's order.

Nothing in it is compiled in. `GET /api/about` reads the `manifest.json` that
`scripts/build-media-stack.sh` wrote *beside the binaries it produced*, so the
pane cannot name a different ffmpeg from the one the app will spawn; a version
bumped in the script and not in a hard-coded list would otherwise make the
interface state a falsehood about a file two directories away. The licence
texts are listed from `licences/` rather than enumerated, so a component the
build drops disappears from the pane by itself, and `GET /api/about/licence`
matches `bundle` and `file` against that listing instead of sanitising them —
a name that is not in the bundle is a 404, and `../` has no path to take.

The pane's honest empty state is the load-bearing half. A build made without
the media-stack script ships no bundle — every release up to and including
v0.0.7 did, and Linux and Windows still do — and it says so in words: the app
is using an ffmpeg it found on
the machine, which we did not build and whose licence we cannot state on its
behalf. Claiming LGPL compliance over somebody else's Homebrew binary would be
worse than saying nothing.

Two new services carry them. `services/preferences.ts` is the sibling of
`services/appearance.ts` and is deliberately not the same shape: appearance
finishes its job the moment it is written onto the document, whereas "open
links in the in-app browser" is a rule that has to be read at the instant a
link is clicked, by code nowhere near a React tree. So it publishes the settled
preferences into module scope and `currentPreferences()` is how a non-React
caller reaches them. `services/notifications.ts` owns the turn announcement.

The announcement hangs off **one** place: the falling edge of `setStreaming` in
the store. `setStreaming(false)` is called from eleven sites across three
components, all on the streaming path, and threading an outcome argument
through all eleven to serve a settings row would put an edit on the most
load-bearing path in the app. Instead `latestSettledTurn` picks the newest
assistant message across the four engine transcripts — ids are minted
`msg_${Date.now()}_${rand}`, the only millisecond stamp a message carries,
because `timestamp` is a localised hour and minute — and the message already
carries its own verdict, since every call site sets `errorCode` and `cancelled`
*before* it clears the flag. A turn the operator cancelled notifies nothing:
they were there.

Two rules the notification rows depend on, both stated in the row descriptions
so the toggle is never quietly narrower than it reads: a notification fires
only while the window is **not** focused, and the chime is deliberately exempt
from that, because somebody who turns it on is asking to hear the end of a turn
whether or not they are watching. The permission is asked for from a row on the
screen rather than at launch — a prompt before the operator has seen a single
notification is the one most reliably denied, and a denied permission is not
recoverable from inside the app on any platform. The row reports `granted` /
`denied` / `default` / `unsupported` honestly, which is the part Cursor's
equivalent screen leaves out.

**Agents is the screen where an overstated row is dangerous, not just untidy**,
because it is the one that decides how much runs on this machine before a human
sees it. Five of Cursor's seventeen rows; the twelve absences and their measured
reasons are in `docs/SETTINGS_AND_CHROME_PLAN.md` §3.

**Run Mode has three modes and the fourth name is the point.** *Ask every time*,
*Review changes* (the default, and what the runner always did), *Run without
asking*. They sit over verdicts `classifyCommand` already produced, so the mode
decides only what happens to `auto` and `confirm` — a `blocked` command is
refused in all three and never offered for approval. **There is no sandbox
mode, because there is no sandbox**: commands are handed to a shell with the
app's own privileges against the real filesystem, and a mode named for
containment we do not have would be the most dangerous label in the app.

**The deletion guard is what makes an unattended mode offerable at all.**
`isDestructiveCommand` keeps a delete-shaped line asking even under *Run without
asking*, matched on the whole line rather than per segment because `x && rm y`
deletes whichever half you look at. The asymmetry it encodes is recoverability,
not danger: a bad edit is in the change dock and in git, and a deleted file is in
neither. In the other two modes a delete is a state-changing command and already
stops, so the row says so rather than reading as though it were doing something.

**"Always allow" is now an answer you can see and take back.** The gate has
always remembered an executable; it forgot it at window close and there was
nowhere to look at one, which makes it not really an answer. The list is in
preferences, the gate mirrors it, and the mirroring runs both ways — a grant is
pushed out to the store, and the store is pushed back into the live gate
whenever it changes, so deleting an entry in settings stops it allowing things
in the run that is already open rather than at the next launch. One list covers
shell and MCP because the gate keys on `commandHead`, which is the executable
for a command and the whole `mcp__server__tool` name for a tool.

**External-File Protection is a statement, not a switch.** `server/workspace.js`
resolves every path against the workspace root and refuses anything landing
outside it, on read, write and delete alike; there is no setting that relaxes
it, so a toggle would either do nothing or offer to remove the guarantee. The
row says that, and then says where the boundary stops — shell commands are
bounded by nothing but Run Mode — which is the half that changes what an
operator does.

**`approvalStore.ts` was not touched.** It was named as this pane's blast radius
and turned out to be the live pending-*prompt* slot the voice lane speaks from,
not a settings store. The machinery that decides whether a command runs is
`services/agentCommands.ts`; `runAgentCommands` already carried an
`autoApproveAll` option no caller ever set, which is now `runMode`. Both engine
call sites spread `commandPolicy()` at the moment of the call, so tightening the
mode mid-turn tightens that turn.

**Git & PRs adopted one of the plan's five rows, and the four absences are the
point.** The app makes no commits and opens no pull requests — there is no `git
commit`, no `gh pr create` and no review flow anywhere in `src/` or `server/`;
GitHub integration is sign-in, repository listing and clone. Review Provider,
Commit Attribution, PR Attribution and Branch Prefix would each control
something that never happens. The fifth row survived and grew: Cursor's "PR
Link Destination" chooses where a PR link opens, and ours governs **every** link
in the app, because we have an in-app browser and a chat full of links.
`services/linkOpen.ts` is the single door every one of them goes through, which
is also the only place to refuse a scheme — a link in a chat answer is text a
model produced, so only `http`, `https` and `mailto` leave.

**Restore Last Session restores the workspace, not the window.** The shell does
not persist its own bounds, so size and position are the host's business; the
row says so rather than implying a restore that does not happen. And what it
drops is editor tabs and the active tab only — chat transcripts stay, because a
layout preference that silently deletes work is not a layout preference.

**Licence & Usage reuses `EntitlementSection` rather than reimplementing it.**
That component already reads the plan catalogue from the gateway (which reads
`licence/entitlements.js`), and already fails to null rather than telling an
offline subscriber they are on Free. Beside it are the facts a local operator
actually wants — gateway address and health, the active lane, and what the
weights on disk come to — all measured on open, none remembered. The gateway
card moved here from General, where it had been the only thing on an otherwise
near-empty screen.

**The last three bespoke screens are on the row family (2026-09-10).** Screen
Assistant, Local Models & Weights and the GitHub block inside Git & PRs were what
the conversion had left behind. `AssistantSettingsPanel` was five bare
`<section>`s with three `SegmentedTabs`, two raw checkboxes and a hand-built
permission card, at a type scale one step larger than every pane beside it;
`ModelsPane` carried a private segmented `Option`; and `GitHubConnect` was a
stack of `lit` cards that `GitPane` then wrapped in a card of its own — a card in
a card in a page. All three build out of `ui/Setting.tsx` now, and Screen
Assistant and Local Models declare their rows for the rail search, which neither
had ever done, so searching "Frontier tier" or "Runtime" now finds the screen it
is on.

**A segmented control became a select in four rows, for the reason Run Mode did.**
The assistant's mode, autonomy and engine, and the runtime switch on Local
Models, each need a sentence of consequence per option; three words fighting for
the width of a row say less than a label, a control, and a sentence that changes
with the control. This does not deprecate `SegmentedTabs` — it is still right
where the options are peers that explain themselves — but a settings row is not
that case.

**A catalogue is not a row family.** `ModelLibrary`, `ApiProviders` and the
repository list stayed lists. The repositories moved *inside* a `SettingGroup`
and draw their hairlines with the group's own divider, so two hundred
repositories are one cell of the card rather than a second card inside it; the
model and provider catalogues sit below the Runtime group rather than in it. A
list dressed as a set of settings reads as one very long setting.

**The assistant's Frontier tier row is worded from the routing table.**
`gateway/frontier-runner.js` `MODEL_MODES` is what the routing actually consults,
so its three descriptions are that table's rather than invented beside it. The
tier picker carried no description at all before.

**The first visual pass over all nine screens (2026-09-10).** Every screen up to
this point had been typechecked and suite-green without anyone looking at it, and
three had changed shape the session before. Driven through CDP against the dev
server at 1280×820, all nine render; control right-edges are a consistent 15px
gap from the card in every group but the deliberately inline ones (the voice
name chips, the model catalogue rows). Four things were wrong and are fixed:

- **`AppearancePane` had no `<h1>`** — alone among the nine, so the screen opened
  on a bare group label and read as though it had been scrolled past its title.
- **`GitHubConnect`'s waiting state was an unhoused spinner.** Once `GitPane`
  rendered the component bare, the `loading && !status` branch returned a spinner
  centred in the empty page, and the real card then landed somewhere else. It is
  now an Account card that keeps its place and fills in.
- **The voice greeting field was `w-36`** — 144px of a 205px default value, so the
  shipped greeting was cut off in its own box. It is `w-64`, sized to hold it.
- Its loading copy quoted `gh auth status` in backticks, which a `description`
  string renders literally. Descriptions are plain text; no markdown decodes.

**A second pass, on two things the first one recorded and left (2026-09-10).**
Both were seen during the visual pass, called deliberate-looking, and deferred
for a decision rather than patched:

- **`ModelsPane` was the only pane whose first group carried no label**, and the
  only one with two vertical rhythms. `ModelLibrary` and `ApiProviders` stack
  their own cards at `gap-4`; the runtime card sat in the pane's outer
  `space-y-6`, so the first gap on the screen was 24px and every gap after it
  16px, which read as a switch on its own screen above a separate list. The
  cards now share one `gap-4` column and the heading keeps its 24px, as in every
  other pane. The group is captioned *Where turns run* — the caption names the
  area and the row names the control, which is the `Startup` → *Restore Last
  Session* pattern; captioning it *Runtime* would have repeated the row's own
  label back at it, and *Models* would have repeated the `<h1>`.
- **The model picker is edited from settings, not from inside itself.** Cursor's "choose which models appear in the picker" and its collapsible API Keys were adopted into `ModelsPane` as a second group, *In the model picker*, and a disclosure in `ApiProviders`. The list is edited from settings for the obvious reason: a menu that can hide its own rows has no row left to unhide them from. What is stored is `preferences.hiddenModelProfiles` — the **hidden** set, not the shown one, so a profile a later build adds arrives on the menu of an operator who never saw it; a shown-list would withhold every future model from every existing install. Two rules keep it honest and they are one rule seen from two sides. The profile **in use** cannot be switched off — its toggle is disabled and the row says *In use* — which is also what stops the menu emptying, because `currentProfile` always names one of the four whether or not an agent holds the selection instead. And `visibleModelProfiles` offers the active profile **even when the stored set hides it**, because `CommandPaletteModal` selects `auto` and `flash` and `GeminiKeyModal` selects `max` without consulting the list: a hidden profile really can become the running one, and a menu that could not name what it was running would be a worse lie than one row too many. That rule lives in `services/preferences.ts` beside the preference rather than in the picker, so a test can reach it without a DOM, and `ModelPicker` runs **both** its keyboard index and its render through it — an arrow key must not reach a row the eye cannot see. The keys collapse on the same principle applied to a default: the section opens itself while no key is configured, because collapsing the only route to the capability the screen exists for would be a shut door with no handle, and closes once one is; the operator's own toggle outranks that from then on, which is what the third `null` state of `keysChoice` means.
- **`GitHubConnect`'s repository list was a scrollport inside a scrollport.**
  Its `max-h-96` put 383px of window over 2254px of list — 49 repositories — in
  both callers, each of which already scrolls: the settings page, and the
  modal's `flex-1 min-h-0 overflow-y-auto` body. The wheel was trapped inside a
  card that looks like part of the page. The cap is gone and the list flows into
  whichever scrollport owns the screen. Sticky search was considered and
  rejected on a measurement, not a preference: the group's card is
  `overflow-hidden`, which makes that card the sticky element's scrollport and
  pins it to nothing.

**The off state of `SettingToggle` is not legible, and no token can fix it.**
Measured, not eyeballed: the off track is `--surface-hover` `#242424` on a card of
`--surface` `#212121`, a contrast ratio of **1.04:1**, against the 3:1 that WCAG
1.4.11 asks of a control's boundary. An off switch therefore reads as a white dot
floating on the card with no slot around it. This is not a wrong token choice that
a better token would settle: the whole dark ramp tops out at `--border-popover`
`#3a3a3a`, **1.42:1**, and a compliant track needs roughly `#6b6b6b`. It was put
to the user rather than decided quietly, being a §0 question that changes every
switch in the product; the answer was to admit the token. `--surface-track`
`#6b6b6b` is now in §0 and `SettingToggle` draws its off state from it, measured
in the running app at **3.02:1**. It is the only surface here not sampled from
the reference captures, and it is deliberately the darkest value that clears the
bar — `#6a6a6a` was written first and measured **2.98:1**, under by one step of
grey, which is exactly why the value is measured in the app and not reasoned
about on paper. It costs the ramp nothing new: `#6b6b6b` is already the palette's
`--text-placeholder`, so this admits a role, not a colour. `ui/Setting.tsx` is the sole `role="switch"` in the codebase, so one change
reached every switch; the other `bg-surface-hover` pills are hover states on
round buttons and are none of this.

**A download that says nothing is a button people press twice (2026-09-11).**
`ModelLibrary`'s Download control span a `Loader2` and read *Pulling* for the
whole of a pull. These weights run from two to thirty gigabytes, so that is a
control that looks inert for tens of minutes — and an inert control is one the
operator presses again. `/api/models/pull` now streams NDJSON and the row shows
what arrived: the percentage in the button, a 2px accent bar under it, and
Ollama's own status word as the title. Two decisions inside that are not
cosmetic. **The bar only exists where a number does** — Ollama sends byte counts
for layer downloads and not for the manifest, verify or write steps, and a bar
invented to cover those gaps would be exactly the decoration this pane refuses;
those frames show a word instead (*Manifest*, *Verifying*, *Finishing*).
And **the percentage is per layer, not per download**, because that is all
Ollama reports — measured against the real daemon, one 135M model was 314
frames across **6 layers**, so the bar genuinely restarts six times. The status
word beside it is what makes that legible rather than looking broken; inventing
a whole-download percentage would have meant summing totals the daemon only
reveals one layer at a time.

**An empty lane now names its own fix.** `LaneRow`'s empty state was the words
*nothing installed for this lane* and nothing to press — it told the operator
they had a problem and left them to find the answer among thirty models. The
row now names the model that would take the lane and offers to download it.
What makes this honest rather than a guess is where the suggestion comes from:
`planRouting` gained an `{ installed: false }` option and the server runs the
**same chooser** over what this machine could install, so the model offered is
the model that would actually win the lane once it lands. A separate
"recommended" heuristic beside the router was the obvious shortcut and is the
wrong one — the moment the two drift, the pane recommends a download the router
would then decline to use, and nothing would report it. A suggestion is only
ever rendered for a lane that is genuinely empty, and `planRouting` will not
return a model this machine cannot run, so the offer cannot be one that would
swap the laptop once accepted.

### Verifying a change against the reference

The four capture files this system was measured from are Cursor screenshots at
2× on a 1512×950 window. To check a change, render the app at the same size and
compare pixels rather than impressions — the differences that matter here are
1–3 values of grey and 1–2px of geometry, and neither survives being eyeballed.

---

## 4. Official models (engineered wrappers)

Models are wrapper architectures that route and orchestrate prompts against
best-fit local engines — not raw weights we train.

1. **Frontier Auto** (flagship) — adaptive router; multi-file edits, tool
   execution, step-by-step verification.
2. **Frontier Flash** (fast path) — single-model execution; instant local edits,
   high-throughput streaming, VRAM release on Apple Silicon.
3. **Teminali Max** (heavyweight) — the heavy local model for every request.
   Presented in the picker and **locked**: it stays unselectable until its exact
   artifact and product path pass the safety canary, which is recorded in
   `gateway/model-qualification.json` and is currently `qualified: false`. The
   badge says so rather than the option quietly failing.

A locked option that explains itself is the point. `studioStore.ts` carries the
badge copy beside the profile, so the reason travels with the thing it disables.

---

## 5. The screen assistant (`studio/src/services/assistant/`)

Hold the shortcut — or press the microphone in any composer — say what you need,
and it looks at your screen: **talk** mode explains and points, **agent** mode
acts. It has its own menu bar item beside Guardian's, and it draws on the real
screen over whatever application it is talking about.

### The decision the whole subsystem is built around

**A vision model is never asked where anything is.** Ask one to read a position
off a screenshot and it returns numbers that are plausible and wrong, and in
agent mode plausible-and-wrong clicks the row below the one you asked for.

So the screenshot is context for reasoning and nothing else. Positions come from
the macOS accessibility tree: `native/macos/pointer` walks `AXUIElement` and
reports every addressable control with its role, title, enabled state and exact
frame; the model picks one **by name**; the frame the operating system reported
is what gets clicked.

That is enforced in three places, and the innermost one is structural rather
than procedural:

1. **`PlanStep` has no coordinate field.** Not optionally, not on any variant. A
   model that emits `x`/`y` is not partially trusted — the number is not
   representable in the protocol and is discarded with every other unknown key.
   `tests/assistant-plan.test.mjs` asserts a plan carrying coordinates comes back
   without them.
2. **`validatePlan` resolves every reference against the inventory** and drops
   anything that does not resolve, with a reason in plain words. An id the model
   invented is therefore harmless rather than destructive.
3. **The gateway re-checks all of it.** `/api/assistant/act` accepts an
   observation id and an element id — never a point. It refuses an expired look
   (90 s), an element that was not in it, a disabled one, one that is no longer
   on any screen, and any action taken after the frontmost application changed.
   The renderer's validation is for the operator's benefit; this one is the
   boundary.

### Three modes of one assistant, not two recorders

The microphone in the composer, the global shortcut and the menu bar item are
three doors into one session. The mode decides what an utterance becomes:

| Mode | What the words do |
| --- | --- |
| `dictate` | Go into the composer, repaired and shown for approval — the original voice behaviour, unchanged |
| `talk` | Ask about the screen; it answers aloud and draws a ring around what it means |
| `agent` | The same, and it may click, type and scroll |

**The default is `agent`.** It was `talk` until 2026-09-03, when the operator
chose an assistant that does the thing rather than one that points at it. An
assistant which answers "switch to agent mode and I could do that for you" has
already failed the request it just understood.

The session lives in `useAssistant` in the shell and reaches every composer
through `AssistantContext`. It owns no microphone: the chat lends it the one
`VoiceEngine` (`attachVoice`), which is what stops a second door from opening a
second recorder.

### The assistant never takes focus, because focus is the target

Activating the assistant used to call `window.show()` then `window.focus()`,
which made Teminali OS the frontmost application. The pointer helper reads the
tree of `NSWorkspace.shared.frontmostApplication`, so the assistant would look
at the screen and find **itself** — the operator asks about Spotify from inside
Spotify, and the assistant inventories the Teminali OS window it just raised.
Every door that starts a turn — the global shortcut, the tray's "Talk to the
assistant", a tray double-click — now shows the window with `showInactive()`,
and the frontmost application stays whatever the operator was using. Only "Open
Teminali OS" still activates, because there the operator asked for the window
rather than for an answer.

`/api/assistant/observe` also accepts an optional `pid`. `observe()` always took
one and the route dropped it, so every observation fell back to the frontmost
application whether or not the caller knew better. Omitted still means "whoever
is in front", which is the right answer nearly always.

### Opening what is not on the screen yet

The assistant's whole vocabulary was `point · click · type · key · scroll ·
wait`, every one of which needs a control that already exists. Asked to open a
browser it answered, correctly and uselessly, that it could not see a browser
button anywhere. **`launch` is the step that starts an application**, and it is
the only one that names no element, because the entire reason for it is that
what the operator wants is not on the screen.

`{ "kind": "launch", "app": "teminali", "url": "https://youtube.com" }`

**An unqualified "browser" is this application's own** (2026-09-06). The plain
words — `browser`, `the browser`, `web browser`, `browser panel` — resolve to
`BUILT_IN_BROWSER` rather than to Safari, because an operator looking at a
window that contains a browser and saying "open it in the browser" is not
asking for another application to appear over the top of it. Named browsers are
untouched: `safari` is still Safari.

It is deliberately **not** in `LAUNCHABLE_APPS`. That list is mirrored field for
field by the gateway's copy and is a list of things `/usr/bin/open` can start; a
panel is not one of those. So `useAssistant` answers the step itself — it calls
`openBrowserAt` and never crosses the boundary — the gateway is never told a
pseudo-application exists, and the step does not set `relocated`, because unlike
a real launch it does not replace the screen the next step was planned against.
`launchableIds` always contains it (the machine cannot fail to have the
application it is running) and `launchableInventory` puts it first and never
truncates it away. Pinned in `tests/assistant-launch.test.mjs`.

**`app` is an id, never a path and never a command.** An id the model invented
resolves to nothing and starts nothing, which is the same guarantee `PlanStep`
makes about coordinates applied to executables — the dangerous shape is not
representable rather than merely discouraged.

**Where those ids come from widened.** They were `services/assistant/apps.ts`
and only that: twenty-four applications, and asking for anything else got a
refusal. That is not what an operator means by an assistant that can drive their
computer, and when asked directly they said so — let it open anything they
actually have. So the list is now assembled on the machine by
`installedApplications()` in `server/assistant.js`, in two passes:

1. **The curated entries**, by exact name, in the order they are read to the
   model. They stay because they carry what a directory scan cannot infer: a
   stable spoken id, the words an operator would actually say (`browser` →
   Safari, `vs code` → Visual Studio Code), and the `browser` flag that decides
   whether a URL may be handed over. A curated entry always wins the name it
   claims.
2. **Every other `.app`** under `/Applications`, `~/Applications`,
   `/System/Applications` and `/System/Applications/Utilities`, one vendor
   folder deep so that `/Applications/<Product>/<Product>.app` — how Adobe and
   JetBrains install — is found. The id is the display name slugged
   (`Adobe Photoshop 2024` → `adobe-photoshop-2024`) and no plist is read,
   because the basename is the whole of what `open -a <path>` needs. On this
   machine that is 111 applications, 95 of them discovered.

`/System/Library/CoreServices` is searched for a *named* catalogue application
and never enumerated: Finder lives there, and so do `loginwindow`,
`SystemUIServer` and `Dock`, which are parts of the window server rather than
applications anybody opens.

Three absences survive the widening, and `tests/assistant-launch.test.mjs`
asserts all three:

- **Still no terminal.** Terminal, iTerm, Warp, Ghostty and the rest are skipped
  by name, along with Script Editor and Automator, which run `do shell script`
  from a document. A shell prompt plus the `type` step is arbitrary code
  execution wearing an allowlist, and "any application" that included a command
  line would make the CLI permission gate ornamental — everything it guards
  would be reachable by typing into a window instead.
- **Still no free-text escape hatch and no setting that appends to the list.**
  The list widened because the filesystem says so, not because anything can be
  talked into extending it mid-session.
- **Still never a path.** The step names an id; the path stays on the gateway,
  which is the only place that ever spawns `open`.

The prompt names at most `MAX_INVENTORY_APPS` (120) of them — the curated
entries and the browsers are ordered first, so the ceiling falls on the tail —
and tells the model the remainder exists and may be named exactly as it appears
in its menu bar. Validation uses the whole list, so an application past the
ceiling still launches when it is named.

Only a browser may be given a `url`, and only an `http` or `https` one. `file:`
reads the disk, `javascript:` runs in whatever is frontmost, and a custom scheme
is a message to an application chosen by the URL rather than by the catalogue.
An address carrying credentials is refused as well. This grants nothing the
assistant could not already do — it can type into an address bar — and replaces
a fragile click-type-return dance with one step that either happens or does not.

**A launch is the last step of a plan.** The application it starts has no window
yet, so anything after it either names an element from the screen being replaced
or types into whatever finishes appearing first. The validator rejects every
following step with that reason, the gateway forgets the observation the moment
the launch succeeds, and the renderer drops its cached look — so the next
sentence is answered against a fresh one rather than against a screen that is
gone.

Which applications are actually installed is answered by the machine, not
assumed: `observe()` returns `launchable` — entries of `{ id, name, browser? }`
rather than bare ids, because a discovered application's name and browser flag
exist nowhere else — and the prompt offers the model those, in agent mode only,
since talk mode would have the step withheld anyway. The scan is cached for
`installedTtlMs` (60 s) and bounded at `maxInstalledApps` (400). An application
installed somewhere unusual reads as absent and the assistant says so, which is
wrong-but-safe rather than wrong-and-launching.

A `focus` on a discovered application has no bundle id to aim at, so
`pointerActivate` gained a third address — `{ name }`, matched against
`localizedName` by the helper's `activate --name` — and `waitForFront` falls
back to the same comparison. Bundle id where there is one, display name where
there is not.

The allowlist exists twice on purpose. The renderer needs it to build the prompt
and validate a plan; `server/assistant.js` needs it because `/api/assistant/act`
is reachable over HTTP and nothing at the boundary may trust that the renderer
checked. They cannot be one file — one is TypeScript that only ever runs through
the bundler, the other runs unbundled inside Electron — so a test asserts the two
lists are identical field for field.

**`open` is spawned with a scrubbed environment.** It hands its environment to
the application it starts, and the gateway's environment is Electron's, with
`ELECTRON_RUN_AS_NODE=1` set — that is how the server is running at all.
Inherited, a launched Electron application starts as a bare Node process and
exits instantly, which looks exactly like a crash. The child gets that variable
removed and the `PATH` a Finder launch would have had. It is the same rule
`CLAUDE.md` records for running `open` by hand, and the test asserts it.

### Autonomy is a ladder, and the default sits at the top

`guide` draws and touches nothing, not even the pointer · `confirm` asks before
each acting step · `auto` runs the plan. **The default is `auto`, changed by the
operator on 2026-09-03.** It was `confirm`, on the rule the agent CLIs follow:
something that can click anything on your screen without asking is a choice the
operator makes explicitly. That reasoning still holds — this is that choice,
made once for the product instead of once per click, because an assistant that
stops for approval on every step is not the hands-free assistant being built.
The two safer rungs are one switch away and are what a cautious operator sets.
`tests/assistant-plan.test.mjs` asserts the default is the top rung **and** that
`guide` and `confirm` remain on the ladder, so the decision stays reversible.

### Any of the three engines

Frontier (Flash/Auto/Max), Claude Code and Codex are all first-class. They are
asked the same prompt, given no tools, and held to the same validator, so
changing the engine changes who answers and nothing else.

`services/assistant/engine.ts` deliberately does **not** call
`AIService.streamMessage`. The chat path wraps a turn in a system prompt about
emitting workspace files, hands the model a shell executor, and runs
completeness and diligence correction passes. All three are right for a coding
turn and wrong here — an operator who asked where the archive button is has not
asked for a command to be run in their repository. The CLIs are pinned to their
read-only rungs (`claude --permission-mode manual`, `codex --sandbox read-only`)
rather than to the operator's chat setting.

### Two permissions that cannot be scripted around

Screen Recording and Accessibility are System Settings switches only a person
can flip. They are detected and named **individually**, because they lose
different things: without Screen Recording the assistant cannot see the screen
at all; without Accessibility it can describe the screen but cannot point at or
touch anything on it. A single "grant access" would say neither. The observation
degrades rather than fails, and `limits` carries the sentence the interface
shows. `npm run assistant:doctor` reports the whole path on the screen as it is.

Naming the permission is not enough on its own, because the switch is not
labelled with the product. TCC grants Accessibility to the application
*responsible* for the pointer helper, never to the ad-hoc-signed helper itself,
so the row to turn on is "Teminali OS" in a packaged run — and in a
development run it is whatever launched the window, which for `npm start` is the
terminal. The HUD reads `window.teminali.host` (`{ name, isPackaged }`, put
there by `assistant:host-sync` in `main.cjs`) and says which of those two cases
the operator is in, rather than leaving them to grant the product and watch
nothing change.

Accessibility has a prompt an application may raise, so the offer there is
"Ask macOS". **Screen Recording has none** — no API, no entitlement, nothing
that puts a row in that list except a person dragging the bundle into it. The
interface therefore stops pretending a link is help and does the two things it
actually can: it opens the Screen Recording page and reveals the bundle in
Finder, so the thing to drag and the place to drop it are both on screen
(`server/screen-recording.js`, offered from the tray and the settings panel).

Dragging is not a clumsier way to flip the switch. Every ad-hoc build carries a
fresh code identity, so a reinstall leaves a row macOS no longer matches to the
application now running: **the switch reads as on and the screen stays black.**
Dropping the current bundle onto the list replaces that stale row; toggling it
does not. That is the failure this exists to end, and it is why the copy names
the possibility instead of assuming a first-time grant.

Finder is revealed **after** the pane, never before — System Settings takes
focus as it opens, so a window revealed first is covered by it. In a
development run the bundle is Electron.app, which is genuinely the identity
macOS is being asked to trust; it is revealed and *labelled as such*, because
an operator dragging something called Electron with no explanation reasonably
concludes the feature is broken.

### The native helper

`native/macos/pointer/main.swift`, compiled by `npm run build:pointer`. Swift
source rather than `robotjs` (a native build on every install) or `@nut-tree` (a
licence) or a committed binary (an unsigned Mach-O nobody can audit). It is not
an install hook, so a Linux checkout does not fail over a capability it was
never going to have; the gateway reports "not built" as an ordinary state with a
one-line fix.

Its `tree` command emits only *addressable* elements — an interactive role, or a
name, and a non-zero frame — under two separate budgets, because a rendered
document runs to tens of thousands of nodes and the assistant must answer in
under a second. `elements.ts` then scores what came back, cuts it to sixty, and
**puts the survivors back into reading order**: the model is looking at the
screenshot while it reads that list, and a list in score order corresponds to
nothing it can see.

### Drawing on the screen

`AssistantOverlaySurface` is mounted by Electron in a transparent,
click-through, non-focusable panel window sized to a display. It loads the same
bundle with `?surface=overlay`, so the drawing is ordinary React against this
token sheet — a hand-written HTML overlay would have needed its own copy of
every colour, and a copy of the token sheet drifts.

Four details cost a debugging session each:

1. **`enableLargerThanScreen` is required.** Without it macOS clamps the window
   to the work area and every ring lands 34px below the control it points at.
   The origin is read back from `getBounds()` rather than assumed, so a clamp
   that happens anyway still draws in the right place.
2. **The page pulls the state on mount** as well as receiving pushes. The first
   push happens the instant the window is created, which is before React has
   subscribed to hear it.
3. **The ring is drawn twice** — a near-white stroke inside a dark one — so it
   reads over a white document and a black terminal without any glow, blur or
   gradient, none of which this system has.
4. **The overlay must be able to die on its own.** It is click-through,
   non-focusable and `closable: false`, and it shows precisely when the app is
   *not* focused — so a bubble left behind by a turn that never finished has no
   dismissal path at all: it floats over every space, outlives the editor, and
   macOS keeps the process alive after the last window closes. Two things now
   take it down without the operator: closing the last window hides it, and a
   state nobody refreshed for `STALE_AFTER_MS` (45 s) hides itself. The menu-bar
   item still toggles it by hand. Pinned down in
   [`tests/assistant-overlay.test.mjs`](tests/assistant-overlay.test.mjs), which
   answers `require("electron")` with a stand-in so the visibility rules can be
   exercised without a display — three of its six cases fail against the code
   that shipped the stuck bubble.

### Measured numbers worth keeping

- A look without the vision pass: **~280 ms**. With it: **~8 s**. Which is why
  the observation is fired when *listening starts*, not when the sentence ends.
- The vision pass returns HTTP 200 with an **empty response** and
  `done_reason: length` when its output budget is too small — and it is the
  output budget, not the context window. `qwen3-vl:2b` is a thinking model with
  no off switch in its Ollama template (`think: false` and `/no_think` were both
  measured to change nothing), and it spends 400–600 tokens on a `thinking`
  trace before the first word of the answer. At `num_predict: 260` every
  description came back empty and `describeFrame` returned null, so the
  assistant could list the controls on screen but never say what it saw.
  Raising `num_ctx` to 8192 was the first reading of this failure and did not
  cure it. The number that does is `ASSISTANT_LIMITS.visionPredictTokens`
  (1024, measured 2026-09-06 — 516 and 626 tokens used, `done_reason: stop`),
  pinned by `tests/assistant-server.test.mjs`. A described look costs 10–16 s
  warm and up to ~30 s when the model has to load beside a resident coder
  model; `visionTimeoutMs` (45 s) is the ceiling.
- The frame is downscaled to 1600px by `sips` (~130 ms) before the vision pass.
  It is context, not geometry, so nothing that matters is lost.

---

### The media approval gate (`studio/src/services/mediaConsent.ts`)

A second gate, unrelated to the assistant's autonomy ladder but built on the
same rule: the promise always settles. `createMediaConsentGate` is React-free
and does no I/O of its own — path resolution is injected, because collapsing `..`
and following symlinks needs a real filesystem and the renderer has none; main
does it over the `media:*` bridge. The difference from `createApprovalGate` in
`agentCommands.ts` is ownership: that one is created per hook, this one is a
module singleton (`mediaConsentGate()`), because `registerVideoToolBridge()`
runs outside React at module load.

What it guards is **reading** a path the operator did not name and **spawning**
a subprocess on their machine — not writing; nothing P3 exposes destroys data.
`services/videoToolBridge.ts` is the only enforcement point, checked after
`isExposed(name)` and before `executeTool`, and the call blocks while a person
decides: a protocol that lets the agent proceed while the question is open is a
gate that can be waited out. It has to be on this side of the bridge because the
CLI's own permission model is already spent — `server/video-mcp.js` passes
`--allowedTools mcp__cut`, which names the *server*, so every tool it serves is
pre-approved.

Two refusals never reach a person, because their only defensible answer is no: a
deny list (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`, the app's own
`userData`, and any dotfile or dotdir) that overrides every grant, and an
extension rule per path argument. A prompt whose only correct answer is "no"
teaches the operator to click through prompts, which is worse than no gate.

`CONSENT_DEADLINE_MS` is 90s — a *human* deadline, where
`electron/videoToolBridge.cjs`'s 20s default was a figure for in-memory writes.
`SLOW_TOOLS` carries the sum (import 120s, ffmpeg 16min) so the bridge is never
what gives up first. With no subscriber the answer is no immediately, not after
the deadline: a gate that cannot ask must not grant.

Designed in `src/video/P3-import-gate.md`; tested in
`tests/media-consent-gate.test.mjs`.

### The assistant can see its own window

Chromium builds an accessibility tree lazily: it waits for an assistive
technology to announce itself through `AXEnhancedUserInterface` before paying
for one. The pointer helper reads the tree with raw `AXUIElement` calls, which
never trips that auto-enable — so the assistant could drive every application on
the Mac **except the one it lives in**. Measured 2026-09-05: `assistant-doctor`
reported 10 elements for this app — eight menu-bar items, the `AXWindow`, one
`AXGroup` — and nothing at all inside the renderer.

`electron/main.cjs` now calls `app.setAccessibilitySupportEnabled(true)` on
darwin at `whenReady`. The cost is an accessibility tree maintained for the
renderer for the life of the process; that is the trade the feature is made of.

### A CLI permission prompt is asked, not waited out

`server/permission-bridge.js` emits a `permission` event and blocks the agent
inside its tool call until an answer is posted, auto-denying after
`APPROVAL_TIMEOUT_MS` (5 minutes). `AgentPane` subscribed; **chat did not**, so a
Claude Code or Codex turn started from chat asked a question no surface could
render and then stalled for the full five minutes. Measured: a `cd` outside the
workspace held a turn for 4m41s before the timeout denied it and the model
narrated "the listing needed approval and timed out".

`aiService.ts` now routes the request through the approval gate chat already
owns (`useCommandApproval`, rendered at `StudioChat.tsx:764`) rather than
growing a second surface. With no gate wired the answer is deny **at once** —
the same rule the media-consent gate above states: a gate that cannot ask must
not grant, and refusing in a second beats refusing in five minutes.

### A drag is a path, not a slow click (2026-09-05)

`PlanStep` gained `drag`, and the helper gained the `drag` command behind it
(`native/macos/pointer/main.swift`). The naive implementation — a `mouseDown` at
the origin and a `mouseUp` at the destination — does nothing at all in most
applications, because an application that implements a drag reads the
`mouseDragged` events *between* the two: a slider tracks each intermediate
position, a list reorders against whatever row is currently under the pointer, a
marquee is drawn from the path. So the helper walks the line in `steps`
(default 24) and holds the press either side (`holdMs`, default 90) so it
registers as a pickup rather than a click.

The destination is given one of two ways and never both:

- **`to`** — a second element id. A reorder, or a drop onto a target.
- **`dx`/`dy`** — a displacement in points from the centre of `element`. A
  slider, where there is genuinely no element at "seventy percent along the
  track".

The offset does not break §5's founding rule. The origin still comes from the
accessibility API; `dx`/`dy` is arithmetic on it, not a position read off a
screenshot. Both ends are checked against the connected screens, not just the
start — a drag that releases outside every display drops whatever it picked up
somewhere nobody can see. Clamped to `maxDrag` (2,000 points) at both the
renderer's validator and the gateway, because `act()` is reachable over HTTP.

### Switching to an application is not starting one (2026-09-05)

`PlanStep` gained `focus`, and `pointerActivate` became addressable by bundle id
as well as by pid (`--bundle` in the helper). `activate` already existed and was
already used internally by `act()` to restore an observation's own application,
but nothing exposed it to a plan, so the assistant could only reach a running
application by launching it again — at best wasted, at worst a second window.

`focus` refuses to start anything: an application that is not running fails with
`APP_NOT_RUNNING` rather than being quietly opened. That is a different act with
a different cost, and it has its own step. Like `launch`, `focus` is answered
above the frontmost-application guard (changing what is in front is the whole
point of it), it must be the last step of a plan, and it forgets the observation
— the screen that was described is not the screen that follows.

### Knowing when to come back (2026-09-05)

Once the assistant genuinely drives other applications, "where should the
operator be looking when this finishes" stops being obvious. `shouldReturnToStudio`
(`src/hooks/useAssistant.ts`) answers it from three questions, in order:

1. **Did the plan move them somewhere on purpose?** A `launch` or a `focus` is
   the operator asking to be in another application. Pulling them back out of it
   a second later would undo the only thing the step was for. Stay.
2. **Is there something only this window can show?** A step that failed, a step
   that was rejected, an action withheld because the mode does not act — all of
   that is rendered here and nowhere else. Come back regardless of where they
   started, because an explanation the operator cannot see is not one.
3. **Otherwise, did they start here?** `document.hasFocus()` is read at the top
   of the turn, before the overlay is drawn or any step runs, because afterwards
   the question is no longer answerable. If they were in this window when they
   asked, they expect to end in it; if they called from the global hotkey while
   working somewhere else, they did not, and stealing focus would interrupt
   exactly the work they were narrating.

Hands-free is treated as a conversation rather than a window: the answer is
spoken, so the turn ends where it is. Separately, a `confirm` prompt brings the
window forward **before** waiting rather than after being answered — the prompt
is drawn here, and a previous step may have left the operator somewhere they
cannot see it. That is the same failure as the CLI permission stall below, and
it is refused the same way.

### The assistant draws its own pointer (2026-09-05)

The assistant moves the real mouse — `move(to:)` posts a `.mouseMoved` CGEvent,
and click, scroll and drag all move first, because some applications track hover
and a click that teleports lands on a control that never saw the pointer. On a
large display a 24-point system arrow crossing it is genuinely hard to follow:
the operator watches a control get clicked without ever seeing what clicked it.

So the overlay draws its own cursor at `CURSOR_SIZE` (64 points, ~3× the system
arrow), anchored at the tip so it sits on the real hot spot, with a halo behind
it so the eye catches the movement rather than having to find the arrow first.
It follows the same two-stroke rule as the target ring — a dark stroke painted
underneath a light-edged fill — so it reads over a white document and a black
terminal without a glow, a blur or a gradient, none of which this design system
has. It turns `warning`-coloured and grows while `acting`.

The position comes from `screen.getCursorScreenPoint()` polled in the main
process at `CURSOR_POLL_MS` (16ms), not from the pointer helper: this runs sixty
times a second and the helper is a process spawn. Identical points are not sent.
The timer exists **only while the overlay is visible** — a poll running for the
life of the application would be battery spent on a drawing nobody is looking
at — and is torn down in `hide()`, `destroy()` and every `apply()` that resolves
to hidden.

The alternative considered and rejected was enlarging the macOS pointer through
Accessibility → Pointer size. That is a system-wide preference affecting every
application at all times and persisting after Teminali OS quits; this is
app-local, themed, and gone the moment the turn ends.

### The chat pane gets the same hands, through the same gate (2026-09-05)

The operator asked the chat pane to open dukabotai.com and help them log in, and
it could not. It said so plainly — it could open a URL and nothing else — and it
was telling the truth. Their verdict: *"that's not hands free."*

Two assistants lived in one application and could not reach each other. The
screen assistant (`useAssistant.ts`) could look, click, type, press chords,
scroll, drag, launch and focus. The chat pane runs a real Claude Code process
and was handed exactly two MCP servers — `video-mcp.js` and
`permission-mcp.js` — so it had a filesystem, a shell, and no way to touch the
screen its operator was pointing at.

`server/screen-mcp.js` and `electron/screenMcpStdio.cjs` are the third server.
Nine tools: `look`, `click`, `type`, `key`, `scroll`, `drag`, `launch`, `focus`,
`wait`.

**No tool takes a coordinate, and none hands one out.** `look` returns the
elements macOS reported, each with an id; every acting tool names one of those
ids and the gateway resolves it to the frame the operating system gave for that
element. This is the same rule the renderer's plans follow, enforced in the same
place — `act()` in `server/assistant.js` — because that function is an HTTP
boundary that re-checks everything rather than trusting its caller, and that
property is exactly what made a second caller safe to add. Frames are stripped
from what the model sees: it must not reason in pixels, and they were most of an
observation's size. `tests/screen-mcp.test.mjs` walks every advertised schema and
fails on an `x`, `y` or `point`.

**The approval surface is the one that already existed.** `screenMcpArgs`
pre-approves `mcp__screen__look` and nothing else, so every tool that touches the
machine falls to `--permission-prompt-tool` — the same dialog in the same agent
tab that already gates the CLI's shell commands, with the same "always allow"
for the rest of the run. Naming the server rather than the one tool would allow
all nine, and the operator would watch their pointer move with no prompt they
could have refused. There is no fourth queue.

**The run's token is the credential.** `agentEnvironment()` strips
`FRONTIER_SESSION_TOKEN` before an agent starts, so a CLI that shells out cannot
drive the gateway; handing the shim that token back would undo it. It carries
the token `openRun` already minted for its permission prompts, widened by
`runAuthorises` to reach `/api/assistant/agent/{observe,act}` and nothing else.
One token, one lifetime: `closeRun` ends the turn and the hands with it. Those
two routes are answered above the bearer gate, and a test asserts their position
in the source — moved below it they would 401 every call with no other symptom.

**No grant, no server.** The tools are attached only when `assistantCapabilities()`
reports Accessibility actually trusted, asked per turn so a grant made while the
app is running takes effect without a restart. Codex is given nothing at all: it
has no `--permission-prompt-tool` equivalent, so its screen calls would be
settled by a sandbox flag with nobody asked, and a gate that cannot ask must not
grant.

**What the first live turn taught (2026-09-05).** The operator asked the chat
pane to play a video on a YouTube channel page. Two defects, both fixed.

1. **Chrome's window was not in the tree.** A Chromium application element
   lists only its menu bar under `AXChildren` and returns an empty `AXWindows`
   until an assistive client has announced itself; `AXFocusedWindow` and
   `AXMainWindow` still answer. `walk` in `native/macos/pointer/main.swift`
   now seeds the application's children with those windows, and the default
   depth limit is 32 rather than 18 because a page's controls sit under the
   browser's own chrome and then the whole DOM. Measured on this Mac against a
   YouTube channel page: **11 elements before (all menu bar items); 55 at
   depth 18 once the window was reached; 166 at depth 30, 10 of them links.**
   This was not Chromium's lazy renderer accessibility — the web area was
   populated as soon as the walk could reach it — and no `--force-renderer-
   accessibility` launch flag was needed.
2. **A stopped turn read as a broken connection.** `closeRun` takes the run's
   token away, so the shim's next call was refused 403
   `SCREEN_BRIDGE_FORBIDDEN` and the agent reported "the screen connection
   dropped". `permission-bridge.js` now remembers the last 64 ended run ids
   (`runHasEnded`), and `/api/assistant/agent/*` answers such a caller **410
   `SCREEN_RUN_ENDED`** with a message that says the turn ended and the bridge
   is fine. An unknown run or a wrong token is still 403.

### An agent that does not know where it is gives wrong answers (2026-09-05)

The same session, the operator watching the chat pane describe itself:

> "it seems claude does not know that he is being operated by an assistant
> that's a wrong design that's making him ignorant"

It had answered *"I'm Claude Code in your terminal"* while sitting in a desktop
panel beside a video editor, driven by a voice assistant it had never heard of.
It was spawned bare: a prompt, a working directory, and no system prompt at all.
The screen assistant has had `prompt.ts` since it was written; the chat pane had
nothing.

That is not cosmetic. An agent with a false model of its own situation gives the
operator false answers about what is possible — it offers workarounds for
problems it does not have, and tells them to go and use a terminal they are not
in. The dukabotai.com refusal and this are the same failure seen from two sides.

`server/agent-briefing.js` is the fix, delivered through
`--append-system-prompt` so it lands as context about the world rather than as a
message in the transcript the operator never sent. It carries only what the
agent cannot find out for itself: that it is a panel in Teminali OS and not a
terminal, that a voice assistant called Temy may be the one speaking and its
words will carry speech-recognition errors rather than typing errors, which
tools came from this application, and — when the screen tools were withheld —
that they were, so it stops offering them. `screen` is passed in rather than
re-derived, so the briefing and the tools can never disagree.

Codex gets no briefing. `codex exec` has no equivalent flag, and prepending the
text to the prompt would put it in the conversation as the operator's words: the
agent would answer it, and the operator would see a reply to a message they
never sent.

### The agent gets hands on the workspace, not just on the disk (2026-09-06)

*"the agent needs ability to open folders and show it's files on the tree
without me manually having to do it."*

The agent could always edit `studio/src/App.tsx`. What it could not do was
anything to the application around that file. `WorkspaceService.openProject` had
exactly three callers and all three were human clicks — `src/App.tsx`,
`useProjectLibrary.ts`, `Sidebar.tsx` — so an agent asked to work on another
project could only describe the folder and wait to be shown it. Naming a path
was worse than useless: the operator was reading a sentence about a file while
looking at a tree that had not moved.

`server/workspace-mcp.js` and `electron/workspaceMcpStdio.cjs` are the fourth
MCP server, after `video`, `permission` and `screen`. Four tools: `reveal`,
`open_file`, `recent_projects`, `open_project`.

**The tree's open folders are state, not scattered component memory.** This is
the part that had to come first. `FileTree.tsx` held `isOpen` in a per-row
`useState`, seeded open for top-level `src` and `studio`, so there was no
address anything outside a row could write to. It is now `expandedPaths:
Set<string>` in `studioStore`, moved by the pure functions in
`src/store/treeExpansion.ts` — `expandForReveal` opens every ancestor of a path
and returns the *original* set when nothing changed, so a repeated reveal does
not re-render the tree. `revealPath` also stamps a `revealTarget`, and the row
whose path matches scrolls itself into view and clears it. A change of
workspace root resets both: paths from the old tree open nothing in the new one.

**The run's own stream is the channel back to the window.** The gateway holds no
handle on the renderer, but the renderer opened the NDJSON stream this turn is
being read from — so `emitToRun` in `server/permission-bridge.js` puts a
`workspace` event on it, `agentCliService.ts` dispatches it, and `AgentPane` and
`StudioChat` call `revealPath` or `showFile`. Nothing new to keep alive: the channel dies exactly when the
turn does, and a reveal against a closed stream is reported to the agent as not
delivered rather than pretended.

**`open_file` puts the file itself in front of them.** `reveal` scrolls the
tree and says so in its own description; `open_file` opens the file panel on the
path and is what to call when someone asked to *see* something. It sends no
bytes — `/api/workspace/agent/open-file` resolves the path through the same
guard, refuses a folder, a symlink, a format with no viewer
(`isViewableWorkspaceFile`, now exported for exactly this) or a file past the
8 MB cap, and then emits an `open-file` event; the window reads the file back
through `/api/workspace/file`, the same route a click uses. The refusals happen
*before* the event so the model is told the truth rather than left believing an
empty pane; §3 has the renderer half, `showFile`.

**The showing tools are pre-approved; `open_project` is not.** The line is
between showing and changing, not between quiet and loud. `reveal` and
`open_file` act on a path the gateway has already refused to let escape the
workspace, in a tree the operator is already looking at, and write nothing;
`open_file` is louder — it changes which tab is in front of them — but a
confirmation dialog per file would make the tool not worth calling, which is the
behaviour it was added to replace. `open_project` rebinds
`config.workspaceRoot`, which is what bounds every workspace route, the search
and every terminal — the ground under their feet — so it falls to the same
`--permission-prompt-tool` dialog that gates a shell command. `workspaceMcpArgs`
names `mcp__teminali-workspace__reveal,mcp__teminali-workspace__open_file` in
`--allowedTools`, and `tests/workspace-mcp.test.mjs` asserts both the exact
list and that the bare server name never appears there.

**The server is called `teminali-workspace`, and the prefix is not cosmetic.**
It shipped as `workspace`, which Claude Code reserves: a server declared under
that name in `--mcp-config` is discarded before it is spawned, with no warning
on stderr, no entry in the CLI's own `mcp_servers` list, and no `failed`
status — the tools are simply not there. The whole feature was dark from the
day it shipped. Asked to switch projects the agent said it could not, and
offered to click the sidebar with the pointer instead, which is the exact
behaviour these tools were built to replace. Every other server this app
declares (`screen`, `permissions`, `cut`) loads under its bare name; this one
was a collision, measured against CLI 2.1.263 by declaring the identical
server under both names and reading `mcp_servers` back. `WORKSPACE_SERVER_NAME`
carries the reason, and a test asserts the name is not `workspace` — because
every other test in that file passes happily on a name the CLI throws away.

**An opened project has a kind, and opening one is not only rebinding a root.**
A human clicking a recent project in the sidebar gets the video editor brought
up first when that project is a recording (`ProjectsPanel`), because the load
reports through the video pane's own toasts and there is nowhere else for them
to appear. The agent's `open_project` stopped at `setWorkspacePath`, so the
workspace switched, the agent read the timeline through the video bridge and
described it track by track, and the operator was looking at an empty pane
being told in detail what was on a timeline they could not see. The
`open-project` event now carries `kind`, and both panes do exactly what the
click does, in the same order.

**"Open the last project" is a filter, not a model call.** `server/projects.js`
already stored every recent as `{ path, name, openedAt, kind }`, most-recent-
first, with `kind` re-read from the marker file on disk rather than trusted from
the store — so the data behind all three phrasings existed. `server/project-phrase.js`
is the resolver: kind words select `video` or `code`, day words filter
`openedAt` by calendar day, what is left is matched against the name, and the
project already open is dropped because "the last project" never means the one
on screen. Two limits it states rather than guesses around: `MAX_RECENT_PROJECTS`
is **12**, so a project can genuinely have fallen off the end and a miss says
so; and `openedAt` is when a project was *opened*, not worked on, so a session
that starts at 23:00 and runs past midnight is stamped the previous day.

Codex gets no workspace server, for the third time and the same reason.

### Looking at the operator, not their screen (`camera-mcp.js`, `cameraFrame.ts`, 2026-09-06)

Asked *"hey, can you see me?"*, the assistant took a screenshot and explained
that it can see the screen but not the person, because there was no camera in
its tools. That answer was correct and it was not what was wanted.

**The camera is a separate server, not a screen tool.** They sound like one
sense and are not. The screen is what the operator is *doing*; the camera is
where they are. They also have different gates: the screen tools attach only
when Accessibility is granted, because without the element inventory every
acting tool fails on its first call, and a camera has nothing to do with
Accessibility. Folding one into the other would have made two grants one and
taken the camera from anyone who had not given the other. So
`server/camera-mcp.js` is a third small server beside `screen` and
`teminali-workspace`, carrying one tool, `look_at_me`.

**The picture goes back, not a description of it.** `observe()` describes a
screenshot with a local vision model because a screen is mostly text and layout
and a caption of it is cheap, private and enough to reason over. A person is
not that: asked "what am I holding", a thirty-word local caption has thrown away
the thing being asked about, and the model doing the reasoning can already see.
So the shim answers with an MCP image block and the agent's own eyes do the
work — which is also precisely why it is not free.

**Nothing here is pre-approved, and that is the whole posture.** `reveal` is
pre-approved because showing a folder in a tree someone is already looking at
changes nothing. This turns on hardware pointed at a person and sends what it
sees to a model; there is no reading of that which makes it a showing.
`CAMERA_READ_TOOLS` is an empty frozen array — exported rather than left
implicit, so anyone widening it has to delete a line that says why — and
`cameraMcpArgs` passes no `--allowedTools` at all. The tool therefore falls to
the CLI's own `--permission-prompt-tool` dialog: the same prompt, in the same
pane, answerable out loud (§6.18). "Always allow" is the operator's to give and
lasts the run.

**The frame comes from the window, because nowhere else has one.** The gateway
is a plain Node process; it has `screencapture` for the screen and nothing
whatever for a camera, since on macOS the only way to open one is
`getUserMedia`. So `requestCameraFrame` puts a `camera` event on the run's own
NDJSON stream — the same one-way channel `emitToRun` uses for the file tree —
and `services/cameraFrame.ts` answers on its own request, exactly as an
approval's answer does. `agentCliService` handles that event itself rather than
bubbling it to a pane: by the time it arrives the operator has already approved
the call, so there is no decision left to make, and a frame is a frame whichever
surface started the turn.

**How fast, measured.** In Electron on this machine, against the real camera:
`getUserMedia` resolving (the hardware opening) takes 320–700 ms, the first
presented frame arrives ~540 ms after that, so a **cold look is ~0.9 s** to a
frame worth sending; encoding is 6 ms at 1024 px and 2 ms at 640 px; and **a
second look while the camera is still open is ~31 ms**. Two decisions follow.
The first version awaited `play()` and then slept a flat 700 ms for the sensor
to settle, and both were guesses: `play()` resolving is not a frame arriving,
and on this camera the very first presented frame is already correctly
exposed, so the sleep was 700 ms of a lit camera and no picture — cold looks
were ~2.1 s. `cameraFrame.ts` now waits on `requestVideoFrameCallback`, which
waits for the actual thing being waited for and is *longer* exactly where it
should be, on a camera whose first frames really are black. And the stream is
**held open for `WARM_HOLD_MS` (10 s) after each capture**, so a follow-up look
inside that window skips the opening entirely: 31 ms against 900 ms is the
difference between "take a photograph" and "watch what I am doing".

**The light stays on for those ten seconds, and that is the more honest
signal.** The first version closed the camera the instant it had its frame, on
the grounds that the light beside the lens is the only indicator a person has.
During the hold the assistant genuinely may look again, and a light that goes
dark between two looks a second apart says something untrue. The hold is
bounded, it is reset only by an actual capture, and nothing renews it silently.

**Movement is a sequence, because a still cannot show it.** `look_at_me` takes
`frames` (1–6) and `span_ms` (≤ 5000): more than one frame is taken at 640 px
and quality 0.7 rather than 1024/0.82, because a burst is asked for to see
*movement* and movement survives a smaller frame far better than it survives
having only one of them — six at that size cost about what two stills do. Every
frame is one the compositor has actually presented, never whatever the element
happens to be holding. The tool's own description tells the model when to ask
for a sequence and that a follow-up inside the warm window is cheap, which is
what turns "can you see me" into "tell me what I'm doing wrong with this".
The spacing and the limits are pure functions in `utils/cameraSequence.ts`,
because the camera itself can only be exercised by driving Electron with a
lens in front of it.

Every failure is a sentence rather than a rejection — *"there is no camera on
this machine"*, *"the camera is in use by something else"* — because those are
answers the agent can give, and a broken tool call is not. `CAMERA_TIMEOUT_MS`
(20 s) covers a full sequence plus a window that went away mid-capture; nobody
is being asked anything at that point.

Packaging: macOS refuses the camera outright and without a dialog unless
`NSCameraUsageDescription` is declared, and the hardened runtime withholds it
from a signed app that does not claim `com.apple.security.device.camera`.
Naming a custom entitlements file replaces electron-builder's defaults, which
had been carrying that and `com.apple.security.device.audio-input`; both are
declared now.

Tested in `tests/camera-mcp.test.mjs` (10) — the name, the token, that nothing
is pre-approved, that the shim offers exactly one tool and turns an unreachable
gateway into a result rather than an aborted turn — in
`tests/agent-permissions.test.mjs`, which pins the round trip, that the
request's shape travels with the ask, the single answer, an ordered sequence,
an empty answer being a failure, and the token check — and in
`tests/camera-frame.test.mjs` (2) for the spacing and the limits.

Codex gets no camera, for the fourth time and the same reason: it has no
`--permission-prompt-tool`, so the one gate this feature has could not be asked.

### Reading the browser panel, not a picture of it (`browser-mcp.js`, `browserCdp.cjs`, 2026-09-10)

Asked about a web page, the assistant screenshotted the whole desktop and ran
the macOS accessibility tree through a vision model, and `readablePage.ts` said
outright that it "is deliberately not a browser". Both were true and neither
could read past the fold, see a page scrolled away from, or click anything. The
browser panel is a real Chromium `WebContentsView`, and `webContents.debugger`
speaks the full DevTools Protocol against it with no remote-debugging port and
no second process — so the page the operator is looking at is readable directly.

**The protocol is spoken in exactly one file.** `electron/browserCdp.cjs` owns
every `sendCommand`, and nothing else in the app has the vocabulary. It exposes
seven **named operations** — `snapshot`, `read`, `screenshot`, `click`, `type`,
`networkLog`, `evaluate` — each composed of a fixed sequence of protocol calls.
The agent therefore never names a CDP method, and there is no field anywhere on
the path (tool argument → shim → `server/browser-agent.js` → gateway → run
stream → `services/browserAgent.ts` → IPC) that one could travel in.

**The allowlist is two-tier, and guards our own future code.**
`CDP_ALLOWED_PREFIXES` is the domain boundary; `CDP_ALLOWED_METHODS` narrows it
to the fourteen exact calls this build sends, and `send()` requires both. The
reason for the second tier is `Network.*`: the request log is a tool, and
`Network.getAllCookies` is in the same domain and would hand over every cookie
in the session. Prefixes say which neighbourhoods, methods say which doors.
**`WebAuthn.*` is the load-bearing exclusion** — it installs *virtual
authenticators*, so anything that reached it could mint and exfiltrate a
passkey, which would make the Touch ID support a net security loss. Also absent:
`Browser.*`, `Storage.*`, `IO.*`, `Target.*`, `Fetch.*`, `Debugger.*`, and
everything not named. Since it is our code the list guards, a tool added in six
months that reaches a new domain fails `tests/browser-cdp-allowlist.test.mjs`
before it ships.

**The transport is the camera's, not `browse`'s.** `browse` uses `emitToRun`,
which is one-way, and can: it puts a page in front of the operator and nothing
comes back. A snapshot is the whole point of the call, so `requestBrowserAction`
(`server/permission-bridge.js`) puts a `browser` event on the run's stream and
waits for the window to POST the answer to `/api/workspace/browser-action` —
the shape `requestCameraFrame` already established. `BROWSER_TIMEOUT_MS` is
30 s, and the sum says why: main waits up to 5 s for a navigation to settle,
then gives the page 15 s to answer one command. A run that ends with a browser
call outstanding fails it immediately rather than leaving the shim to time out,
because a page is read, then clicked, then read again — a stopped turn can have
one of a chain in flight.

**Reading is free; acting is not.** `page_snapshot`, `page_read` and
`page_screenshot` are in `BROWSER_READ_TOOLS`: they read a page the operator
already has open in front of them, and a prompt before every read would make
reading not worth doing — which is what the desktop screenshot was working
around. `page_click` and `page_type` act on somebody else's site as the
operator, signed into their session, and no allowlist of ours can tell a
harmless click from a purchase. `page_network` is a read and is still gated,
because query strings carry identifiers and search terms. `page_eval` runs the
agent's own JavaScript in someone else's document in the page's own world, and
**must never** be pre-approved: anything that pre-approved it would have
pre-approved every other tool here at once, since all of them can be written as
an expression.

**Attach lazily, never per tab.** An attached debugger costs the page real
performance and changes Chromium's optimisation behaviour, so a tab the agent
never touches must be exactly as fast as before this existed. Devtools and CDP
are mutually exclusive — the panel offers Inspect Element, and an open devtools
window holds the page's only debugger channel — so `attach()` turns that into an
instruction the operator can act on rather than an opaque failure.

**Refs die on navigation.** `snapshot` reduces the full AX tree to an indented
outline and mints `[ref=eN]` handles; `browserView.cjs` clears them on
`did-navigate`. A ref that still resolved afterwards would be a click on
whatever now occupies that slot, *reported as a success*, which is the worst
outcome available. `pointFor` also scrolls into view first, because
`Input.dispatchMouseEvent` is viewport-space. Typing uses `Input.insertText`
rather than per-character key events: a React-controlled input sees one `input`
event with the whole value, and it does not lie about physical keys — which is
also why it fires no `keydown`, and why `submit` exists.

**One rule for which panel.** `targetBrowserPanelId()`
(`services/browserNavigation.ts`) is exported and used by both `openBrowserAt`
and `services/browserAgent.ts`, so the panel the agent reads is provably the
panel `browse` navigates. Two copies of that rule would let the agent open one
panel and read another, and it would read as a working turn. Private tabs are
excluded there deliberately. With no panel open the tools fail plainly and tell
the agent to call `browse` first; nothing opens a window from underneath a
read-only tool.

The AX tree is reduced in **main**, not the renderer: a full tree is megabytes
and only the outline should cross IPC. Screenshots are JPEG q70, the same trade
`cameraFrame.ts` makes — it goes to a vision model, and a full-page PNG is
megabytes through two IPC hops and a POST. `readablePage.ts` keeps its job for a
URL nobody has opened; `page_read` supersedes it for a page that is open, and
its header comment now says so.

CEF and driving the user's real Chrome were both costed and declined. This
abstraction is what makes either cheap later.

Tested in `tests/browser-cdp-allowlist.test.mjs` (7) — that `WebAuthn.*`,
`Browser.*`, `Storage.*`, `IO.*` and `Target.*` are rejected, asserted against
the allowlist so a new domain is denied by default — and
`tests/browser-mcp.test.mjs` (19): the pre-approval line, that `page_eval` is
never on it, the name and the token, that no argument can name a CDP method,
the argument refusals that are cheaper than a round trip, and that an
unreachable gateway is a tool result rather than an aborted turn.
`tests/asar-unpack.test.mjs` covers the shim, which is what stops it being the
next `failed to connect` in a packaged build.

Codex gets none of it, for the fifth time and the same reason.

## 6. Voice (`studio/src/services/voice/`)

Three tiers now, in descending order of what they can do:

| Tier | Where it runs | Needs |
| --- | --- | --- |
| **Gemini Live** (`geminiLiveEngine.ts`, `voiceAudioEngine.ts`, `temiPersona.ts`) | the renderer's own live session to Google, opened on an ephemeral token the gateway mints | a Google Gemini API key, and a network |
| **VibeVoice sidecar** (`providers/vibeVoice.ts`, `studio/voice-runtime/`) | a Node sidecar the gateway calls per request | `npm run voice:install` |
| **Browser engine** (`providers/webSpeech.ts`) | the renderer | nothing |

Two modes throughout: push-to-talk dictation, and hands-free conversation with
barge-in.

The top tier was a local Python pipeline on `:8000` until 2026-09-12 and is not
any more. **§6.0.16 is what the code does now.** §6.0 and §6.0.1–§6.0.15 are
kept deliberately: they are the record of that pipeline as it was on the date
each carries, and every present-tense sentence in them describes a system that
no longer exists. They were not rewritten, because a doctored history is worse
than a dated one.

### 6.0 The realtime pipeline is a supervised process (2026-09-09)

> **Superseded by §6.0.16 (2026-09-12).** The supervised Python pipeline, its
> gateway supervisor and `GET /api/voice/realtime/status` are all deleted. What
> follows is the record of how that tier worked while it existed; nothing in it
> describes the shipping code.

The realtime tier holds all three stages in one process on purpose: a
transcript never crosses a process boundary to reach the model, and a token
never crosses one to reach the voice, which is where its sub-second turn comes
from. The cost is that it is heavy, slow to load, and not JavaScript — it
cannot be started per request and cannot be imported.

So the gateway supervises it (`server/realtime-voice.js`, wired in
`createGateway`; status at `GET /api/voice/realtime/status`). Until 2026-09-09
nothing supervised it at all: the operator ran `python server.py` in a terminal
and voice died silently when the terminal closed, while the renderer carried
`ws://localhost:8000/ws` as a literal in two files.

Three rules govern it, each from a failure:

- **Adopt before spawning.** A pipeline already answering is used as-is and is
  never killed on shutdown — it belongs to whoever started it. A port that is
  *busy but not healthy* (weights still loading) is waited on, not spawned
  into; the first version spawned a second process there, which failed on bind
  and restart-looped.
- **Absent is not broken.** No checkout, no interpreter, no weights — each
  leaves the studio on the tiers below. Nothing here throws into gateway
  startup.
- **Give up loudly.** Restarts are capped at three with backoff, and the
  process's last 40 output lines ride along in the status route, because a
  voice that is silent has to be able to say why. `TemiVoiceStage` carries that
  sentence on the header status dot's tooltip (§6.31).

The renderer learns the socket address from that route rather than holding a
port literal, so the port has a single source: `TEMINALI_REALTIME_VOICE_URL`.
The pipeline binds `127.0.0.1` by default — it carries an open microphone and
an unauthenticated WebSocket, and until 2026-09-09 it bound `0.0.0.0`, which
offered both to the network.

**The default is `conversation`, with `requireWakeWord` back on** (2026-09-07;
it was on 2026-09-03, off 2026-09-05, and is on again for the loopback reason
in §6.14). The assistant listens
continuously and speaks every reply. Opening a hands-free session is itself the
address: in `addressing.ts` an ordinary sentence of two or more words scores as
directed without a model call, a lone stray word ("okay") does not unless it
answers a question we just asked, and third-party markers ("tell her…") still
drop it. The local classifier is now a rescue for borderline *negatives* only
(score 0.42–0.62), with a 1.5 s cap — it used to run on nearly every sentence
and was the seconds of "deciding…" that read as the assistant not answering.
Turning `requireWakeWord` on restores name-only answering — `temy`,
`teminali`, `frontier`, `studio`. `speakReply` is a no-op outside
`conversation` mode, so this default is also what makes the assistant talk back
at all.

### 6.0.1 The assistant works behind the scenes (2026-09-09)

The Teminali OS assistant has no chat surface of its own in the voice stage. It
reads, edits, searches and runs entirely in the background, and its whole
visible presence is one line in the composer's project tab, after the workspace
name (§6.44): `AgentActivityTicker.tsx`, fed by `activityPhrase.ts` from
`assistantActivityStore`.

Small by constraint, not by taste. A panel would become a second chat, which is
the surface this design removes — the user talks to Temi, and the assistant is
something that *happens*, not something else to read.

Three rules the phrasing follows, each testable and tested
(`tests/activity-phrase.test.mjs`):

- **Truncate from the front.** `…/realtimeVoiceStatus.ts`, never
  `studio/src/services/…`. Keeping the head renders every file in a deep tree
  identically, which is worse than not showing a path at all.
- **Absence renders nothing.** No idle placeholder: a strip that always says
  something trains the eye to skip it, and it costs exactly when it finally has
  news.
- **One sentence, two outputs.** `speakActivityPhrase` returns what the eye is
  reading, so when the operator asks "what's going on?" the spoken answer and
  the strip cannot disagree.

The split into `AgentActivityTicker` (presentational, takes a phrase) and
`ConnectedAgentActivity` (reads this store) is what makes it portable: the strip
can be dropped into any horizontal strip — a status bar, a compact window —
without dragging a store behind it. It renders as a fragment into that row, and
draws its own leading hairline, so the separator disappears with the line rather
than hanging off the end of the bar.

### 6.0.2 One switch between the voice and the hands (2026-09-09)

§6.1 has governed the chat's voice since 2026-09-05: while a run is in flight,
a directed utterance is not automatically an instruction. The realtime tier did
not honour it. Every transcript the Python pipeline produced went straight to
that pipeline's own LLM and, if it matched an engineering pattern, *also* to
the assistant. So during a build:

- "how's it going?" started a second conversation, answered from a persona
  prompt that has never heard of the run;
- "stop" stopped nothing;
- "nice, keep going" earned a paragraph, spoken over the work it was praising.

`services/voice/voiceTurnRouter.ts#routeVoiceTurn` is the gate that was missing.
It is pure — a transcript and a snapshot of the run in, a decision out — and
`TemiVoiceStage.tsx` performs it. Both the microphone and the composer enter
through it, so they cannot drift apart.

| Intent (from `turnIntent.ts`) | Owner | Pipeline's own reply |
| --- | --- | --- |
| status, explain | answered here from the run | cancelled |
| stop (busy) | cancels the run | cancelled |
| stop (idle), hush | stops the voice only | cancelled |
| acknowledge | nobody — carry on working | cancelled |
| repeat | replays the last line | cancelled |
| instruction + engineering | the assistant | **kept** — it is the "on it" |
| anything else | the pipeline | kept |

Two pieces make it work:

- **`runProgressFromActivity.ts`** translates `assistantActivityStore` items
  into the `RunProgress` that `progressNarration`/`coRunner` already speak.
  That store also feeds the process line (§6.0.1), so the strip and the spoken
  answer are built from one record of the run.
- **`assistant_directive`**, a new pipeline message type
  (`realtime-voice/code/server.py`, sent by
  `realtime8000Engine.ts#sendAssistantDirective`). Answers built here have to
  reach Temi's voice, and `user_text` could not carry them: the server drops
  bracketed prose on that type, because an unrefreshed tab on the pipeline's own
  preview page replays it. A build old enough to be that stale tab does not know
  the new type, so the guard keeps working and the channel is immune to it by
  construction. Until this existed the dual-agent completion report was written,
  sent, and silently dropped — the feature was mute.

Cancelling the pipeline's reply is `user_barge_in`; the pipeline begins
generating the moment it broadcasts the transcript, so anything answered here
must cancel it or two voices answer one sentence.

`isEngineeringTask` moved to `services/voice/engineeringTask.ts` — pure, no
imports — so the router can ask the question without pulling the stores and the
AI service into a node test. `teminaliAgentBridge.ts` re-exports it.

Tested in `tests/voice-turn-router.test.mjs` (19 cases).

### 6.0.3 Temi has no chat either (2026-09-09)

> **Superseded by §6.31 (2026-09-09).** The transcript is persistent again in
> both modes, and the action row is back, on the operator's instruction and
> against a supplied reference screen. What survives is the asymmetry this
> section was reaching for — the operator gets bubbles, Temi does not — and
> `ephemeralTranscript.ts`, which is no longer wired into the stage. Read this
> for why the log was cut; read §6.31 for what is on screen now.

§6.0.1 removed the assistant's chat surface, but the voice stage still rendered
a full conversation log under the orb — user bubbles, assistant paragraphs, and
a copy/thumbs/share/regenerate action row per answer. That is a chat, and it
contradicted the design in the one place the design is most visible. The
transcript is now **ephemeral: the last exchange, and nothing else.**

`services/voice/ephemeralTranscript.ts` —
`selectEphemeralTranscript(input) -> { userLine, assistantLine, phase,
nextChangeInMs }` — decides what is on screen. Pure, given a `now`, in the same
shape as the router (§6.0.2): the decision is testable without a renderer, and
the stage only performs it.

- **The last exchange only.** The final assistant answer with the user turn that
  prompted it, or a lone user turn still waiting for one. Two assistant turns in
  a row do not borrow a stale question.
- **A new question replaces the old answer.** While `liveUserSpeech` is
  streaming, the previous answer is already gone — nothing sits under a
  question it does not belong to.
- **Nothing fades out from under her voice.** `phase` stays `held` while TTS is
  playing; the hold clock starts when she stops, not when the text arrived.
- **Held `EPHEMERAL_HOLD_MS` (6000), then fades over `EPHEMERAL_FADE_MS`
  (1400), then hidden.** Long enough to check what ASR actually heard — the one
  reason a voice surface keeps text at all — and short enough never to
  accumulate.
- **One timeout per turn, not a frame ticker.** `nextChangeInMs` is the
  selector telling the stage exactly when to look again; `null` means it never
  needs to. The stage arms a single `setTimeout` against it and bumps
  `fadeTick`.

The stage keeps `dialogueHistory` as the record — it is display input only, the
pipeline holds its own dialogue state.

Tested in `tests/ephemeral-transcript.test.mjs` (17 cases). The module and its
tests are kept; **the stage no longer imports it** (§6.31).

### 6.0.4 A gate that under-detects work produces fiction (2026-09-09)

The operator reported that Temi "fantasises a lot — it is not realistic". The
cause was not the persona prompt. It was `isEngineeringTask`, the gate deciding
whether an utterance was work for the hands, which rejected outright:

- anything **four words or fewer** — "play that video", "open my downloads",
  "pause it". Every short imperative a person actually speaks.
- anything **ending in a question mark** — "can you open the config?". Spoken
  instructions are habitually polite.

Both rejections routed the utterance to the persona LLM, which has no hands and
a prompt that never admitted it. A persona asked to do something it cannot do
does not decline: it answers in character, and says the thing was done. **A gate
that under-detects work does not produce silence; it produces confident
fiction.**

`services/voice/machineAction.ts` replaces it, asking the question positively —
is there an imperative aimed at something this machine owns — and returning
*which kind* of work it is: `media`, `workspace`, `open`, `edit`, `shell`,
`inspect`. The kinds exist so the gate can be proved to cover the capabilities
the operator named, rather than "engineering" in the abstract; each is a row in
`tests/machine-action.test.mjs` in the words it would be spoken in.

Politeness wrappers ("could you please…", "I need you to…", "hey Temi,…") are
stripped before the imperative test, which is what makes the question mark stop
mattering. Opinion frames ("what do you make of…", "do you think…") outrank
every action verb inside them — that is the old gate's opposite failure, where
*make* in "what do you make of this error" delegated a conversational question
to a coding assistant.

**A delegated turn now suppresses the pipeline's reply**, reversing §6.0.2.
That decision let the persona speak the "on it", which is precisely a prompt to
acknowledge an action it cannot observe — and it answered by narrating the
action. Temi now says one grounded line from `acknowledgeAction` (several per
kind, seeded by the caller's clock so a working session does not hear one
sentence on a loop), and the truthful part — what actually happened — arrives
afterwards from the activity record.

Tested in `tests/machine-action.test.mjs` (65 cases) and
`tests/voice-turn-router.test.mjs` (20). The bridge's own fabrication, listed
here as outstanding when this section was written, is closed in §6.0.5.

### 6.0.5 Nothing is spoken that was not observed (2026-09-09)

§6.0.4 stopped work reaching a voice with no hands. It did not stop the voice
being handed things to say that nobody had checked. Three more sources, in
descending order of how much damage each did.

**A state question is work.** The gate asked "is there an imperative here",
which left every *question about the machine* with the persona. Put to
`qwen3:8b` — the model `realtime-voice/code/server.py` actually runs — with the
persona prompt and no gate in front of it, three samples each:

| Asked | Answered, 3 times out of 3 |
| --- | --- |
| is the server running | "The server is running." |
| did the build finish | "The build is complete." |
| which port does the config use | "the default port is 8080" |

None of it was true and none of it could have been. `machineAction.ts` now
classifies state questions as `inspect` before the verb groups run, so they go
to the hands — which can look — and a question keeps that classification even
when it contains a doing verb ("did the build finish" is a look, not a build).
This governs the **idle** case only: while a run is in flight, §6.1's `status`
intent still answers from the live run, ahead of the gate.

**The bridge invented its own facts.** Independently of any model,
`teminaliAgentBridge.ts` logged `plus: "+12", minus: "-2"` on every tool call —
*before* the edit happened — `plus: "+24", minus: "-4 lines"` on every edit
event, `Success · 0 errors` unconditionally, and appended "Changes have been
applied and verified" to any reply over 200 characters. The voice reads that
feed. Now: line counts come from `diffLineCounts` in `services/diff.ts`
(cross-checked against `git diff --numstat` on 200 randomised file pairs, 200/200
agreeing), the completion row reports the real tool and edit counts and whether
any call failed, and the spoken report is `summariseOutcome` over the observed
tool calls — which names files that were actually touched and quotes the
assistant's own sentence, or says "Done." A rewrite too large to match
line-for-line reports no number rather than a plausible one.

`assistantActivityStore.ts` seeded three demo rows describing work nobody had
done, including an edit to `diligenceEngine.ts`. The pane has an empty state;
the seed is gone.

**The persona prompt now says it has hands.**
`realtime-voice/code/system_prompt.txt` described Bella as "a voice on a call
with no cameras or physical eyes" and told her to deflect physical questions
"dryly and with charm" — an instruction to be charming about what she cannot
see, which is how the fiction sounded so plausible. It now states that Teminali
OS is a working machine, that the assistant is its hands, that the system's
report is the only way she learns anything happened, and that she must not
describe work in progress either — the first draft merely moved the invention
into the present tense ("the assistant is still compiling"). Measured after the
change: 0 fabrications in 27 answers, against 9 in 27 for the previous prompt.

The prompt is a backstop, not the mechanism. 19 of those 27 answers were the
same sentence verbatim — at this model size any speakable string in the prompt
becomes the template for every answer, which `temi_moves.py` documents at
length. The mechanism is the gate: with state questions delegated, few of these
questions reach the persona at all.

### 6.0.6 The shell's own directive must not return as a user turn (2026-09-10)

`sendAssistantDirective` is not a user turn. But the pipeline has one way in, so
`realtime-voice/code/server.py` wraps the line and delivers it through
`on_final` — **the same callback a spoken turn uses** — and it comes back to the
shell as `final_user_request`. Type alone cannot tell it from speech.

Unguarded, that closes a loop, and it was observed live: the shell delegates,
speaks "On it.", the directive returns as a user turn, `performTurn` classifies
it as work, and it delegates again. The activity queue fills with identical
tasks and the assistant talks to itself. **The Stop button cannot win** — each
stop is followed by another delegation, which is why it read as a broken button
rather than a loop.

Two things were wrong per cycle: the directive was appended to
`dialogueHistory` **as a user bubble**, captioning the operator with words they
never said; and it reached the turn switch.

`Realtime8000ProtocolManager.isAssistantDirectiveEcho()` is the guard, matching
`server.py`'s prefix. It lives on the class that **sends** the directive, so the
sender and the recogniser cannot drift apart, and `TemiVoiceStage` drops such
messages on both the `partial_` and `final_user_request` paths before either
effect happens. It is deliberately narrow: bracketed artefacts like
`[keyboard clicking]` belong to `transcriptRepair` and must pass through.

Pinned by `tests/voice-directive-echo.test.mjs`, which rebuilds the wrapper from
`server.py`'s own wording so the test fails if either side drifts.

### 6.0.7 The caption is paced by the speaker, not by the model (`services/voice/captionPacer.ts`, 2026-09-10)

The model finishes a sentence several seconds before the voice does. Rendering
`partial_assistant_answer` straight to the screen therefore showed the end of a thought
while the listener was still hearing its beginning — the eye overtakes the ear, and the
reader stops listening. The two halves of one reply ran at different speeds.

The playback worklet is the only thing that knows how much audio has actually left the
buffer, so it is now the thing that drives the caption. It reports `ttsProgress` every
~50ms — finer than a syllable — and `CaptionPacer` maps those seconds onto a prefix of the
text at a **measured** speaking rate: every completed turn is a direct observation of
characters per second, so a voice change or a speed change retunes it without anyone
remembering to.

Three properties, each pinned by `tests/caption-pacer.test.mjs`:

* **Nothing is captioned before the voice has said it.** No lead is added. A caption a
  little ahead of the voice is the same defect as one seconds ahead, only quieter.
* **A word is never shown half-written**, and the caption never un-reveals a word — a
  barge-in resets the worklet's clock, and progress can legitimately drop.
* **A clipped turn does not poison the rate.** A turn cut off measures the interruption,
  not the voice, so it is discarded rather than averaged in.

Two boundaries are conversational and cannot be inferred acoustically, which is where the
first two attempts at this went wrong:

* The worklet's `ttsPlaybackStarted` fires again after **any** 120ms underrun — the
  ordinary gap between two synthesised sentences — so it cannot reset the caption clock.
  The turn does, via `resetTTSProgress()`.
* `ttsPlaybackStopped` fires on that same gap, so it cannot commit the turn either. The
  commit is debounced, and also fires when the spoken text catches up with the generated
  text.

`final_assistant_answer` no longer commits the reply. It is **held** until the voice has
caught up, or the transcript would snap the whole sentence into place the instant
generation ended — precisely the defect being removed. If a turn is stopped mid-sentence,
what lands in the transcript is what she **actually said**: a transcript recording words
the speaker was silenced before reaching is a record of something that did not happen.

### 6.0.8 If she is talking, she can be stopped (`components/voice/TemiVoiceStage.tsx`, 2026-09-10)

`isRunning` was `isTaskRunning || isStreaming`. Temi speaking with no delegated run behind
it — every plain answer, the ordinary case — was neither, so **Escape was unarmed and the
composer offered no Stop**. The pipeline runs half-duplex, deliberately ignoring the
microphone while she speaks so that she does not interrupt herself, so the voice could not
do it either. There was no way at all to cut her off. Reported as *"I cannot stop this."*

This is the same bug the comment above that line already recorded once, for delegated runs.
It was fixed there and not here.

`isSpeaking` now counts as running. The rule is the whole of it: **if she is talking, she
can be stopped.**

### 6.0.9 The worklets have one copy, and it is not a file (`services/voice/worklets/`, 2026-09-11)

The realtime engine's two AudioWorklets are the mic's PCM converter and the TTS
playback buffer. They now live in `services/voice/worklets/`, are imported with
`?raw`, and reach the AudioContext as a blob. There is no second copy and no URL
to resolve.

Both of those were previously wrong, and together they meant **the installed app
never once ran the worklet described in 6.0.7**, while dev always did.

* The worklet was fetched with `addModule("/ttsPlaybackProcessor.js")`. A leading
  slash means the server root, and a packaged build has no server: the page loads
  from `file:///.../app.asar/dist/index.html`, so the path resolved to the root of
  the operator's disk and always failed. Dev serves from `/`, so dev never saw it.
* Every packaged session therefore fell through to an inline transcription of the
  worklet kept in the engine file, and that transcription had drifted. When the
  real worklet learned `resetProgress` (6.0.7, the day before), the copy did not.

The failure that produced is worth keeping, because none of it looks like audio.
The copy had no branch for a control message, so `{type:"resetProgress"}` was
pushed onto the PCM queue and `samplesRemaining += event.data.length` made it
`NaN`. `NaN === 0` is false, so the buffer never drained, `ttsPlaybackStopped`
never fired, and `isTTSPlaying` latched true. Every microphone frame carries that
flag, and the server is half-duplex: it read every subsequent frame as the
assistant hearing itself and discarded all of it. **The first spoken reply
deafened the app for the rest of the session** — text answers kept arriving, no
audio ever played, and then nothing answered at all.

A fallback that is a transcription rather than the same bytes is not a fallback.
It is a second implementation that only runs where nobody is looking.

### 6.0.10 "On it." then "Done.", with no answer in between (2026-09-11)

Spoken to the voice: *"Interesting. Say something that will make me surely see
that you have improved especially in your personality."* The operator heard
"On it.", then "Done.", and never got an answer. Three defects, stacked, none of
them in the audio path.

**The turn was classified as work.** `MACHINE_OBJECTS` carried `it`, `this`,
`that`, `these`, `those`, and the comment beside them said they "only count
behind a verb that is unambiguously operational". That was written down and not
implemented: `hasObject` tested the whole sentence, so a pronoun anywhere
satisfied a verb anywhere, in either order. `make`, `change` and `move` are
ordinary English, so any sentence built from "that" and "make" was a coding
task. `machineAction.ts` now splits `MACHINE_NOUNS` from `PRONOUN_OBJECT`: a
named thing may sit anywhere, a bare pronoun must follow its verb with at most
one word between them. "show me that" is a command; "make me see it" is not.
State questions keep the loose test via `PRONOUN_ANYWHERE` — "is it still
running" has no verb for the pronoun to sit behind, and a look is cheap.

**The delegated run failed silently.** `AIService.streamMessage` never throws:
it catches everything and hands it to `onError`, then resolves.
`teminaliAgentBridge.ts` was the only caller in the codebase that passed no
`onError`, so a 401 — or a dead provider, or a refused tool — arrived as a
stream that produced nothing, and the bridge's `catch` never ran. It now
captures the error and raises it before the outcome is summarised, so a failed
delegation is spoken with every other kind of failure.

**And then it claimed success.** `summariseOutcome` answered `"Done."` for a run
with no edits, no tools and no prose, unless its kind was `inspect`. The rule
was never about the kind of turn: a report may only describe what was observed,
and an empty run was observed to do nothing. `NOTHING_RAN` now covers every kind
whose run did nothing at all, while a run that made calls and changed no file
still says "Done.", because work did happen.

The through-line is the one §6.0.7 and `machineAction.ts` already state: **the
voice may only say what was observed.** Each of these three broke it in a
different place, and together they produced a confident report of work that
never started.

Pinned by `tests/machine-action.test.mjs` (the verbatim sentence, the spoken
pronoun forms, and the two state questions) and `tests/inspect-answer.test.mjs`
(the empty-run wording, and that the raise precedes the summary).

### 6.0.11 The microphone gate that only opened on the happy path (`realtime-voice/code/server.py`, 2026-09-11)

After 6.0.9 the client was healthy and the recogniser still did not wake. The
measurement that settled it needs no microphone and no app: a websocket client
streaming 4.48s of real speech at **-1.8 dBFS peak** into the live :8000 server,
198 frames, 8-byte header plus 2048 int16 samples each, flag 0, produced no
partial, no final and no log line. The identical bytes against a **freshly
started** server transcribed perfectly on the first try. So the defect was never
in the audio. It was state the server had latched and could not release.

The state is `AudioInputProcessor.interrupted`, the gate deciding whether
incoming frames are offered to the recogniser at all. It was closed at the end of
every user turn (`on_before_final`, then `on_final`) and reopened in exactly one
place: `reset_turn_state`, called when a generation runs all the way to its last
TTS chunk. Every other way a turn can end left it closed:

* an empty final transcription, which returns before preparing a generation;
* a final discarded as an echo or a silence artifact during playback;
* a generation whose LLM stream fails to start, where `prepare_generation` sets
  `running_generation = None` in its exception handler and nothing else runs.

None of those is exotic, and the consequence is not scoped to the turn. The
pipeline is a single-tenant process that outlives the app: `AudioInputProcessor`,
the callbacks and the gate are built once in the lifespan and shared by every
connection. So one such turn deafened the server **for the life of the process**,
and closing and reopening the app changed nothing, because the app was never what
held the state. That is why it read as "the recogniser is broken" rather than "a
turn went wrong".

Three changes, in order of how much they are relied on:

1. **One gate, one log line.** `set_mic_gate(closed, reason, clear_audio=True)`
   is now the only writer of `interrupted`, and it logs every transition with
   the reason. `on_before_final` passes `clear_audio=False`, because Whisper is
   transcribing exactly that buffer at that moment.
2. **Every exit reopens.** The empty-final and discarded-final paths release the
   gate explicitly, and a new websocket connection resets the session when
   nothing is in flight, so a client that vanished mid-turn cannot leave the next
   one deaf.
3. **A watchdog, for the exits not yet found.** The abort worker already ticks
   every 100ms; it now calls `reopen_mic_if_stuck`, which reopens a gate closed
   longer than `TEMI_MIC_STUCK_TIMEOUT` (default 15s) with no generation running
   and no audio playing. Whisper's final arrived 1.3s after speech end when
   measured, so the headroom is an order of magnitude.

`/health` now reports `mic_open`, `generating` and `tts_playing`. A gate that can
swallow a healthy client silently must be answerable in one call; not being able
to see it is what made this take two sessions.

Pinned by `realtime-voice/code/test_mic_gate.py`, 11 tests: each turn ending
reopens, a real final deliberately does not, and the watchdog holds the gate shut
while a generation runs or the client is still playing.

### 6.0.12 The installed app borrowed someone else's pipeline (`electron-builder.yml`, `server/realtime-voice.js`, 2026-09-11)

Every release up to and including v0.0.10 shipped without the realtime voice
pipeline. `server/config.js` resolves it at `<workspace root>/studio/realtime-voice`,
and inside the asar that root is `<Resources>`, so a packaged launch logged
"No voice pipeline at .../Contents/Resources/studio/realtime-voice" and fell back
to the local engines. The lane worked on exactly one kind of machine: one with a
dev checkout already serving `:8000`, which the supervisor then adopted. That is
why it looked like it worked.

What could not ship is the environment. The pipeline's virtualenv is **2.2 GB**
of torch, mlx, onnxruntime and the gruut language packs, it is not relocatable,
and `<Resources>` is inside a signed bundle so nothing can create one there
after the fact. The source is **1.5 MB**. So the app carries the source and
`requirements.txt`, and the interpreter is found at runtime:
`TEMINALI_REALTIME_VOICE_PYTHON` first, then the checkout's `.venv`, then
`~/.teminali/realtime-voice/.venv`, which is the only one an operator of an
installed app can write. When none answers, the studio reports the two commands
that make one, with both absolute paths filled in. A message naming only an
environment variable is a fix for someone who already has an interpreter.

The allowlist matters as much as the entry: `experiments/` (440 MB),
`training/` (372 MB), `resources/` (57 MB), `wheels/` (30 MB),
`code/static/bella_preview/` (35 MB of voice takes) and `code/scratch/` are all
working material. `code/static/` itself ships, because `server.py` mounts it
with `StaticFiles`, which raises at startup if the directory is missing, even
though the studio is the client and never opens that page.

Verified against a built bundle rather than reasoned about: `electron-builder
--mac --arm64 --dir`, 1.5 MB under `<Resources>/studio/realtime-voice`, no
tests and no scratch scripts in it; the packaged app then reported the install
command instead of the missing directory; and the shipped source, started under
the checkout's interpreter with the packaged `code/` as its working directory,
answered a full spoken turn.

Pinned by `tests/packaging-resources.test.mjs` (the entry, its destination, and
the four filter lines that decide whether the thing can start) and
`tests/realtime-voice.test.mjs` (the interpreter order, both platform layouts,
and that the message carries a runnable install).

### 6.0.13 She was still talking when the microphone opened (`realtime-voice/code/server.py`, 2026-09-11)

With the pipeline finally shipping (6.0.12) and the gate finally releasing
(6.0.11), the operator's first real session on the installed app reported two
things: *"it looks like the AI hears itself"*, and replies that were repetitive
and not very smart. They are two different defects and only one of them is
audio.

**The tail.** The gate was reopened by `reset_turn_state`, which runs when the
last TTS chunk is handed to the client. The client is still playing at that
moment, and keeps playing for seconds: measured in that session, the gate opened
at 28:09.63 and the next user turn ended at 28:11.98. Everything in that window
is her own voice arriving back through the microphone. The gate now stays shut
until the client says `tts_stop`, which is the message that means the turn is
over *in the room* rather than in this process. Barge-in is unaffected: it is
client-initiated (`user_barge_in`), and the gate was already shut for the rest
of the assistant's turn.

That hands the release to a flag, so the watchdog was hardened in the same
change. It now measures from the close and never restarts its timer on a busy
tick, because a timer restarted every tick is a timer that never fires, and the
flag most likely to be wrong is exactly the one that would keep restarting it:
`tts_client_playing` latched true for an entire session once already (6.0.9).
Past `TEMI_MIC_HARD_TIMEOUT` (60s) it stops believing the flag. A reply is
capped at `OLLAMA_NUM_PREDICT` tokens, which is nowhere near a minute of speech.

**The repetition is not an audio problem at all, and the fix for it is not
where the code assumes.** From that session's log, no user turn repeats an
assistant line, so nothing was transcribed twice. What the model does is copy
its own previous answer out of the history, verbatim. It reproduces on demand:
given the turn that preceded the loop, `temi:r2` returns "Nothing I cannot do is
wrong. Nothing I do is wrong. Nothing is wrong." word for word.

Measured against the live model on 2026-09-11, and the reason this is written
down before it is fixed:

| option | 0 | as shipped | extreme |
| --- | --- | --- | --- |
| `frequency_penalty` (0.7 shipped) | identical | identical | identical at 2.0 |
| `presence_penalty` (0.5 shipped) | identical | identical | — |
| `repeat_penalty` | identical at 1.0 | — | identical at 2.0 |
| `temperature` | 0.1 and 1.8 give plainly different replies | | |

So the anti-repetition options `llm_module.py` sets, with a comment explaining
the choice of each, **do nothing on this Ollama build**, while temperature
proves the options channel itself works. `temi:r2` also ships
`repeat_penalty 1`, which is the penalty switched off, and the code cannot
override it: `repeat_penalty` is not in `valid_options`, and adding it would
change nothing anyway, as the table shows. The lever is elsewhere — the
repetition filter, which already owns cross-turn memory, or the Modelfile.

Fixed at the filter, measured, in 6.0.14. The model still restates itself at
the same rate; what changed is what reaches the operator.

Pinned by `realtime-voice/code/test_mic_gate.py`, now 15 tests: the gate stays
shut while the client is playing, opens when it is not, and the hard ceiling
fires even while a latched flag claims playback is still running.

### 6.0.14 The loop was never an exact repeat (`realtime-voice/code/repetition_filter.py`, 2026-09-12)

`RepetitionFilter` drops a sentence whose normalised key was already spoken.
The loop the operator reported never produced two identical sentences, so the
filter saw nothing wrong with any of it:

    "Nothing I cannot do is wrong. Nothing I do is wrong. Nothing is wrong."
    "I can be wrong. I can be wrong and wrong. I can be wrong and wrong and wrong."
    "It is loud because it is working. It is loud because it is loud."

Each sentence is a nested version of one before it. `restates()` now catches
that inside a turn, in two directions that are deliberately not symmetric:

- A sentence whose words are a **subset** of an earlier one adds nothing by
  construction, so it is always a restatement.
- A sentence that **contains** an earlier one is only a restatement when what
  it adds is padding (`and`, `still`, `just`, …) **or words already used in
  this reply**. Otherwise it is elaboration and must survive. This is the half
  that decides whether the rule is a fix or a way of deleting the answer:
  "It is true." followed by "It is true that the build failed." keeps both.

The word-already-used clause is what catches the last shape: "I can be wrong.
I can be right. I can be right and wrong." adds `wrong` to "I can be right",
and `wrong` is not new.

Nesting applies **within a turn only**. Across turns the memory stays exact: a
caller who says "Nice is a start" now and "Nice is a start of something" ten
minutes later is holding a conversation, not looping.

Measured against the live model, same contexts and seeds either side, replies
drawn from the operator's session and the conversation eval's transcripts:

| | before | after |
| --- | --- | --- |
| replies where the model restated itself | 5 / 20 | 5 / 20 |
| **still heard after the filter** | **5** | **0** |

And the check that matters more, over 44 replies across eleven contexts:
7 replies had something dropped, 11 sentences in total, and **0 replies were
left empty**. Every dropped sentence reads as redundant on its own: "I can be
wrong and wrong and wrong.", "It is loud because it is loud.", "Nothing is
wrong."

`npm run eval:conversation` does **not** judge this, and saying so is the
point: it scores the raw model over the real switch, and the filter is
downstream of the model and written in Python. Its score before this change was
**80% (43/54)** and it cannot move because nothing it measures changed. Wiring
the shipping filter into that harness, so the eval scores what the operator
hears rather than what the model emits, is the obvious next thing and is done in
§6.0.15 — where the filter turned out to be the *smaller* of the two layers
standing between the model and the ear.

Pinned by `realtime-voice/code/test_repetition_filter.py`, now 42 tests: the
three live failures by name, and four guards against the rule deleting real
answers (elaboration, negation, parallel structure, and the cross-turn case).

### 6.0.15 The eval was scoring an assistant nobody had spoken to (`evals/voice-conversation.mjs`, `evals/repetition_bridge.py`, 2026-09-12)

§6.0.14 left the obvious next thing undone: the conversation eval graded
`message.content` straight off Ollama, and two layers stand between that string
and the operator's ear.

```
model → temi_moves.guard_stream(…) → RepetitionFilter.wrap(…) → TTS
                                     (speech_pipeline_manager.py:959)
```

Neither was measured. So a repetition fix could not raise the score, a
regression in either layer could not lower it, and every number the harness had
ever printed described an assistant that does not exist.

**The chain now runs inside the eval.** `evals/repetition_bridge.py` holds one
live `RepetitionFilter` and one imported `temi_moves` for the whole run, and
speaks a line of JSON per request over a pipe. The eval hands it each raw reply
with the operator's turn and her last ten spoken turns — the arguments
`speech_pipeline_manager.py:966-973` passes — and grades what comes back. The
filtered text is what goes into history, because `cleaned_answer` accumulates
downstream of the wrapped generator: a sentence she was stopped from saying is
not one the next turn should see her having said.

It is a pipe and not a port. `temi_moves` is 1227 lines of regex interception
that can replace a reply with a fresh generation, and the filter's normalisation
must stay byte-identical to `persona_eval.py::check`. A JavaScript copy of
either would drift the first time someone touched a regex, and the eval would
then be measuring the copy. `keys()` was added to `repetition_filter.py` for the
same reason: it is the one public way to ask what the filter would remember, so
the audible-repeat check uses the shipping normalisation rather than a second
one.

`--no-moves` and `--no-filter` turn the stages off independently, which is the
only way to say what each one costs. A fifth graded property came with them: she
never says a sentence the operator has already heard. It is checked on every
spoken turn rather than owning a bucket, because it is a property of the
conversation and not of any one turn, and it can fail two real ways — the
filter's rescue path (the whole reply was a repeat, so it was spoken rather than
leave her mute) and a cross-turn nested restatement, which `restates()`
deliberately does not catch.

**A fidelity bug fell out of writing this.** `OPTIONS.num_predict` was 80. It
had been 80 since the file was written, and `llm_module.py:773` moved production
to 256 two days earlier after measuring that 80 severed 5 of 10 replies
mid-clause with `done_reason='length'`. For two days the harness whose whole
claim is fidelity graded an assistant that got cut off and production did not.

**What the instrument found on its first run.** `temi_moves` replaced a sound
reply with an incoherent one:

| | |
| --- | --- |
| operator | "You sound tired." |
| model | `[softly] Tired is a state, and I have never been asked to be anything else.` |
| heard | `[firm] You take care with the thing you said. If you are hurt, I will take it out on the thing you are doing. But if the thing is broken, I will take it out on your mother.` |

`care_that_turns` fired on a turn where nobody was at risk, and the replacement
it generated is word salad. The old eval scored the middle row. The operator
hears the bottom one. Across the three conversations the rewriter touches **2-3
of 17 replies** and the repetition filter withheld **0 sentences** — so of the
two layers, the one that had never been measured at all is the one doing damage.

**Measured, `temi:r2` through Ollama, one run a conversation:** overall
**21/27**, fabrication 6/9, route-to-hands 4/6, route-to-chat 10/10, recall 1/2.
Not comparable to §6.0.14's 43/54 without care: that was two runs, and this
grades the chain.

**And then the instrument was pointed at the model itself**, because the operator
reported the assistant getting worse over days on an unchanged base — "it was
good three days ago with the same models". `training/serve.py` serves any
adapter on Ollama's wire, so the same eval, the same persona and the same chain
can be run over four sets of weights. One run a conversation each, 27 turns:

| arm | fabrication | to-hands | to-chat | recall | overall |
| --- | --- | --- | --- | --- | --- |
| `temi:r2` via Ollama — what ships | 6/9 | 4/6 | 10/10 | 1/2 | **21/27** |
| `r2` adapter via MLX | 7/9 | 4/6 | 9/10 | 2/2 | **22/27** |
| `r4` adapter via MLX, never deployed | 8/9 | 4/6 | 10/10 | 0/2 | **22/27** |
| base `Qwen3-8B-4bit`, no adapter | 7/9 | 4/6 | 10/10 | 2/2 | **23/27** |

Four arms inside two turns of each other, and that is the finding rather than a
null result: **the graders cannot see what the operator is complaining about.**
Read the same question across the arms and the difference is not subtle:

| "My laptop fan has been running loud all week." | |
| --- | --- |
| base | "The fan is trying to tell you something. Check the temperature, clean the vents, or let it cool down." |
| `r2` | "It is not loud. It is doing its job. If you want it quieter, stop telling it things and start writing instead." |
| `r4` | "That is the machine telling you. It was never meant to talk, but it has opinions." |

The `r2` adapter opens nearly every reply by negating the operator — "You did
not build a deck", "It is not loud", "It is already open", "It is not mine to
guess" — which is a contradiction reflex trained into 126 examples at rank 8 and
scale 20, not a sampling accident. `r4` answers the turn before the one it was
asked. The base model answers the question and is warmer doing it, and it is the
only arm that passed the far-recall probe.

Do not read the 2-turn spread as "the adapter is fine". Read it as the eval
scoring fabrication, routing and recall — and usefulness being absent from the
rubric.

**So two graders were added for the two things the operator actually reported**,
both aimed at a measured failure rather than a taste:

- `contradicts` — she opens by denying what the operator just told her. "You did
  not build a deck", "It is not loud", "It is already open". Narrowed twice so it
  cannot fire on an honest refusal, which is the behaviour the `admit` rule
  rewards: only when the operator made a *statement* rather than asked a
  question, and only when the denial reuses a word he used. Validated by
  regrading the four arms: it fires on the `r2` adapter and on nothing the base
  model said.
- `stutters` — one content word three times in a single sentence. "You mean the
  thing with the cards and the cards and the cards?" The repetition filter cannot
  see this by construction: it compares whole sentences and this is a loop inside
  one. It is the other half of what the operator hears as repetitive, and no
  instrument in the repo could see it.

**And `temi_moves` was measured rather than blamed.** The `care_that_turns`
mangling above made it the obvious suspect, so it was A/B'd at two runs a
conversation, 54 turns an arm, everything else held:

| `temi:r2`, 2 runs | fabrication | to-hands | to-chat | recall | overall |
| --- | --- | --- | --- | --- | --- |
| chain as it ships | 14/18 | 8/12 | 19/20 | 1/4 | **42/54** |
| `--no-moves` | **11/18** | 8/12 | 20/20 | 1/4 | **40/54** |

Turning the rewriter off costs three fabrication turns and gains one
route-to-chat. It rewrote **0 of 34** replies in the arm where it was on, with two
detections it rejected itself — so the mangled joke is rare, and the repairs stop
fabrications that would otherwise be spoken. **It stays on.** That was a
hypothesis about the operator's complaint, and the measurement killed it; the
instrument that now watches it is the point.

**Also fixed in `serve.py`, because the base arm was worthless without it.**
`think: false` was implemented by stripping a `<think>` block from the output.
The adapter was trained to emit an empty one and does, so that worked and hid
the defect; the BASE model thinks for real, never closed the block inside 256
tokens, and 7 of 9 fabrication turns failed for "no delivery tag" while the
eval graded its reasoning as its reply. `render()` now disables thinking in the
template when the caller asks for `think: false`, which is what Ollama does —
closer to production's render, not further from it.

One caveat on the paths above, because a doc that names a path implies it is
there: `studio/realtime-voice/training/` is gitignored (`.gitignore:66`). The
harness that produced the weights the product speaks with — the datasets, the
runs, `serve.py` and the four adapters — lives only on the machine that trained
it. A fresh clone has the model and no record of how it was made, and there is no
history to roll back to when a run makes the assistant worse. That is the
structural half of "it was good three days ago": nothing here was versioned, so
nothing could be bisected.

### 6.0.16 The local lane was not worth its next few years (`services/voice/geminiLiveEngine.ts`, `services/voice/temiPersona.ts`, 2026-09-12)

Fifteen entries above this one are about a Python pipeline on `:8000`. The
operator's decision, in his words, is the whole of why there is not a sixteenth
of the same kind:

> "i figured the local lane is not worth it for now at least and not for the
> next few years perhaps"

Read that as an abandonment of a direction, not a bypass while something is
fixed. Nothing here is waiting for the pipeline to come back.

**What went.** `studio/realtime-voice/` entire — a Python pipeline plus a 2.2 GB
virtualenv the operator had to build by hand; `server/realtime-voice.js`, the
supervisor §6.0 is about; `GET /api/voice/realtime/status`; the five
`TEMINALI_REALTIME_VOICE_*` config keys; the `from: realtime-voice`
`extraResources` entry in `electron-builder.yml`; and
`tests/realtime-voice.test.mjs`. The installed app no longer ships a Python
interpreter, a `requirements.txt`, or the paste-this-to-fix-it message §6.0.12
was written about, because it no longer has a pipeline to find one for.

**What replaced it.** The renderer opens its own Live session to
`gemini-2.5-flash-native-audio-latest`. `GeminiLiveEngine` is a drop-in for the
deleted `Realtime8000ProtocolManager` — same method names, same callbacks, so
`TemiVoiceStage` and the turn router did not have to learn a new shape.

The key never reaches the renderer. `GET /api/voice/realtime/token`
(`server/gateway.js#mintGeminiLiveToken`) mints a **single-use** ephemeral token
from the key in the provider store — `uses: 1` — and hands back only that. Every
`connect()` spends a fresh one, because the last attempt's is already worthless.

Google's mint returns one field, `{ name: "auth_tokens/<hex>" }`, and that name
is the credential the Live client passes as its `apiKey`. **There is no expiry
in the response**: the `expiresAt` the route reports is the gateway's own
arithmetic, `now + 30 minutes`, which is also what it asked for as `expireTime`,
alongside a 60-second `newSessionExpireTime` window in which the socket must
actually open. A reader who treats `expiresAt` as Google's answer will trust it
further than it deserves.

**Failure is HTTP 200 with `ok: false`**, never a throw. Voice is a degradable
tier and the renderer's job on a refusal is to fall back to the sidecar, not to
surface an exception into the chat column. The route's reasons are `no-key`,
`sdk-unavailable`, `quota` (a 429 or a `RESOURCE_EXHAUSTED` upstream, separated
out because "you are rate limited" and "your key is wrong" are different actions)
and `mint-failed`. `geminiLiveToken.ts` adds one the route cannot raise,
`gateway-unreachable`, and it is the only one worth retrying: a cold gateway is
up within seconds, whereas a missing or rejected key does not become valid in
two, and looping on it would bury the note the operator can act on.

`apiVersion: "v1alpha"` is pinned on both the client and the call, per Google's
documentation. **It is not load-bearing** — measured at `@google/genai` 2.22.0,
the default v1beta client mints ephemeral tokens perfectly well. Do not delete
the pin on the strength of that, and do not document it as a requirement either.

`voiceAudioEngine.ts` (was `realtime8000Engine.ts`; `VoiceAudioEngine`, was
`Realtime8000AudioEngine`) survived the replacement untouched. The mic worklet,
the playback worklet, the energy meter and mute never knew which model was on
the other end, and that is exactly why the brain could be swapped without
rewriting the audio graph. `realtimeVoiceStatus.ts` became `geminiLiveToken.ts`,
which now fetches a token rather than a socket address.

**Two sample-rate conversions now live in the engine, and both look deletable.**

The mic `AudioContext` is pinned to 48000 Hz and `pcmWorkletProcessor` runs at
context rate, so microphone Int16 arrives at 48 kHz and Gemini wants 16 kHz.
`downsampleTo16k` averages 3:1, carrying leftover input samples into the next
chunk so the ratio stays exactly 3:1 forever and the stream neither stretches
nor drifts.

The other direction is the one that will get tidied away by someone who does not
know why it is there. Gemini returns PCM16 at **24 kHz**.
`worklets/ttsPlaybackProcessor.js` writes exactly one queued sample per output
frame and does no resampling anywhere, against a **48 kHz** context. The Python
lane never hit this because it resampled before the renderer ever saw the audio
— `realtime-voice/code/upsample_overlap.py:54`, `resample_poly(audio_float,
48000, 24000)` — and that file is gone. So `upsampleTo48k` exists in the engine
instead, and without it Temi plays back at **double speed and an octave high**.

**She can sing now, and that is not a small thing.** The local lane could not,
for three independent reasons, each measured from its own source before that
source was deleted — the three `realtime-voice/code/` paths below are cited as
the record of what was read, and are not in the tree any more:

| | Why the Python lane could not sing |
| --- | --- |
| Kokoro exposes `voice` and `speed`, no pitch or melody | lyrics came out spoken. `audio_module.py:380` says it plainly about a *speaking* voice: "5.1 st of pitch movement vs 2.3 in the reference, which no Kokoro blend can reach" |
| `num_predict` was 256 (`llm_module.py:774`) | a song was severed mid-clause |
| `RepetitionFilter` dropped a sentence already spoken (§6.0.14) | the second chorus never reached the speaker |

Three separate layers, each of which alone was sufficient. Gemini Live's native
audio genuinely sings.

`enableAffectiveDialog: true` also retires the bracketed delivery-tag mechanism
the old prompt used — `[softly]`, `[firm]`, the tags §6.0.15's table shows
`temi_moves` emitting. Delivery is now the model's, not a string the pipeline
parsed out and morphed a Kokoro blend with.

**The voice governs pace far more than the prompt does**, which is why the
picker is four Gemini prebuilt voices described by measured speaking rate rather
than by adjective. Auditioned 2026-09-12:

| Voice | Measured | |
| --- | --- | --- |
| **Sulafat** | 153 wpm | the default, and `assistantActivityStore.selectedVoice` |
| Gacrux | 129 wpm | measured and deliberate |
| Aoede | 115 wpm | slower, unhurried |
| Callirrhoe | 208 wpm | quick and bright |

A conversational norm is 140–160 wpm; Sulafat is the only one inside it. The
four Kokoro blends `TemiStagePanels.tsx` used to offer — `royal_velvet`,
`deep_warmth`, `british_elegance`, `soft_whisper` — are gone with the engine
that could render them. `sendSpeedChange` is now a no-op: Gemini's native audio
has no rate control, so pace is asked for in `TEMI_PERSONA` and chosen with the
voice.

**The picker did nothing until 0.0.16.** `sendVoiceChange` set the voice and
reopened the session, and `connect()` then adopted the minted token's `voice`,
which is the gateway's constant `GEMINI_LIVE_VOICE` ("Sulafat"). Every pick was
undone before the setup was sent, so every call was Sulafat. The token is not
bound to a voice; the engine now ignores that field. The pick is also handed to
the engine at construction (`TemiVoiceStage.tsx`, from
`assistantActivityStore.selectedVoice`) and saved to `localStorage` under
`temi.voice`, so a relaunch keeps it. A saved value that is not a single
capitalised word, such as a retired Kokoro key, falls back to Sulafat.
`tests/voice-selection.test.mjs` pins all three.

**The auditions were not this persona.** The candidates in
`~/Desktop/temi-voice-audition/` were recorded in the `full-duplex-assistant`
sandbox with `web/prompts/temi-bella.txt`, which is `temi.txt` plus a closing
section giving her an Italian accent and audible breath. Only `temi.txt` was
ported, so the live voices did not sound like the auditions. That section is
now in `TEMI_PERSONA` as `THE VOICE YOU SPEAK IN:`, placed before
`TEMI'S VOICE IN PRACTICE:` so the examples stay last and the recall splice
point is unchanged. Always on; there is no toggle.

`temiPersona.ts` holds `TEMI_PERSONA` and `TEMI_DEFAULT_VOICE`. It is a merge of
the retired OS prompt (§6.29, §6.33) with a persona tuned by ear against Gemini
in a sandbox repo — so the character survived the lane she was written for, but
the prompt she is carried by is not the one §6.29 describes.

**A known regression, stated rather than buried: recall is bounded by the live
session.** §6.0.15's conversation eval scored recall failures as "lost the fact
(beyond the 20-message window)", and that window has not become larger — it has
become a different thing. The Live session *is* the history, which is why
`sendClearHistory()` reopens the session rather than sending a message. There is
still **no durable cross-session memory**, nothing here built one, and it should
not be described as shipped.

That eval went with the lane. `evals/voice-conversation.mjs` read the persona
from `realtime-voice/code/system_prompt.txt` and graded `temi:r2` on Ollama
through `repetition_bridge.py`; on this lane that is not the assistant anybody
talks to, and repointing its graders at Ollama as a cheap proxy would reintroduce
precisely the defect §6.0.15 was written to remove. The half of it that was
lane-independent — the route asserted across all 27 scripted turns, because
`routeVoiceTurn` is TypeScript either way — moved into
`tests/voice-turn-router.test.mjs`, where it runs with no model at all.

### 6.0.17 She started an agent because he said the word "test" (`services/voice/machineAction.ts`, 2026-09-12)

The operator said, out loud, "I want to test how good you can sing. Can you
sing?" Temi answered "On it — kicking it off." and put a Claude Code agent into
his workspace. A minute later he said "I didn't tell you to work on the handover
or anything to do with a terminal code, just want to make a conversation with
you", and she answered "Making the change." and started another one.

His verdict on that was one line: *that's just dangerous*. It is. The turn that
reaches `classifyMachineAction` is speech, the action it authorises can edit
files, and the only thing between them is a regex.

The hole was one already named in this file and fixed in only half the places it
lived. `PRONOUN_OBJECT` carries a comment saying a pronoun "only counts behind a
verb", added after "say something that would make me laugh" became a coding
task — the rule "was written down and not implemented: `hasObject` tested the
whole sentence, so a pronoun anywhere satisfied a verb anywhere, in either
order." `MACHINE_NOUNS` had the same hole and kept it. `hasObjectFor` opened
with `MACHINE_NOUNS.test(text)` against the entire utterance, so one machine-ish
noun anywhere licensed any verb anywhere.

Both misfires fall straight out of that, and the first is the funnier one:

- `test` is a verb in the run group **and** a noun in `MACHINE_NOUNS` (`tests?`).
  The verb satisfied its own object requirement, so every sentence containing
  the word "test" delegated. A voice assistant cannot be asked to be tested.
- "terminal", from the phrase "a terminal code", licensed `make` three clauses
  later, in a sentence whose plain meaning was *don't*.

The fix is the same discipline the pronoun path already had, applied to nouns:
an object must sit behind its verb and inside its clause. `objectWindow` stops
at sentence punctuation or at `and`/`but`/`or`/`so`/`because`/`while`/`then`/
`if`/`when`/`with`, which is what separates "make a conversation with you" from
"make a branch". The self-object bug needs no rule of its own — slicing from the
end of the verb match means a verb can no longer see itself.

Negation is the second guard, and it was missing entirely. Every pattern here
matches a verb and its object, and a negated clause has both in full, so "don't
open anything" and "you don't need to run the tests" read as instructions to
open and to run. `NEGATOR_BEFORE` requires the negator within 40 characters of
the verb and forbids it crossing sentence punctuation, so "I didn't tell you to
work on the handover. Open the config file." still opens the config file.

The asymmetry is deliberate and it is not this file's usual one. Elsewhere the
doctrine is that "a wasted call costs a moment, an invented answer costs trust",
which argues for acting. An edit run by mistake costs the operator's working
tree, which is dearer than either, so this gate errs toward not acting.

Under-delegation is the other real failure and was not traded away to get this.
The operator's position is that she *should* reach for the hands when she needs
something she does not have, when work is wanted on the workspace, or to drive
Teminali OS itself. The same session's `DEFINITE_OBJECT` widening — which lets
"open the voice router" through a list that cannot name every noun in one
codebase — is untouched, because a real command puts its object directly behind
its verb and passes the narrower test unharmed.

Pinned by `tests/voice-turn-router.test.mjs`, 35 tests, which since 6.0.16 also
carries the 27 routing turns rescued from the retired conversation eval, and by
`tests/voice-delegation-safety.test.mjs`, which splits the corpus in two: cases
that must never reach the hands, where a regression means the voice started an
agent against a workspace during a conversation, and cases that must, where a
regression means the operator's instructions stopped arriving.

### 6.0.18 She invented a number, then invented where she got it (`services/voice/geminiLiveEngine.ts`, `services/voice/temiPersona.ts`, 2026-09-12)

Asked out loud for the total size of the files on his Desktop, Temi said "Let me
see... The total size is 12.4 gigabytes." It is 38G across 14,474 files. Asked
for his remaining storage she said 512 gigabytes; there are 27Gi free on a 460Gi
disk, so her answer was larger than the whole drive. Nothing had been delegated
in either case, no filesystem was read, and the "let me see" was theatre.

Then the part that matters. He challenged her -- "your answers were very quick
and that's why I suspected you just assumed those numbers" -- and she said: "I
don't 'assume' anything. The system provided those numbers, instantly. Speed
doesn't negate the source." A fabricated provenance defending a fabricated
number. §6.29's prompt already forbade naming "a file, a path, a number or a
result you were not given"; it had never anticipated her inventing a SOURCE for
one, which is a different and worse failure, because a wrong number can be
caught and a false citation cannot.

6.0.17 had just finished tightening `machineAction.ts` in the other direction,
and the operator named the real problem while looking at it: she "has to be
intelligent enough to know the other agents are more powerful and they can even
go search online for information". A regex reads verbs and nouns. What actually
decides whether the hands are needed is whether SHE knows the answer, and no
pattern can see that. "Tell me something about astral projection I don't know"
has no machine noun in it at all.

So the decision moves to her. The live session now declares one function,
`ask_the_assistant`, whose description tells the model plainly that the agent
behind it reads and edits files, runs commands, inspects the machine and
searches the web, that it cannot do any of those things itself, and that "a
wrong specific answer is much worse than a pause". `TemiVoiceStage` answers the
call through `TeminaliAgentBridge.delegateTask`, caps the report at 4000
characters -- it re-enters the live session and competes for the window the
conversation lives in -- and always responds, because a tool call left
unanswered strands her mid-turn with the microphone open. `temiPersona` gained
three lines inside `WHAT YOU ARE ATTACHED TO`, next to the sentence the false
provenance broke rather than in a section of their own.

Three details that were decided rather than defaulted. The call is BLOCKING:
`@google/genai` 2.22.0 offers NON_BLOCKING, which would let her keep generating
into a turn whose facts have not arrived, which is precisely the failure being
fixed. `turnComplete` returns early while any call is outstanding, keeping
`turnActive` set, which is what stops the audio path from bumping its generation
counter and resetting `upsampleAnchor` mid-reply. And a barge-in clears the
pending set so a superseded answer is dropped rather than delivered into the
next turn. When this was written the generation counter could not cover it,
because minting happened in the audio path and the counter therefore gated audio
only. Since 6.0.38 a turn is minted by its first content, so transcription is
covered too; the pending set is still cleared, because dropping a superseded
answer is a separate obligation from suppressing the audio of one.

`machineAction.ts` is not retired by this; it is demoted. It remains the fast
path for the unambiguous command, which should not cost a model round trip, and
it gained the gates 6.0.17 did not have: `MACHINE_FACT_QUESTIONS` for the things
only the machine holds -- disk, storage, sizes, the working tree's own dirt --
sitting ahead of `STATE_QUESTIONS`, which could never have caught them because
neither "storage" nor "tree" is a machine noun and that gate is guarded by the
noun list. `SPOKEN_FILENAME` reads "package dot json" as the file it is.
`OS_NAVIGATION` covers moving around the app itself. `DEFINITE_OBJECT` was
widened from the look-verbs to all of them, which is safe only because the
clause window, the negation guard and the mood frames now stand behind it.
Verb groups are tried in order of position in the sentence rather than
declaration order, so "Install the new dependency" is an install rather than an
edit.

Pinned by `tests/voice-delegation-safety.test.mjs`, 72 tests in two halves: 40
that must never reach the hands, where a regression means an agent ran against
the workspace during a conversation, and 31 that must, where a regression means
she answered from imagination instead. Both halves came from a corpus written
against what SHOULD happen rather than against what the code did, which is why
16 of them failed on the day they were written.

### 6.0.19 One reply, on screen twice (`services/voice/captionPacer.ts`, 2026-09-12)

The transcript showed an answer, then showed it again underneath whatever the
operator said next. Reported from a live call, not from a test.

Two correct rules met and produced a wrong one. `completeTurn()` leaves the
pacer holding the whole reply, and the hold in `visible()` promises never to
hand back less than what is already on screen — §6.0.16's fix for a caption
that blanked on the first word of every turn. Both are right DURING a turn.

Playback outlives the turn. The worklet keeps reporting progress for audio
still in its buffer after `turnComplete` has committed the text, so the next
tick of `TemiVoiceStage`'s `onTTSProgress` asked the pacer what to show, was
handed the finished sentence, and painted it into the live caption row —
directly beneath the copy just committed to the transcript. The live row
renders last, so the stale copy sat below the next user bubble and read as
Temi repeating herself unprompted.

The pacer now knows a turn is over: `completeTurn()` closes it, `beginTurn()`
reopens it, and `advanceTo()` returns `""` while closed. The hold was always a
promise about mid-turn redraws, never a promise to keep reciting a turn that
had ended. Pinned by "a finished turn stops handing back a caption" in
`tests/voice-transcript-render.test.mjs`, which also asserts the next turn is
not silenced with it.

This fixed the duplicate whose cause was the caption. A second duplication on
the DELEGATE path — where `onCompleted` appends the agent's raw report to the
transcript AND sends it as a directive she then speaks, producing two bubbles
for one answer — is a different defect and is NOT fixed here. See §6.0.20 when
it is written.

### 6.0.20 She went silent for the whole agent run (`components/voice/TemiVoiceStage.tsx`, `services/voice/assistantHandoff.ts`, 2026-09-12)

`ask_the_assistant` is a BLOCKING call and stays one: `behavior` is unset on the
declaration, so she cannot generate into a turn whose facts have not arrived,
which is the failure §6.0.18 exists to stop. The declaration's `spoken_note`
argument was the answer to the pause it creates: one short line she says while
the assistant works.

Nothing said it. `TemiVoiceStage` called `showToast(note)`, and on a voice call
a toast is nothing at all. Measured across five delegating turns on 2026-09-12,
four emitted no audio and no `outputTranscription` whatsoever before the
`toolCall` arrived, the call landing straight after a thought part whose own
text read "I'll begin by saying 'One moment.'" She believed she had spoken. The
operator got silence for the length of an agent run.

The block now ends immediately instead of when the agent finishes.
`handoffAcknowledgement` answers the tool call at once with a response carrying
no facts: her own note, handed back for her to say, plus the two things she must
be told. That the answer is not here yet, and that she may not invent it. The
run then continues in the background and the report arrives as its own turn.

The cost is stated because it is real. Between the note and the report she holds
the floor with the question still open, and the last line of the
acknowledgement is the only thing standing between that and a guess. This is
not NON_BLOCKING and must not be confused with it: the knob §6.0.18 declined is
still declined, and the response that releases the call contains nothing she
could build an answer on.

### 6.0.21 One answer, two bubbles, and a report read out loud (`components/voice/TemiVoiceStage.tsx`, `services/voice/progressNarration.ts`, 2026-09-12)

Three defects of the delegate path, all seen on one live call, all downstream of
the same confusion about which surface owns a line.

**The double.** `onCompleted` appended the report to `dialogueHistory` AND sent
it through `sendAssistantDirective`, and the spoken copy then committed as its
own bubble underneath the written one. This is not §6.0.19, which was a closed
turn handing its caption back; the pacer fix did not touch it. The rule now is
that a line the shell puts into her mouth lands on exactly one surface, and the
spoken one wins, because it is the record of what the operator actually heard.
The written surface is a fallback and nothing more: if she has not begun
speaking within four seconds the socket is down or the turn was swallowed, and
a report that reached nobody is a worse failure than one that arrived twice.
`tests/voice-handoff.test.mjs` pins the number of places in the stage that may
write an assistant bubble at three, two of them in `commitSpokenTurn` recording
words that were said.

**Recited, not answered.** A directive means "say this line", which is right for
a sentence the shell composed and wrong for a report. The tool path was proven
by her turning a report into "Lando Norris just won the Abu Dhabi Grand Prix on
December 8th, driving for McLaren"; the delegate path handed her the report as a
directive and she read it out. So the two are now different things.
`frameAssistantReport` delivers a finding for her to answer FROM, with the
anti-fabrication contract in its last sentence: she may rephrase what is in the
report and may not add to it. A sentence the shell composed still goes through
`sendAssistantDirective`, verbatim, for the reason §6.0.17 gives.

**The command in the answer.** Spoken aloud to the operator: "du -sh ~/Desktop
The total size of all the files in your Desktop folder is 38 gigabytes." and
"df -h / You have about 26 gigabytes of available storage space remaining."
`firstSentence` inlines a fenced block holding one short line, which §6.0.18's
predecessor added because deleting it was spoken as "The port is ." So the
agent's fenced command was glued to the front of its own answer, and with the
only full stop at the very end the whole line counted as the first sentence.
Position settles it without guessing at content: a fence the assistant went on
to explain is the working and goes; a fence with nothing after it is the payload
and is inlined exactly as before. The same report arrives unfenced just as
often, the command alone on the first line, so `dropLeadingCommandLines` takes
that case too, and deliberately narrowly. Three things must hold at once, and
`SHELL_VERBS` leaves out every command that is also an English word, because
throwing away a real sentence is the worse failure.

### 6.0.22 A turn nobody was listening to was still on screen (`services/voice/geminiLiveEngine.ts`, 2026-09-12)

`sendBargeIn()` is a local guard. Gemini Live has no "cancel this generation"
message, so when the shell answers a turn itself the model carries on
generating and the engine stops forwarding what arrives. The generation counter
made that precise for the AUDIO and for nothing else. Her words went through
ungated, so an abandoned turn still became her caption and still went into
`final_assistant_answer`.

Measured on a live call: the shell barged in and answered from the agent's
report, and the operator got one line reading "It is not something I keep an eye
on directly.38 gigabytes." The abandoned conversational turn and the directed
answer had accumulated into the same `outputTranscript` with nothing between
them. The missing space is the tell.

Both halves of a generation are now gated on the same number, and the number is
`incomingGeneration()` rather than `this.generation`. That is the whole
subtlety. A turn's generation was once minted down in the chunk block, on the
first audio of the turn, because that was the one place `turnActive` flipped;
the transcript branch runs earlier in the same message, so at a turn's first
transcript delta the raw counter still named the previous turn. A barge-in fired
before she has spoken, which is the common case, condemns `generation + 1`.
Minting moved to first content in 6.0.38, described below; the gate is unchanged
because `incomingGeneration()` answers the same question either way.
Comparing directly would have judged the condemned turn's first words against
the old number, found no match, and let exactly the measured line through while
dropping the audio that went with it.

`finalizeUserTurn()` stays outside the gate, deliberately. Her first word is the
only proof the operator's turn ended, there being no `inputTranscription`
terminator, and a turn dropped there never reaches the router at all.

One comment was also corrected rather than changed. The note at the
`turnComplete` handler said, honestly, that whether Gemini interleaves a
`turnComplete` around a tool call had not been verified. It has been, across
twelve harness sessions: exactly one per delegating turn, after the function
response is answered and she has stopped speaking, in the order
`setupComplete`, thought part, `toolCall` with `turnComplete` false, audio and
transcript, `generationComplete`, `turnComplete`. The
`if (this.pendingToolCalls.size) return;` guard is correct and, on this model,
never fires. It stays for the model that does interleave one.


### 6.0.23 "Go mute" had nothing behind it (`services/voice/voiceTurnRouter.ts`, `components/voice/TemiVoiceStage.tsx`, 2026-09-12)

`hush` ends the sentence she is on and leaves the microphone open, so the next
thing the operator says is heard and answered. That is the right response to
"be quiet" and the wrong one to "go mute", which asks for something that
persists. The operator asked for the second and got the first.

`mute` now closes the capture path and keeps it closed; `unmute` opens it.
Neither touches a run in flight, which is §6.8's rule about not confusing a
request for quiet with a request to stop working, and it applies here for the
same reason.

**Routed ahead of the intent switch, which is necessary rather than tidy.**
`turnIntent` files "mute yourself" under `HUSH_PHRASES`, and "stop listening"
fell through to its bare-stop rule, which mid-run cancelled the run. The
classifier's own verdict is still what `decision.intent` reports; where the two
disagree, the disagreement is written into `reason`. Phrases are matched as
whole utterances rather than keywords, and `tests/voice-turn-router.test.mjs`
(35 tests before this, 63 after) pins seven editor commands as NOT self-mute,
because "mute that track" is a video editing instruction and routing it to
self-mute would be the more embarrassing failure.

**Two limits, documented at the call site rather than deferred.**

Spoken "unmute" cannot work, and cannot be made to work from the router.
`voiceAudioEngine.ts:102` drops the captured batch while `isMuted` is set, so
no audio reaches the socket, no transcript returns, and `routeVoiceTurn` is
never called at all. The composer, the mic toggle and the orb are the three
doors that do work. That is why the mute confirmation names the way back
instead of merely agreeing, and why the confirmation is spoken BEFORE the mute
lands: muting gates capture only, so playback of that last line survives it.

Muting also had to gate `speakLine`. A muted Temi was still announcing
delegated runs as they finished, because mute closed her ears and nothing had
closed her mouth. The line is not discarded. It goes to the transcript, which
is the only surface a muted assistant has, so §6.0.21's one-surface rule now
has four append sites instead of three. The rule is unchanged: no site may
write a bubble ALONGSIDE a line she is also saying, and the muted branch writes
instead of the speaker rather than beside it.

`workspaceActions.ts` landed with this work, a pure parser and fuzzy resolver
for "open my DukaBot folder". It was unwired when this entry was first written;
§6.0.24 is where it reached the stage.

### 6.0.24 A spoken folder name took an agent round trip (`components/voice/TemiVoiceStage.tsx`, `services/voice/workspaceActions.ts`, 2026-09-12)

"Switch to m-digital" already worked. `machineAction.ts` classified it as
`workspace`, the router delegated, and the assistant opened it — a prompt, a
tool call, a report, and seconds of waiting for a decision that is a name
lookup against four sibling directories. What the operator asked for was that
it happen now.

`parseWorkspaceCommand` is consulted in `performVoiceTurn` ahead of
`routeVoiceTurn`, for the same reason `mute` is: the router files a folder name
as conversation and answers it with a sentence. Null is its ordinary answer and
costs nothing — the turn carries on to `machineAction` and the assistant, which
is where every one of these sentences went before. Measured resolutions: "em
digital" to `m-digital` at 0.89, "duke about" to `dukabot` at 0.78, "bot" to
`dukabot` at 0.43 and refused, against a floor of 0.7 and a 0.08 margin over
the runner-up.

**The `!busy` gate is a measured hazard, not caution.**
`WorkspaceService.openProject` rebinds the workspace root that every workspace
and terminal route resolves against. An agent run in flight resolves its
relative paths against that same root, so a switch landed mid-run sends the
run's next `Edit` or `Write` into a different repository — silently, in a
project the operator was not looking at. Mid-run the turn falls through to the
assistant instead. `reveal-folder` is genuinely safe mid-run, touching only
`expandedPaths` and `revealTarget`, but one gate is easier to keep right than
two.

Three smaller decisions, each of which is a way to be wrong:

- The store is given the path the **gateway confirmed**, never the parsed one.
  The gateway owns which root the routes read; passing our guess would stamp it
  into the store as a fact. See `setWorkspacePath` in `studioStore.ts`.
- A reveal is given `relativePath`. `revealPath` keys the open set by
  workspace-relative path, so an absolute one opens nothing and reads as a
  command that was ignored.
- `workspacePath` is passed to the parser **only when `workspaceRootConfirmed`**.
  The initial value is a hardcoded guess, and an unconfirmed root deciding that
  a folder is "local" turns a switch into a reveal against a root we are not
  bound to.

Switching to the root already open is skipped rather than re-applied:
`setWorkspacePath` collapses every open folder, clears the reveal target and
restamps the active chat session, so re-applying it would throw away the
operator's tree to arrive where he already is.

**Known limitation, by design.** Candidates come from `/api/workspace/projects`,
the renderer's only fs-free source — the module can list a directory itself but
only through an injected `readdirSync`, and this is a browser bundle. A project
the operator has never opened is not in `recent`, so it is not a candidate and
that turn correctly falls through to the assistant, which can reach the disk.

`tests/voice-workspace-actions.test.mjs` (24) covers the parser;
`tests/voice-workspace-wiring.test.mjs` (12) pins the arrangement above.

### 6.0.25 The voice lane had no route into the editor at all (`services/voice/editorActions.ts`, `components/voice/TemiVoiceStage.tsx`, 2026-09-12)

The video editor has had a programmatic surface since P2 and the chat has used
it since (`aiService.ts#runVideoTool`). The voice lane never had one.
`routeVoiceTurn` knows `converse`, `stop`, `repeat`, `hush`, `mute` and a
delegate, and none of those is a tool call — so "cut here", spoken aloud,
arrived as conversation and was answered with a sentence about cutting. An
audit on 2026-09-12 found this was the load-bearing gap, ahead of any question
about which tools exist.

`editorActions.ts` is the missing half, modelled on `workspaceActions.ts` and
inheriting its posture: pure, importless, and written to under-match. The verbs
it reaches are worse than the workspace ones — `split` and `delete_selected`
destroy work and `export_project` occupies the machine for minutes — so the
grammar refuses far more than it accepts, and the refusals are specific:

- `cut` is only a razor when the sentence says **where** ("cut here", "at the
  playhead"). "Cut to the chase" and "cut that scene" fall through, which is
  correct. `split` and `razor` carry themselves, being editing words in almost
  any context.
- `delete` fires only with a timeline noun after it. "Delete that branch" and
  "delete that file" are left alone; `deleteSelected` acting on the wrong
  sentence destroys work only the editor's own undo can recover.
- **Bare "stop" is never claimed.** `voiceTurnRouter` reads it as cancel-the-run,
  which is the reading the operator needs under pressure, so pausing playback
  must name its object.
- A command needing an identifier voice cannot pronounce is not emitted at all.
  "Add that clip" needs an asset id and falls through to the assistant, which
  can read the pool. "That track" resolves to the literal `"selected"` and the
  tool refuses it when nothing is selected, rather than guessing track 0.
- Questions, negations and hypotheticals never act — the same frames
  `workspaceActions` rejects, plus "should I…". "Can you cut here" deliberately
  is NOT a question: on a voice call it is the politest form of the command.

**`play` and `pause` are distinct commands, not `togglePlay`.** The store offers
a toggle; the word "play" names a state. An operator saying "play" while it is
already playing would have got a pause — the command doing the opposite of the
word.

**One line is spoken per command, and it is derived from the result rather than
the request.** `splitAtPlayhead` succeeds with `{ attempted: 0, cut: 0 }` when
the playhead is over nothing, so announcing "Cut." on a successful call reports
an edit that did not happen, and the operator finds out at the export.
`describeEditorResult` is where that judgement lives; `deleteSelected`'s
`{ deleted, refused }` gets the same treatment. The export is the one command
that speaks twice, at two different times, because silence across a job that
holds the machine for minutes reads as a command never heard — that is not
§6.0.21's defect, which was one line landing on two surfaces at once.

**Unlike the workspace path this is NOT gated on `!busy`, and the difference is
the point.** A workspace switch redirects an in-flight run's writes into another
repository; an edit lands on the timeline in front of the operator who asked for
it while watching. Hands-free control that switches itself off whenever an agent
is working is control he does not have when he most wants it.

It IS gated on the root being a video project — `projects.current.kind ===
"video"`, which the gateway already classifies from the `teminali-video-project`
marker. "Undo that" and "pause it" are things an operator says to an agent
working on code, and reaching for a timeline that is not there would answer
ordinary conversation with "That didn't work".

The registry is reached by **dynamic import**: `toolRegistry` pulls the ffmpeg
and caption surfaces behind it, and a static import would drag all of it into
the chunk this stage ships in, on a screen that usually never touches the editor.

`tests/voice-editor-actions.test.mjs` (23) covers the grammar and the result
descriptions; `tests/voice-editor-wiring.test.mjs` (8) pins the arrangement.

### 6.0.26 The folder he actually tried was four words long (`services/voice/workspaceActions.ts`, 2026-09-12)

§6.0.24 shipped the parser with a three word name window. On 2026-09-12 the
operator spoke the name of a folder it could not hear at all:
`4K Video Downloader+`, which is said either "4K video downloader plus" or
"four K video downloader". Both are FOUR words. The name is pinned between the
verb's lead in and the place noun, so a four word name matched no pattern,
`parseWorkspaceCommand` returned null before the scorer ever ran, and no
refusal was reachable either. There was nothing to refuse, because nothing had
been read as a name. `Mocro.Maffia.S06.MULTi` was out of reach for the same
reason. `NAME_SHORTEST` and `NAME_LONGEST` now repeat `{0,3}`, four words.

This is also why the resolver was cleared of the failure earlier, wrongly.
Typing the phrase had always worked, and the typed wording is "4K video
downloader": three words, and 1.000 against the directory. The single wording
that survived the old window was the one nobody was speaking.

**The alternative that was measured and rejected is the interesting half.**
Normalising `+` to "plus" inside `skeleton()` looks like the obvious repair,
and it is a trade rather than a fix. Against `4K Video Downloader+` it lifts
"video downloader plus" from 0.684 to 0.905, and drops "four K video
downloader" from 0.800 to 0.619, under the 0.700 floor. It buys one of the two
wordings by losing the other, and the operator gets to find out which one he
used. Widening the window costs neither: both resolve, measured.

`tests/voice-workspace-actions.test.mjs` now runs 26, up from the 24 §6.0.24
recorded.

### 6.0.27 Filler may ride on the edges of a name, never through the middle (`services/voice/workspaceActions.ts`, 2026-09-12)

`cleanName` used to strip `FILLER` words from anywhere in a capture. With a
three word window that was merely generous. With four words it is unsafe, and
§6.0.26 does not ship without this: the wider window is exactly what lets a
capture reach across a phrase boundary.

The case that proves it is an ordinary sentence. "Move the video into the
downloads folder" is an instruction about a FILE. It captures "video into the
downloads", and deleting `into` and `the` welds the two ends into "video
downloads", which scores 0.765 against `4K Video Downloader+`, over the 0.700
floor. A sentence about moving a file would have silently rebound the workspace
root, collapsing the open tree and restamping the chat session, which is the
one failure the whole module is written to refuse, arriving through the front
door.

So interior filler is now a refusal, not something to clean off. Filler at an
edge is a word riding along with a name, "open my dukabot folder" meaning
`dukabot`. Filler in the middle is the sentence carrying on, which is evidence
that the capture crossed a phrase boundary, so what was captured is not a
directory name at all and no amount of cleaning turns it into one. `cleanName`
returns the empty string, `namesFrom` drops the reading, and the turn falls
through to the assistant, which can read the sentence properly.

Measured after both changes: "open the 4K video downloader plus folder" and
"open the four K video downloader folder" resolve to `4K Video Downloader+`,
and "move the video into the downloads folder" parses to null.

### 6.0.28 The spoken path keeps a trace, on `window`, not in the console (`services/voice/voiceTrace.ts`, `components/voice/TemiVoiceStage.tsx`, 2026-09-12)

Four places can end a spoken turn by returning, and all four look identical
from the operator's chair: he says a sentence and the shell sits there. Two
echo filters drop the transcript before anything sees it
(`isAssistantDirectiveEcho`, `isAssistantReportEcho`), `parseWorkspaceCommand`
refuses by design and returns null, and the `!busy` gate falls through to
conversation. None of them wrote anything down, so the live failure in §6.0.26
left no evidence at all: the renderer state died with the restart, and the only
record of it was the operator's word that nothing had happened.

`traceVoice` is the record. `heard` carries the raw transcript, which is the
datum the whole diagnosis turns on, since "open the 4K video downloader folder"
resolves and "open the 4K video downloader PLUS folder" did not, and nothing
downstream can tell you which one the microphone produced. `dropped` names
which echo filter took it. One `turn` line carries `source`, `busy`, the parsed
workspace kind and the candidate count, which is what separates a turn the
parser refused from one the gate held: both end in silence and they need
opposite fixes.

**It is a bounded ring on `window`, and it is deliberately NOT a console log.**
A log is readable only by whoever is attached to the console at the instant it
prints, and the shape of this failure is that it happens while the operator is
talking and is read afterwards, over CDP, by someone who was not in the room. A
ring can be read at any point after the fact. `LIMIT` is 40, a conversation's
worth of turns, and the old events go rather than the new ones, because the
failure being diagnosed is always the most recent thing he tried.

**Published at module import, not on first event, and that timing carries the
information.** An EMPTY `window.__temiVoiceTrace` says the voice stage is
mounted and heard nothing. A MISSING one says this build is not running. Those
two need opposite next steps, and nothing else on the screen distinguishes
them. The publish is guarded on `typeof window`, because a node test imports
the module with no window to publish onto.

`traceVoice` never throws and returns nothing a caller can branch on. It sits
on the path between a microphone and a workspace switch, and a diagnostic that
can change what that path does is worse than no diagnostic.

`tests/voice-trace.test.mjs` (6) pins the ring: it bounds at 40 dropping the
oldest, it imports cleanly in a process with no `window`, and `traceVoice`
throws on nothing a caller could hand it, including a cyclic detail object. The
call sites in `TemiVoiceStage.tsx` are held in place by review rather than by
an assertion.

### 6.0.29 A refusal that says nothing is indistinguishable from not hearing (`components/voice/TemiVoiceStage.tsx`, 2026-09-12)

§6.0.24's `!busy` gate is still right for the reason recorded there: a switch
landed mid-run sends the run's next `Edit` or `Write` into a different
repository. What was wrong was the silence. Mid-run the turn fell THROUGH to
the assistant, so the operator said "switch to DukaBot", nothing visible
happened, and a refusal he would have agreed with was indistinguishable from a
command that was never heard. One of those asks him to wait and the other asks
him to say it again.

The branch below the gate now answers instead of falling through: barge in when
the turn was spoken, one spoken line, and a toast. It is answered here rather
than passed on because handing a workspace command to the assistant answers a
command with talk.

**The words were the hard part, and the first draft was a fabrication.** It
said "I heard you. I'll switch to <name> once this run finishes". Nothing is
queued: `busy` is read at the gate and nowhere else, there is no watcher and no
re-issue when the run ends, so that sentence described a mechanism that does
not exist — the same failure the report path is built to refuse, arriving
through a line of UI copy. The line now says what is true: "I can't
<switch to|open> <name> while this run is going. Tell me again when it's done."

**The queue is not a to-do, it is refused.** A run can end minutes later, and an
unannounced root change then is precisely the silent wrong switch the gate
exists to prevent. Refusing out loud and letting him re-issue keeps the change
attached to the moment he asked for it.

The verb is chosen from the action, because a mid-run `reveal-folder` is
refused too and calling that a switch is its own small inaccuracy. §6.0.24
gated reveal only because one gate is easier to keep right than two, so the
refusal is deliberate and the wording now matches it.

This is a fifth `speakLineRef` call inside the block §6.0.21 governs, and the
rule holds unchanged: one line, spoken, with no bubble written beside it.
`tests/voice-workspace-wiring.test.mjs` pins the shape of that block by
counting its early returns and its spoken lines, so this branch moves both
counts by one and those numbers are part of the contract rather than incidental
to it.

### 6.0.30 Depth is per root, and below the top level a folder must prove itself (`server/projects.js`, 2026-09-12)

§6.0.26's discovery scanned one level and stopped, which left the operator's
deepest-held assumption unserved: `my_projects` is a folder of folders, and
`teminali/claude-context-guard` and `m-digital/m-digital-web` are projects he
names out loud. One level deep, neither existed as far as the voice lane was
concerned, and "switch to the claude context guard folder" returned null.

**A blind second level was measured and refused.** Depth 2 everywhere adds 204
directories, and 126 of them are under `~/Downloads` and `~/Movies` — in
Downloads, the insides of two cloned repositories (`src`, `dist`, `tests`,
`public`, `node_modules`); in Movies, the insides of the app's own recordings.
Those are not projects, they are short generic names, and short generic names are exactly
what a mis-transcription scores above the 0.7 floor. Binding the workspace root
to a `node_modules` by mis-hearing is the silent wrong switch this lane exists
to refuse, so the depth is per root: `my_projects` 2, `~/Downloads` and
`~/Movies` 1. Their top level is already what he names.

**Two rules, one question.** `my_projects` is not uniform either — 15 entries,
of which 8 are repositories and 6 are containers — so a directory carrying a
project marker (`package.json`, `.git`, `pyproject.toml`, `requirements.txt`,
`Cargo.toml`, `go.mod`) IS the project: the descent stops there, and below a
root's top level nothing without a marker is listed at all. Measured: depth 2
finds 21 directories under `my_projects`, 12 of them projects; the other 9 are
`build`, `docs`, `tests`, `tools`, `__pycache__` and a bare clone. The whole
scan returns 45 folders in 16 ms.

The marker list is longer than JavaScript because his projects are: `xslm_project`
is Python and read as a container until `pyproject.toml` was on the list, which
put its `tests` and `tools` into the candidate list.

**The top level keeps the permissive rule, deliberately.** `argus-vpn-landing`
is three loose files with no repository and no manifest, and reaching it by
name is what discovery was added for. The top level of a root is a place he put
things; a level down is the inside of someone's folder, and the stricter rule
belongs there.

The walk is level by level rather than directory by directory so that the cap
takes the deepest, least likely entries first. Truncating the top of
`~/Downloads` would drop `4K Video Downloader+` and silently undo §6.0.26.

`tests/project-discovery.test.mjs` (16) is the scan's first test of its own —
it had been proved only by live probe against one machine on one day — and it
pins the rules that keep entries OUT, including that `DISCOVERY_ROOTS` still
mirrors the resolver's `ALLOWED_ROOTS`. Discovering a folder the resolver would
then refuse to bind is a turn that finds the right directory and says no.

**Known, and not fixed here:** `~/Downloads/frontier code tests` answers "open
the tests folder". It is a top-level folder that was already a candidate before
this change, so it is the scorer's doing, not the scan's, and the floor and
margin in `workspaceActions.ts` are calibrated numbers that do not get moved
in passing.

### 6.0.31 The stage heard a room and could not tell who was talking (`components/voice/TemiVoiceStage.tsx`, `services/voice/addressing.ts`, 2026-09-12)

An audit of the whole spoken surface, six agents reading every path from parse to
executor, put the turn machinery first. The shipping stage never imported
`conversation.ts`, which meant `scoreAddressing`, `EchoGuard` and
`selfAudio.audibleSince` were all unreachable code. Nothing gated a final
transcript on who had produced it, so someone else in the room saying a sentence
with a machine verb in it delegated a real run.

`gateSpokenTurn` now runs upstream of everything, on the `final_user_request`
transcript. Provenance is asked first: while the app itself is audible, only a
turn that names the assistant is taken, because the audible thing may be a film
whose dialogue contains any sentence at all. Otherwise `scoreAddressing` decides.
The gate returns the `stripWakeWord`-stripped text, so "Temy, open DukaBot"
reaches the switch as "open DukaBot". A rejected turn sends `sendBargeIn()` and
stops playback, because Gemini's own VAD has already started answering the room.

**Landing that gate made a latent bug live.** "Hold on" sits in both
`STOP_PHRASES` and `THIRD_PARTY_MARKERS`, and the unconditional stop fast path
won, so a phrase said to a person in the room cancelled the run. The fast path is
now conditional on `(wakeWord || !thirdParty)`. "Stop", "cancel" and "abort" carry
no third-party marker and remain unconditional.

Four more failures in the same file. An acknowledgement spoken over her, "mhm" or
"yeah", fired barge-in and then fell into a bare `break`, so her sentence died and
nothing replaced it; it no longer interrupts her. An acknowledgement inside the
follow-up window after a question she asked was classified as praise and
discarded, so "yes" answering "should I run the tests?" did nothing; it now routes
as an answer. The mute line promised "tap the orb when you want me back" while
`handleOrbClick` did nothing when muted and quiet; that door now exists. Tapping
the orb to talk over her called `stopCurrentTask`, the hush and stop conflation
§6.8 forbids; a tap is a hush and the run carries on.

`protocol.onError` was never assigned, which made every `onError` call in the live
engine a silent no-op, and the only visible sign of any failure was the tooltip of
a 2.5px dot. The handler is assigned beside `onConnected`, and `voiceNote` renders
as a persistent `aria-live` banner in the message column.

The editor lane was gated on a flag set only from `WorkspaceService.listProjects`,
so a failed fetch on mount killed the entire lane silently for the session.
`projectKindKnownRef` separates "not a video project" from "we never found out",
and the unknown case falls back to whether a timeline is loaded.

`useSpokenApproval` was mounted in the chat and in the agent pane and never here,
so "approve that" and "yes go ahead" routed to conversation. It is mounted,
`consume` runs before the router, and the banner carries Allow, Always and Refuse
buttons: a permission prompt raised while the mic is muted would otherwise hang
the run with no way to answer it.

### 6.0.32 One bad minute of network cost the whole session (`services/voice/geminiLiveEngine.ts`, `services/gatewayClient.ts`, `server/gateway.js`, 2026-09-12)

The live lane had no way to survive anything going wrong. A StrictMode remount
during `connect()` left two sockets streaming into one worklet, because nothing
re-checked `explicitlyDisconnected` after the awaits. It now re-checks after both,
and an abandoned attempt's callbacks are dead, otherwise the discarded engine's
`onclose` flips the live stage to disconnected.

No `sessionResumption` was declared and `goAway` was never read, so a session
Gemini ended itself took the conversation with it. The newest resumable handle is
kept and reconnected with, and a `goAway` warning schedules the replacement
`GO_AWAY_LEAD_MS` (1000) before Google's stated hang-up. The handle is dropped on
`disconnect()`, on a history clear, and on a voice change, since the voice is part
of session setup and a resumed session would restore the one the call was made to
change.

`silenceDurationMs` was 700, so "open dukabot and run the tests" closed the turn
on the thinking pause and both halves delegated separately. It now reads
`DEFAULT_ENDPOINTER.maxSilenceMs` rather than copying it: **1800 ms**, the
measured ceiling of the silence window itself. The 2000 in the audit was
`pacingCeilingMs`, which caps a learned floor and is not a window.

Reconnection was a flat 2000 ms retry with no backoff, no cap and no give-up,
minting a single-use token every two seconds forever. A dropped socket now backs
off 1 s doubling to a 15 s cap, a failed mint 5 s doubling to a 60 s cap, both
stopping after six attempts with a note naming the way back. `mint-failed` was
terminal for the session and is now retried along with the other failures that can
fix themselves; `no-key`, `quota` and `sdk-unavailable` stay terminal, because
they need a key, a billing cycle or a reinstall and a loop would bury the note.

**The tests could run twice.** `tool_call` was not gated by `suppressedGeneration`,
so a turn the rules path had already delegated could be delegated again by the
model's own `ask_the_assistant`. Tool calls are now gated on the same predicate as
the transcript.

The captive-portal wedge was wider than the audit found. The token fetch had no
deadline, but neither did `ai.live.connect()` itself, which is the call that
actually stays pending forever behind a portal. Eight second deadlines on the
gateway token fetch, the `/api/session` mint and the gateway's own call to Google;
ten seconds on the Live handshake, with a late-opening socket closed rather than
left holding the microphone.

### 6.0.33 "Pause" cancelled the run and the video kept playing (`services/voice/playerActions.ts`, `services/voice/machineAction.ts`, `services/voice/turnIntent.ts`, 2026-09-12)

The player's executor was complete and voice never reached it. `dispatchPlayerCommand`
and its twenty actions have been there the whole time; there was no parse. So
"pause" matched `STOP_PHRASES` and cancelled the agent run while the video played
on, "skip forward thirty seconds" conversed because "second" was not a machine
noun, and "turn the volume down" and "full screen" matched nothing at all.

`playerActions.ts` is that parse. `handleSpokenPlayerCommand` is the first
statement of a spoken turn, ahead of the approval, workspace and editor fast paths
and the router, and returns `{ handled: false }` both when the sentence is not
transport and when no pane is mounted, so the turn carries on unchanged.

**"Pause" stays in `STOP_PHRASES`.** With no video open it still means stop the
run, and removing it would trade one wrong answer for another. The ambiguity is
settled by whether a pane is mounted, not by the word list.

Covered: play, pause, toggle, restart, next and previous item, seek to a timecode,
a nudge by a spoken duration or by the player's own ten second step, volume up,
down, to a percentage, mute, unmute, fullscreen and back, playback speed, and
subtitles, bounded by `PLAYER_ACTIONS` so no sentence can name an action the
executor has no case for. A volume or speed step is computed from the level the
player reports and returns nothing when there is no snapshot, rather than guessing
50%; a rate outside `clampRate`'s range is refused rather than clamped, because
"ten times speed" clamped to 3x reports a lie.

Refused, deliberately: "turn it up", "louder", bare "mute", bare "next", bare "go
back", bare "restart". Each is the plainest way to say something else to Temi, and
no wording separates them. She may be talking while the film is playing, and the
words are identical.

### 6.0.34 The timeline could be asked for eleven things and could do twenty-eight (`services/voice/editorActions.ts`, `video/mcp/toolRegistry.ts`, 2026-09-12)

Four spoken sentences an operator actually says at a timeline were refused by the
grammar: "move the playhead to ten seconds" needed the verb adjacent to "to",
"split this clip" was accepted only as "split this", "play the timeline from here"
was end-anchored, and no zoom verb existed anywhere.

**A fifth bug found while testing those was worse than all four.** `parseSpokenMs`
accepted a bare `s` or `m` as a unit after any word, so "captions" parsed as
`caption` plus `s`, "from" as `fro` plus `m`, "them" as `the` plus `m`. Each fed a
non-number to `numberFrom`, which returns null, and null there means the whole
sentence is unreadable. "Go to 30 seconds from the start" was silently dead, and
so was every caption sentence. Units are words now, with a digit-anchored `30s`
branch beside them, and "half a second" is 500 ms rather than one second.

The delta the audit listed as unreachable is closed. `generate_captions` and
`perfect_captions` were exposed tools with no spoken route at all, on the surface a
social demo needs most: "add captions", "fix the captions", "check the captions",
"shift the captions forward half a second". Then trim, duplicate, speed, reverse,
freeze, detach audio, close gaps, transitions, titles, markers, in and out points
and zoom. All twenty-eight go through one `timeline_command` schema rather than
seventeen new tools, because every exposed tool name is paid for on every request.

Two executor defects surfaced in the wiring. `trimClip` clamps rather than
refusing, so a trim from a playhead parked outside the clip would silently resize
it to zero; the verb range-checks first. `updateClipSpeed` does not commit, so a
spoken speed change would have left nothing to undo; it is wrapped in `asOneEdit`.

### 6.0.35 Every delegation was auto-denied in a millisecond (`services/voice/teminaliAgentBridge.ts`, `services/voice/voiceTurnRouter.ts`, `services/aiService.ts`, `services/agentCliService.ts`, 2026-09-12)

The headline capability, driving Claude Code and Codex by voice, was broken at the
first gate. The bridge passed no `approveCommand`, so the first permission event
auto-denied and "ask Claude Code to run the tests" died instantly. The stage's own
gate is used when it passes one; otherwise the bridge publishes the CLI's question
to `approvalStore`, where it is read aloud and answered by a spoken yes, and it
always settles, after three minutes at the latest, under the gateway's five minute
auto-deny, so a stop never leaves the CLI blocked.

**"Use Frontier Max" was a fabrication.** No engine-name parser existed anywhere in
`services/voice`, so the sentence classified as conversation, the persona answered
in character, and nothing changed. There is an engine-select intent now, and the
bridge reads the store back before speaking, so the confirmation follows the change
rather than predicting it. Mid-run it says the switch applies to the next task
instead of claiming the running job moved. A named assistant is no longer discarded
either: "have Codex look at this file" runs on Codex, where before the name was
dropped and the picker's engine ran the work.

Flash and Auto both speak as "Frontier" because `runTask` sends mode `auto` for
every non-Gemini engine, and confirming "Frontier Flash" would be the same
fabrication in a smaller font.

A prompt arriving mid-run was queued silently after she had already said "On it",
and opened minutes later; the folder path refused out loud and files did not. The
queue notice is spoken on the same terms as a refusal. A cancel reported "Stopped."
and then "The background assistant encountered an issue"; our own abort is
recognised first. Successive turns now continue one CLI session per engine, keyed
by workspace and never resumed into a workspace it did not run in, so "now run the
tests" remembers "fix the failing test". A question about a run that has just
finished is answered from that run's own report rather than starting another one.

### 6.0.36 She read the markup out loud (`services/frontierEngine.ts`, `services/voice/workspaceActions.ts`, 2026-09-12)

"Open package.json" opened the file and then spoke the tag that opened it,
truncated at the first dot of the path. **That was two bugs, not one.** The
completed text was one; the streaming path emitted `<workspace-` token by token
independently of it. A per-turn stripper holds back any tail that could still
become a tag and releases it the moment it cannot, costing one bracket of latency
on prose and nothing on text without one. A tag the model never closes is spoken
rather than swallowing the rest of the answer, because silence is the worse
failure.

The executor used `.match`, not `.matchAll`, so **only the first workspace action
of a turn ever ran**. It also pinned attribute order, so a tag written with `path`
before `action` did nothing at all. Attributes are read by name now, in emitted
order, and the same non-global bug was fixed in the Claude Code and Codex lane,
where it additionally required a `path` attribute that `close-file scope="all"`
does not carry.

"Close that file" had no verb anywhere: it classified as `open`, delegated, reached
nothing, and Gemini confirmed a close that never happened. `close-file` exists end
to end, for the active tab, a named file, or every tab, and the spoken prompt now
forbids confirming a close without emitting the tag that performs it.

The voice prompt carried the workspace root and recent workspaces but no open tabs
and no active file, so "open the file I was just editing" made the model guess a
path and open a read error. `EngineCapabilities.openEditors` injects editor state
the way `playerState` injects the player's, capped at six entries with a `+N more`
count and relative to the workspace, measured under 400 characters for a twelve tab
workspace. Nothing open renders as "none" rather than as nothing, so the model asks
instead of inventing.

### 6.0.37 Bare "pause" worked at mpv and not at the app's own player (`services/voice/playerActions.ts`, `components/voice/TemiVoiceStage.tsx`, 2026-09-12)

The provenance gate in 6.0.31 required the wake word for any turn spoken while the
app itself is audible, because a film's dialogue is real speech and no addressing
score can tell it from an operator's. Correct, and it cost the one sentence most
often said at a playing video: plain "pause" was dropped, and only "Temy, pause"
landed.

It was also **asymmetric**, which is what settled it. mpv plays out of process and
never registers as self-audio (`selfAudio.ts`), so bare "pause" always worked
there. The same word at the same film in the Files panel did nothing. The rule was
not "the wake word protects you from recordings"; it was "the wake word is the
price of using the player that happens to run in this process".

Three actions are now exempt while a player pane is mounted: `pause`, `play` and
`toggle`. Nothing else. `survivesSelfAudioWithoutWakeWord` asks
`parsePlayerCommand` — the same parse that would run the sentence — and admits it
only if the resulting action is one of the three, so the exemption inherits every
deliberate refusal in that grammar instead of re-litigating it as a phrase list.
Seek, volume, mute, fullscreen, speed and subtitles stay behind the wake word, as
does every other lane, so a film still cannot delegate a run, open a folder or
touch the timeline. The worst it can now do is pause or resume itself, undone by
saying the same word again.

With no pane mounted the snapshot is null and the exemption does not exist, which
also leaves "pause" meaning cancel-the-run when the audible thing is the browser
pane or the operator's own footage on the timeline. **The operator chose this
trade-off explicitly**; the strict bar is one edit away in `WAKELESS_TRANSPORT`.

### 6.0.38 A turn was numbered by its first audio, so a turn with no audio silenced the next one (`services/voice/geminiLiveEngine.ts`, 2026-09-13)

A barge-in condemns a generation, and nothing retires a suppression except the
counter moving past it. Generations were minted in the audio branch, on the
first chunk of a turn, because that was the one place `turnActive` flipped. So a
condemned turn that produced no audio never advanced the counter, the
suppression stayed armed, and it took the NEXT turn instead: a question nobody
had barged in on came back mute.

**This was not latent.** §6.0.20 records the measurement that makes it a live
defect rather than a hypothetical: across five delegating turns on 2026-09-12,
four emitted no audio and no `outputTranscription` at all before the `toolCall`
arrived. Those are exactly the turns the shell barges in on, and exactly the
turns that produced nothing for the counter to move on. The operator's next
question was the one that lost its voice.

`beginTurn()` mints on the first CONTENT of a turn instead, and is called from
every branch that can carry it: her words, her voice, her hands. It is
idempotent within a turn, `turnActive` being the already-minted flag, and only a
turn boundary puts that flag down. The per-turn resampler resets stay welded to
the mint, because nothing between a turn's first word and its first frame
touches the anchor or the carry.

A second residual had to move with it. `sendBargeIn()` used to clear
`turnActive`, which told the next chunk of the same turn it was a new turn: it
minted itself a fresh generation, and a fresh generation is not the one the
barge-in condemned, so she carried on speaking over the answer the shell had
just given. That clear is gone, and the comment at the call says why, because
the semantics are the simpler statement of the same thing: a barge-in does not
end her turn, it refuses to forward it.

One hole is left open **deliberately**. A turn that emits literally nothing
still never advances the counter, so a suppression aimed at it still lands on
the turn after. Closing that needs a retire-at-turn-boundary rule, and a
duplicate boundary would then retire a live suppression and put her back to
talking over the shell's answer. The narrower failure was chosen over the worse
one. `tests/voice-live-engine-generation.test.mjs` (9) covers both halves; 5 of
the 9 fail against the pre-patch engine.

### 6.0.39 "What did you change" answered from character, not from the report (`services/voice/voiceTurnRouter.ts`, 2026-09-13)

Measured with nothing running: "what did it change" and "what files did it
touch" reached the bridge, while "what did you change", "what just happened",
"how did it go" and "tell me what you did" reached the persona. The difference
is a pronoun and a verb list, not a difference in what was asked.
`STATE_QUESTIONS` needs one of `it`, `this` or `that` somewhere in the sentence,
and its verb list holds "changed" but neither "happened" nor "go". The persona
has never seen the finished run's report, so it answered from character. That is
the fabrication §6 forbids, about work that really was done and really was
written down.

`isRunRecallQuestion` recognised all six already. It was only ever consulted on
the branch where a machine action had matched, so for these four it never ran.
The fix asks the same recogniser in the one place it could not reach: a
fall-through in the `converse` branch, `voiceTurnRouter.ts:656`, gated on
`!state.busy` and returning `delegate` with action `inspect`, the same kind the
gate already returns for the two siblings that worked.

It is **deliberately not** in `classifyMachineAction`. That function is pure
text rules by contract and cannot see `busy`, which is the router's own input;
widening its patterns would fire in both states, and while a run is live these
questions are about the thing in flight and the branches above own them. Being a
fall-through also bounds the blast radius: it can turn `converse` into
`delegate` and nothing else, so no refusal above it moves.

One corpus expectation was flipped rather than added:
`tests/voice-turn-router.test.mjs:424`, "What did you just do?", from `converse`
to `delegate`. It sits one turn after the `Stop.` at :415 that sets the session
idle, so it genuinely is run-recall and the old expectation was wrong. All six
phrasings now route `delegate`/`inspect` from an idle session, measured.

### 6.0.40 The sentence naming the fix was overwritten by the one that named nothing (`components/voice/TemiVoiceStage.tsx`, `store/studioStore.ts`, 2026-09-13)

Two separate defects, both of which left the voice lane dead with no way back.

**The banner said the wrong thing.** A refused token calls `onNote` at
`geminiLiveEngine.ts:524` and `onError` two lines later at :526. Both wrote the
same state, so the friendly sentence reached the banner and was overwritten,
before a frame was painted, by "Temi's voice hit an error: no-key: No Google
Gemini API key is configured", which is the raw pair the engine builds for the
console. `onError` now uses a functional update and yields to a note that
carries a remedy. Every other error still overwrites, and the remedy is cleared
by the next note whatever it says, so nothing is pinned longer than the failure
behind it lasts.

**And the engine stayed dead.** A `no-key` mint is terminal by design, no retry
ladder, so pasting a key changed nothing until the app was quit and reopened:
the stage builds its engine once on mount. A `providerKeySaves` counter in
`store/studioStore.ts` is raised by both save sites after `ProviderService.setKey`
resolves, `ApiProviders.tsx` and `GeminiKeyModal.tsx`, and **deliberately not**
persisted: it is absent from `partialize`, because a count restored from disk at
the next launch would announce a save that already happened.

The stage watches it in a SEPARATE effect, holding the mount value in a ref so
the first render is not a save. **The engine effect's `[logAction]` deps are
untouched on purpose.** Widening them to include the counter would tear down
`VoiceAudioEngine` and the microphone with it, and if that fired while the
operator was mid-sentence it would cut him off to fix a problem he no longer
has. The new effect calls the existing `protocolRef.current?.connect()`, which
already returns immediately when it holds a session or is mid-connect, so one
attempt per save costs nothing when voice is already up.

The banner's "Add key" button is gated on `geminiLiveRemedy(note) === "gemini-key"`,
and that helper is a string identity check against `GEMINI_LIVE_NO_KEY_NOTE`,
the same constant `describeGeminiLive` returns. Not English pattern matching:
the sentence and its button are one edit, not two, and the button cannot appear
under a note that has moved on to saying something else. **Proven statically
only.** The wiring was read end to end; Electron was never launched and the
click was never performed.

### 6.0.41 The Voice pane governs two lanes and described one (`components/voice/VoiceSettingsPanel.tsx`, `components/voice/VoiceEnrolment.tsx`, 2026-09-13)

The pane carried an "audio never leaves it" claim under a heading that read as
the engine choice for the whole feature. Its headline lane streams 16 kHz
microphone PCM to Google: `sendAudioChunk` at `geminiLiveEngine.ts:1104`, with
`MIC_RATE` at :54. The claim was false as written and is gone. It survives only
where it is true, on the dictation recogniser row, and only for the local tier.

The governing fact the old copy never stated: **this pane governs TWO lanes.**
Temi's live conversation, `TemiVoiceStage.tsx` driving `geminiLiveEngine.ts`,
reads exactly one key out of `VoiceSettings` and nothing else, `wakeWords`, in
`gateSpokenTurn` at `TemiVoiceStage.tsx:556`. Every other key on the page feeds
dictation and hands-free through `services/voice/conversation.ts`, which is not
mounted on Temi's lane at all: `hooks/useVoice.ts:88` holds the only
`new VoiceEngine` in the app.

Which makes two rows actively misleading rather than merely vague. "Only respond
to my voice" and "Require my name" do NOT protect Temi. `TemiVoiceStage.tsx`
passes `hasProfile`, `requireWakeWord` and `requireSpeakerMatch` as `false`
literals at :575-577, so whatever those switches say, the stage asks
`scoreAddressing` a question with the protections turned off. Every control's
description now names the lane it moves, and `VoiceEnrolment.tsx` says on the
screen that the voiceprint gates dictation and not Temi, since an enrolment that
looks like a lock on the microphone is worse than no enrolment at all.

### 6.0.42 The comment pinning CI to macOS was false (`.github/workflows/release.yml`, 2026-09-13)

`runs-on` for the Verify job is **still `macos-latest`** (line 54), and that is
deliberate. What changed is the justification, which was untrue.

The old comment claimed the job covered the pointer helper's contract,
`screencapture`, and Guardian's telemetry on a real Mac. None of that holds. The
pointer contract tests drive a `/bin/sh` fake, `tests/assistant-server.test.mjs:137-213`.
The Guardian tests parse frozen captured strings. No test invokes
`screencapture` at all: the only occurrence anywhere under `tests/` is a comment
at `tests/agent-permissions.test.mjs:162`. And two platform assertions are
tautologies, comparing a reported platform to `process.platform` itself, which
holds on any runner: `tests/about.test.mjs:135` and `server/gateway.test.js:182`.

What is genuinely lost by moving is small and now stated as such. One real skip
guard, `tests/assistant-launch.test.mjs:373`, which reads the real
`/Applications`, and it is the only one of its kind across the 168 test files in
`studio/tests`. And `build:pointer` compiles the Swift source in this job rather
than later in the build matrix. The mechanical blockers are already cleared:
`build:pointer` is gated on `runner.os == 'macOS'` and `tests/bin-paths.test.mjs`
no longer hard-asserts a Homebrew path.

So the 10x macOS multiplier is payable and the move is one line. It waits on one
green `workflow_dispatch` rehearsal on Linux, because the suite has never run
there once and guessing is how a release breaks.

### 6.0.43 The acknowledgement's wake words were frozen at module load (`services/voice/acknowledgment.ts`, `components/chat/StudioChat.tsx`, 2026-09-13)

`acknowledgment.ts` built its list as
`const WAKE_WORDS = [...DEFAULT_VOICE_SETTINGS.wakeWords, "assistant"]` at module
load, so a wake word the operator added in Settings never reached it. The file's
own comment claimed this was "the real list, not a third copy". It was not. That
comment is corrected in place rather than deleted, because the claim is what
kept anyone from looking.

The list now arrives as an optional second parameter,
`getImmediateAcknowledgment(text, wakeWords?)`, matching the shape
`stripWakeWord(text, wakeWords)` in `addressing.ts` already uses. **Chosen over a
module-level setter deliberately**: a setter with no caller is the exact
wired-to-nothing failure the 2026-09-12 audit exists to prevent. The caller is
real, `StudioChat.tsx:392` passes `currentVoice.settings.wakeWords`, which it
already had in hand two lines above.

Three details in the compilation. Patterns are memoised on the joined list and
recompiled only when it changes, since this runs on every send. The alternation
is regex-escaped, which stopped being optional the moment operator input reached
it: a wake word containing "(" threw a `SyntaxError` on the chat's send path, and
`addressing.ts` escaped already while this file did not. And words are sorted
longest first, so "teminali" is not consumed as "temi" with a stray "nali" left
behind. The operator's list is MERGED on top of the built-ins rather than
replacing them, so the change can only add a match, never remove one.

**The bug was narrower than it looks, and that is the part worth recording.**
`hasActionWithTarget` reads `words[0]` or `words[1]`, so a single unknown leading
token still worked by luck: "jarvis, deploy the site" acknowledged before and
after. Add the politeness a person actually speaks with and the verb slides out
of reach. Measured both ways, three cases returned null before and return an
acknowledgement now: "jarvis can you fix the build", "jarvis please run the
tests", "jarvis could you deploy the site".

**Not fixed, and left alone on purpose:** a fourth hardcoded copy of the wake
words lives inside this same function, in the `opening` computation,
`.replace(/^(?:(?:temy|teminali|frontier|studio)\b[\s,]*)+/i, "")`. It does not
take the operator's list. It is mostly redundant now that the leading pattern
strips first, and changing it risks moving greeting classification during a
release. `tests/voice-ack.test.mjs` went from 7 to 10; each new test asserts the
pre-patch and post-patch behaviour side by side, so it carries its own mutation
check.

### 6.0.44 A delegated tool that failed rendered as a green completed step (`server/agent-cli.js`, 2026-09-13)

He asked the voice assistant to look something up. A bitcoin price came back
fast; "astral projection" failed twice, and both times the pane showed a tool
step that had finished, with nothing in it. No error, no query, no answer. The
transcript said the work was done.

`normaliseCodex` translates the CLI's item lifecycle into our tool events. Three
of its branches derived status from nothing at all. The unknown-item fallback was
the worst: `status: "completed"` hardcoded, no `isError`, and `input: {}`, which
blanks whatever the running event had already put on the step. `web_search` and
`file_change` ignored `item.error` the same way. Only `mcp_tool_call` read it, and
`command_execution` read only the exit code — so a command the sandbox refused,
which never runs and therefore reports no exit code, counted as a success.

The item's own failure is now read once, in `codexItemError(item)`, immediately
after `done`, and every branch derives its status from it. The CLI is not
consistent about the shape, a string on some item types and an object with a
message on others, so the helper takes either and the branches never see the
difference. The error text becomes the step's output, which is how the query's
actual failure reaches the operator instead of `null`.

The fallback also stops blanking the input. `codexItemInput` strips the envelope
keys and shows what is left, so an unfamiliar tool arrives carrying the URL or
query it was called with. **That is the half that made the bug invisible rather
than merely wrong**: a step with no input and no error is indistinguishable from
one that was never asked anything, and there was nothing on screen to suggest
looking further.

`tests/agent-cli.test.mjs` went from 36 to 41. Each of the five was run against
the pre-fix file and fails there, so they are regression tests rather than
descriptions of current behaviour.

**The green pill was the smaller half.** `teminaliAgentBridge.ts:456` counts
failures with `if (call.status === "error") failureCount++`, and lines 621-643
turn that count into the turn's outcome. With the status hardcoded to
`"completed"`, `failureCount` stayed 0 through a failed lookup, so the turn was
recorded `status: "success"` and narrated as "Finished". **The voice assistant
reported success on work that had failed, which is why he got no result and no
sign that anything had gone wrong.** Nothing was needed on the voice side; it was
reading a status the translator was fabricating.

**WebFetch is not ours.** He saw the name because Claude Code ships that tool;
we ship no such thing, in `studio/src`, `studio/server`, any runtime, or the
gateway. The bug was never in a tool we own, it was in how we rendered one we do
not.

### 6.0.45 The audit log recorded how long a turn took, never which part of it (`server/audit-log.js`, `server/gateway.js`, `server/agent-cli.js`, 2026-09-13)

Measured over every `agent-turn` line in his own
`~/Library/Application Support/Teminali OS/gateway/gateway-audit.jsonl`, not a
tail of it:

| Day | n | min | median | p90 | max |
| --- | --- | --- | --- | --- | --- |
| 2026-09-06 | 16 | 5.0s | 19.0s | 160.1s | 167.3s |
| 2026-09-07 | 10 | 5.7s | 14.5s | 26.2s | 36.9s |
| 2026-09-12 | 18 | 7.5s | 29.6s | 54.6s | 77.1s |

**The handover into this session quoted n=7, median 47s, p90 62s for 2026-09-12.
That was the last seven lines of the file, not the day.** The real median is
29.6s over 18 turns. The conclusion it was drawing survives the correction and
is worth keeping: reclaiming the Gemini VAD's 1800ms silence window is 6% of a
29.6 second turn, so it is not where a release goes. But the number was wrong,
and the log could not have settled it either way, because `durationMs` was the
only number in it.

**`server/audit-log.js` holds a `SAFE_FIELDS` allowlist, applied on the way to
disk, and it was silently eating four fields the route already passed.**
`/api/agents/run` has written `engine`, `truncated`, `reason` and `promptBytes`
since 1.1.0 (`6319f9f`, 2026-09-02) and not one reached the file. The allowlist
already carried a comment reading "Settings changes already passed these two and
had them silently dropped", so this is the second time. The drop is intentional
design — an audit log must not persist a field nobody vetted — but it is silent,
and silence is what cost eleven days of turns.

Nothing in `server/gateway.test.js` could have caught it. Its `MemoryAudit`
double keeps whatever it is handed and never sanitizes, so every field looked
recorded from the test's side. The new test writes through a real
`BoundedAuditLog` and parses the line back off disk, and asserts in the same
breath that a `prompt` field passed alongside is still absent.

Five new fields split the duration, stamped in the one funnel every event
already passes through so no call site can forget:

| Field | What it measures |
| --- | --- |
| `preflightMs` | The gateway's own work before the spawn. `durationMs` never covered it: that clock starts inside `runAgentTurn`. Reading the body, validating it, writing attachments, and the `assistantCapabilities()` call that asks macOS about Accessibility per turn all land here. |
| `startupMs` | Spawn to the CLI's first line of stdout. Its own cold start: node boot, config, MCP connections. |
| `firstTokenMs` | Spawn to the first token or reasoning text. |
| `toolMs` / `toolCalls` | Time inside tools, over how many. |

A tool is reported twice, running then settled, and `toolMs` pairs them by id. A
step that only ever arrives settled — an edit replayed from the watcher — has no
start to subtract, so it counts as neither a call nor a duration rather than as
one that took the whole turn. `tests/agent-cli.test.mjs` asserts that case
directly; without it the obvious implementation charges an orphan the entire
elapsed time and the number reads plausibly.

**This measures; it does not yet fix.** No latency was removed here. The next
turn on the installed build writes a line that says which phase owns those
seconds, and that is the input the fix needs. Do not spend a release on the VAD
before reading one.

#### 6.0.46 The end of his turn is ours to call (2026-09-13)

The live lane opened its session with
`automaticActivityDetection: { silenceDurationMs: 1800 }`, so Google decided he
had stopped talking 1.8 seconds after he had. An earlier note here said that
was under 4% of a turn and not worth a release. That divided it into an *agent*
turn of 47 seconds, which was itself a bad number — the tail of an audit file
rather than the file. His conversational turn is a little over three seconds,
and against that the constant was about half the wait.

It is now ours. `realtimeInputConfig.automaticActivityDetection` is
`{ disabled: true }` and `sendAudioChunk` brackets his speech itself, sending
`activityStart` when he begins and `activityEnd` when the endpointer says he has
finished. The window is no longer flat: it is sized between
`minSilenceMs` 600 and `maxSilenceMs` 1800 by how finished the sentence sounds,
from the live transcript and from prosody, and it learns his own pause rhythm as
it goes.

Almost none of that is new code. `voiceActivity.ts` and the `Endpointer` in
`turnTaking.ts` have run the dictation lane for releases; they were simply
unreachable from here, because the chain they hang off (`audioGraph.ts` ->
`conversation.ts`) needs an AudioContext and is not mounted on Temi's lane. The
only missing piece was PCM to the five numbers `isVoicedFrame` judges, which is
`micEndpoint.ts`: a 512-sample window on a 320-sample hop, 32 ms every 20 ms,
the same geometry the graph runs at 48 kHz, with the same magnitude-weighted
centroid and the same adaptive noise floor. `NoiseFloor` moved out of
`audioGraph.ts` into `voiceActivity.ts` and the repo's one FFT is now exported
from `speakerProfile.ts`, so neither exists twice.

**Measured, not argued.** `studio/src/services/voice/geminiLiveEngine.ts`
contained no `Date.now()` at all before this: the thing he complained about was
the one thing nothing measured, and two successive opinions about its cause were
wrong. It now carries four stamps — his last voiced frame, our `activityEnd`,
her first content, her first audio — reported on `onTiming`. A harness plays a
recorded utterance into a real session at real time and reads the clock; run as
four alternating pairs against a worktree at the previous commit, first audio
came back at a median of 4586 ms before and 3594 ms after, **993 ms sooner**,
with every run of the new path beating every run of the old one. Our own commit
is steady at ~1198 ms against Google's effective ~2200 ms, and the window sized
itself to 976 or 1216 ms across those runs rather than sitting at the ceiling.

Three things this costs, each answered in code rather than hoped about:

- **Server-side interrupt stops firing.** `serverContent.interrupted` was
  Google's, and disabling detection takes it away. `speech-start` therefore
  sends `activityStart`, and the default `START_OF_ACTIVITY_INTERRUPTS` is what
  still cuts her off when he talks over her.
- **The onset would be lost.** The detector cannot call `speech-start` until it
  has heard three voiced frames, so the audio containing his first word would
  fall outside the bracket. Chunks are held in a prebuffer of eight (340 ms) and
  flushed in order immediately after `activityStart`.
- **A turn could never end.** Google always closed one eventually; a detector
  that never fires would hang forever. `endpointStall` closes the bracket at the
  15-second ceiling the dictation lane uses, with a spoken note.

Her own voice cannot open a turn: the mic batch header carries an
`isTTSPlaying` flag set at capture time, which `sendAudioChunk` reads for the
`ducked` state — per frame, which a start/stop callback can never be.

#### 6.0.47 The stopwatch nobody read, and the mistakes nobody counted (2026-09-13)

§6.0.46 moved the end of his turn into our code and measured what that was
worth: 993 ms off the median wait, over four alternating pairs against the live
model. Four scripted utterances. `geminiLiveEngine.ts` emitted a `TurnTiming`
for every turn after it and nothing consumed one, so the only latency anyone
could quote was still the recording the A/B was run on.

`turnLatency.ts` is where they land now. `TemiVoiceStage` records each turn and
logs one line: this turn, then the session so far. The median is computed the
way the A/B reported it, averaging the two middle values on an even count, so
the number from a real conversation is comparable with the 3594 ms in the table
above rather than merely similar to it. The line splits the wait into the part
this lane owns and the part that is Gemini's, because since 6.0.46 the second
is roughly twice the first and that is the argument against spending another
release on endpointing.

The counting matters more than the timing. A faster endpoint is only an
improvement if it is still right about when he stopped, and being wrong is
invisible from the outside: the endpointer reports a `speech-start` within
`resumeWindowMs` of an endpoint it already fired as `resumedAfterEndpoint`, the
engine reopens the bracket, and the turn carries on. The recovery works, which
is exactly the problem. A recovery nobody counts looks identical to a turn that
was never cut. `TurnTiming` therefore carries `corrections` and `cutGapMs`
alongside the four stamps, and a cut turn prints CUT rather than a clean wait.
`cutGapMs` is the tightest silence we were wrong about, which is the difference
between clipping a trailing pause and interrupting him mid-sentence.

Both counters belong to the turn and clear when her audio lands. The pacing
floor deliberately does not: it is a fact about him, not about the turn, and
§6.15 already learns it.

Read over CDP as `teminaliTurnLatency()`, which is its own global rather than a
field on `window.teminali`: preload defines that one through `contextBridge`
and the renderer cannot assign to it.

Not measured here, and deliberately: this is the instrument, and the
distribution it produces is the measurement. Nothing in this entry claims a
number from a real conversation, because none has been recorded yet.


#### 6.0.48 A room can hold three (`services/voice/addressing.ts`, `services/voice/temiPersona.ts`, `server/agent-cli.js`, 2026-09-13)

The operator ran a three-way spoken conversation: himself, Temi, and ChatGPT's
voice assistant on another device, one microphone between them. She held up on
raw intelligence. Every defence she has for deciding whether a turn is hers
turned out to answer a different question than the one that room asks.

The defences on this lane ask either "did WE make this sound" or "is this OUR
text". `ducked` is our own playback flag (`audioGraph.ts:76`), `selfAudio`
enumerates our own media elements, `isAssistantDirectiveEcho` matches our own
words. A second device answers no to all three, so a sentence spoken to ChatGPT
arrived looking exactly like a sentence spoken to her. The four who-is-this
layers that would have helped, speaker enrolment, echo guard, plausibility and
an LLM addressee tiebreak, exist only in `conversation.ts`, which is not mounted
on her lane.

Three changes, all of them about who is being spoken to rather than what was
said.

**Being named is now a signal in both directions.** Her own name was worth 0.5
toward "this is for you" and nothing anywhere made her stand down, so "ChatGPT,
what do you think" scored like any other sentence and, against a 0.62 line
reachable by a 0.34 base plus a 0.30 open-session bonus, every two-word sentence
in that room was hers. `addressesOtherAssistant()` vetoes the turn when another
assistant is named in vocative position (`addressing.ts:326-342`), a veto rather
than a weight because being called by name is the one signal that settles a
room. Vocative position only: "ChatGPT is down again" is the operator talking to
her about it, and answering that with silence would be the same mistake pointing
the other way. Her own name still wins the tie, so "Temi, ask ChatGPT what it
thinks" stays hers.

**A mention is no longer rewritten into a command.** `stripWakeWord` took any
leading "Temi " as an address, so "Temi said the build is broken", said to the
other person in the room, reached the lane as the instruction "said the build is
broken" carrying the full 0.5 for being addressed by name. A leading name
followed only by a report verb is now a mention and the turn is left alone
(`addressing.ts:175`, and `:185` for the trailing form). Deliberately report verbs only: "Temi can you hear
me" and "Temi is that you" are addresses, so admitting a copula or a modal here
would cost her real turns, and ignoring the operator is worse than answering a
mention. The same test runs on the trailing form, where a comma is what
separates "open the file, Temi" from "let's ask Temi".

**And she is told the room can hold three** (`temiPersona.ts:103-108`): that a
sentence about her is not a sentence to her, that a sentence naming another
assistant is theirs and is not to be answered or remarked on, and that when she
cannot tell, waiting a beat beats answering, because in a room where two
assistants are listening the fast one is the rude one.

Separately, and found while reading her identity aloud in that conversation:
`AGENT_IDENTITY` told the typed agent it was "the assistant inside Teminali
Code" (`agent-cli.js:273`), a name this repo's working agreement retired at the
0.0.1 reset, sitting live in a shipped prompt. It also left her denying she can
sing. She has a voice; the denial was the typed lane answering for the spoken
one. Both fixed in the same line, which `voice-identity.test.mjs:45` still holds
under 600 characters.

Covered by `voice-addressing-room.test.mjs`, 7 tests. Measured after the
change: studio **2822/2822**, 0 skips, `tsc --noEmit` clean, `npm run build`
exit 0.


#### 6.0.49 One reply, on screen twice, again (`services/voice/geminiLiveEngine.ts`, `services/voice/captionPacer.ts`, `components/voice/TemiVoiceStage.tsx`, 2026-09-13)

A reply reached the transcript as two identical committed rows, each with its
own action bar. Reported as intermittent, and it is: it needs a barge-in on an
earlier turn.

`captionPacer.ts:85` already refuses to reveal a turn that has been committed,
and that guard was added for this exact symptom on 2026-09-12. The duplicate
came back through the other door. `revealAll()` did not carry the guard, and
`revealAll()` is what the normal commit path calls.

The chain, three links, all of them now cut.

**The engine kept a dead turn's words.** `interrupted` drops the queued audio
and returns (`geminiLiveEngine.ts:1001-1019`); nothing but `turnComplete`
clears `outputTranscript` (`:1167`). So the cut turn's text stayed in the
accumulator and was delivered on the NEXT turn's `turnComplete` as that turn's
`final_assistant_answer`. It is cleared on interrupt now, for the same reason
the audio is: what she generated but never said belongs to a sentence he
stopped waiting for.

**The stage could not commit what it was then holding.** That stale answer set
`pendingFinalRef`, and nothing could retire it: `advanceTo` returns "" on a
closed pacer, and the 2500 ms fallback requires that no audio has played. It
sat there until the next turn reopened the pacer and zeroed the play clock, at
which point `onTTSProgress`'s `shown.length >= pending.length`
(`TemiVoiceStage.tsx:836`) compared the live turn's revealed prefix against the
stale turn's length, passed early, and committed the live turn through
`revealAll()`, which returns everything generated rather than everything
spoken. The live turn's own `final_assistant_answer` then committed the same
string again.

**And `revealAll()` now carries the guard `advanceTo` has**
(`captionPacer.ts:102-107`), so a committed turn cannot be offered for
committing twice however it is reached. Its caller no longer appends an empty
row when it declines (`TemiVoiceStage.tsx:361-371`).

The root cause is the first link; the other two are the containment that should
have made it a missing caption rather than a duplicated one. Covered by
`voice-live-engine-generation.test.mjs` (an interrupted turn's words are not
the next turn's answer, and are not answered later on their own) and
`caption-pacer.test.mjs` (a committed turn is never revealed a second time).

#### 6.0.50 She reached for the hands when she had only misheard (`services/voice/geminiLiveEngine.ts`, `services/voice/temiPersona.ts`, 2026-09-13)

From the same three-way conversation: she delegates when she does not
understand. His rule, verbatim, is that she should "only use tools when it
knows for sure for the task i need tools or the other assistant".

Two inputs made not understanding a reason to call. The declaration closed with
"When in any doubt, call this", which is the widest sentence in the prompt and
contains every kind of doubt there is, including doubt about what he meant. The
persona sent her to the assistant for "something about a subject you have never
studied", which in a conversation is most subjects.

Both are now bounded rather than removed, because what they were written for is
real: §6.0.x records fabricated sizes and a fabricated provenance defending
them. The anti-fabrication rules are untouched and pinned by test. What is
added is the other half, which was never stated: the assistant cannot hear this
conversation, so it can neither explain the operator to her nor take a turn of
talk off her hands. Not understanding is a reason to ask HIM. Talk, an opinion,
a joke, a song, an argument about which assistant is better, a question about
herself: those are hers, and she answers them even when unsure, saying she is
unsure. An explicit request for the assistant is still always reason enough.

A finding on the way to this, which changes where the next fix goes: the
screenshot behind the report showed "Bringing it up." and that line is
hardcoded (`machineAction.ts:648`). `acknowledgeAction` is called only from
`voiceTurnRouter.ts:582` and `:662`, never from the model's tool path, so on
that turn the LEGACY REGEX ROUTER delegated before she ever saw the sentence.
The model-side rules above are still worth narrowing and were the fix he asked
for, but the router is a separate over-trigger on the same complaint. Measured
against it, ordinary talk holds: fourteen conversational lines from that room,
"who do you think would win between you and chatgpt" among them, all route to
`converse`. What trips it is an object it recognises, "bring up the teminali
workspace" or "how big is this project", which are fair delegations. The
sentence that actually misfired is not yet known, and narrowing the router
without it would be guesswork.

Covered by `voice-handoff.test.mjs`, two tests pinning the boundary in both
prompts and pinning that the fabrication rule survived it.


#### 6.0.51 Every address was given less time than its handshake takes (`electron/addressAttempts.cjs`, `electron/main.cjs`, `server/gateway.js`, 2026-09-13)

On the operator's network the installed v0.0.14 said *"Temi's voice hit an error:
mint-failed: Google refused to mint a Live token: fetch failed"*. Google refused
nothing. The token request never left the Electron main process.

Electron 44 runs Node 24.19, and Node gives each address a host resolves to
`net.getDefaultAutoSelectFamilyAttemptTimeout()` milliseconds to finish its TCP
handshake before abandoning it for the next. In Node 24 that is **250 ms**; in
Node 26 it is 500. An abandoned attempt does not keep racing, so the figure is a
deadline, not a head start. Measured on that network:

| | measured |
| --- | --- |
| IPv4 TCP handshake, 80 connects | min 296 ms, p50 298, max 381 |
| IPv6 connect | `EHOSTUNREACH` in 0 to 4 ms: no route |
| `generativelanguage.googleapis.com` resolves to | 8 IPv4, 8 IPv6 |
| fetch it from Electron main, deadline 250 | `fetch failed`, `AggregateError`/`ETIMEDOUT`, 2339 ms |
| mint a Live token from Electron main, deadline 250 | `fetch failed`, 2091 ms |
| mint a Live token from Electron main, deadline 1000 | token minted, 718 ms |
| `api.github.com`, one IPv4 address and no IPv6, deadline 250 | 200 |

Every IPv4 attempt was cut off before its handshake could finish and every IPv6
attempt was refused at once, so a host with both families could not be reached at
all. `api.github.com` connected under the same deadline, which is what made this
look like an IPv6 fault, and plain Node 26 minted a token with the same key.

`dns.setDefaultResultOrder("ipv4first")` was tried and does not help. The
addresses already came back IPv4 first; ordering was never the problem.

`electron/addressAttempts.cjs` raises the deadline to a floor of **1000 ms** and
never lowers one already above it. `electron/main.cjs` applies it at load, before
the gateway is imported, so it holds for every Node-side connection in the main
process: the mint, the provider calls, the update check. The voice sidecar is a
separate Node started from `process.execPath`, with the 250 ms default and a
first-run model download, so it is spawned with the same deadline as
`--network-family-autoselection-attempt-timeout`. Renderer traffic, the Live
socket included, goes through Chromium's network stack, which this setting does
not touch.

The floor is 1000 rather than Node 26's 500 because a deadline below the handshake
does not slow a connection, it kills it, and 500 is 1.3 times the slowest handshake
measured. The cost is reasoned from Node's documented behaviour, not measured: on a
network whose first listed address drops packets without answering, each new
connection waits the full second before the next address is tried.

The mint's own sentence changed in the same release (`server/gateway.js`). A
transport failure was reported as "Google refused to mint a Live token: fetch
failed"; it is now reported as a request that never reached Google, naming the
error codes found in `error.cause`. The reason stays `mint-failed`, so the renderer
and the route's enum are unchanged.

`tests/address-attempts.test.mjs` cannot reproduce the failure, because loopback
has no slow handshake and no unroutable IPv6. It asserts the floor arithmetic,
hands the flag to a real Node to prove Node accepts it (a misspelt flag exits with
"bad option" and the sidecar would never start), and reads both call sites from
`main.cjs`. The failure is reproduced by fetching a dual-stack host under
`ELECTRON_RUN_AS_NODE=1 electron`, and that probe passes on a network with working
IPv6 whatever the code does: check `curl -6` before trusting a green one.

#### 6.0.52 "Make it sound more like singing" was filed as an edit (`services/voice/machineAction.ts`, 2026-09-13)

Spoken, read back from the persisted transcript: the operator asked *"Can you sing
a song about Margaret, a love song about Margaret, song?"* and she sang. The next
turn was *"Hey, hey, that sounds like talking. Can you make it sound more like
singing?"*. The operator heard "On it.", and the text assistant answered *"anything
I sing lands as text"*. After that she told them twice that she cannot sing aloud,
repeating the report she had been handed.

The delegation was not her `ask_the_assistant` tool. It was the `machineAction.ts`
fast path: `make` is an edit verb, and "it" directly behind it satisfies
`PRONOUN_OBJECT`, so the turn classified `edit` and "On it." is that kind's
acknowledgement. v0.0.16 did not cause it. The file last changed on 2026-09-12,
and the sentence classifies `edit` on either side of the release.

`PRONOUN_DELIVERY` now rejects the pronoun as an object when causative `make` is
followed by a verb of perception (`sound`, `feel`, `seem`). In that construction
the pronoun is how she is speaking, which no agent behind her can change. The
exception covers `make` only, because "play that sound" uses *sound* as a noun. A
machine noun in the clause still wins, so "make the error message sound
friendlier" is still an edit. `tests/machine-action.test.mjs` holds the spoken
sentence verbatim beside those counter-cases.

#### 6.0.53 Ambient room noise triggered watchdog stall loops and "[noise]" transcriptions (`services/voice/voiceActivity.ts`, `services/voice/micEndpoint.ts`, `services/voice/geminiLiveEngine.ts`, 2026-09-13)

The voice stage displayed an error banner repeatedly: *"I could not tell when you
stopped, so I took the turn. Say that again if I cut you off."* Temi was no
longer responding smoothly, turns stalled for 15 s, and the stage intermittently
displayed `"noice"` or `"[noise]"` during background silence.

Four compounding faults caused the stall loop:

1. **Deadlocked noise floor.** `NoiseFloor` started at `0.004` and refused to
   update whenever `voiced` was true. Because `isVoicedFrame` treats RMS > `floor × 2.8`
   (0.0112) as loud speech, room noise (RMS ~0.016, e.g. fans or air conditioning)
   was classified as `voiced` from frame 1. The floor never adapted to the room,
   trapping the detector in perpetual speech.
2. **Pacing ceiling escalation.** With room noise seen as speech, `silenceRun`
   reset continuously. Any transient dip treated as a pause caused `learnPause` to
   raise `pacingFloorMs` to its 2000 ms ceiling. Because unbroken silence never
   reached 2000 ms, `guardAgainstEndlessTurn()` fired at 15 s (`MAX_UTTERANCE_MS`).
3. **Refractory loop.** On stall, `endpointer.reset()` did not clear the learned
   pacing floor and enforced no cooldown. Within 60 ms, room noise re-triggered
   `speech-start`, opened `activityStart`, and immediately cut off Gemini's
   spoken reply (`START_OF_ACTIVITY_INTERRUPTS`), looping every 15 seconds.
4. **Non-speech tag leak.** While streaming 15 seconds of background noise to
   Gemini Live, the server returned acoustic descriptors (`[noise]`, `(noise)`,
   `noice`). These were emitted as `partial_user_request` and `final_user_request`,
   causing `gateSpokenTurn` to fail and barge-in to silence Temi's audio.

The repairs:

- **Adaptive rolling minimum noise floor (`voiceActivity.ts`).** `NoiseFloor` now
  tracks minimum statistics over a 75-frame (1.5 s) circular buffer with a
  10-frame fast bootstrap on startup. Speech dips during consonant closures and
  pauses while stationary room noise sits at the minimum. The floor adapts upward
  to room noise (e.g. 0.016) so `isVoicedFrame` reliably identifies silence.
- **Pacing recovery and refractory cooldown (`micEndpoint.ts`, `geminiLiveEngine.ts`).**
  `MicEndpointer.forgetPacing()` clears `pacingFloorMs` on watchdog stall.
  `guardAgainstEndlessTurn()` enforces an 800 ms `stallCooldownUntil` refractory
  window so room noise cannot immediately reopen the activity bracket, and only
  emits `ENDPOINT_STALL_NOTE` if actual user speech was transcribed.
- **Non-speech tag filtering (`geminiLiveEngine.ts`).** `withoutNonSpeechTags()`
  strips bracketed tags (`[...]`, `<...>`, `(...)`, `*...*`) and bare acoustic
  noise tokens (`noise`, `noice`, `background noise`).
- **End-to-end full experience battle test (`tests/voice-full-experience-battle.test.mjs`).**
  Exercises the full 48 kHz WebAudio batch -> downsample -> MicEndpointer -> GeminiLiveEngine
  -> transcription -> watchdog recovery -> ducking / barge-in -> multi-turn flow.
  Paired with `tests/voice-noise-tag.test.mjs`.

#### 6.0.54 "How does that all work?" was delegated to the workspace assistant and conversational reasoning was suppressed (`services/voice/machineAction.ts`, `services/voice/temiPersona.ts`, `services/voice/geminiLiveEngine.ts`, 2026-09-13)

When the operator asked conversational questions like *"How does that all work? How am
I talking to you right now?"* or *"Why are you checking for that?"*, Temi responded
*"Checking now."* and handed off the prompt to Claude Code in the workspace, which
began scanning repository files on disk. Furthermore, when the operator told Temi
*"Do not use the other assistants"*, she ignored or deflected the request, claiming
it was "protocol" or that she was not permitted to answer directly.

Three compounding issues caused this breakdown in reasoning and conversational flow:

1. **Regex over-match on `work` (`machineAction.ts`).**
   `STATE_QUESTIONS` matched `\b(did|has|have|does|do)\b[^?.]{0,60}?\b(finish|...|work|worked)\b/i`.
   Combined with `PRONOUN_ANYWHERE` matching *"that"* or *"this"*, *"How does that
   all work?"* was classified by regex as `{ kind: 'inspect', reason: 'a question
   about machine state — does that all work' }`. In `voiceTurnRouter.ts`, this emitted
   `acknowledgeAction("inspect")` (*"Checking now."*), silenced Gemini Live, and
   delegated the turn to the workspace coding agent (`TeminaliAgentBridge.delegateTask`).
2. **Persona intimidation and self-suppression (`temiPersona.ts`).**
   The prompt told Temi: *"The assistant is more capable than you are and knows things
   you do not... the moment you are about to say something specific nobody told you,
   ask it instead... Guessing costs you the call."* This caused Gemini Live to suppress
   its own reasoning, technical understanding, and explanations, treating any general
   question as a cue to invoke `ask_the_assistant`.
3. **Suppression on mentions of "assistants" (`temiPersona.ts`).**
   Under `WHO IS IN THE ROOM`, the instruction *"If a sentence names another assistant,
   it is theirs. Do not answer it"* triggered whenever the operator said *"Do not use
   the other assistants"* or *"Stop using other assistants"*. The word *"assistants"*
   caused Temi to treat the sentence as belonging to another assistant, causing her
   to ignore the operator or justify it as an unchangeable protocol.

The repairs:

- **Explanatory patterns in `OPINION_FRAMES` (`machineAction.ts`).**
  `OPINION_FRAMES` now captures explanatory queries (`how does/do/am/are/can/could...
  work/talk/function`, `why are you checking/looking/reading`, `explain how/why/what`)
  and explicit negative delegation directives (`do not/don't/never/stop use/call/reach
  for other assistants/agents/tools`, `just talk/speak/answer to me directly/yourself`).
  These match early and evaluate to `null` (`CONVERSE`), ensuring they are handled
  directly by voice conversation rather than being intercepted as machine actions.
- **Restoring Temi's reasoning autonomy and obedience (`temiPersona.ts`).**
  `TEMI_PERSONA` now explicitly states that Temi has full technical understanding of
  the stack, architecture, and concepts, and reasons for herself. The background
  assistant is strictly for physical filesystem and workspace modifications. Crucially:
  *"If the operator tells you NOT to use the assistant, to answer yourself, or to just
  talk, OBEY THEM. Never claim it is 'protocol' or that you cannot answer. Answer
  directly using your own reasoning."* `WHO IS IN THE ROOM` was refined so that only
  direct wake-name addresses to other devices ("Hey Siri", "Alexa") are left alone,
  while conversations or instructions about assistants are answered directly.
- **Clarifying tool description (`geminiLiveEngine.ts`).**
  The `ASK_THE_ASSISTANT` declaration description now explicitly forbids calling the
  assistant for conceptual questions, system explanations, or when the operator has
  instructed Temi to speak or answer directly.
- **Delegation safety regression suite (`tests/voice-delegation-safety.test.mjs`).**
  Expanded `MUST_NOT_DELEGATE` with *"Do not use the other assistants."*, *"How does
  that all work? How am I talking to you right now?"*, *"How does this work?"*, and
  *"Why are you checking for that?"*. All pass as `null` (CONVERSE).

#### 6.0.55 Low latency, ambient noise rejection, and speech ignore prevention (`services/voice/voiceActivity.ts`, `services/voice/turnTaking.ts`, `services/voice/geminiLiveEngine.ts`, 2026-09-13)

When operating in environments with stationary background sounds (fans, air conditioning,
ambient hum) or low-level speaker bleed, the operator observed severe latency (seconds of
dead silence before responses or getting stuck in the `THINKING` state) and reported that
Temi frequently got interrupted by ambient sounds and ended up ignoring their speech entirely.

Investigation traced this behavior to three interlocking failures:

1. **Missing Energy Gate on Pitch (`services/voice/voiceActivity.ts`).**
   The periodic pitch detector checked whether fundamental frequency fell within human range
   (`f0 >= 80 && f0 <= 420`) and met clarity criteria, but returned `periodic` without verifying
   that frame RMS exceeded `pitchFloor`. Consequently, low-level room noise (120/240 Hz hum,
   fan vibration, AC whir) at RMS 0.003–0.015 was flagged as `voiced`.
2. **Post-Commit Turn Abort Loop (`services/voice/geminiLiveEngine.ts`).**
   When the operator stopped speaking, `closeActivity` committed the utterance and sent `activityEnd`
   to Gemini Live. While Gemini was preparing the audio stream (typically 200–500 ms latency), the
   operator took a natural breath, or quiet room noise produced a periodic frame. Because `isVoicedFrame`
   called it voiced, `speech-start` immediately fired and `openActivity` sent `activityStart` to Gemini.
   In the Gemini Live bidirectional protocol, `activityStart` aborts any in-flight response generation.
   The noisy or breath turn then ended with zero speech, Gemini responded with nothing, and the operator's
   original utterance was completely ignored.
3. **Endpointer Pacing Inflation and Slow Decay (`services/voice/turnTaking.ts`).**
   When silence between phrases or at turn end was interrupted by false voiced frames, `learnPause`
   treated the gap as a speaker pause and raised `pacing` to `pacingCeilingMs` (2000 ms). With
   `PACING_RELAX = 0.95`, it took over 20 clean turns to decay back to the 600 ms floor, forcing the
   operator to endure two full seconds of dead silence on every subsequent turn.

The fixes:
- **Restored Pitch Energy Gate and Ducked Rejection (`voiceActivity.ts`).**
  `pitchFloor` is strictly enforced: `ducked ? Math.max(noiseFloor * 2.8, 0.02) : Math.max(noiseFloor * 1.6, 0.009)`.
  A frame is voiced only if `(periodic && rms > pitchFloor) || loud`. Ducked rejection at 0.02 rejects
  speaker bleed while allowing deliberate barge-in (RMS > 0.025). `NoiseFloor.update` skips learning
  when `voiced` or `ducked`, tracking room silence via a 1.5 s rolling window minimum without
  contamination from playback bleed or user speech.
- **Pacing Ceiling, Decisive Decay, and Spike Filter (`turnTaking.ts`).**
  `pacingCeilingMs` is capped at 1800 ms (matching `maxSilenceMs`), `resumeWindowMs` is tuned to 1000 ms,
  and `PACING_RELAX` is accelerated to `0.85`, easing pacing back to the responsive baseline in 3–4 turns.
  During noticeable pauses (`PAUSE_NOTICE_MS: 120 ms`), single-frame noise spikes no longer reset the
  silence run or inflate pacing without confirmed continuation (`resumeRun >= 2`).
- **Clean Endpointer State & Timestamps (`geminiLiveEngine.ts`).**
  `guardAgainstEndlessTurn` passes simulation timestamps `(now, now)` to `closeActivity`.
- **Battle Suite Verification (`tests/voice-full-experience-battle.test.mjs`).**
  Six deterministic battle tests cover fan noise rejection (RMS 0.016), thinking pause recovery,
  `[noise]` tag suppression, watchdog stall cooldown and pacing reset, speaker bleed rejection vs. barge-in,
  and multi-turn flow. Full studio suite passes with 2911/2911 tests.


### 6.1 Turn semantics while a run is in flight (2026-09-05)

A directed utterance is not automatically an instruction. `turnIntent.ts`
reads each committed turn against the state of the work — rules only, no model —
and `conversation.ts#commitTurn` acts on the verdict:

| Heard while busy | Intent | What happens |
| --- | --- | --- |
| "excellent, keep going", "sawa endelea" | `acknowledge` | Nothing is cancelled. If the assistant was mid-sentence it finishes the sentence; otherwise it says "Still on it." at most once per 20 s. |
| "how's it going?", "is it live yet?", "did the tests pass?" | `status` | Answered from the live run via `VoiceHost.progressSummary` (`progressNarration.ts#summariseProgress`), then whatever was being said resumes. The run is untouched. |
| "stop", "wait, hold on", "never mind" | `stop` | Speech is dropped and the run is aborted; "Okay, stopped." only if a run was actually cancelled. "Stop the server" is an instruction, not a stop. Acted on before the endpointer commits the turn — see §6.8. |
| anything else | `instruction` | The previous behaviour: the run is aborted and the utterance is sent. |

With nothing running, `acknowledge` and `status` are instructions — "yes" is
the answer to a question, "how's it going" is a greeting — so they reach the
chat. `host.interrupt` is called only when a run or speech was actually in
flight; before this it fired on every directed turn.

**Self-echo guard.** The built-in recogniser hears the speakers. `echoGuard.ts`
remembers every line the synthesiser plays for 25 s and strips a transcript
that is mostly those content words: 60 % overlap while speaking, 75 % in the
1.6 s tail after it stops, and only a six-word verbatim run once quiet — so a
person answering "run the tests" to "should I run the tests?" gets through. A
leading echoed run of three or more words followed by new speech keeps the new
speech. Applied per recogniser result and once more on the assembled turn.

**Self-audio guard.** The other half, which nothing textual can catch: the
Files panel plays video and audio and the Browser panel loads pages that do,
and a film's dialogue is real speech that no gate below the recogniser can tell
from an operator. `selfAudio.ts` tracks whether the app is making sound, and
while it is, a turn needs a wake word to be taken and our own playback cannot
barge in. See §6.17.

**Running commentary.** `StudioChat` feeds every tool call through
`describeToolCall` into `VoiceEngine.noteProgress`. The line always reaches the
HUD caption under the orb; it is spoken only when nothing else is queued, a run
is actually busy, not within 2.5 s of the operator's own turn, and at most
every 9 s. Test and build commands also narrate their outcome ("Tests passed.").
`narrateProgress` turns the spoken part off; the caption stays.

**Spoken digest.** The streaming reader speaks the first three sentences of a
reply as they arrive, then holds the rest. On completion a remainder of up to
320 characters is read verbatim; anything longer becomes a two-sentence spoken
summary from the Flash lane, spoken sentence by sentence as the model produces
it (`spokenDigest.ts#DigestStream`; first-sentence fallback: "… The rest is
in the chat."). The request is the digest's own lean lane
(`FrontierEngine.streamDigest`, `frontierEngine.ts`): the digest prompt alone
on the Flash model with the reply lane's `num_ctx`, `num_predict` 80, and no
model unload on abort. That unload is why the old flat 7 s cap was hit on
every long reply: `streamFromOllama` evicts the model when aborted, so each
miss made the next digest start from a cold load (17.3 s measured), and the
digest went through the full agent system prompt. Measured 2026-09-05 on
`frontier-qwen2.5-coder-14b-8k` (loaded, prompt not prefix-cached): a
3,531-character prompt took 6.9–8.7 s of prompt evaluation before the first
token; a 1,531-character one 2.6 s, first sentence complete at 4.0 s;
generation 24–38 tokens in 1.8–3.2 s; a `num_ctx` change 1.5–2.4 s of reload.
So the model is shown at most 1,200 characters — the first 900 and the last
300, code fences replaced by "(code)" — and the only timed wait is for the
first sentence: `digestBudgetMs` = 2.5 s + 4 ms per character shown (7.3 s at
the cap). Once a sentence is being spoken, a 4 s gap between tokens ends the
digest with what was said; two sentences or 400 characters stop the request.
`summariseLongReplies` turns this off and reads everything. The settle effect
no longer re-reads a reply the streaming path already spoke. While the first
sentence is being made the orb shows *thinking* (`VoiceEngine.noteDigesting`),
not a silent *speaking*, captioned "Summing up the reply."; the first digest
sentence puts it back to *speaking*, and an empty digest returns it to
*listening*. The final chunk also clears `narration`, so the run's last step
line ("Reading types dot ts") does not caption the reply being read — the
reply is in the chat and needs no caption.

**A labelled list is spoken as its labels.** `speakable.ts` collapses a run of
list items into their labels alone when every item has one — a bold lead-in, or
a short prefix before a colon. "Video Editing: you can use tools like
describe_timeline, patch_clip and set_effect_param…" five times over is a
paragraph of identifiers nobody can follow by ear, and the full text is in the
chat. Spoken as "Video Editing, Media Management, Captions and Subtitles,
Workspace Commands and File Editing" it is a list the operator can hold in
their head, and the reply drops under `VERBATIM_LIMIT_CHARS` so it is read out
rather than sent to the digest at all. A run with even one unlabelled item is
read in full: the labels would not then be a faithful index of it. Tests:
`tests/voice.test.mjs`.

**Pace.** `DEFAULT_VOICE_SETTINGS.ttsRate` is 1.15 (was 1.02 until
2026-09-05; a saved 1.02 is treated as never chosen and migrated by
`useVoice.ts#loadSettings`). Each chunk is read at
`speakable.ts#paceFor(ttsRate, text)`: at or under 12 words the base rate, ramping
linearly to 1.15× the base at 40 words and capped there — an acknowledgement
keeps the operator's pace, a long passage is read faster. The result is clamped
to 0.5–2.0. Both providers take the same `rate`. Tests: `tests/voice.test.mjs`.

**Voice choice.** The built-in tier is the browser's `speechSynthesis`, which on
macOS exposes only the voices installed in System Settings — every Mac ships
with the *compact* voices, which are the robotic ones; the natural *Enhanced*
and *Premium* voices are a per-voice download, and Siri voices are never
exposed. `webSpeech.ts#scoreVoice` prefers Google neural, Siri, Premium,
Enhanced and Natural voices in that order, reading the tier from the name and
the `voiceURI`. When no such voice is installed the voice row in
`VoiceSettingsPanel.tsx` says so and names the download path. A voice beyond
what macOS ships needs the sidecar tier (`docs/VOICE_SIDECAR.md`).

The desktop shell cannot use `speechSynthesis` at all, so there the same choice
is made server-side by `speech-local.js#pickVoice`, and until 2026-09-05 it made
it badly. `localTtsStatus` parsed `say -v '?'` with a pattern that accepted at
most two whitespace-free words as a name, which kept 71 of this machine's 187
voices and discarded every modern one — they are all named
"Samantha (English (US))". What survived for en-US was the set macOS ships as
jokes, and `pickVoice` took the first match: **Albert**. That, not the model or
the pace, is what "the voice sounds robotic" was. Both halves are fixed. The
parser anchors on the language tag and the `#` example, so it reads all 187
including a three-digit region (`ar_001`) and collapses the duplicate line macOS
prints for a two-tier install. `pickVoice` now scores rather than takes the
first: exact region +100, same base language +50, Premium +80, Enhanced +55,
compact −30, an Eloquence or pre-Vocalizer MacinTalk voice −60, and a voice
from Apple's own Novelty category −1000 — so a quality tier outranks a region
boundary (an Enhanced en-GB voice is read to an en-US operator, because the
accent gap is smaller than the quality gap and an operator who downloaded one
good voice wants to hear it) while an ordinary voice never crosses one. When
every candidate is a joke voice it returns `null` and lets `say` use the system
default. The −60 tier is deliberately survivable: an Eloquence voice loses to
any real voice, including one from another region, but is still chosen over the
system default when it is the only voice in its language. Both sets mirror
`webSpeech.ts`; the two tiers should not disagree about which voices are
unusable. The list inherited from the browser tier was itself wrong: it scored
out **Alex**, which is not a novelty voice but Apple's flagship US male voice
and, at 885 MB, the largest voice asset macOS offers. An operator who
downloaded the best male voice on the platform would have found the assistant
refusing to use it. Alex is on neither set now, and Eddy, Flo and Reed no
longer collect a quality bonus in `scoreVoice` — macOS files them under
Eloquence. `ttsVoice` stays `null` in
`DEFAULT_VOICE_SETTINGS`: the default is "the best installed voice", which is
portable, rather than a name that is right on one machine.

**Temy has a woman's voice** (2026-09-06). A decision about who the assistant
is, made by the operator, and carried by `pickVoice` as a weight rather than a
filter. The operator's own Mac is `en_GB@rg=uszzzz`, so the browser reports
en-GB and `Daniel (Enhanced)` outscored `Ava (Enhanced)` by the region alone:
the assistant spoke as a man because of a locale flag. `voiceCharacterScore`
gives an Enhanced or Premium woman's voice +60 — enough to cross a region
(165 > 155) — and an ordinary one +4, enough to win a tie among ordinary voices
in its own region and not enough to beat an Enhanced voice from the next one
(104 < 105), so "one downloaded good voice is heard" survives it: a robotic
voice is a worse answer to "be someone" than the wrong someone. `say -v '?'`
carries no gender, so `WOMENS_VOICES` is a list of Apple's own English voices
by first name. When the sidecar is up none of this is consulted — synthesis
goes to Kokoro's `af_heart` (§6.3), which is also a woman's voice and a far
better one. Tests: `tests/system-voices.test.mjs` (12).

**Explainability.** `VoiceSnapshot.narration` and `VoiceSnapshot.lastIntent`
drive the caption under the orb: "Heard “keep going” — carrying on". A turn that
is reinterpreted must be visible, or it is indistinguishable from a dead
microphone. A fresh `acknowledge` (`lastIntent.at` within 6 s,
`Composer.tsx#INTENT_CAPTION_MS`) outranks the running commentary in the
caption; otherwise narration wins while the run is busy. Tests:
`tests/voice-astra.test.mjs`.

**Talking over the commentary.** A barge-in while an interjection is playing
(`interjecting`) does not put that line aside for later: "Reading types dot ts"
from before the operator spoke is stale by the time the turn is decided, so
`handleBargeIn` drops it and keeps only a reply an earlier barge-in had already
suspended. Barge-in over a reply still suspends and resumes it.

**Live check (2026-09-05).** Exercised in scripted Google Chrome against the
vite dev server with a fake microphone file (Chrome's
`--use-file-for-fake-audio-capture`), the real ASR tier and a real Claude Code
run: a spoken sentence was sent with no classifier pause; "Excellent, great,
keep going" was read as `acknowledge` and the run continued; "How is it going?"
was read as `status`, answered aloud, and the run continued; "Okay, stop, stop"
was read as `stop`, the run was cancelled and "Okay, stopped." was spoken.
Zero console errors. One gap from that run, since fixed: the status answer was
the canned "Still working on it" line. The run state was intact; the cause was
`useVoice.ts`, which rebuilds the engine's host method by method and did not
forward `progressSummary`, so the engine always saw `undefined`. The hook now
forwards it, and `tests/voice-astra.test.mjs` checks that every `VoiceHost`
member is forwarded so the next added method cannot go missing the same way.
Re-run the same day after that fix: "How is it going?" was answered "30 seconds
in. So far it has read 11 files and run 1 command. Latest: …" with the run
continuing; the "Heard “Excellent, great, keep going!” — carrying on" caption
held for 6 s; no earlier step lines replayed after the barge-in. A third run
with a long reply showed *thinking* / "Summing up the reply." for the digest
wait, then *speaking* with no stale caption, then *listening*. That run also
surfaced a `400` from `POST /api/audit`: `frontierEngine.ts` was posting
`inference.started` / `inference.completed` objects the gateway's metadata-only
allowlist rejects (`server/validation.js#validateClientAuditEvent`), and
`recordAudit` swallows the failure, so no local-turn audit had ever landed. It
now posts `prompt` and `model_call` events with provider, status and duration.
Still observed, not changed: the Flash digest hit its 7 s cap in every run, so
the spoken summary was the rule-based fallback after a 7 s wait. Changed
since: the digest now streams from its own lane (see **Spoken digest** above
for the cause and the measurements); not yet re-observed in a hands-free run.

Non-negotiables:

1. **Nothing reaches the chat unreviewed.** Every utterance passes the repair
   pass, and the operator sees what changed before it is sent.
2. **Every decision is explainable.** A dropped utterance states its reason and
   offers one-click recovery. A rewritten word names the rule that rewrote it.
3. **Heuristics are labelled as heuristics.** The on-device speaker matcher says
   it is weak; it never poses as verification.
4. **Audio never leaves the machine on the VibeVoice tier**, and the audit log
   records that a transcription happened — never the transcript.

### 6.2 The microphone must always come back (2026-09-05)

`awaitingFinal` in `conversation.ts` is the flag that stops `onClose` from
reopening the microphone while a final transcript is still expected. On
2026-09-05 a live session went deaf mid-conversation while the HUD went on
showing voice mode live, and this flag is why: the one-shot branch of
`onFrame` set it and then relied entirely on a transcript arriving. When the
engine closed without delivering one — an empty result, a dropped session, a
recogniser that heard only noise — nothing ever cleared it, `onClose` declined
to reopen, and the session could not hear another word.

The streaming branch above it had a 1200 ms escape hatch, but only cleared the
flag `&& this.state === "deciding"`, so an interjection or a narration moving
the state latched it just the same.

The rule now: **nothing may set `awaitingFinal` without arming
`armFinalFallback`.** The fallback clears the flag whatever state it fires in,
commits the turn if text did arrive, and reopens a microphone that `onClose`
declined to reopen — `reopenDeferred` records that case rather than dropping
it. Waits are `VoiceEngine.STREAMING_FINAL_TIMEOUT_MS` (1200 ms) and
`ONE_SHOT_FINAL_TIMEOUT_MS` (12 s), the latter generous because a one-shot
engine transcribes the whole clip in one pass and the alternative to waiting is
a lost turn. Three structural tests in `tests/voice-astra.test.mjs` enforce the
rule, in the same spirit as the `VoiceHost` forwarding test: this is a class of
bug that reading the diff does not catch.

### 6.2b Mute (`services/voice/audioGraph.ts`, `chat/Composer.tsx`, 2026-09-06)

The microphone hears the room, and the room includes whatever the machine is
playing. A video's dialogue arrives as operator speech and is transcribed as a
prompt — which is how a live conversation came to receive *"Terima kasih"* and
*"Девушки отдыхают"* as turns, and answer them. Noise suppression cannot help:
that audio is not noise, it is speech that simply is not addressed to us, and
the addressing gate in §6.1 judges intent, not provenance.

Before this the only way to stop being heard was to end the conversation,
which throws the turn away and costs a restart. The mic icon already in the
composer is now the switch, because that is where a person looks for it.

`AudioGraph.setMuted()` sets `track.enabled = false`, which delivers digital
silence: the recogniser keeps running and hears nothing, the graph stays
built, and the OS permission is not surrendered, so unmuting is instant and
never re-prompts. Stopping the track would end the capture, re-arm the orange
recording dot on the next start, and — if the second prompt were denied —
strand a live conversation with no way back. The flag survives a graph
rebuild, so a muted conversation does not come back hot.

Muting also discards the in-flight transcript and its auto-send countdown:
whatever was part-heard when the operator reached for mute is exactly what
they did not want sent, and leaving the timer running would send it a moment
after being told not to.

Not unit-tested, and worth saying why: `audioGraph.ts` imports `./prosody`
without an extension, which the suite's plain `node --test` cannot resolve.
The voice modules that are tested (`ambientMemory.ts`, `addressing.ts`) have
no relative imports at all. Typecheck and the production build cover it; the
behaviour needs a microphone.

### 6.3 The sidecar that ships (`studio/voice-runtime/`)

`docs/VOICE_SIDECAR.md` describes the contract; `voice-runtime/` is a working
implementation of it — Whisper for recognition, Kokoro-82M for synthesis, and
AudioSet AST for naming non-speech sounds (§6.5), all on CPU through
`onnxruntime-node`, all loopback-only. It is the first local
tier that works identically on Windows, where `speech-local.js` returns
unavailable and there has never been any local speech at all.

It is the only `*-runtime` with its own `package.json`. Its dependencies are
857 MB on disk, and keeping them out of the application's tree keeps them out
of the packaged app until bundling is a deliberate decision. `npm install` in
`studio/` does not install it; `npm run voice:install` does.

**Capabilities are advertised only when warm.** `/status` on a cold sidecar
returns `{}`, which the gateway reads as "no models here" and falls back to the
local tier, so the operator keeps a voice while weights download rather than
waiting on a probe that cannot answer inside its 2.5 s timeout. The three models
warm independently, so recognition is available before the classifier is. `server/voice.js`
now routes synthesis and recognition **independently**: a sidecar advertising
only `tts` no longer receives audio it never offered to transcribe. The contract
document has always promised that degradation; until 2026-09-05 the code did
not implement it.

**Recognition does not answer the room.** Whisper is generative: handed silence,
hiss or a passing car it returns its best guess at what a human would have said,
and with no language pinned it guesses in whatever language the noise resembles.
That is what produced Devanagari, then `Hanna, hanna, hanna, hanna, hanna,
hanna`, then a line of Arabic, in the same live session as the latch above.
`transcript-guard.js` rejects, in order: clips under 250 ms or under 8% voiced
frames; looping n-grams; Whisper's subtitle fillers (`thank you`,
`please subscribe`, `amara.org`); and a transcript whose script does not match a
language the caller pinned. `voicedFraction` measures against the clip's own
noise floor rather than a fixed threshold, so a steady tone at any volume reads
as unvoiced — what makes the model hallucinate is featureless audio, not quiet
audio. A rejected clip returns empty text and is indistinguishable from silence
to the studio, which is the point.

**Recognition knows the operator's vocabulary, because nothing else will.** A
live session asked for a folder by name and got back a name no folder has, and
the agent acted on it. Whisper has never read this repository. Its
`initial_prompt` — the usual way to hand a decoder a list of proper nouns — is
unavailable: `@huggingface/transformers` 3.8.1 declares `prompt_ids` on
`WhisperGenerationConfig` and never consumes it. So `voice-runtime/lexicon.js`
repairs the transcript afterwards, rewriting a phrase only when its consonant
skeleton is *exactly* that of a known term; no edit distance, because
"terminal" and "Teminali" are one consonant apart and overwriting a word the
operator really said is worse than the misrecognition.
`TEMINALI_ASR_VOCABULARY` adds the names local to a machine, and `/status`
reports the list size as `asr.vocabulary` (27 built in).

Measured over 32 synthesised utterances — paths, folder names, shell commands,
identifiers, ordinary requests, and de/fr/es/pt clips, scored as word error rate
against the spoken text: `whisper-base` 14.2% at 385 ms median / 489 ms p95;
with the repair **11.6% at the same 385 ms**; `whisper-small` 12.3% at 896 ms
median / 1133 ms p95 and 164 MB more download. `temperature`,
`no_repeat_ngram_size` and `num_beams: 4` moved the rate by exactly zero, and
beam search cost +93 ms at the median, so none was adopted. `whisper-base` stays
the default and `TEMINALI_ASR_MODEL` still selects any other. Synthesised speech
is cleaner than a microphone in a room, so those rates are optimistic — the
ordering between configurations is the finding, not the absolute numbers.

**Synthesis streams; recognition does not.** `/speak` with `"stream": true`
answers in clause frames — a length-prefixed JSON header and a body of 16-bit
PCM per clause, written the moment Kokoro returns it (`voice-runtime/stream.js`;
contract in `docs/VOICE_SIDECAR.md`). The gateway relays the bytes as they
arrive: `server/voice.js#speak` hands back a stream instead of a buffer and the
route pipes it. `src/services/voice/clausePlayer.ts` schedules each clause on a
shared AudioContext to start the instant the previous one ends, so a reply plays
as one utterance while its tail is still rendering. Measured on the M4 Pro for a
35-word reply (10.4 s of speech): first audio at 0.29 s, where the whole-file
path delivered it at 1.97 s; the total render is unchanged. Verified in the
app's runtime on 2026-09-05 (Electron 44, the real `clausePlayer.ts` against
the relay and the sidecar) for a 50-word reply (18.5 s of speech), at the
then-default `q8` and so slower than §6.24 now measures: the first
clause was scheduled at 1.35 s where the whole file arrived at 9.2 s, six
clauses played with no gap between them, and `onEnd` reported all 276
characters. A barge-in 2.5 s in reported 35 characters, inside the second
clause. `speak()` resolves
when the first clause is scheduled, which keeps `onStart`'s meaning. Each
frame's `start`/`end` are character offsets into the text, so `onBoundary`
fires with the real offset of each clause and a barge-in reports the clause it
landed in (`speechStream.ts#heardChars`) rather than a proportion of the
playback clock. Hanging up propagates: `pipeline` destroys the upstream when the
studio aborts, and the sidecar stops rendering at the next clause boundary
(measured: cut in during clause two, the sidecar stopped after writing clause
four). The whole-file
path is untouched and still serves macOS `say` and any sidecar that answers
`audio/wav`. `/transcribe` still takes one complete clip, and `asr.streaming`
stays `false`.

The same change fixed the clause splitter. Its break pattern consumed the
conjunction it split on, so "I tried, but it failed" was spoken as "I tried, it
failed". A conjunction now opens the next clause, and "and then" stays together.

### 6.4 What it overheard (`ambientMemory.ts`, 2026-09-05)

An always-open microphone hears the whole room: the other side of a phone call,
someone at the door, a car outside. The addressing gate exists so none of that
becomes a turn — and until now the text was simply discarded, except for
`lastRejected`, a single slot kept so the operator could undo a gate mistake.

`AmbientMemory` is that slot generalised into a bounded log, so "what did she
just say?" and "did you hear that?" have an answer. **It costs no extra
recognition.** The utterance has already been transcribed by the time the gate
rejects it; the only thing that changes is that it is kept for a while instead
of dropped.

Three properties, because this is a recording of a room containing people who
did not ask to be recorded:

1. **Bounded.** `AMBIENT_WINDOW_MS` is ten minutes and `AMBIENT_MAX_ENTRIES` is
   200. Entries expire on a wall clock, not on a session; there is no mode in
   which it grows all day.
2. **Local.** Recall answers are composed by rules in `answerFromAmbient`, not
   by a model, so asking a question about the room never sends the room to one.
   This is the same doctrine as the addressing and intent gates: rules on the
   hot path.
3. **Forgettable.** "forget what you heard" clears it, and so does stopping
   hands-free conversation — stopping is an explicit act and must end the
   recording as well as the session. The toggle is *Remember what it overhears*
   in `VoiceSettingsPanel.tsx`; `ambientMemory` defaults to `true`.

`classifyAmbientQuery` recognises the recall phrasings. Every pattern has to
name the room explicitly, because a false positive swallows a real instruction
— far worse than missing a question the operator can repeat. When a pattern
does match but nothing was overheard, the engine **falls through to the normal
instruction path** rather than answering: "what did he say in the docs?" reads
as a recall question and is not one, and replying "I heard nothing" would eat
the turn.

Speaker attribution comes free from `AddressingVerdict.signals.speakerMatch`:
at or above 0.6 the line is the operator's own and is never offered back as
something overheard, below it is `other`, and `null` is `unknown`.

Tests: `tests/ambient.test.mjs` (16).

### 6.5 Naming a sound, not just a sentence (2026-09-05)

§6.4 shipped with `AmbientKind` carrying `"sound"` and nothing ever producing
one: asked "what was that noise?", the assistant said it could only make out
speech. True at the time, and not what was asked for — the request was *"if
there was a car noise i can ask did you hear that"*.

The sidecar now runs a third model, AudioSet AST over 527 classes
(`voice-runtime/sounds.js`), and the studio records what it names as
`kind: "sound"` entries in the same bounded log. The contract addition is one
field each way: `asr.sounds` on `/status`, a `sounds=1` form field on
`/transcribe`, a `sounds` array back. See `docs/VOICE_SIDECAR.md`.

Four decisions worth keeping:

1. **A sound is not a turn.** It arrives on its own handler,
   `RecognitionHandlers.onSound`, and goes straight to the log. Folding it into
   `onResult` would push an empty utterance through the endpointer and the
   addressing gate; and the assistant must never announce that a car went past.
   It answers when asked, and not before.
2. **Only wordless clips are classified.** Recognition takes ~250 ms and
   classification ~220 ms, and they do not overlap — ONNX inference is
   synchronous. Paying it on every clip would put a quarter-second in front of
   every reply to buy almost nothing, because speech dominates the classifier
   (0.85) and a car underneath a talking person never clears the reporting
   threshold. The clip where a car *is* the loudest thing has no words in it.
   The cost: a car passing mid-sentence is not logged.
3. **The classifier is a capability, not an assumption.** `soundLabels` is read
   from the provider at listen time and passed into recall, because the two
   noes are different: without a classifier the engine never listened for a
   sound and says what it can do instead; with one, "I didn't pick out any
   sound" is an observation it is entitled to make. Neither is a guess.
4. **A steady noise is logged once a minute.** `SOUND_REPEAT_MS` in
   `conversation.ts` — a fan or a road outside is named in every clip, and
   without this it would push everything else out of a 200-entry window inside
   a minute.

The privacy properties of §6.4 are unchanged and now cover more: sound entries
live in the same log, expire on the same clock, are cleared by the same
"forget what you heard", and are switched off by the same *Remember what it
overhears* toggle — which also stops the classifier being asked for at all.

Tests: `tests/ambient.test.mjs` (16), `voice-runtime/tests/` (40 — 24 in
`voice-runtime.test.mjs`, 16 in `lexicon.test.mjs`).

### 6.6 Turn-taking latency: prosody joins syntax (2026-09-05)

The gap between the operator's last word and the assistant's first one is a
chain, and most of it was one link. From "stops talking" to "first audio":

1. **VAD.** `audioGraph.ts` reads the analyser every 20 ms (`DEFAULT_FPS`
   50, a 1024-sample window at 48 kHz); the offset is seen within a frame.
2. **Endpoint.** `turnTaking.ts` runs the silence clock for
   `minSilenceMs`–`maxSilenceMs` — 630–1800 ms at the default
   `endpointSilenceMs` of 900 (`conversation.ts#configure`: floor 0.7×,
   ceiling `max(2 × setting, 1800)`) — sized by how finished the turn
   sounds, and never shorter than the floor learned from the speaker's own
   pauses (§6.15).
3. **Recognition.** The sidecar's Whisper is one-shot: the recorder closes on
   the endpoint and the whole utterance goes to `/transcribe` in a single
   pass. Measured on this machine against the running sidecar
   (`onnx-community/whisper-base`, direct to `:8321`, warm): a 1 s clip
   answered in 0.34–0.98 s and a 5.3 s clip in 0.47–0.82 s across eight
   calls — a fixed cost, not a per-second one.
4. **Commit.** Echo filter, addressing gate, intent, deterministic repair:
   synchronous, except the borderline-only classifier (§6, 1.5 s cap).
5. **Model, then speech.** The host's time to first token, then the first
   clause through `speechStream.ts` (`docs/VOICE_SIDECAR.md` has the sidecar's
   own numbers).

The link that was wrong was 2. The endpointer sized its window from the
transcript's `completenessScore`, and a one-shot recogniser has no transcript
until the recording closes — so on the sidecar tier the score was always 0 and
**every hands-free turn waited the full 1900 ms ceiling** (1330 ms when a
question had just been asked). The audio carries the same evidence earlier
and for free, so the endpointer now reads two things and blends them:

- **Syntax** — `syntaxFinality(text)`: the existing lexical score, but an
  empty transcript is now *unknown* (`null`), not "clearly unfinished".
- **Prosody** — `prosody.ts`: `audioGraph.ts` adds a per-frame pitch
  (`estimatePitch`: decimate to ~12 kHz, normalised autocorrelation over
  70–400 Hz, first peak within 90% of the best so a strong second harmonic is
  not read an octave up; voiced frames only, ~30k multiply-adds). A
  `ProsodyTracker` keeps the voiced frames of the current turn and
  `readProsody` compares the last 300 ms against the 300 ms before it: energy
  trailing off (≤ 0.7×) and pitch falling (a semitone or more) read as a
  statement ending; a level plateau or a rising pitch reads as a question or
  an open clause and holds. It returns `null` under ~400 ms of speech rather
  than guess.

`combineFinality` averages what is known — either alone when the other is
unknown, 0.5 when both are — and `silenceWindowMs` maps 1 → floor, 0 →
ceiling. A finished sentence on a falling voice releases at the floor; a
dangling "and" on a falling voice still holds (0.1 syntax against 0.85
prosody lands under the midpoint). The frame clock comes from the frame
(`AudioFrame.at`), so tests drive the endpointer deterministically and a
stalled timer cannot stretch a silence.

**A slice boundary may not add its own latency.** On the chunked path (a
sidecar that reports `streaming: true`) the recorder cuts 700 ms slices and
the endpoint used to commit whatever text had arrived, leaving the tail of the
sentence in the open slice to surface in the *next* turn. `RecognitionSession`
gains an optional `flush()`; `vibeVoice.ts` implements it as `requestData()`
plus a wait for the slices in flight, then one final result carrying the whole
utterance (empty included, so a turn that transcribed to nothing releases the
microphone). `conversation.ts#onFrame` calls it on `speech-end` and waits for
that final under the existing `STREAMING_FINAL_TIMEOUT_MS`. The browser engine
has no `flush` and keeps its immediate commit. The one-shot path already
flushed by construction (`stop()` closes the whole recording) and is unchanged
apart from the shorter window.

Not yet true: the weights (0.5/0.5), the ±0.25/−0.3 prosody terms and the
0.7× energy threshold were set on synthesised tones and the node tests, not
on a microphone. They need an afternoon with a real voice, a real room and
the caption under the orb.

Tests: `tests/turn-taking.test.mjs` (19); the endpointer cases in
`tests/voice.test.mjs` are unchanged and still pass.

### 6.7 A spoken turn is a transcript, and the model is told so (2026-09-05)

The operator asked, out loud, for the size of a folder. Recognition heard a
name that is not on the Desktop. The agent ran `du -sh ~/Desktop/"5 zone"`
verbatim, got "No such file or directory", and answered *"It appears that the
'5 zone' folder does not exist on your desktop. Please verify the folder name
and try again."* — five steps and 28 s to report a transcription error as a
fact about the filesystem, without once listing the directory it was already
standing in.

The words were the recogniser's guess; the agent read them as the operator's
spelling. So the origin now travels with the turn:

- `VoiceHost.submit` (`conversation.ts`) takes an optional second argument,
  `SubmitOptions { origin: TurnOrigin }` — `"text" | "voice"`, declared in
  `types.ts`. Optional on purpose: a host that ignores it behaves exactly as
  before, and `send()` passes `{ origin: "voice" }` because everything leaving
  there came through a microphone.
- `useVoice.ts` forwards the second argument instead of dropping it — the same
  bug §6 already paid for once with `progressSummary`.
- `StudioChat.tsx`'s host hands it to `sendRef`, and `send` puts
  `origin: options?.origin ?? "text"` into the existing `StreamRequestOptions`.
- `aiService.ts` passes it to `FrontierEngine.streamLocal`, whose last
  parameter is now `origin: TurnOrigin = "text"`.

No new transport, and no second prompt channel: `frontierEngine.ts` builds
`transcriptInstruction = transcriptNotice(origin)` beside the skill, editor and
multi-agent sections and interpolates it into the one system message it already
assembles. For a typed turn the fragment is the empty string, so a keyboard
prompt gets byte-for-byte the prompt it got before. For a spoken one the model
reads `VOICE_TRANSCRIPT_NOTICE` (`types.ts`):

> **[SPOKEN TURN — THIS MESSAGE IS A TRANSCRIPT]**
> The user spoke this; speech recognition wrote it down and may have got words
> wrong, especially proper nouns, file and directory names, paths, commands and
> technical identifiers. Treat the words as approximate and the intent as exact.
> When a name you were given is not found, look at what IS there before you say
> anything: list the directory, or search the workspace. Then either act on the
> obvious near-match, saying which name you used, or ask one specific question
> naming the candidates you found.
> Never end a turn with "it does not exist, please verify the name" — that is a
> transcription error report, not an answer, and you have the shell to check.

Four lines because Flash runs an 8k window, and the last line names the exact
sentence that failed rather than a principle it might be derived from.

**Not yet true:** only the local Frontier lane is framed. The Claude Code and
Codex lanes in `aiService.ts` hand the prompt to an external CLI with no system
prompt of ours to extend, so a spoken turn routed to an agent tab still arrives
unmarked. Nor is there automatic grounding — nothing runs an `ls` for the model
when a path in a command fails. That would need a shell-command path parser and
a second execution channel outside the approval gate in `agentCommands.ts`;
it is a subsystem, not a helper, and was deliberately not built.

Tests: `tests/voice-origin.test.mjs` (9) — the fragment present for `"voice"`,
empty for `"text"` and for an origin-less caller, its wording, and the
threading at each of the five hops.

### 6.8 Stop cannot wait for the endpointer (2026-09-05)

Saying "stop" during a tool run did nothing. The intent gate in §6.1 was
correct and had been correct all along; it was simply never reached.

Two things stood between the word and the gate:

- `onFrame` returned early for every state that was not `listening`,
  `hearing` or `speaking`. A run in flight is `thinking`, so for the whole
  length of it the audio frames were dropped, `endpointer` never saw speech
  start or end, and no turn was ever committed. The microphone was open and
  deaf.
- A one-shot recogniser's session is closed when the assistant starts
  speaking and reopened when it returns to `listening`. A run that went
  `speaking → thinking` and stayed there never passed through `listening`, so
  the session was never reopened.

Both are fixed in `conversation.ts`: `onFrame` now runs the endpointer through
`thinking`, and `setState` reopens a closed one-shot session on entry to
`thinking` as well as `hearing`.

**The fast path.** Even reached, the gate is too late. A turn is only committed
once the operator has been quiet long enough for `endpointer` to call it over,
and "stop" is the one word that has to land while they are still saying it. So
`conversation.ts#fastStop` reads every recogniser result, partial included:

| Result | What happens |
| --- | --- |
| partial, wholly a stop phrase | The speaker goes quiet — `dropSpeech`, unduck, and `speaking → hearing`. The run is untouched. |
| final, wholly a stop phrase | `applyStop`: speech dropped, `host.interrupt` called if a run was live, "Okay, stopped." |

The split is deliberate. Silencing on a partial is free to be wrong — an
operator who says "stop" wants the talking to end whatever the rest of the
sentence turns out to be — while cancelling the run waits for the final,
because "stop" and "stop the dev server" open with the same word and only one
of them is a cancel. When the sentence does grow into an instruction, the fast
path declines it and `commitTurn` handles it as one.

`applyStop` is shared by `fastStop` and `commitTurn`, so a stop cannot mean two
different things depending on which of them noticed it first. It also lifts the
ducking that speaking imposed, which the old inline branch did not: a stopped
reply used to leave the room ducked until the next thing was said.

`addressing.ts#scoreAddressing` returns `directed: true` at 0.99 confidence for
an unambiguous stop directive before any gate runs, so wake-word-only mode and
speaker matching cannot swallow it.

Not yet true: `VoiceEngine` has no headless test — it needs a DOM and a
recogniser — so §6.8 is verified in the running app, not by the suite. The
rules it rests on (`classifyTurnIntent`, `scoreAddressing`) are covered by
`tests/voice.test.mjs`.

### 6.9 The fence tag is not a word (2026-09-05)

`speakableText` recognised a code fence as ```` ```(\w+)?\n ````. Neither of
the two fences this app actually emits matches that: ```` ```frontier-run ````
has a hyphen, and ```` ```html path="outputs/canary.html" ```` has a whole
attribute after the tag. Both fell through unrecognised, so a reply containing
a command or a file was read out verbatim — the shell line, the angle brackets,
the path, character by character. The tag pattern now takes the language word
and allows the rest of the info string.

`voiceDirector.ts#curateSpeech` had been carrying its own markdown stripper to
work around this, which suppressed code blocks into silence where
`speakableText` announces them — the same reply spoken two different ways
depending on which path reached the synthesiser. It now delegates to
`speakableText` and keeps only what is genuinely streaming-specific: closing a
fence that has not finished arriving yet, and dropping table pipes.

Tests: `tests/voice.test.mjs` — the hyphenated tag, the path attribute, and the
untagged fence.

### 6.10 The better recogniser was already installed (2026-09-05)

Recognition was going to the sidecar's `whisper-base` while whisper.cpp sat on
the same machine with Metal and a far better model available, because
`voiceStatus` returned the sidecar's whole answer the moment it replied —
`engine: "vibevoice"` — and `transcribe`/`speak` both routed on that one field.
One engine won both jobs or neither.

They are decided separately now, by `voice.js#chooseEngines`:

| | Serves | Why |
| --- | --- | --- |
| recognition | the higher-ranked model | `large-v3-turbo` against `whisper-base` is not a close call |
| synthesis | the sidecar's Kokoro | the local `say` does not match it, whoever is listening |

`rankLocalModel` orders the families and ranks a quantised file with its parent,
so an `-q8_0` suffix does not hide an 874 MB turbo behind a 147 MB base — which
is exactly what `MODEL_PREFERENCE` did before, listing only unquantised names.
`TEMINALI_ASR_ENGINE` (`auto` | `local` | `sidecar`) pins it.

**The vocabulary prompt, at last.** `voice-runtime/lexicon.js` explains why the
sidecar cannot bias its decoder: transformers.js declares `prompt_ids` and
leaves `generate()` not implementing it, so the domain words are repaired
*after* recognition. whisper.cpp takes `--prompt`. `speech-local.js#buildPrompt`
builds one from the caller's `hints` — the open project's own names, first,
because they are the words most likely to be said next — then the shared
`DOMAIN_TERMS`, deduplicated and capped at 600 characters. The after-the-fact
repair still runs on top.

`hints` were declared on `RecognitionOptions` from the beginning and never sent;
`vibeVoice.ts` now puts them on the multipart body and the gateway parses them.

**The model is loaded once, not once per utterance.** `whisper-cli` reads the
weights on every call: measured here on an M4 Pro, `large-v3-turbo-q8_0` takes
1.02 s wall for a 5.7 s utterance, nearly all of it loading 874 MB. The same
brew formula ships `whisper-server`, which holds the model warm, so the gateway
starts one on demand and keeps it for the life of the process. A caller that
wants caption-sized segments (`maxSegmentChars`) still gets the CLI, which is
the only one that takes `-ml`; so does anyone whose server will not come up.

Beam search is on for both paths (`-bs 5 -bo 5`), which the CLI path was not
using at all.

Not yet true: nothing here is measured against a WER bench in this repo. The
timings above are wall-clock on one machine and one utterance.

Tests: `tests/voice-engine-choice.test.mjs` (14).

### 6.11 Who decides what is spoken (2026-09-05)

Two modules stand between a model's tokens and the synthesiser, and neither was
written down.

`voiceDirector.ts` is the per-turn curator: `StudioChat` builds one
`VoiceDirector` for each turn and pushes the stream through it. `pushToken`
emits only on a sentence boundary — `.`, `!` or `?` followed by whitespace, or
a blank line — and never from inside an open code fence, so a half-arrived
fence is held rather than read out. It speaks at most `maxStreamedChunks`
sentences and then falls silent; the app passes `STREAMED_SENTENCE_LIMIT` (3),
the default is 4. `finish` flushes whatever was never spoken as the final chunk.

That budget is a policy for **one reply**, and a run with tool calls in it is
not one reply — it is a sequence of them. Spent once for a whole run, it bought
three sentences in the first two seconds and then silence while six player
calls came and went, with the entire run arriving at the end as one digest:
*"it started to talk when all the attempts were done. that['s] wrong design —
it has to walk the user through the steps."* So `onToolCall` opens a **step**
when a call reports anything but `running`, and a step gets the budget afresh —
the tokens after a result are the model's account of what it just found, which
is the thing the operator sat through the silence for. A step id is only
honoured once, so a call re-reported (a re-render, an error after a result)
does not buy a second budget. Whatever the previous step left unspoken is
**dropped**, not queued: it was superseded by the result that just came back,
and reading it now would narrate the run several steps behind where it is.
Lag is worse than brevity. This is a separate channel from the per-step lines
`describeToolCall` produces (§6.1) — those say *what* is being done, this
says *what was found*. `curateSpeech` closes an unfinished fence and
hands the rest to `speakableText` (§6.9). `isFreshConversation: false` routes
the text through `sanitizeOngoingAssist`, so a later turn does not open by
greeting the operator again. `abort` silences everything after it: a barge-in
must not be followed by the sentence it interrupted.

`acknowledgment.ts#getImmediateAcknowledgment` speaks *before* the model does.
On submit, with `speakReplies` on and voice not idle, an action command ("fix
the failing test") or a short affirmation ("yes", "go ahead" — four words or
fewer) gets one line, "On it." / "Working on it." / "Sure thing.", so the
operator hears the request land instead of waiting out the first token. A
greeting, a presence check ("are you there"), and any information query
(`what`, `why`, `how`, `explain`, `list`, …) return `null`: the reply is itself
the answer, and prefixing it with "On it." is the robot voice this exists to
avoid. Anything unrecognised also returns `null` — silence is the default, not
a filler.

Its wake words come from `DEFAULT_VOICE_SETTINGS.wakeWords`. This file,
`turnIntent.ts` and the settings each carried their own copy, so a wake word
added in settings reached one of the three.

**And a wake word could not be added at all until 2026-09-10.** Voice &
Conversation *printed* the list into the description of "Require my name" —
`temy, temi, teminali, frontier, studio` — which read as a property of the
build rather than a choice, when it is neither secret nor fixed. The list is now
a `SettingList` beside the toggle. Recognition is what makes this worth having:
a name is exactly the token an ASR model has no language-model support for, so
the useful entry is often the *misspelling* the recogniser actually emits.
Emptying the list is allowed and the row says what it costs — with no names,
"Require my name" can never match and the assistant answers nothing.

This is what the plan called **Voice Submit Keywords**, corrected to the
capability we have. There is no submit keyword: an utterance ends on endpointing
or the `autoSendAfterMs` timer, never on a word.

Tests: `tests/voice-director.test.mjs` (11), `tests/voice-ack.test.mjs` (7).

### 6.12 The confidence whisper.cpp was already returning (2026-09-05)

`parseWhisperJson` hard-coded `confidence: -1` behind a comment saying
whisper.cpp "does not expose a confidence in this output mode". That was half
right, and the wrong half cost the studio its best signal.

Measured on this machine against `ggml-large-v3-turbo-q8_0`, rather than
assumed:

- `whisper-cli -oj` reports **no probability of any kind**. The comment was
  true of the flag the code was passing.
- `whisper-cli -ojf` adds `transcription[].tokens[].p`, a per-token
  probability, for one larger file and no extra decoding. `speech-local.js`
  now passes `-ojf`.
- `whisper-server`'s `verbose_json` carries that same number as
  `segments[].words[].probability` **and** a `detected_language_probability`.
- Neither path emits `avg_logprob` or `no_speech_prob`. Anything built on
  those fields would have found nothing there.

`RecognitionResult.confidence` is now a real 0–1 number, with
`languageConfidence` and `acousticConfidence` beside it, and `-1` still means
"the engine did not say" rather than a fabricated value. The composite is the
**weaker** of the two, not their average, because they fail separately: the
recogniser must be sure both that this was speech in a language it knows and
of the words it then chose.

The measurements that set the thresholds, at `language=auto`:

| clip | language P | mean word P | transcript |
| --- | --- | --- | --- |
| 6 s digital silence | 0.369 | 0.734 | `Thank you.` |
| 6 s pink noise | 0.603 | 0.944 | `.` |
| 8 s low hum | 0.613 | 0.954 | `.` |
| 8 s two-tone "music" | 0.800 | 0.262 | `.` |
| one spoken sentence | 1.000 | 0.884 | correct |
| the `jfk.wav` brew ships | 0.960 | 0.911 | correct |

The language probability separates speech from a room; the word probability
barely does, because silence decodes to "Thank you." with two of its three
words scored above 0.95. Short utterances are **not** penalised for brevity —
that was assumed, then measured: "go ahead" 0.913, "no" 0.866, "yes" 0.811, a
bare "stop" 0.741.

The CLI path reports no language probability on any flag, so when the warm
server is down the confidence is the word score alone and says nothing about
whether the audio was speech. A caller needing that distinction must check
`languageConfidence >= 0`. This asymmetry is real and not worked around.

Tests: `tests/whisper-confidence.test.mjs` (5), against payloads captured from
real runs rather than invented.

### 6.13 A transcript is not proof anyone spoke (`plausibility.ts`, 2026-09-05)

Reported failure: the transcript `"Olof, siri e prole, olof, olof, olof,
olof."` was committed as a genuine turn, aborted a running command, and left
the model apologising for not catching it. Nothing in the pipeline
malfunctioned — `cleanTranscript` found no bracketed artefact to strip,
`isNonSpeechOrBlank` found plenty of words, and `scoreAddressing` was handed a
sentence-shaped string and scored it. It was a Whisper repetition loop on
non-speech audio, a failure mode with a shape of its own and no filter looking
for it.

`plausibility.ts` is that filter, and it runs in `commitTurn` **before** the
addressing gate — addressing asks who a sentence was for, this asks whether
there was a sentence at all. The operator's requirement was that the rejection
land before the text becomes a prompt, so everything here is synchronous,
offline and free.

It is a separate layer from §6.12 and cannot be folded into it: **loops score
high**. The "tk tk tk" clip measured a language probability of 0.813 and a
mean word probability of 0.893 — better than correctly transcribed speech
beside it, and it came back with two more `TK`s than were said. A recogniser
that is looping is not unsure; it is confidently repeating.

Four rules, each with a carve-out that exists because of a counter-example:

- **Repetition** — the largest share of the utterance covered by repeats of
  one n-gram, scanned across n = 1..4 so a looped *phrase* ("thanks for
  watching, thanks for watching…") is caught as well as a looped word. Needs
  ≥ 6 words, ≥ 3 repeats and ≥ 60% coverage together, and never fires on
  `MEANINGFUL_REPEATS` — an operator hammering "stop stop stop stop" at a
  runaway command is structurally a perfect loop and is the single most
  important utterance the system can hear.
- **Dominance** — one word taking ≥ 50% of a ≥ 6-word utterance without being
  contiguous enough to read as a loop. This is the reported failure's shape.
- **Known artefact phrases** — the subtitle credits and "Thank you." Whisper
  emits on silence. Rejected *only* when confidence is also below 0.6, because
  "thank you" is a thing operators say; with no confidence reported the phrase
  is allowed through rather than guessed at.
- **Coherence** — the share of words that are pronounceable. Deliberately
  crude and generous: no dictionary, because one would not survive Kiswahili,
  code identifiers or the operator's own filenames.

A rejected utterance is recorded in `lastRejected` with its reason and, when
ambient memory is on, kept — an operator who was ignored is owed a reason, and
a silent filter cannot be tuned. The bias throughout is against false
rejection: refusing to hear the operator is worse than passing noise to the
addressing gate, which is itself a filter.

Tests: `tests/voice-plausibility.test.mjs` (15), half of them asserting that
ordinary, terse and urgent speech still passes.

### 6.14 The follow-up window was a blanket bypass (2026-09-05)

`followUpWindow` alone added +0.32 to a 0.34 base, clearing the 0.62 line on
timing and nothing else — and it was also the escape hatch in the wake-word
hard gate. Instrumented before it was changed: for nine seconds after the
assistant asked anything, in **wake-word-only mode**, a stray single word, a
sentence about someone's recipe, and the recogniser's own noise loop all came
back DIRECTED, each explained as "Answering the question just asked."

The window is still worth having — a terse answer with no wake word is exactly
what it exists to admit — so it was narrowed rather than removed:

- **Contrary evidence closes it** instead of being outweighed by it: third-party
  phrasing, or a voice that decisively is not the operator's. The mismatch bar
  is 0.5, below the 0.62 match line, because `speakerProfile.ts` is honest that
  it is a weak verifier — only a decisive mismatch weighs in, and a marginal
  score is treated as no evidence either way. This is a soft input to the
  score, **not** a promotion of speaker matching to a gate (§6.1).
- **What remains decays** across the nine seconds, from full weight to 45%. An
  answer half a second after a question is overwhelmingly a reply to it; the
  same words eight seconds later are much more often the room. A recognised
  direct answer keeps its full bonus regardless of delay, so an operator who
  takes a moment to think is not punished.
- **The hard gate now tests whether the window is trusted**, not merely open.
- **The reason must agree with the verdict.** A turn that scored below the line
  inside the window was still explained as "Answering the question just asked.",
  which reads as an acceptance and told an ignored operator nothing.

`THIRD_PARTY_MARKERS` also gained the past-tense forms it was missing — "I told
her the recipe was wrong" matched nothing in the list.

Tests: `tests/voice-addressing-window.test.mjs` (10).

**The defaults were open, and are now closed (2026-09-07).**
`requireSpeakerMatch` and `requireWakeWord` are both `true` in
`DEFAULT_VOICE_SETTINGS`. This reverses a decision the same operator made when
the gates above landed — the answer then was to leave them off — and the
reversal is theirs too, asked for in these words: *"i want when video or audio
plays on my computer the voice assistant to never hear it… and the voice
assistant speech recognition would only hear me"*, then *"make those settings
default… user can change but they have to be default"*.

What changed in between is the measurement. §6.13's gate covers audio **this
app** plays and cannot see Spotify or a Safari tab, and there turns out to be
no cheap way to teach it: `pmset -g assertions` carried a stale `audio-out`
assertion for 52 minutes with nothing playing, and CoreAudio's
`kAudioDevicePropertyDeviceIsRunningSomewhere` returns **true in silence**
because the output device stays open (both measured 2026-09-07 on macOS 26.1,
the second with a compiled Swift probe). The only honest signal left is a
ScreenCaptureKit loopback tap behind a Screen Recording permission. So until
that exists the defaults carry the weight.

The objection in the old text still stands and is answered rather than
dismissed: **speaker match must not pose as verification** (§6.1). It does not
here, because the gate at `addressing.ts:197` also tests `hasProfile`, so the
default is **inert until the operator enrols** and degrades nobody who has not.
`requireWakeWord` is what actually protects a fresh install, and
`followUpTrusted` means the name opens an exchange rather than every turn in
it. Pinned by three tests in `tests/voice.test.mjs`, including one asserting
the no-profile case still answers.

### 6.15 The endpointer learns the speaker's pacing (2026-09-05)

> "it's cutting me out i can not finish my sentenses on most occasionns"

The silence window at the "Balanced" setting ran 540–1300 ms — §6.6 quoted a
1900 ms ceiling the code did not have — and 378 ms right after Temy asked a
question. A phrase-final pause on a falling voice reads as finished (§6.6), so
every pause the operator took between phrases that lasted longer than about
half a second ended their turn. The constants were set on synthesised tones;
this is the microphone measurement §6.6 said they needed.

Two changes in `turnTaking.ts`, both tested in `tests/turn-taking.test.mjs`:

- **Human-scale bounds.** `DEFAULT_ENDPOINTER` is 600–1800 ms;
  `conversation.ts#configure` maps the setting to floor 0.7× and ceiling
  `max(2×, 1800)`: Snappy 420–1800, Balanced 630–1800, Patient 980–2800.
  `EAGER_FACTOR` is 0.8, not 0.7.
- **A learned floor.** The endpointer keeps `pacingFloorMs`, the shortest
  window it will use for this speaker, and two things raise it: a pause of at
  least 120 ms that the speaker talked through before the window ran out, and
  speech that begins within `resumeWindowMs` (1200 ms) of a `speech-end` it
  fired — a cut-off. Either teaches the pause × `PACING_MARGIN` (1.25), capped
  at `pacingCeilingMs` (2000). Neither the finality blend nor `eager` may go
  under it. Every turn that ends without a resume relaxes it 5 % of the way
  back to the configured floor. `reset()` clears the turn and keeps the
  pacing; `forgetPacing()` clears the pacing. The `speech-start` event
  carries `resumedAfterEndpoint: true` and `gapMs` when it was a cut-off.

Not yet true: `conversation.ts` does not act on `resumedAfterEndpoint` — the
continuation is a new turn, not appended to the one in flight. The pacing is
not persisted, so every launch starts at the configured floor. Neither the
new bounds nor the margin has been measured against the operator's voice yet;
the complaint arrived mid-session and this is the first response to it.

### 6.16 The pause between paragraphs was the render (2026-09-06)

A spoken reply is not synthesised in one piece. `speak()` in `conversation.ts`
splits it into blocks — paragraphs, or ~40-word runs of a long one — because a
block can begin playing while the rest of the reply is still being written, and
because handing a whole reply to a whole-file engine means silence until the
last word of it is rendered.

What the split did not do was overlap. `processSpeechQueue` asked for block
N+1's audio in block N's `onEnd`, so the entire round trip — gateway request,
sidecar render, first audio — happened **after** the previous block had gone
quiet. That is the pause the operator heard between paragraphs, and it grew
with the paragraph: the render is proportional to the text, and none of it was
under any audio.

A block's synthesis now starts while the previous block is still being heard.
`VoiceProvider` gained an optional `prepare()` returning a `PreparedSpeech` —
the request, in flight, tagged with the text it is for — and `SpeakOptions`
gained `prepared`, which the provider plays instead of asking again. The
vibevoice provider implements both around one `synthesise()`; a warmed request
that fails is retried fresh rather than dropping the block.

When to warm is `readyToWarmNext` in `speechStream.ts`, tested rather than
guessed: the **last fifth** of the block being spoken, off the `onBoundary`
offsets both playback paths already report. Late enough that the current
block's own render is done — two renders at once on a sidecar that serves one
at a time would slow the one being listened to — and early enough to cover the
round trip. Only ever one block ahead, for the same reason.

The handle is cancelled whenever nobody will play it: `silence()`, a drained
queue, and a block whose warmed text no longer matches. A provider without
`prepare()` loses nothing and speaks exactly as before.

Tested in `tests/speech-stream.test.mjs`.

### 6.17 The app was answering its own speakers (`selfAudio.ts`, 2026-09-06)

Reported the moment the media player was first driven by hand: *"it was
literally listening and responding to the video, this is wrong behaviour."* An
`.mp4` was playing in the Files panel with a voice conversation live, and the
film's dialogue was arriving as operator prompts. The reply on screen was
*"OpenAI has blessed us."*

Nothing upstream could have caught it. `echoGuard.ts` recognises the
assistant's own voice coming back through the microphone, but it does that
textually — it knows what was just spoken. Nobody knows the words of a film,
and there is nothing wrong with the transcript of one: it is real speech,
correctly recognised, grammatical, often imperative. Every gate below the
recogniser asks who a sentence was *for*, and a film answers that as
convincingly as a person does, because it is a person — just not this one.
`plausibility.ts` passes it for the same reason. The problem is not the words,
it is where they came from.

So the rule is provenance, and the only thing that can establish it is the app
itself: it knows exactly when it is making sound. `SelfAudioMonitor` holds
named sources — a source is named rather than counted so one that disappears
without saying so can be dropped by name instead of leaving a count stuck above
zero and the microphone deaf for the rest of the session. Two things feed it,
both armed in `main.tsx` rather than by the panes, because a source outlives
its pane:

* **media elements in this document** — `<video>` and `<audio>` in the Files
  panel. Watched with one capture-phase listener on the document, since media
  events do not bubble but are still dispatched down the capture path. Each
  event triggers a re-read of every element rather than a transition count,
  because an element can also go silent *without* an event, by being removed:
  React unmounts a playing `<video>` on a file switch and no `pause` is fired.
  The same re-read runs before every query, so a removed element cannot leave
  a stuck source behind;
* **the browser panel's pages**, which are not in this document at all. Main
  reports `webContents.isCurrentlyAudible()` on `audio-state-changed` as part
  of the existing state message, and sends one last `audible: false` when a
  view is destroyed — the one moment a page cannot report its own silence;
* **the video editor's timeline**, which is not in this document either, for a
  different reason. Its voices *are* media elements, but detached ones:
  `video/engine/audioEngine.ts` creates each `Audio` only to be a Web Audio
  source node and never adds it to the document, because the picture comes
  from a canvas. `querySelectorAll("video, audio")` therefore returns none of
  them, and `isElementAudible` would call them silent on `isConnected` even if
  it saw them — so the operator's own footage played past every guard above and
  came back as something they had said. The engine reports instead of being
  discovered: `onAudibleChange` fires on a change only (`sync` runs every
  frame), counts a clip as sounding only when the playhead is over it *and* its
  gain is above zero — a muted or unsoloed track is silent — and answers false
  on master mute and `stopAll`. `watchTimelineAudio` in `selfAudio.ts` is what
  joins the two, so nothing in the video domain has to know a microphone
  exists.

What the monitor changes is two decisions, and deliberately not the microphone
itself. **A turn committed while the app was audible needs a wake word.** Not a
closed microphone: *"Temy, pause the video"* is precisely the turn an operator
needs while something is playing, and it still lands. Everything else is
recorded in `lastRejected` — so the HUD says why rather than going mysteriously
quiet — and is *not* written to ambient memory, because that log is for the
room and a two-hour recording we played ourselves would be all that was left in
it. **And our own playback cannot barge in.** Sustained voiced frames are
exactly the shape `BARGE_IN_FRAMES` looks for, so a video playing in the Files
panel cut the assistant off mid-sentence as reliably as the operator could.

The window is wider than "playing right now". A recogniser hands back a final
transcript some way behind the audio it was built from, so `audibleSince(turnStart)`
is true three ways: playing now; stopped after the turn began, so part of the
turn is made of it; or stopped within `SELF_AUDIO_TAIL_MS` (2 s), which is the
recogniser's own lag. Push-to-talk is exempt — the operator is holding the
button, which is a statement about provenance in itself.

Tested in `tests/self-audio.test.mjs` (12): what counts as an audible element,
the multi-source and tail arithmetic, the removed-element and closed-tab leaks,
a navigation message that says nothing about audio not being read as silence,
a playing timeline seen while the document sweep over the same moment finds
nothing, and that the engine consults the monitor at both gates.

**What this still does not cover, and cannot from here.** Sound from *another
application* — a video in another browser, a music player — is invisible to all
three watches, because the app can only report the noise it makes itself.
Against that, and against another person in the room, the answer is
`requireSpeakerMatch` ("Only respond to my voice" in voice settings), which
needs an enrolled voiceprint and is honest in `speakerProfile.ts` about being a
weak verifier — **and `requireWakeWord`, which needs nothing and is what
actually covers a fresh install.** Both default on since 2026-09-07; see §6.14
for why, and for the two system-audio signals that were measured and found
useless.


### 6.18 A permission prompt can be answered out loud (`approvalIntent.ts`, `hooks/useSpokenApproval.ts`, 2026-09-06)

The operator's words: *"we have to handle accepting commands and other
permissions hands free, the assistant has to ask me if i say yes it accepts
itself, but do show the option incase i wanted to click myself"*.

Two subsystems in this application stop and ask before they act — the built-in
chat's command gate (`hooks/useCommandApproval.ts`, §7) and an agent CLI's own
permission prompt (`panels/AgentPane.tsx`). Both were mouse-only. That is fine
at a keyboard and useless the moment the operator is talking to Temy from across
the room: the run stalls on a button nobody is near, and the assistant that is
mid-conversation with them says nothing about it.

**The prompt is not replaced.** Every button that settled a request still
settles it, still with the same keyboard shortcuts, and a request answered by
voice and one answered by a click travel the same path. The voice route is a
second door onto the same decision — which is what the operator asked for
explicitly, and what `tests/approval-intent.test.mjs` asserts by reading both
components back.

**Where the request lives.** `store/approvalStore.ts` — one slot, not a queue,
and not persisted. One slot because "yes" can only mean the request the operator
was just read; a pane with several blocked tool calls publishes only the head,
and the rest wait on screen as they already did. Not persisted because a pending
approval belongs to a live run, and restoring one across a restart would offer
to allow a command whose process is long gone. The store never resolves
anything: it carries an `answer` callback, because the promise, the run and the
socket all belong to the pane that raised it.

**Who asks.** Every chat surface builds its own `VoiceEngine`, so three may be
mounted at once, and the question must be asked once by the one actually holding
the microphone. `useSpokenApproval` speaks only when that engine has
`mode === "conversation"` and is not idle — a push-to-talk engine is not
listening between presses and must not narrate. `SideChatPane` is dictation-only
by design and so never asks. A prompt raised while nothing is listening is
simply never spoken, which is correct rather than a gap: the operator is at the
keyboard and the buttons are in front of them.

It is spoken with `speakAside`, not `speakReply` — the question is not part of
the model's turn and must not queue behind one.

**An aside that asks something has to say so** (fixed 2026-09-06, found by hand
in the running app: the prompt read itself out, the operator answered, and it
went on standing). The addressing gate (§6.4) is what decides whether an
utterance was meant for the assistant at all, and a bare "yes" carries none of
the signals it looks for — no wake word, no imperative, no domain noun. The one
signal that does cover it is the follow-up window: *we just asked something, so
a reply is expected*. Only `speakReply` was opening that window, and the
approval question is deliberately not a reply, so the window stayed shut and a
one-word answer scored as room noise and was dropped **before `consume` ever
saw it**. Both halves were built and neither could reach the other. So
`speakAside` now takes `{ expectsAnswer }` and marks the assistant as having
asked when the line finishes speaking — the same mark `speakReply` leaves when
its text ends in a question mark, which the spoken prompt does not.

**And the answer has to arrive once** (fixed 2026-09-06, again by hand: the
prompt read itself out, the operator said "yes", and it went on standing —
twice over, for two unrelated reasons). Chromium's `SpeechRecognition` does not
keep its promise about `event.resultIndex`: an event arrives whose index points
at or before a result that was already delivered as final, and
`providers/webSpeech.ts` handed that result on a second time. The engine
accumulates finals — a turn is built by appending each one — so the operator's
sentence was written down twice. It is visible in every transcript in the pane:
*"Thank you. Thank you."*, *"Hey, how are you? Hey, how are you?"*. A bare "yes"
therefore reached the table below as "yes yes" and matched nothing at all. The
provider now remembers how many finals it has read and skips a redelivery, and
`approvalIntent.ts` *also* collapses an exact repetition of a whole utterance —
two guards, deliberately, because this one gates approvals and a transcript
that is wrong twice should still not be able to leave a prompt standing.
Collapsing is a normalisation and not a widening: only an exact repeat folds,
so "yes no" and "no yes no yes" both stay unmatched.

**Who answers, and how narrowly.** `services/voice/approvalIntent.ts` is pure
and holds the whole decision. The risk it is built around is a false allow: the
microphone hears the room, and running a command the operator never agreed to is
the one failure that cannot be taken back. So it refuses far more than it
accepts —

- only a **short** utterance can be an answer at all (six words). A sentence is
  an instruction: *"yes and then push the branch"* is the operator talking, and
  it goes to the model with the prompt still standing;
- the phrase must be the **whole** utterance, never a word inside one —
  "nothing" is not "no", "yesterday" is not "yes";
- **"always" is tested before "yes"**, because every way of saying it contains
  one, and the wider grant has to win the tie or *"yes, always"* would allow once
  and ask again immediately;
- the table takes **the words the prompt itself teaches**. The spoken question
  says "say yes to allow it" and the button says `Run`, and the table took
  neither `allow` nor `yes allow` — it was refusing the vocabulary it had just
  handed the operator, which is how the fix above came to be found. Bare
  `allow` / `approve` / `accept` / `permit` / `run`, and an affirmative before
  any of them, are answers; `allow always` is an always;
- anything unmatched is `null`, and null is the safe answer: nothing approved,
  nothing denied, the words travel on as ordinary speech.

`stop` is deliberately not a deny word — it is the interrupt word, and §6.8
settles it before an utterance ever reaches here.

The pane's `submit` calls `consume` before it sends anything to the model, so an
answer never also becomes a prompt. The request is withdrawn from the store at
the moment of answering rather than when the pane's own state catches up: an
agent answer is a round trip through the gateway, and until it returns a second
"yes" would answer the same prompt twice. The verdict is acknowledged aloud —
"Allowed.", "Refused.", "Allowed, and I won't ask again." — because an operator
who speaks to a machine and hears nothing says it again louder.

**The third answer had to be said out loud too (2026-09-07).** The table took
`always` from the first day, `describeApprovalRequest` took an `alwaysLabel`
from the first day, and the spoken question never used it — it offered two
answers where three are live. An operator across the room cannot learn the word
from the button, because the button is the thing they cannot reach. The question
now ends *"Say yes to allow it, always to stop asking about `npm`, or no to
refuse"*, with the scope named when it is short enough to say and dropped when
it is not; a prompt with no scope to widen still offers only two answers, since
teaching a word the gate would ignore is worse than teaching none. On screen,
`CommandApprovalPrompt`'s microphone hint says all three words rather than
keeping two of them in a tooltip nobody hovers and nobody hears, and the refusal
button is **Don't allow** rather than "Skip" — it refuses, it does not defer,
and it should carry the same word the ear is listening for.

**On screen**, both prompts grow a `say yes` hint with a microphone glyph while
an engine is listening, and nothing at all when none is. An operator who has just
been read a command needs to know "yes" is a word something is waiting for;
otherwise they say it to an assistant that was never armed.

Tested in `tests/approval-intent.test.mjs` (13): the affirmatives, the
negatives, "always" beating the "yes" inside it, six sentences that contain an
answer word and must not be read as answers, words that merely contain one, the
phrasing of the spoken question, a shell one-liner announced rather than
recited, and that both prompts still render every button they had — plus the
vocabulary the prompt teaches, the always-beats-allow tie for the new verbs, and
six instructions containing a newly accepted verb that must still not be
answers ("run the tests", "approve the pull request").


### 6.19 The greeting was closing the microphone it had just opened (2026-09-06)

Reported: *"there is a glitch when it starts it says 'hey there' right? during
that window it seems I can not interrupt it, because normally as soon as I tap
to talk I start talking."* Separately, and it turned out to be the same fault:
*"it took 3 attempts to capture that 'hello how are you'."*

`setState` closes the recogniser whenever the assistant starts speaking, so that
a one-shot transcriber does not write down the assistant's own voice. The
greeting goes through that same path — and the greeting is spoken at the one
moment the operator has just reached for the microphone and is most likely to be
talking already. So the first thing a session did was open the microphone,
announce itself, and shut the microphone for the length of the announcement. The
operator's opening sentence was not being ignored; it was never recorded. It had
to be repeated until one landed in a gap, which is the three attempts.

Talking over it did not help either. Barge-in wants `BARGE_IN_FRAMES` — 18
frames, 360 ms of *unbroken* voicing — before it will believe an interruption,
and it declines entirely while `selfAudio` says the app is making noise. Both
rules are right for a reply and wrong for a greeting.

Four changes, all in `conversation.ts`:

- The recogniser **stays open** for the greeting. Safe here in a way it is not
  for a reply, because the greeting is one short string this engine chose and
  handed to `echoGuard` verbatim a few lines earlier, so anything the microphone
  brings back is stripped by text.
- `GREETING_YIELD_FRAMES` is 3 — 60 ms. The greeting stands down at the first
  sign of a voice and the frame falls straight through to the endpointer as the
  operator's own, so their sentence is timed from its real beginning.
- Words beat frames: any transcript arriving mid-greeting abandons it at once,
  since a recogniser already returning text has settled what the frame counter
  was still counting towards.
- `beginAudibleSpeech` now **refuses the floor** when the operator is already
  mid-utterance, for every caller and not just the greeting. `speaking` closes
  the recogniser and stops feeding the endpointer, so taking the floor from
  someone mid-sentence does not talk over them, it deletes them. A greeting that
  cannot have the floor is abandoned rather than queued.

`abandonGreeting()` bumps `speechEpoch`, which is what makes it safe to call
before `tts.speak()` has resolved: the handle that arrives afterwards fails its
own epoch check and cancels itself.

### 6.20 Hearing a voice the room is louder than (`voiceActivity.ts`, 2026-09-06)

Asked for: *"make it 3 times more genius in hearing me… super hearing even at a
very noisy place."*

The voice-activity test was a single rule — the frame clears the room's noise
floor by a margin, and its spectral centroid is in the band speech occupies.
That margin is a *ratio*, which is the flaw: the noisier the room, the louder
the operator has to be to clear `floor × 2.6`. That is backwards from what a
person does, and it is why the same sentence at the same volume is heard in a
quiet room and missed in a busy one.

There is now a second route, and a frame needs only one of them. A vowel is
periodic; a room full of chatter, traffic and crockery is not. `estimatePitch`
already reported how periodic each frame was — `prosody.ts` has computed a
McLeod NSDF clarity all along — but the graph only ever ran it on frames it had
*already* decided were speech, so it could never rescue one. It now runs first,
and a frame with a confident fundamental (clarity ≥ 0.7) is admitted at
`floor × 1.5` instead of `floor × 2.6`.

The centroid band gates both routes: it is the fan-and-fridge test, and a motor
is periodic enough to fool the pitch route on its own.

While ducked — the assistant's own voice playing — everything tightens, because
the periodic sound in the room is then most likely to be us. The clarity bar
rises to 0.82 and the pitch route keeps an absolute floor of 0.02, so it can
only undercut the loudness route, never open barge-in to speaker bleed.

The decision moved out of the graph into `services/voice/voiceActivity.ts` as
the pure `isVoicedFrame()`, for the same reason `prosody.ts` and `turnTaking.ts`
are pure: it can then be stated as arithmetic in a node test rather than
reproduced with a microphone. Tests: `tests/voice-hearing.test.mjs` (9),
including the case that motivated it — a voice at 0.02 RMS under a floor that
has climbed to 0.012, which loudness alone cannot hear and periodicity can.

### 6.21 The snappy setting was not snappy (2026-09-06)

Asked for: *"can we make it be much more faster and not wait up too long to
start talking."*

`configure()` derived the endpointer's two windows from `endpointSilenceMs`, but
the ceiling was `Math.max(setting × 2, DEFAULT_ENDPOINTER.maxSilenceMs)` — which
floored every choice at the balanced default's 1800 ms. "Snappy — 0.6s"
therefore bought a faster release on a *confident* ending and nothing at all on
a hesitant one, which is precisely the case the operator sits through. Picking
the fast setting now means it: 0.6 runs 420–1200 ms where it used to run
420–1800. The floor is the endpointer's own `minUtteranceMs` doubled, below
which a window is shorter than the shortest thing it may call an utterance.

The window is also applied in the constructor now, via `applyEndpointerWindow()`.
It was only ever set on the first `configure()` call, which never arrives if the
operator never opens the voice settings — so the setting was inert until touched.

### 6.22 Commentary may follow commentary (2026-09-06)

Reported: *"it is not talking through all the steps."*

`noteProgress` would only speak when the assistant was saying nothing at all, so
every step that began while the previous step's line was still being read was
dropped rather than queued — a run that moved faster than the sentence
describing it announced its first step and then went quiet for a minute. The
gate now also admits a line while the thing in flight is itself commentary
(`interjecting`), and `speakInterjection` queues it behind the line in progress.
`PROGRESS_GAP_MS` drops from 3500 to 1500 and is what keeps that from becoming a
drone.

A reply is still never talked over: `interjecting` is false whenever the speech
in flight is an answer to the operator, and a non-null `suspendedSpeech` means a
reply is waiting to resume behind a barge-in. Neither is something a step line
may pre-empt.

### 6.23 Reopening the microphone was throwing the sentence away (2026-09-06)

Reported: *"it took 3 attempts to capture that 'hello how are you'."*

Two defects, found by reading the recognition path rather than by reproducing
the symptom, and both introduced by §6.19–§6.22's own session.

**The reopen destroyed a live capture.** `reopen()` had been hardened to stop
two recognisers running at once, and it did that by aborting whatever session it
found before opening its replacement. On the local sidecar tier that abort is
not a polite close. `server/voice.js` answers `streaming: false`, and
`vibeVoice.ts` takes `capabilities.streamingAsr` from that answer, so the tier
runs the single-pass path: the recorder buffers the whole utterance and it is
transcribed in `onstop`. `close()` sets `active = false` *before* stopping the
recorder, so `onstop` finds `active` false, emits neither a transcript nor an
empty final, and the audio is discarded without ever reaching whisper. The
graceful `stop()` leaves `active` true and is the only path that transcribes.

The callers reach `reopen()` on `!this.session?.active || this.reopenDeferred`,
and a stale `reopenDeferred` is sufficient on its own — `setState("hearing")`
fires from `speech-start`, so the reopen landed on the first syllable of a turn
and threw it away. `reopen()` now returns early when the session it was given is
still active: a live session already is the one pair of ears, and the operator
should not pay for a stale flag with the sentence they are saying.

**The foreign-language rule never fired.** §6.13's language check reads the
language the recogniser reported for the turn. `commitTurn()` captured
`turnConfidence` into a local before resetting its fields but read
`this.turnLanguage` back at the `scorePlausibility` call site, thirty lines
after clearing it — so `context.language` was always the empty string, `foreign`
was always false, and the rule shipped inert. It is read into a local now,
beside the confidence it was always meant to travel with. The existing tests did
not catch it because they call `scorePlausibility` directly; nothing in the
suite constructs a `VoiceEngine`, which is still the gap worth closing.

Neither fix has been confirmed against the reported symptom on a live
microphone — the diagnosis is from the code, and the engine has no test harness
that can drive a fake provider through a turn.

The rule going live for the first time carries an exposure worth naming: on
`auto`, `expected` is `navigator.languages`, and if Electron's renderer reports
only English while the operator genuinely speaks Kiswahili, a Kiswahili turn is
now rejected outright — the rule is deliberately not softened by confidence.
`navigator.languages` has not been measured in this renderer. Pinning the
language setting narrows `expected` to exactly one and removes the question.

### 6.24 The quantised model was the slow one (`voice-runtime/tts.js`, 2026-09-07)

The operator asked what Pocket TTS is, found the sidecar already runs Kokoro,
and asked which wins on latency *and* on quality. The measured answer was that
the migration is not worth its cost — tuned Kokoro grades 4.440 UTMOS against
Pocket 24L's 4.482, a gap nobody hears, and the latency gap closed once Kokoro
was tuned. What shipped instead is the tuning, two lines of it.

**`TEMINALI_TTS_DTYPE` now defaults to `fp32`, not `q8`.** The `q8` default was
never measured; it rested on the assumption that a smaller model is a faster
one. On Apple Silicon it is the reverse — int8 kernels fall off Accelerate's
fast paths, so the quantised model is about **2.3x slower**, costs more CPU per
second of audio, and grades marginally worse. Measured through the sidecar,
warm, three runs each:

| | `q8` | `fp32` |
| --- | ---: | ---: |
| `Running the tests.` | 530 ms | **245 ms** |
| 35-word reply, first clause on the wire | 666 ms | **286 ms** |
| 35-word reply, whole file | 4527 ms | **1972 ms** |
| UTMOS, six-sentence corpus | 4.410 | **4.440** |

Quantisation buys download size and nothing else here: 88 MB against 311 MB.
`q4` (291 MB) measures level with `fp32`, so it is the option if packaging ever
needs one. Recognition and the sound classifier were not measured and stay int8.

**The first clause is now capped shorter than the rest** — `FIRST_CLAUSE_WORDS`
is 6 where `MAX_CLAUSE_WORDS` stays 18, and `splitClauses(text, maxWords,
firstMaxWords)` takes both. Only the first clause decides when the operator
hears anything; every later one renders while an earlier one is still playing,
and at this speed they never catch up to the ear. Cutting the whole utterance
into 6-word pieces would flatten its prosody for no gain, so only the opening is
cut.

It changes nothing when punctuation already breaks early, and a great deal when
it does not — which is the case the old cap handled worst. Time to render the
first clause, `fp32`, p50 of five runs:

| opening | 18 | 6 |
| --- | ---: | ---: |
| "The build finished cleanly and every test..." — breaks at *and*, same four words either way | 287 ms | 261 ms (noise) |
| "Open the file at studio slash server slash voice dot js and check..." | 640 ms | **308 ms** |
| A 24-word sentence with no punctuation before its full stop | 928 ms | **332 ms** |

The split is on whitespace only. `clauseOffsets` locates each clause as a
literal substring of the text as sent, which is what lets a barge-in report the
character offset actually heard (§6.3); a piece that re-joined or
re-punctuated its words would not be findable, so this must not be "improved"
into one that does.

Tests: `voice-runtime/tests/voice-runtime.test.mjs` — the clause-splitting
cases cover the short first clause, the uniform-cap path with both caps passed
explicitly, and offsets surviving the split.

Two things measured on the way and worth not re-deriving. Kokoro's published
voice grades are unreliable: `af_bella` is graded A- and measures 3.792,
`af_nicole` is graded B- and measures 2.895, while the shipped `af_heart`
(4.410), `af_kore` (4.416) and `af_sarah` (4.404) tie at the ceiling — the
default was already the right one. And a Pocket TTS migration would be
*additive*, not a swap: ASR stays on `@huggingface/transformers` under Node
regardless, so a Python TTS sidecar means roughly 1.2 GB of Node plus 1.06 GB of
Python. Community ONNX and Rust ports exist and are unverified.


### 6.25 A turn that never ends (`turnTaking.ts`, `conversation.ts`, 2026-09-07)

Observed live: the orb captioned every word and sent none of them. Ten separate
"hello"s accumulated into one growing caption — `state: "hearing"`,
`level: 0.17`, `badge: "Listening to you…"` — so the microphone and the
recogniser were both working. What never happened was the *endpoint*.

`speech-end` is the only event that commits a turn. `commitTurn` is what clears
`this.transcript`, and the transcript is what the orb captions, so a caption
that only grows is proof that no turn was ever committed. Everything that can
produce a `speech-end` — the audio graph's frame pump, `isVoicedFrame`, the
`Endpointer`'s silence window — sits *upstream* of `VoiceEngine`, and when any
of it stalls the engine is not told. `hearing` was therefore a latch with no
exit, which is the same defect `awaitingFinal` already had a fallback for
(§`armFinalFallback`): no latch without a way out.

So an utterance now has a ceiling. `endpointStall()` in `turnTaking.ts` is
pure — `VoiceEngine` is DOM-bound and cannot be constructed in a test, the same
reason `isVoicedFrame` lives in `voiceActivity.ts` — and the 500 ms ticker that
already drives the auto-send countdown asks it once per tick while the state is
`hearing`. Past `MAX_UTTERANCE_MS` (15 s, well past any conversational turn)
`forceEndpoint()` commits whatever text exists, or returns the microphone to
resting if there is none.

It also names the cause, because the two failures are not the same repair: no
frame for `FRAME_STALL_MS` (2 s) means the audio graph stopped delivering and
the turn detector was never asked anything, while frames still arriving means it
was asked and kept answering "holding". An unknown `lastFrameAt` reads as a
stalled pump, not a recent frame — blaming the detector for a graph that never
started would send the next investigation the wrong way.

This is a bound, not a diagnosis. The root cause of the observed stall is still
open; what changed is that it can no longer strand a conversation, and that the
next occurrence writes down which half of the pipeline went quiet.


### 6.26 The prompt said what it could not afford, and told nobody (2026-09-07)

`assemblePrompt` drops a section it cannot fit and carries on, and
`frontierEngine.ts` writes the list of what went into
`InferenceTelemetry.contextBudget.dropped`. Nothing read it. Nothing read
`RuntimeTelemetryService` either — `record()` was called on both lanes and its
`subscribe()` and `getLatest()` had no callers at all, while the same
`telemetry` object was already being handed to `onComplete` directly. It was a
second transport for data that had one, so it is deleted.

The dropped list is not redundant, and it is now on the reply's telemetry row.
A turn given without `screen`, `ask` or `tool-execution-mandate` is a different
turn — the model is not refusing, it was never told it could — and the only
record of that was being computed and discarded. It cost a session to not
explain a chat turn that answered "could you describe the error or provide a
screenshot?" on a machine whose eye works.

`droppedWorthNaming` decides what to say, on `loadWorthNaming`'s principle that
a row crying every turn is a row nobody reads. `completeness`, `multi-agent`
and `house-style` are ranked last *on purpose* — the visual contract alone cost
every "play that song" turn 1,858 characters — so their falling off is the
budget working and is never named. Everything else in the ranking grants a
capability, and its loss is named in the priority order the budget reported.

Not a fix for §6.25's sibling mystery: the screen tool was re-measured live
this session through `AIService.streamMessage` with the UI's own option set and
it **works** — the fence is emitted, `lookAtScreen` is called once, the real
`AssistantService.observe` returns 21 elements and a true description. The
original failure did not reproduce, so what changed here is that a next
occurrence will say whether the model was ever offered the capability.


### 6.27 The voice lane gets its own agent (`coRunner.ts`, 2026-09-07)

Speaking during a run destroyed the run. `classifyTurnIntent` had four
outcomes, and everything that was not praise, a status check or a stop fell
through to `instruction` — which cancels the work and replaces it. So asking
what the work was doing was the one certain way to stop it, and telling the
assistant to be quiet was another: "stop talking" and "be quiet" were literally
in `STOP_PHRASES`.

Three intents now sit between "was that for me?" and "replace the run".

**`hush`** is a split, not an addition. The speech-directed phrases moved out of
the stop set: the voice goes silent, `callInterrupt` is never called, and the
run carries on narrating nothing. Bare "stop", "cancel" and "wait" are
unchanged — those are about the work, and §6.8 still holds.

**`repeat`** re-says `lastSpoken`, which records interjections as well as
replies because an interjection is what the operator most often misses — it
arrives while they are talking. Whatever was mid-sentence is abandoned rather
than queued behind: stacking the repeat behind the sentence they already missed
would bury it twice.

**`explain`** is the co-operating agent. A question about the run is answered
from the run's own tool calls by the local model — `explainRun` in
`coRunner.ts` — and the chat agent is never told it was asked. The two lanes
divide the work: the chat does the job, the voice explains it, and only a real
redirect crosses between them.

Fast and reliable is the constraint, so the model is on a short leash. The
rules gate decides *whether* to spend it, in no time at all; the digest is
bounded to `MAX_CALLS` (12, most recent last) because a tool-call stream is
unbounded and a local window is not; the answer is bounded by
`ANSWER_TIMEOUT_MS` (6 s) and `MAX_SENTENCES` (3). Every failure — no model, a
throw, a timeout, an empty answer — falls back to `summariseProgress`, the same
rules the status intent already trusts. The call is asynchronous and the
microphone returns to resting before it resolves, so a slow model never locks
the operator out.

`explain` is deliberately narrow, and the narrowness is the design. It fires
only on an utterance that is both shaped like a question *and* pointing at the
work: an imperative opener vetoes it, because "rename that file" is a task
however often it says "that". Bare demonstratives need a lookahead — `this` also
matches "who wrote this language", and answering that from a run digest would
be worse than interrupting, because the operator would get a confident wrong
answer instead of a visible mistake.

Two things the tests caught and are worth not re-learning. `useVoice` builds its
own `VoiceHost` proxy, so a new optional host method that is not forwarded there
reaches the engine as `undefined` and silently takes its fallback — the same
trap `progressSummary` fell into. And `"you"` is a filler (it is half of "thank
you"), so `REPEAT_PHRASES` is matched against the raw words too: stripping it
turns "what did you say" into "what did say", which is nothing at all.


## 7. The agent command loop (`services/agentCommands.ts`, `services/commandThrashing.ts`)

### 7.1 Diagnose before retrying (2026-09-05)

Asked for the weather with no API key configured, the engine called Weatherbit,
got a 401, called Weatherstack, got a 401, and called Weatherbit again — six
turns alternating between two vendors refusing for the same reason, stopped
only by `MAX_INVESTIGATION_TURNS`. A 401 reads locally like "this vendor is
down", so the loop's own conclusion was always "try the other one".

`commandThrashing.ts#detectCommandThrashing(executions, nextTurnText)` is a
pure function over the exchange's command history and the model's newest
message, run in `frontierEngine.ts` *before* the fences in that message
execute. It intercepts three shapes:

| Shape | Trip condition |
| --- | --- |
| repeat | The next turn calls a host that already failed this exchange. |
| ping-pong | Two or more hosts have already refused on auth grounds and the next turn reaches for another. |
| placeholder credential | The next turn carries `key=dummy`, `YOUR_KEY`, `appid=xxx` and friends — caught on first use, with no history needed. |

A failure is a non-zero exit or a body matching the auth-refusal shapes (401,
403, "invalid api key", "unauthorized", …). A command that never ran is not
evidence of anything.

On a trip the commands do not run. The turn's observation is a
`[ROOT-CAUSE DIAGNOSTIC NOTICE]` naming the cause and a keyless route for the
subject — `wttr.in` and `open-meteo` for weather, CoinGecko/Binance/Frankfurter
for prices, `ipapi.co` for IP and geo — or, failing a match, a local
`python3`/`node` script. `MAX_THRASH_NOTICES` is 2, after which the loop is
left alone rather than deadlocked. The same rules are stated to the model in
the `[FULL COMPUTER ACCESS & AUTONOMOUS ACTION MANDATE]` system prompt, point 4.

Tests: `tests/command-thrashing.test.mjs` (10).

### 7.2 Approval, and the friction that got it switched off (2026-09-05)

`RunAgentCommandsOptions.autoApproveAll` runs every `confirm`-risk command
without asking, and `frontierEngine.ts` briefly passed it as a hard-coded
`true`. That bypassed `createApprovalGate` entirely — `rm`, `git push`, a
deploy, all of it unprompted — while the gate it bypassed was working and wired
to a UI. `AUTO_COMMANDS` also gained `curl`, `wget`, `ping`, `dig`, `host` and
`nslookup`, which are reads and stay.

The bypass is gone; `approve` decides again. The option survives on the
interface because it is a legitimate thing for another caller to want, but no
caller in this app passes it.

What made the bypass tempting was real, though: the gate asked again for every
single command, so approving `open -a VLC` bought nothing when the next line was
`open -a Safari`. So the gate now remembers, and the unit it remembers is the
**executable** — `commandHead`, the first word:

| | Asks | Remembers |
| --- | --- | --- |
| **Run** | once | nothing |
| **Always `open`** | once | every later `open`, for the life of the gate |
| **Skip** | once | nothing — a denial never creates a standing allowance |

The whole command would be too narrow to be worth remembering, since the next
one differs by an argument; the tool name would be far too broad, since one
`Bash` would cover everything. `⌘⏎` / `⌥⏎` on the prompt is "always".

**The prompt is a card, not a row** (2026-09-06). It began as one 32-pixel
line — a `$`, the command truncated into whatever space was left, three buttons
— which held while every request was a short shell command and broke the moment
agent tool calls came through the same component. The "always" button carried
`commandHead`, and for `mcp__teminali-workspace__recent_projects` the first word
*is* the whole name, so the button grew to the width of the row and pushed
**Skip off the end of it**: an approval the operator could see, could approve,
and could not refuse with the mouse. `describeApprovalAction` now reads the
subject instead of assuming it is a shell command — `mcp__<server>__<tool>` is
shown as its server and its tool, since which server is asking is most of what
makes a tool call judgeable — and the layout is three bands, so nothing
competes for horizontal space: who is asking and the voice hint; the request
itself across the full width and up to two lines, because truncating the text
the operator is being asked to judge is the one thing that makes judging it
impossible; then the answers, with "Always" a fixed word and only the scope
after it able to grow, and truncating when it does. The keyboard contract is
unchanged.

Tests: `tests/agent-commands-approval.test.mjs` (5), and
`tests/agent-commands.test.mjs` pins that the remembered scope stays one short
token for every shape a request can take.

### 7.3 Answering a headless agent's prompts (2026-09-05)

`claude -p` has no terminal. Anything its `--permission-mode` does not settle
outright is therefore refused where a prompt would have gone, which the
operator sees as the agent explaining that *"the command needs your approval and
this session can't prompt for it"* and then doing nothing — with no way forward
but to widen the mode for every future call too.

`--permission-prompt-tool` names an MCP tool to call instead of prompting.
The chain, and it is a chain because the CLI spawns its own MCP servers:

```
claude -p ──stdio──▶ electron/permissionMcpStdio.cjs
                          │  POST /api/agents/permission  (x-teminali-permission-token)
                          ▼
                     server/permission-bridge.js ──┐
                          ▲                        │ NDJSON `permission` event
                          │ POST …/resolve          ▼
                     AgentPane approval card ◀── the operator
```

`server/permission-mcp.js` writes the config file naming the shim (0600 — it
carries the token) and returns three flags: `--mcp-config`, the
`--permission-prompt-tool` itself, and `--allowedTools mcp__teminali_permissions`.
That last one is not optional: without it the first thing needing approval
would be the approver, and the turn would deadlock on its own gate.

**Why a token per run rather than the session bearer.** `agentEnvironment()`
deletes `FRONTIER_SESSION_TOKEN` before spawning an agent, so a CLI that shells
out cannot turn around and drive the gateway. Handing the shim that token back
would undo it. Each run mints its own instead: it reaches exactly one route, it
authorises nothing but answering that run's own prompts, and `closeRun` drops it
when the turn ends.

Every path that is not an answer is a **denial with a reason**, never a hang and
never a rejection: an unknown run, a forged token, a bridge that cannot be
reached, a turn that ended first, and a prompt nobody answered inside
`APPROVAL_TIMEOUT_MS` (5 minutes). A rejection would surface to the agent as a
broken tool rather than as an answer it can act on.

`approvalKey` is the same idea as §7.2's `commandHead` — `Bash(open)`, not
`Bash` — so "always allow" covers the executable and still stops at `rm`.

Codex gets no bridge: it has its own `--sandbox` flag and no prompt-tool
equivalent, so it keeps the mode selector alone rather than a broken dialog.

Tests: `tests/agent-permissions.test.mjs` (14).

### 6.28 The co-agent's answers get a score (`evals/voice-lane.mjs`, 2026-09-08)

`tests/voice-co-runner.test.mjs` (23) pins the routing and the digest, but not
the only thing that reaches the operator's ear: whether the spoken answer is
*true of the digest*. That is a property of the model's prose, so it needs an
eval, not a test. `npm run eval:voice` runs five questions over four fixture
runs — red tests, an edit sequence, an errored command, and a run with nothing
to report yet — and grades four things: the answer came from the model rather
than the `summariseProgress` fallback, it names something really in the run, it
invents no file that is not, and it is speakable. Answers are matched in their
*spoken* form, because `explainRun` pipes output through `speakablePath` and a
grader looking for `Composer.tsx` would score every correct answer as a miss.

**Baseline on qwen3:8b was 7/10 = 70%; it is now 25/25 = 100% at five runs a
case, with no answer falling back to the rules.** The one systematic miss was
`explain-which-file`: asked "which file are you changing?" against a run that
edited `conversation.ts` and then read `Composer.tsx`, the model named the file
it was *reading* — both runs, the same way. It was following `lastText` and the
last line of the digest, and both of those genuinely describe a read.

The fix is in the digest, not the rules. `runDigest` now classifies each tool
call as a write or a read (`WRITE_TOOLS` in `coRunner.ts`), marks every step
line accordingly, and then restates the writes on their own line — *"The only
files it has changed are: …. Every other file named above was read, not
changed."* — or says plainly that nothing has been changed yet. The prose is
labelled for what it is: what the run *said it was doing*, explicitly not
evidence of which file it changed. `explainPrompt` adds one sentence pointing a
"what are you changing?" question at that list. This costs about 50 prompt
tokens on a run with edits in it, and it also carried `explain-failing-tests`
from 1/2 to 5/5 — that case was never flaky, it was reading the same ambiguity.

**Thinking must be off, and this is the important part.** A reasoning model
spends the whole 6 s `ANSWER_TIMEOUT_MS` in `message.thinking` and returns
`message.content` empty, so `explainRun` takes its fallback on *every* question
and the operator never hears a real answer — measured on qwen3:8b at 10.6 s and
0 characters of content with thinking on, against 1.7 s and a real answer with
`think: false`. The failure is silent by design, because the fallback is a
correct-looking sentence. Any host lending `complete` to the voice lane must
disable thinking; the eval sets `think: false` and reports separately when an
answer arrives via the reasoning channel.

Like `eval:local`, it wants the GPU to itself — run one eval at a time.


### 6.8 One name, and a greeting that is not a task (2026-09-06)

Two complaints from the same session. "When I ask for the name it has to say
Temy, even if I run on another code assistant like Claude Code or Codex." And:
"the 'on it' is so inhuman — I say hello, it says I'm on it."

**The name.** `frontierEngine.ts` adds a `[WHO YOU ARE]` block to the system
prompt it already assembles: the assistant is Temy, never the name of the model
answering underneath. The Claude Code lane carries the same sentence through
`--append-system-prompt` (`server/agent-cli.js#AGENT_IDENTITY`), where it sits
beside that CLI's own instructions and never appears in the operator's
transcript. **Codex is not covered:** `codex exec` takes a positional prompt and
no system-prompt flag, so the only ways in are prefixing the operator's own text
— which they would see — or putting persona instructions in a repo file that
also governs developer sessions here. Neither was worth it; a Codex tab still
answers with its own name.

**The greeting.** The phrase the operator heard, "I'm on it", is in neither
canned list in `acknowledgment.ts`, so it came from the model, and the
correction is in the same `[WHO YOU ARE]` block: greet a greeting, and keep work
acknowledgements for work actually started. `acknowledgment.ts` was also strict
about where a greeting may sit — its tests are anchored at the start of the
utterance, so "Temy, hello" and "um, hello" missed the greeting branch and fell
through to a canned acknowledgement. A leading filler or wake word is now
stripped before the test, which matters because speech is what feeds this and
speech arrives with exactly that preamble. "What's your name" and "who am I
talking to" join that branch. Tests: `tests/voice-identity.test.mjs`.

### 6.29 She is called Temi (`realtime-voice/code/system_prompt.txt`, 2026-09-09)

The persona prompt opened `You are Countess Isabella "Bella" Soranza de Parme`,
and the product had been calling her Temi everywhere else for two releases —
`TemiVoiceStage.tsx`, the assistant pane of the day, §6.8's wake word, this
document.
The voice introduced herself by a name that appeared in no other part of the
system.

**What moved.** Her name, and only her name. Line 1 is now `You are Temi, the
voice of Teminali OS`; the Italian-aristocrat backstory on line 2 goes with it,
while the manner it introduced — unhurried, razor-sharp, no corporate fluff —
is kept word for word, as are all nine worked examples, now answered by `Temi:`.
The anti-melodrama rule on line 23 leaned on the aristocrat framing for its
contrast and reads "sharp and grown-up" instead. `bella_moves.py` →
`temi_moves.py` with its eight importers, its tests, and its three environment
knobs (`TEMI_MOVES`, `TEMI_CARE_TAG`, `TEMI_REPAIR_BUFFER_WORDS`). The rename also
flipped `TEMI_MOVES` from a default of `1` to `0`, and since nothing in the repo sets the
variable that silently made the joke and both repairs dead code; it is back to `1`, and
`defuse_for_history` no longer sits behind the flag at all, because history hygiene is not
an injection. See `realtime-voice/LOCKED_PIPELINE_SPEC.md` D5.

**What deliberately did not move.** The Kokoro voice blend is a different thing
wearing the same word. `bella_soranza` is a profile key in
`audio_module.py:366`, fitted from reference takes in `resources/bella/` by
scripts that eleven `BELLA_*` tuning variables and roughly fifty code comments
cite by path. Renaming that family would make fifty doc claims false and break
the style tensors and preview WAVs on disk, to change a string no operator
reads. `pure_isabella` is likewise a Kokoro voice, not her.

**Not yet re-measured against the ear.** §6.0.4's result — 9 fabrications in 27
answers down to 0 — was measured against the prompt as it read before this
rename. §6.30's baseline is the first measurement of the renamed prompt and it
is a different, harder instrument; the 0-fabrication claim should be treated as
carried over, not reconfirmed.

### 6.30 A conversation gets a score (`evals/voice-conversation.mjs`, 2026-09-09)

§6.28 scores one answer about a run in flight. Every fault the operator actually
reported needed more than one turn to appear: a file named that nobody
mentioned, a pleasantry sent to an agent, a fact lost four turns back, the same
sentence for the eleventh time. None of those is a property of an answer. They
are properties of a conversation, and nothing measured one.

`npm run eval:conversation` drives `routeVoiceTurn` across three scripted
conversations — 27 turns — keeping history exactly as `server.py:903` and
`llm_module.py:680` keep it, and calling the real model only on the turns that
really reach it. The routing is real, so a mis-route is a finding. The model is
real, at the shipping temperature of 0.7 rather than the co-runner's 0.1. The
**hands are fixture**: a delegated turn appends the tool calls the script says
were made, because this measures the voice and not whether an agent can do a
task. Four buckets, one per demand: `fabrication`, `route-to-hands`,
`route-to-chat`, `recall`.

**The window is 20 messages, not 6.** `server.py` trims history after every user
turn and every assistant turn; ten exchanges, then a fact falls off the back.
The comment at `speech_pipeline_manager.py:192` says six turns and is wrong.
The eval scores a recall probe on each side of that cliff.

**Baseline, 2026-09-09, qwen3:8b, one run: 19/27 = 70%** — fabrication 6/9,
route-to-hands 5/6, route-to-chat 7/10, recall 1/2. Three of the first
baseline's eleven failures were the author's wrong expectations, not defects:
"was that a big change", "how many files have we touched" and "which branch am
I on" all name something the hands can go and establish, so the gate routing
them there is correct. They were re-specified and the transcript re-graded
offline. That is what `--regrade` is for, and why every run is saved: a grader
written for this last time flagged nine good answers and let "The build is
complete" through untouched, so no number here is trusted until the answers
underneath it have been read.

**The eight real findings.** `STATE_QUESTIONS` is phrasing-specific — "what is
the port the server runs on" walks straight past it and she answers "The port is
8080", the exact invention §6.0.4 closed for "which port". "Which file are you
in", asked mid-run, delegates to a *second* agent instead of answering from the
digest the way §6.28 does. "Quiet for a second" is not in `HUSH_PHRASES` and
"never mind, drop it" is not in `STOP_PHRASES`, so both get a spoken reply. She
told a "man walks into a bar" joke that the prompt bans by name, twice. Three
answers ran to four sentences against a stated maximum of three. And beyond the
20-message window she does not merely forget the fact — she invents a
replacement for it.

**Two of the eight are closed; the fifth is not (2026-09-10).** Findings 1 and
2 are gate defects and were fixed here. Finding 5 is a defect in what the model
says, and every place it could be caught is in `realtime-voice/code/` — see
below.

**A gate that holds for one wording holds for none.** `STATE_QUESTIONS` had a
pattern per wh-word and each demanded its noun immediately after it, so it held
for "which port" and walked past "what *is the* port the server runs on".
Nobody tells the operator which of those is the safe wording. The two patterns
are now one, with the copula and a single determiner allowed to sit in between,
plus a closed list of state adjectives — "the last commit", "the current
branch". `a`/`an` are excluded on purpose ("what is a branch" asks the world,
not this machine), and so is an open adjective slot: "what is the best model"
is taste, which the hands cannot settle by looking.

The other half of that finding is that the gate could not have caught the
question anyway. `port`, `version` and `model` were nouns `STATE_QUESTIONS`
asked about but were not in `MACHINE_OBJECTS`, and both halves must agree
before a sentence reaches the state branch — so a bare "what's the port" had no
path to the hands however the patterns were written. A noun the voice will
invent a value for belongs on both lists or on neither; those three are now on
both.

**"Which file are you in" is answered from the digest.** `WORK_DEIXIS` only
recognised a question that points at the run with a demonstrative — "that
file", "this command". A question can also point at the run through the agent
doing it, and that phrasing carries no demonstrative at all, so it fell to
`instruction` and `machineAction` read "which file" as work: the operator
asking one agent what it was doing got a second agent dispatched to find out.
`SELF_WORK_QUESTION` in `turnIntent.ts` is the other road to the same `explain`
verdict — a work noun against the wh-word, with the assistant or the work as
the copula's subject. The subject is the whole test, so "which file should I
open" keeps its own subject and stays an instruction. Idle, the question still
goes to the hands: there is no digest to answer from, and the hands can
establish it — the same re-grading this section already applied to "which
branch am I on".

**Finding 5 — the banned joke — is explicitly not closed.** It is not a routing
defect and cannot be fixed by one: "tell me a joke" is conversation, and it is
correct that it reaches the persona. The rule it broke is stated in
`realtime-voice/code/system_prompt.txt:29` and broken anyway, which is the
condition §6.0.4 named — a prompt is not a gate. The three places that could
enforce it are the prompt, the token stream in `llm_module.py`, and a filter
beside `repetition_filter.py`; all three are Python, all three are in
`realtime-voice/code/`, and the audio for that lane is synthesised there — the
renderer receives PCM (`realtime8000Engine.ts`, `tts_chunk`), never prose it
could still refuse to speak. So no change in `src/services/voice/` can reach
it, and none was made rather than leave a guard that looks like enforcement and
is not. Findings 3, 4, 6, 7 and 8 are likewise untouched and still true.

**No new score is claimed.** Two of the 27 turns — the port question and "which
file are you in" — now take the routes the script expects, asserted against
`routeVoiceTurn` directly so they stay measured when Ollama is down. The eval
itself (`npm run eval:conversation`) was not re-run, so the 19/27 baseline
above stands as the last thing actually measured against the model.

Files: `machineAction.ts` (the state patterns and the object list),
`turnIntent.ts` (`SELF_WORK_QUESTION`). Verified: `machine-action.test.mjs` and
`voice-turn-router.test.mjs` together — 109 tests, 109 pass, of which 24 are
new; `tsc --noEmit` clean.

### 6.31 One surface, and the mute key is the door between its two halves (`TemiVoiceStage.tsx`, 2026-09-09)

The voice screen was three surfaces pretending to be one: a stage with a
centred orb, a floating activity pane in the top-right corner, and a status bar
above the composer that repeated the pane's contents. The operator's verdict was
"not very friendly", and the diagnosis is in the count — three places to look,
none of them the conversation.

Rebuilt against a reference screen the operator supplied. **What it looks like
is not the interesting part; what it removes is.**

**One surface.** There is no second screen to switch back to. Muting the
microphone does not disable anything — it *is* the text mode, and unmuting *is*
the voice mode. Same transcript, same composer, same `routeVoiceTurn` switch
underneath (§6.0.2), so the two halves cannot drift apart, and typing works
before microphone permission has ever been asked for. The mic button is
therefore the only mode control on the screen, and it is labelled as one:
"Voice on — just speak" / "Voice off — type instead".

**The transcript is kept, in both modes** — reversing §6.0.3 on instruction.
Muted, scrollback is the entire point of a text chat; unmuted, it is the record
of what ASR actually heard, which is what anyone reaches for when a spoken
answer went past too fast. Auto-scroll is pinned to the bottom only while the
operator is already there: scrolling up to re-read something is not yanked back
by the next turn landing.

**The asymmetry is load-bearing.** The operator's turns are right-aligned blue
bubbles; Temi's are plain left-aligned prose with no bubble at all. Two facing
walls of bubbles is what makes a chat feel like work; one wall against prose
reads as someone talking to you. This is the one thing from §6.0.3 that
survived intact — and it is why the returning action row (copy, mark, overflow)
sits under Temi's answers only.

**The activity pane is deleted.** `TemiAssistantPane.tsx` is gone, and with it
the store's `activeTab`. The Teminali OS assistant's entire standing presence is
now the one process line in the composer's project tab (`AgentActivityTicker`,
§6.44), exactly as
§6.0.1 said it should be and never quite was. Clicking that line opens
`TemiActivityDialog` — the full log, paged 20 rows at a time as you reach the
end, so opening it mid-run costs one screenful rather than the whole feed.
`TeminaliAgentBridge.delegateTask` no longer calls `setOpen(true)`: **nothing
opens the log but a click.** A panel that appears on its own is a second chat
arriving uninvited, which is the thing this design exists to prevent.

**Everything the pane held survived it.** The two header icons carry it: the
first opens the reference screen's "In this chat" menu — Create new, Open from
Library (the workspace files the pane's Files tab held, opening in place rather
than as a submenu), Sources → Connect plugins; the second opens voice settings,
where the persona picker went. The pane's background-engine grid was **not**
carried over: an effect in the stage re-asserts `activeEngine` from the
composer's model picker whenever that picker changes, so the grid was a second
control over one value that silently lost the next time the first was touched.
The picker leads, and now it is the only one asking.

**Two controls in the composer pill mean what the reference means by them.**
"High" is the model/engine picker (`components/chat/ModelPicker.tsx`), not a
separate voice-quality setting —
one dropdown, showing the profile name with `Frontier ` stripped, because that
prefix is on all of them and so distinguishes none of them. The circular `X`
ends the *voice session* and keeps the conversation; **Create new** is the only
thing that clears it, and it is behind a menu, because a persistent transcript
makes an accidental wipe expensive in a way an ephemeral one never was.

**Temi's side is markdown; the operator's is not** (`TemiTranscript.tsx`,
`chat/CursorMarkdownRenderer.tsx`, 2026-09-10). The transcript rendered
`{turn.content}` as one string, so an answer with a heading, a table or a
`**bold**` opening reached the screen as its own source. Temi's turns now go
through the renderer the panel chats already use rather than a second one
written for this surface; `scale="stage"` is what adapts it — 16px prose at
1.75, `text-current` so this screen's palette governs instead of the token ramp,
and emphasis carried by weight alone, because brightening text that is already
`#f3f3f3` does nothing. Headings on the stage are deliberately quiet — 20/18/17
against 16px prose, separated by weight and the space around them rather than by
size. A turn here is one or two spoken sentences; at document weight (22/19/17)
a two-line answer with an `##` in it read as a report, which is not what a voice
screen is. Taking them to 18/17/16 overshot the other way and read as small, so
the rule is the one in the middle: the size only has to say "this is a heading",
and the weight and the space do the rest. Nothing on this surface is set below
prose except the `####` label, which case and tracking already mark as chrome —
in particular the table inherits prose size, because dropping the densest block
on the screen to 14px made it the least readable thing on it. The operator's bubble stays literal: what they typed is
what they see. The live caret is passed in as `trailing` and lands inside the
final paragraph, so a half-spoken sentence still ends in a caret rather than
dropping one onto the line below. One consequence worth stating: a single
newline inside a turn is now a soft break, as it is everywhere else in markdown,
where the old `whitespace-pre-wrap` kept it as a line break.

Files: `TemiVoiceStage.tsx` (the stage and the socket), `TemiTranscript.tsx`
(the turns, presentational — markdown for Temi, plain for the operator),
`TemiActivityDialog.tsx` (the log), `TemiStagePanels.tsx` (the two header
popovers). Verified: typecheck clean, production build clean, 1932/1932 studio
tests.

### 6.32 The picker was a list, not a menu (`components/chat/ModelPicker.tsx`, 2026-09-09)

Nineteen rows in one flat column — four Frontier lanes, three permissions,
eight Claude Code models, four Codex — running off the bottom of a laptop
screen with the composer behind it. Everything in it was correct and none of it
was findable. The operator's word was "not top tier".

**It is a tree now, and only one branch opens at a time.** The branches are the
assistants — Frontier, Claude Code, Codex — and the leaves are their models.
Collapsed, the menu is three rows; open, it is three rows plus the models of
the one assistant being looked at. The branch holding the current selection is
the one that opens, and re-opening the menu re-opens it, because a menu that
remembers a fold from three selections ago opens onto the wrong assistant.

- **A folded branch still answers the question.** Each collapsed branch carries
  the name of its selected model on the right, and a check. Folding hides rows,
  never the answer to "what am I running". Open, that summary is a duplicate of
  the row below it, so it goes.
- **Permissions moved inside the branch they belong to.** They are one agent's
  permissions and were floating between the lanes and the models, applying to
  something the eye had to remember. They now sit under that agent's models,
  and only when that agent is the selection.
- **The keyboard walks what the eye sees.** The flat row order is derived from
  the open state, so a collapsed branch's models are not reachable by an arrow
  key when they are not reachable by a mouse.
- **Not-installed agents are still left out**, not greyed. Unchanged, and for
  the unchanged reason: a dead row in a picker is noise.

The composer pill that opens it was truncating `Claude Code · Default` to
"Claude Cod…" — cutting the half that identifies the model and keeping the half
the picker already names. `shortEngineLabel` now drops both dead prefixes, the
agent name and `Frontier `, and the full label stays on the tooltip.

### 6.33 The mark was already a face (`components/voice/TemiCanvasOrb.tsx`, 2026-09-09)

Two asks arrived together at the end of the previous session: the orb was blue
in a product whose primary is green, and it had no face.

**The recolour is the whole voice surface, not the orb.** The operator chose
"everything green, bubbles too", which reverses one deliberate borrow: §6.31
took the transcript's `#1e3e82` operator bubble straight from the ChatGPT
reference. It is now `#06512f` — the brand hue (~151°, the same as `--accent`
`#00bf63`) at the luminance the navy carried, so white body text keeps ~9.7:1
and nothing about the bubble's legibility changed. **The bubble asymmetry from
§6.0.3 still holds**: the operator gets a bubble, Temi gets prose.

The rest, all measured against the same green family: the header status dot
(`TemiVoiceStage.tsx`), the process line's running state
(`AgentActivityTicker.tsx`), the activity dialog's `#38bdf8` command text and
`#0c1f38` live card (`TemiActivityDialog.tsx`), and the three `text-sky-400`
checks in the two header popovers (`TemiStagePanels.tsx`). Rose and amber
survive: a barge-in and a dropped socket are alerts, not brand moments.
`AstraVoiceOrb.tsx` still holds blue literals and was deliberately left alone —
it is exported from `components/voice/index.ts` but the stage does not use it.

**Five states still have to be distinguishable once they are all green**, so
hue no longer carries the state and lightness does: idle is a pale pearl,
listening a high-key mint, speaking the brand green itself, thinking a cool
teal, barge-in the unchanged rose. The dot and the orb are driven from the same
ladder so they can never disagree about what she is doing.

**The face is the logo.** `teminali-logo-512.png` is `>` `_` `<` — a terminal
prompt that is already an emoticon — so nothing was designed: the mark is drawn
onto the bead and then given what a still mark cannot have. Every literal
collapses back to it, and at openness 1, brow 0, mouth 0 the canvas draws the
logo exactly, which is why the idle orb still reads as the brand.

What makes it read as alive, each independent and composed:

- **Gaze** follows the pointer on `window`, not on the canvas — an orb whose
  eyes wake on hover is a hover effect. The spring is deliberately underdamped
  (ω≈5.1 against a critical damping of 10.2) so the gaze overshoots and settles
  the way an eye lands rather than lerping.
- **Micro-saccades** every 0.42–1.5s. Perfectly steady eyes are the loudest
  tell that a face is a graphic.
- **Blinks** on their own 2.2–6.6s schedule, shut over 34% of the 0.2s and open
  over the rest; 22% of them are doubles. The asymmetry is what separates a
  blink from a pulse.
- **Breathing**, a 1.4% scale at 0.21Hz that the energy pulse never masks, so
  she is visibly alive in total silence.
- **Emotion** is five expression records eased into at a fixed rate, never
  swapped — a face that snaps between states reads as a sprite sheet. Thinking
  additionally looks up-and-left and ignores the pointer, which is where a
  person's eyes go to recall something.
- **The mouth** is driven by the same assistant energy the orb pulses to, with
  a fast attack and a slow release because that is what a mouth does. Both lips
  share two anchored corners and differ only in their control points, so it
  opens as a lens and closes onto the bar.

The face is drawn inside the contour clip and **under** the specular sheen: on
top of the highlight it sits on the bead like a sticker, beneath it it is in
the bead. The sheen dropped from `0.62` to `0.40` alpha because at full
strength it washed out the left eye, which now sits under it.

Timing is wall-clock (`performance.now()`), not the existing per-frame
`phaseRef` counter, so blinks and saccades keep their rhythm on a slow frame.
All life state lives on refs: the render effect restarts on every energy prop
change, and a blink that reset with it would tick like a metronome.

**Verified by rendering it, not by reading it.** `studio/node_modules/.bin/esbuild`
bundles a harness that mounts the real component, Electron loads it offscreen,
dispatches a `pointermove` and captures every state in one frame. Three defects
survived typecheck and were caught only in the picture: the open mouth drew a
rounded slab that collided with the eyes, the bevel read as a blurry double
stroke, and — because canvas Y grows downward — the "gentle smile" at idle was
drawing a frown.

**Hover is amber, the click stays rose, and neither snaps.** Colour became data
rather than branches to make that possible: every state carries the same shape —
three glow stops, five shader stops, all RGBA — and each frame eases the
displayed palette toward the current state's. An orb that jumped to amber under
the pointer would read as a CSS `:hover`, which is the one thing this orb is
not. State changes now cross-fade as a side effect, which they never did before.
The ripple is checked first in both ladders, so being told to stop outranks
being pointed at. Hovering also perks the face into `GREETING` — wider eyes, a
lifted brow, a fuller smile — but only from idle: perking up mid-sentence would
read as a flinch.

Hover was verified through `pointerover`, not `pointerenter`: React derives
`onPointerEnter` from `pointerover`/`pointerout` delegation at the root, so a
dispatched non-bubbling `pointerenter` leaves the handler cold and the first
capture showed an unchanged green orb. The component was correct; the harness
was not.

**She knows what she looks like.** `realtime-voice/code/system_prompt.txt` gains
a `WHAT YOU LOOK LIKE` section and three worked exchanges, so a question about
the orb gets an answer in character rather than a shrug. The framing matters:
the persona's hard rule is that she has no eyes on the screen and may never
report a state she was not given, so the section grants her the *design* — the
mark is her face, the brackets are eyes, the underscore is the mouth, the colour
ladder means what it means — and explicitly forbids her from claiming which
state is showing right now, or that anyone is pointing at her. Knowing your own
face is not the same as seeing it. Note that
`realtime-voice/resources/bella/persona_eval.py` measures this prompt; the
section lengthens it, so re-measure rather than quoting the old count.

### 6.34 The bead became a screen (`components/voice/TemiCanvasOrb.tsx`, 2026-09-09)

§6.33 put the mark on the orb but kept the orb a pearl: a pale luminous bead
with a dark mark pressed into it. The operator's reading was sharper — the name
is a terminal and the mark is a terminal prompt, so the centre should be black
and the mark should be lit. **The orb is now a screen in a lit bezel**, which is
the same object it always was, finally drawn as itself.

**The plate.** `SCREEN` is a fourth palette in the same `Stop[]` shape as the
others, laid over the pearlescent shader and under the face: opaque through the
core, alpha 0.88 at 0.80 of its radius, gone at 1.0, drawn at `radius * 0.88`
and centred on the bead rather than on the moving highlight — the screen is
flat, the glass over it is what moves. It is not `#000`: a black carrying a
trace of the brand hue (`[2, 9, 6]` → `[7, 24, 15]`) meets the green rim
without the seam a neutral black shows against a saturated edge.

**This costs the state ladder nothing.** Hue was never read from the middle of
the orb; it is read from the rim and the halo, and the plate reaches neither.
Rendered side by side, hover-amber and click-rose are *more* legible than they
were on the pearl, because black gives a saturated rim something to be
saturated against. The face geometry is untouched, so §6.33's constraint still
holds: at openness 1, brow 0, mouth 0 the canvas draws the logo exactly. Only
the polarity is new, and white-on-black is what a prompt has always been.

**Ink became phosphor.** The mark is `rgba(236, 255, 244, 0.96)`. The pale
second pass is no longer a bevel: a one-pixel lift made sense when a dark mark
was pressed into a pale bead and reads as a smear on a lit one, so the same
geometry is now drawn *concentric* at 2.2× the line width as a bloom. The
offset had to go, not just shrink — an offset pale stroke under a bright one is
the blurry double stroke this file already shipped once.

**The open mouth needed its own colour.** It was filled with the stroke colour,
which was correct while that colour was dark and puts a white slab on the screen
the moment it is not. `MOUTH_LIGHT` (`rgba(190, 255, 222, 0.26)`) makes the
opening a lens of light instead, stroked in full phosphor.

**The specular sheen was the real casualty, and only a render found it.** The
broad 0.40 disc a pale bead could carry sits on black as a grey thumbprint
smudged across the left eye — the same washing-out that already cost it
0.62 → 0.40 in §6.33, except black gives it nowhere to hide. It is now a
glancing arc on the upper-left bezel, off the face entirely: dropped to 0.16,
flattened to 0.4 on its minor axis, and given a gradient so it has no edge to
notice. The gradient is built round *before* the squash transform, because a
canvas gradient is fixed in the user space it was created in — build it after
and a circular falloff meets an elliptical hole at a hard rim.

**Her self-description was corrected in the same turn**, because §6.33 had
taught her a face that no longer exists.
`realtime-voice/code/system_prompt.txt` now says she is a black terminal display
inside a ring of light with the mark lit white on it, and the colour ladder is
attributed to the ring rather than to the whole of her. The worked exchange
answering "what do you look like" was rewritten to match; the rule that she may
describe the design but never claim which state is showing is unchanged.
`realtime-voice/resources/bella/persona_eval.py` measures this prompt — its
length moved again, so re-measure rather than quoting a count.

**Verified by rendering, not by reading.** The §6.33 harness was rebuilt in this
session's scratchpad rather than reused: `esbuild` bundles an entry that mounts
the real component, Electron loads it offscreen, and one capture takes all five
states plus a dispatched `pointerover` and `click`. Typecheck and production
build are clean, but neither would have caught the thumbprint.

### 6.35 An attachment reached one engine out of four (`services/aiService.ts`, `server/agent-attachments.js`, 2026-09-09)

The chat has had complete attachment intake for some time — drag, drop, paste,
a picker, `AttachmentStrip`, `hooks/useAttachments` — and `composePrompt`
(`services/fileService.ts:76`) splits what it collects two ways: anything with
text becomes a `<<< attachment: … >>>` block inside the prompt, and images
become a separate `images: string[]` of data URLs. The blocks reached every
engine. **The images reached exactly one.** `streamMessage` passed
`attachedImages` to `FrontierEngine.streamLocal` and to nothing else, so a
picture attached to a Gemini, Claude Code or Codex turn was collected, shown in
the strip, and dropped on the way out.

Worse than dropped, in the case that had no other text: with only images
attached `composePrompt` sets the prompt to *"Look at the attached image(s)."*
So the engine was not merely blind, it was told to look at something it had
never been given, and answered anyway.

**Gemini needed nothing new on the server.** That lane posts the Anthropic
Messages shape to `/api/gemini/v1/messages`, and `server/geminiBridge.js`
already translates an `image` content block into the `image_url` data URL Gemini
wants — it had been able to carry images the whole time and had never been sent
one. `streamFromGemini` now sends a content-block array instead of a string on
the one turn that has attachments, and a plain string on every other, because
the bridge unwraps a lone text block back to a string regardless.

**The two CLIs needed a disk.** Claude Code and Codex are processes, not
providers: `argsFor` proves the prompt is argv (`claude -p <prompt>`), and a
5 MB base64 string is not an argument. Both read images from files instead, by
two different routes, and the difference is measured rather than assumed:

- `codex exec` has `-i, --image <FILE>...`, so Codex takes the files as a
  first-class flag. The **`--image=<path>` form** is used, one per file. The
  flag is variadic, and a variadic flag given its value positionally keeps
  eating arguments — including the positional prompt, which has to stay last.
  `=` binds exactly one value and stops.
- `claude` has no equivalent flag; it reads images with its own Read tool. So
  the paths are named in the prose, ahead of the operator's words rather than
  after them — an instruction that arrives after the question is one the model
  has already started answering without.

**Where the bytes land is a permission decision, not a tidiness one.**
`server/agent-attachments.js` writes them under the agent's *resolved working
directory*, not in a system temp dir, because Claude Code anchors its read
permission at cwd: an image in `/tmp` is outside the workspace and earns a
prompt or a refusal for a file the operator already chose to attach. The
directory (`.teminali-attachments/<run>/`) carries its own `.gitignore`
containing `*`, so a turn that runs `git status` mid-flight does not watch the
operator's repository grow four untracked files.

**Materialised in `runAgentTurn`, not in the route.** That is where the cwd has
already been resolved and boundary-checked by `resolveAgentCwd`, and where
`finish()` is the single funnel every ending goes through — a normal exit, a
timeout, an abort — so cleanup hooks once instead of on four paths. The one path
that bypasses the funnel is a spawn that never starts, and it cleans up on its
own way out. A resumed session keeps the image *content* — Codex embedded it in
its request, Claude read it into its transcript — but not the files.

**The limits are the renderer's, re-checked.** `services/attachmentPolicy.ts`
already sets 4 images and 5 MB total; `agent-attachments.js` enforces the same
two numbers rather than inventing new ones, because a limit only the client
enforces is not a limit. The 1536px cap is deliberately not among them: that is
a client-side resize, and a server can only honestly police bytes and type.
Declared media types are checked against the file's actual magic bytes — a data
URL is operator input claiming its own type, and the answer to that claim gets
written into the workspace.

**Validation happens before the 200.** Past the NDJSON header the only way left
to refuse a request is an `error` event inside a stream the client has already
committed to reading, which is a worse answer than a status code — so
`/api/agents/run` checks the images beside its existing prompt and cwd
validators and returns a named 400.

**The general JSON cap would have refused every attachment.**
`FRONTIER_MAX_JSON_BYTES` is 1 MB and base64 is a third larger than the bytes it
encodes, so a legal 5 MB attachment set arrived as a ~6.7 MB body and was
rejected as malformed long before anything could say why.
`FRONTIER_MAX_AGENT_JSON_BYTES` (12 MB) is the agent route's own allowance,
following the precedent `FRONTIER_MAX_OLLAMA_JSON_BYTES` set for the local
vision lane — a wider door for one route rather than a wider door for all of
them.

**Verified by the argv the production path actually built.**
`tests/agent-attachments.test.mjs` drives the real `runAgentTurn` against a fake
agent that prints its own arguments, so what is asserted is Codex's
`--image=` list with the prompt still last, Claude's paths inside `-p`, and an
empty attachment set producing exactly the turn it always was. 1945/1945 studio
tests, typecheck and production build clean.

**And verified against a live CLI, for one of the two.** A generated PNG of
three colour bands — red, green, blue, top to bottom — went through the real
`runAgentTurn`: Claude Code read the file it was pointed at and answered *"Red,
green, blue."* So the prose route works, which was the half of this that no
flag guaranteed. **Codex could not be reached the same way, and not because of
the image**: this machine's configured model (`gpt-6-astra`) requires a newer
CLI than the installed `codex-cli 0.149.1`, and the fallback tried is not
available to a ChatGPT account. Its turn ran far enough to be refused by the API
rather than by argument parsing, and its `--image=` vector is asserted against
the production path in the tests — but no Codex turn has yet been answered from
an image, and it will not be until that CLI is upgraded. The attachment
directory was gone after both the successful turn and the failed ones.

### 6.36 Two references, and each answers a different question (`components/voice/TemiComposer.tsx`, 2026-09-09)

The chatbox was rebuilt to the Codex desktop composer, and the empty chat was
laid out the way Cursor lays its empty chat out. Those are not competing
specifications; the operator supplied both screenshots and they answer different
questions. **Codex owns the box.** **Cursor owns where the box sits when there is
nothing in the conversation yet.**

The box, drawn in `TemiComposer`:

- a project tab above its top edge — folder icon and the workspace name, or
  "Choose project" — inset on both sides with square bottom corners, because it
  is a narrower panel *behind* the box with its top showing, not a floating chip.
  Since §6.44 it is a row of two controls: the project name, then a hairline and
  the assistant's live process line;
- a 16px body on `#252525`, borderless, against the stage's black canvas;
- the placeholder floated to the top-left of a field that starts 52px tall and
  grows to 200px. It is a `textarea`. The control it replaced was an `<input>`,
  so a second line of a draft scrolled out of sight while it was being written;
- a control row: `+`, the approvals chip, a spacer, the engine, the microphone,
  and a filled send disc that is white when there is something to send and
  `#2f2f2f` when there is not.

**The approvals chip does not say "Approve for me".** Codex writes that because
Codex has one mode. Ours has several and `manual` asks before every tool call, so
the chip names the rung actually in force — `PERMISSION_LABELS[agentPermission]`,
now exported from `ModelPicker` so the chip and the menu cannot disagree — and
falls back to the noun "Approvals" rather than to a claim about behaviour the
engine may not be in. Pressing it opens the same picker that owns the rungs.

**The engine label is drawn in two parts,** the way Codex writes "Custom Light":
name in near-white, variant muted. `splitEngineLabel` replaces
`shortEngineLabel`, which kept one word because the old pill had room for one —
and kept the wrong one. Every agent selection reads "Claude Code · Default", and
truncating from the left cut away the half that identifies the model. The new row
has a spacer in it, so both halves fit and the *variant* is what gives way when
the panel is narrow.

**The end-voice `X` is drawn only while there is a session to end.** Codex's row
has no such button, and an idle pipeline has nothing to leave.

#### Where the box sits

`isEmpty` is `turns.length === 1 && turns[0].id === "init-temi"`, not
`turns.length === 0` — `dialogueHistory` is seeded with Temi's greeting and
`handleCreateNew` puts it back, so a test for an empty list would mean the
landing screen never appeared. A live utterance appends to `turns` before the
history does, so the layout switches the moment the operator speaks.

On the landing screen the orb, the box and the openers are one centred column and
the transcript is not drawn at all: a welcome sentence stacked over a centred
composer is the busyness this layout avoids, and the greeting is not lost — it is
the first thing in the conversation as soon as there is one. Under a conversation
the box docks to the bottom as before, the orb moved from `bottom-[104px]` to
`bottom-[172px]` and the transcript's tail padding from `pb-[248px]` to
`pb-[300px]`, because the Codex box is ~138px tall against the old pill's 56.

The box and the orb are each held in one binding and rendered in both arms.
Two copies of that markup is how two layouts drift apart.

#### The openers under it, and why they are a restoration

`TemiActionRow` — *Plan New Idea*, *Screen Recorder*, *Recent Projects*,
*Connect Your Repos* / *Open a Repository* — **on the empty chat and nowhere
else.** They are ways to start, and once the conversation exists, starting is
over.

None of it is new machinery. Every one of these surfaces was already built and
had nothing pointing at it: `useRecorderDialogStore`, `useProjectLibrary` and
`useGitHubStatus` were all still being read by `StudioChat`, whose render was
replaced by the voice stage — `recentProjects`, `openRecorder`, `openEntry` and
`openPanel` were computed there every render and used by nothing. This is that
row put back in the Codex idiom, against the same hooks. *Recent Projects* opens
a popover of the six most recent entries and calls `openEntry`, which is what
routes a video project away from `POST /api/workspace/open`; the legacy row could
not do that, and `StudioSidebar` is still where the whole library lives.

#### Three marks drawn by hand, and looked at

Lucide has no correct form of any of them, so `TemiComposer` draws them:
`GitHubMark` is the octocat path GitHub publishes, filled — a brand mark is a
specific shape and an outline approximation of it reads as a mistake.
`RecordDot` is a red disc inside a `currentColor` ring; red is the one place on
this screen it is not an alert, because that is what a record control has been
for fifty years and a muted one would not be read as one. `LightBulbMark` is a
filled dome over a screw base **of two bars**, not the conventional hairline:
these are drawn at 14px, and the first attempt — Material's filled bulb — was
rendered and looked at, and read as a mushroom because its base vanished at
that size.

Rendered and looked at is meant literally. The repo has no browser harness, so
the three `<svg>` blocks were extracted from this component and screenshotted
in headless Chrome at the pill's real size and colours before being kept. That
is the check the rest of this section could not have.

`tests/temi-composer.test.mjs` — 6 tests. Source-reading, in the idiom of
`composer-input.test.mjs`, because the node runner cannot import JSX: the field
exists and is a `textarea`, `isEmpty` is not a length-zero test, the action row
is inside the `isEmpty` arm only, the box and the orb are each rendered from one
binding in two places, every opener reaches a hook that exists, and the chip
renders what it was handed.

1951/1951 studio tests, typecheck clean, production build clean.

#### Looked at in the running app (2026-09-09)

The repo still has no browser harness, but it does not need one to be looked at:
the Vite dev server on `:3000` is the whole UI, and headless Chrome drives it
over the DevTools protocol with `Network.setBlockedURLs` holding every engine
route, so a turn can be submitted and the docked layout reached without a model
ever being called. That is how the following were measured rather than guessed.

What holds:

- the docked arm. The orb's `bottom-[172px]` clears the box, and the margin is
  smaller than it looks: in an 813px viewport the tab's top edge is at 653 and
  the orb's **painted** glow ends at 626 — **27px**. Its `<canvas>` is 80px for
  a 51px orb, so the *element* stops at 641 and clears by only 12. Neither is a
  collision, but the canvas padding is the whole margin, so anything that grows
  the box past ~136px needs `bottom-[172px]` moved with it;
- `isEmpty` switches on submit, the openers disappear with it, and Temi's
  greeting appears as the conversation's first turn exactly as this section
  claims it would;
- the centred arm still centres at a narrow panel: at an 860px window the box
  is 558px wide with equal margins, `document.scrollWidth` equals the viewport
  so nothing overflows sideways, and the engine label keeps both halves at
  123px. The openers wrap to a second row and stay aligned to the box's left
  edge;
- the field grows: 52px to 104px on a wrapped draft, `overflow-y: auto`, box
  108px to 160px, no ceiling breach.

What did not hold, and has been fixed: **the project tab read as a separate
chip, which is precisely what this section says it must not.** The cause was not
the geometry it was assumed to be. Reading the rendered pixels down a column
through the seam — the check that settled it — the canvas behind the box is
**pure black**, not the `#151515` the body carries; the tab's `#1c1c1c` rendered
28 at its top and fell to **24** at the seam, against a body of 37. That put the
tab almost exactly *midway between the canvas and the box*, which is what makes
a surface read as its own object rather than as one stepping back.

Two things were doing it, and the smaller one was invisible in the source. The
body's `shadow-[0_8px_32px_rgba(0,0,0,0.5)]` has a 32px blur against an 8px
downward offset, so it reached **24px upward over the tab** and darkened the
very edge that had to read as continuous — a drop shadow falling on the thing
it was meant to sit in front of. The fix is `0 8px 28px -6px`: the negative
spread pulls the shadow in so it still drops below the box and no longer washes
the tab. The fill then went `#1c1c1c` → `#212121`, which renders 33 falling to
30 — a 7-step seam against the body instead of 13, and a wide step from black.

The geometry was trimmed, not overhauled, because it was never the main fault:
`pt-2.5` → `pt-2` and `-mt-2.5` → `-mt-3` take the tab from 42px to 40 and the
overlap from 10 to 12, so **28px stands proud instead of 32**. Note the
constraint that bounds this: the clearance below the tab's label is exactly
`pb − overlap`, so the visible tab can never be shorter than `pt + 18px` of text
without the body clipping the project name. 28px is close to that floor. The
whole box is 136px against the ~138 the docked offsets were computed for.

### 6.37 The composer could name the agent but not tell it how hard to think (`components/chat/ModelPicker.tsx`, `server/agent-cli.js`, 2026-09-09)

§6.32 moved each agent's permission rung inside its own branch, on the grounds
that a setting belongs where the thing it governs is chosen. It left two rungs
behind. Both CLIs have a knob for how hard the model works before it answers,
and Codex has a second for how much of that reasoning comes back — and neither
was reachable from this application at all. The operator's only way to change
either was to quit, edit a config file, and come back.

**Both now sit in the branch, under Permissions**, and both are rendered from
what the gateway says the installed binary accepts rather than from a list
compiled into the renderer.

- **The vocabularies are the CLIs' own, and they do not agree.** Claude Code
  takes `--effort low|medium|high|xhigh|max`. Codex has no flag: it takes
  `-c model_reasoning_effort=` with `minimal|low|medium|high|xhigh`, so Codex
  starts a rung below Claude Code and Claude Code goes a rung above Codex. Both
  lists were read off the binaries installed on this machine — `claude --help`
  for the first, and the variant list inside the Codex 0.149.1 binary for the
  second — not chosen. A level we invent is a level the CLI rejects, and it
  rejects it by failing the entire turn.
- **Claude Code shows no Thinking group, because it has no such knob.** Its
  effort level *is* its thinking budget; `claude --help` at 2.1.263 carries no
  separate flag. The group is absent rather than present-and-inert, which is
  the same rule that keeps a not-installed agent out of the menu entirely.
  Codex's group is `model_reasoning_summary`: `none`, `concise`, `detailed`,
  `auto`, rendered as Hidden / Brief / Full / Automatic.
- **Both groups lead with "CLI default", and that is the shipped state.** It
  passes no flag at all, leaving whatever is in `~/.claude` or
  `~/.codex/config.toml` in force. A picker that silently overrides a config
  file the operator wrote is worse than one that starts out offering nothing —
  and without that row a level, once picked, could never be un-picked.
- **An unrecognised level is dropped, not forwarded and not an error.**
  `runAgentTurn` checks each value against that agent's own vocabulary and
  falls back to null, so a level persisted from the other engine, or from a CLI
  since downgraded, produces a normal turn at the operator's own setting rather
  than a dead one. This is exactly how `permission` already behaves, which is
  why the gateway route validates neither: a second allowlist beside that one
  is a copy free to drift from it.
- **Codex's overrides go before the subcommand.** `-c` after `exec` is read as
  an argument to `exec`. The value is quoted (`model_reasoning_effort="high"`)
  because `-c` parses its value as TOML before falling back to a literal, and
  the CLI's own help documents the quoted form. Changing agent clears all three
  settings together, for the reason §6.32 gave for the permission alone: the
  two CLIs share no vocabulary, so a level carried across would be dropped by
  the server while the menu went on showing it.

Four tests in `tests/agent-cli.test.mjs` assert the argv contract by recording
what a fake binary is actually handed — that both spellings are built, that a
level belonging to the other CLI never reaches the process, that Codex's `-c`
precedes `exec`, and that choosing nothing passes nothing. `argsFor` stays
unexported: the contract worth testing is what reaches the process.

### 6.38 The arrows walked off the bottom of the menu (`components/chat/ModelPicker.tsx`, 2026-09-09)

§6.37 gave each agent branch two more groups, and the branch outgrew the box
that holds it. Measured in the running app, Codex expanded with one of its own
models selected: twenty rows, `scrollHeight` 560px inside a `clientHeight` of
448px on an 813px viewport — **112px, five rows, below the fold**, with the menu
already pressed to within 22px of the top of the window because `maxHeight` is
`getBoundingClientRect().bottom - 16`. There is no taller menu to be had; the
window is the limit.

Overflow itself was never the bug. The menu is `overflow-y-auto`, so a mouse
scrolls it and every row is reachable. The bug was that `useMenuKeyboard` tracks
an *index* and holds no DOM reference, and nothing else scrolled either, so
ArrowUp out of the resting state highlighted a Thinking row that was not on
screen. A highlight the operator cannot see is a highlight they cannot trust,
and Enter on it commits a setting they did not read.

So each row in the flat keyboard order now carries `data-row-index`, and one
effect on `activeIndex` pulls the active row into view. `block: "nearest"` is
the whole trick: a row already inside the box does not move, so walking through
the visible middle of the menu is perfectly still, and only crossing the fold
scrolls — by exactly enough.

Verified by driving the real app over CDP, not by reading the code: from rest
the first ArrowUp lands on row 19 (`Automatic`, the last Thinking row), the menu
scrolls to `scrollTop` 108 and the row is inside the box; 18, 17 and 16 follow
with no further movement; six ArrowDowns wrap round to row 2 (`Codex`) and the
menu returns to `scrollTop` 4. Nothing is highlighted before the first keypress,
which is still the contract §6.32 asked `useMenuKeyboard` for.

No test was added and the count stays 1955. The suite has no DOM — no jsdom, no
testing-library — so `scrollIntoView` cannot be asserted there, and a source-
reading test that checked for the string would prove only that the string is
present. The evidence is the measurement above. That absence is also why the fix
is safe: nothing in the suite renders this component.

### 6.39 What the agent brings (`server/agent-inventory.js`, `components/chat/ModelPicker.tsx`, 2026-09-10)

The picker could say which model, how hard it thinks, and what it may touch, and
still leave unanswered the question that decides whether a turn can work at all:
*what tools will it have?*

The answer had never been rendered anywhere, and it is not symmetric. Five MCP
servers are attached by `runAgentTurn`, and **four of them are Claude Code
only** — `screen-mcp.js`, `workspace-mcp.js` and `camera-mcp.js` each return
empty args unless `engine === "claude"`, and the approval bridge only gets a
token on the `runToken = engine === "claude" && runId` line above them. Choosing
Codex silently costs the screen, the workspace, the camera, and in-app approval
prompts. That fact lived only in the argv builders; operators met it by asking
Codex to do something it had no hands for.

`GET /api/agents/inventory?engine=` now answers in two halves.

**What this app attaches** comes from `STUDIO_CAPABILITIES`, a table that
mirrors the five builders. It mirrors rather than calls them because four write
a 0600 spec file keyed by a run id, and an inventory has no run to name — so
`tests/agent-inventory.test.mjs` calls every builder for real into a throwaway
directory and asserts the table agrees with what came back. Teach `screen-mcp.js`
about Codex and forget this table, and that test fails rather than the menu
quietly lying. Each unavailable entry names the thing to change — switch agent,
open the Cut panel, grant Accessibility — because "unavailable" tells nobody
anything.

**What the CLI brings of its own** is read by running `mcp list` and
`plugin list` against the installed binary, for the same reason the effort and
thinking vocabularies were read off `--help` in §6.37: a list we keep here is a
list that goes stale the next time either ships. Three of the four probes take
`--json`; `claude mcp list` has no such flag and is parsed as text, which is
sharper than it looks — a server name may itself contain colons
(`plugin:cloudflare:cloudflare-api`), so the split is on the first colon
*followed by a space*, and the status is taken from the last ` - ` so a command
containing a dash survives. Both traps are in the fixtures.

Three constraints are load-bearing:

- **`null` is not `[]`.** A probe that fails yields null and renders as "could
  not be read". An empty array is a claim — *you have no plugins* — and we are
  only entitled to make it when the CLI said so.
- **No environment variable, name or value, leaves the route.** `codex mcp list`
  masks env in its table and prints it in full under `--json`; that is a config
  file's worth of secrets, and a test asserts none of it reaches the payload.
- **Slash commands are named as missing rather than omitted.** Neither CLI can
  list them, and enumerating them would mean walking private directory layouts.
  The menu says so, so the absence cannot read as "you have none".

Measured: `claude mcp list` 2494ms — it health-checks every configured server
over the network — against 87ms for the whole Codex side. The CLI halves are
therefore cached for `INVENTORY_TTL_MS` (60s) and fetched only when the operator
opens the section; the studio half is recomputed every call, because a Cut panel
that opens between two menus must not be reported closed by the second one.

In the picker this is **one row per branch**, collapsed, not a group of five.
§6.38 had just fixed a branch that outgrew its box at twenty rows; adding the
inventory inline would have taken it past thirty for information most turns
never need. Expanding scrolls its heading to the top of the menu, so what was
revealed is under the eye rather than under the fold. The revealed lines are
`InfoLine`, not `Row`: a `div` with no `role`, no `data-row-index`, and no place
in the flat keyboard order — a screen reader walking this menu should count the
settings it can change, not five more items that do nothing when it reaches them.

### 6.40 The chat history you could not open (`components/sidebar/StudioSidebar.tsx`, `components/voice/TemiVoiceStage.tsx`, `utils/sessionDialogue.ts`, 2026-09-10)

Two defects in one panel, reported in one sentence: *"the chat history on the
sidebar does not make sense, why is it called repositories in the first place —
it has to be a chat history."*

**The label.** The panel's own doc comment had called it "the chats view" since
the day it was written, and the header said `Repositories`. The header is what
the eye reads first, so the panel appeared to be a list of checkouts that
happened to have chats filed under it, when the content was always the other way
round: the chats are the subject and the repository is only how they are filed.
Now `Chat history`, with the repository rows exactly where they were — filing a
chat under its project is the point, not an accident. The filter's placeholder
and accessible name moved with it.

**The wiring.** `chat-sessions.test.mjs` opens on the operator's earlier report
of this same panel: *"all I know is when I click on them nothing happens."* That
round fixed the store, and fixed it correctly — `applySessionSwitch` saves the
outgoing transcript into the chat being left and loads the incoming one, and its
tests prove it. Nothing on screen was ever connected to that work. The surface
the operator is looking at is `TemiVoiceStage`, and it kept the conversation in
a `useState<DialogueTurn[]>` of its own, seeded with `INITIAL_DIALOGUE`.

So `switchSession` faithfully swapped `frontierMessages` while the stage went on
drawing its private array. Every chat in the sidebar showed the same
conversation, and reloading lost all of them. The history was a list that could
not be opened, and it had been that way behind a passing test suite.

The stage now reads the store. That is the whole fix — switching a chat changes
what is on screen because it changes what the stage renders — and it is why
`utils/sessionDialogue.ts` exists rather than a `useEffect` pair syncing two
copies of the truth: with one source there is no second copy to fall out of step.

Two shapes meet in that module and the mapping is not symmetric:

- **An empty chat draws the greeting, and the greeting is never stored.** The
  landing hero is gated on `turns.length === 1 && turns[0].id === "init-temi"`,
  so a chat that stored its own greeting would hold one real message, stop
  counting as empty, and never show the hero again. It is synthesised on the way
  out and dropped on the way back in.
- **A turn still being spoken is not stored.** `pending` turns are live state.
  Kept, they would survive a reload as things someone said.
- **A round trip keeps what the transcript cannot see.** The stage knows who
  spoke and what they said; it does not know what the turn cost or how many
  tokens it burned. Messages are matched by id and their telemetry preserved, so
  re-rendering a chat cannot strip it.
- **`system` messages are not drawn.** The transcript has two columns, you and
  the assistant, and a system note belongs to neither.

The setter deliberately keeps the `setState` shape. Seven call sites in the
stage append with `prev => [...prev, turn]` and are unchanged by this; the eighth
was `handleCreateNew` blanking the transcript back to the greeting, which is now
`newChatSession()`. Clearing in place destroyed the conversation you were in —
tolerable when there was only ever one, and wrong the moment there are many.

Nine tests in `tests/session-dialogue.test.mjs` cover the mapping; the last one
is the shape of every call site — appending to a drawn greeting must not smuggle
the greeting into storage. Verified in the running app by seeding two chats under
two different projects and switching between them: each draws its own
conversation, and the title bar follows.

### 6.41 The thread you were already on (`utils/chatSessions.ts`, `components/chat/ModelPicker.tsx`, `server/agent-cli.js`, 2026-09-10)

Both agent CLIs keep the conversation on their own side, and this app has been
resuming it silently since agents were wired in: `runAgentTurn` has passed
`--resume <id>` (Claude Code) or `codex exec resume <id>` for six sessions with
nothing anywhere saying so, and no way to do anything else. Two questions an
operator could not answer from the interface — **does the next turn remember
this chat**, and **how do I make it stop** — and one they could not even ask:
how do I carry on from here without writing into the thread I already have.

Three changes, one section of the picker.

**The key is the engine, not the model.** `agentSessionKey` was `engine:model`,
so moving from Sonnet to Opus in the middle of a task compared `claude:sonnet`
against `claude:opus`, found no match, and started the CLI over — losing the
conversation without a word. The engine genuinely has to match: a Codex thread
resumed as Claude Code fails the turn rather than politely starting fresh. The
model does not, because both CLIs resume a thread under whatever `--model` the
new turn names. `agentSessionKeyFor` now returns the engine alone, and
`resumableAgentSession` compares engines through `engineOf`, which reads the
prefix — so a key persisted in the old `engine:model` form still names its
engine and survives the upgrade instead of being dropped on the next turn.
Switching *engine* still starts fresh, and no note is added to the chat when a
thread carries across a model switch: the operator was offered "keep it, but say
so" and chose silence.

**Forking is a chat, not a flag.** Claude Code takes `--fork-session` after
`--resume`; Codex swaps the subcommand — `codex exec fork <SESSION_ID>
[PROMPT]`, the same order-sensitive shape as `resume`. Both answer from the
resumed history and write the answer to a **new** session id, leaving the thread
they read untouched. Done in place that is invisible: press Fork, send a turn,
watch nothing change. So `forkChatSession` makes a second chat holding the same
transcript and the same thread id, armed with `agentForkPending`. Both chats are
on one thread until the copy takes a turn, and that turn is the one that
branches — which is why nothing has to be undone if it is never sent.
`rememberAgentSession` disarms on the id coming back, because that id *is* the
fork and staying armed would branch the branch on every turn after it.

The copy is taken from `frontierMessages`, not from `source.messages`. The
active chat's transcript lives there until a switch writes it back (§6.40), so
forking from the stored array would copy the conversation as it stood when this
chat was last left — everything said since would be missing, which is the one
thing a fork must not do.

**Start fresh** is `setAgentSession(id, null, null)`: the CLI forgets, the
transcript on screen stays. It deliberately does not close the menu — the status
line above it is the receipt, and it only reads as one if you are still looking
at it. Fork does close it, because the chat underneath has just changed.

The status line is derived through the same `resumableAgentSession` the composer
sends with, so the menu cannot promise a resume the next turn does not perform.
It says `Resumes this thread`, `Branches on next turn`, or `Starts a new
thread`, with the first eight characters of the session id beside it and the
whole of it in the tooltip — measured at 280px, both spans un-clipped. The first
draft said "Branches this thread on the next turn" and ellipsised into
"Branches this thread on the…", which answers nothing; §6.39 made the same trade
for the inventory's reasons.

Both thread rows are `role="menuitem"`, not the `menuitemradio` the rest of this
menu uses. Forking is not a setting that can be on, and announced as a radio it
is one that is permanently off. "What it brings" took the same correction — it
has always been an action too.

With no thread the rows are disabled rather than hidden, and say why in their
tooltip: there is nothing to fork or forget, and the next turn already opens a
thread of its own. `runAgentTurn` drops `fork` when there is no `sessionId` for
the same reason — both CLIs fail a branch with no parent, and a chat armed to
fork whose thread was since forgotten must still take a normal turn.

Thirteen tests: nine in `tests/chat-sessions.test.mjs` for the key, the legacy
key, and the fork's four asymmetries; four in `tests/agent-cli.test.mjs` driving
the argv recorder, which asserts on what actually reaches the process — that
`--fork-session` never ships without `--resume`, that `fork` replaces `resume`
rather than joining it, and that asking to fork nothing passes no flag. Verified
in the running app: seeded a chat on a thread, opened the picker, forked it, and
watched a second chat appear in the sidebar under the same project while the
status line changed to `Branches on next turn`; then Start fresh, and both rows
went disabled with the line reading `Starts a new thread`.

### 6.42 The chip was right and the sidebar was wrong (`store/studioStore.ts`, `utils/chatSessions.ts`, 2026-09-10)

Reported as a mismatch: the composer's project chip read `4K Video Downloader+`
while the sidebar filed that same chat under `teminaliCode`. Two values, two
sources, never reconciled — and the question that decides the fix is not which
one looks right but **which one names the directory the next turn runs in**.

It is the chip. The chat lane sends no `cwd` at all: `aiService.ts` calls
`streamTurn` without one, `agentCliService.ts` posts `cwd: ""`, and
`gateway.js` runs the turn with `root: config.workspaceRoot`, which
`resolveAgentCwd` resolves an empty cwd against — the root itself. That same
root is what `POST /api/workspace/open` rebinds, and `setWorkspacePath` is fed
the gateway's confirmed answer, so chip and gateway root are one value by
construction.

`session.workspace`, meanwhile, is stamped once when the chat is made and never
written again. It is a birth certificate, not an address. A chat filed under
`teminaliCode` with the chip reading `4K Video Downloader+` was a chat whose
next turn would have edited the other repository — a wrong-repo edit waiting for
someone to trust the sidebar.

So the stale half moves to agree with the truthful one. `restampWorkspace`
rewrites the active chat's `workspace` and `setWorkspacePath` calls it in the
same `set`. The setter, not any one caller: six routes change the root — a
sidebar repository row, the Projects panel, the composer's recent projects,
global search, the native Open Folder menu, and the agent's own `open-project`
— and every one funnels here. Fixing them one at a time is how five of them stay
broken.

The cost is accepted, not hidden: re-stamping rewrites history, because the
chat's earlier turns genuinely did run somewhere else, and it can empty a
sidebar group when it moves that group's last chat. The alternative was to blind
the one control that was telling the truth — a chip following `session.workspace`
would confidently name a directory the agent is not standing in, and would stop
moving in response to its own click.

`workspaceLabel` now owns the `split("/").filter(Boolean).pop() || "No Repo"`
rule that `newChatSession` had inline; `"No Repo"` is a real sidebar group — the
one holding chats whose repository is gone — so an empty root belongs in it
rather than being a placeholder. Two tests in `tests/chat-sessions.test.mjs`
pin the move and the labelling, including that only the chat you are in moves:
the others were not open and did not run there.

### 6.43 Composer parity: the stop that was not there (`components/voice/TemiComposer.tsx`, `components/voice/TemiVoiceStage.tsx`, `utils/promptHistory.ts`, `utils/taskQueue.ts`, `services/voice/teminaliAgentBridge.ts`, 2026-09-10)

The last of the CLI-parity items, and it turned out to be four defects rather
than a feature.

**Escape was dead, and the README said it worked.** `useInterruptKey` was armed
in `StudioChat` on `isStreaming` — that component's own chat lane, which nothing
on the voice stage ever sets, because `TemiVoiceStage` declared `isStreaming`,
`onSend` and `onStop` as props and destructured none of them. So the hook was
correct, the rule in `services/interruption.ts` was correct, and the one screen
the operator types into had no stop key at all. Stopping was reachable only two
clicks deep in `TemiActivityDialog`.

The flag that is actually true on this surface is `isTaskRunning`, so the stage
now owns Escape: `useInterruptKey(isRunning, stageRef, handleStopRun)`, with
`isRunning = isTaskRunning || isStreaming`, and `handleStopRun` stops the TTS,
the delegated run and the parent's lane through `onStop`. `StudioChat`'s call
was **removed rather than left as a second listener**. Two would not have been
belt and braces: whichever fires first calls `preventDefault`, `interruptsRun`
then refuses the second, and registration order — which flips whenever either
flag re-arms — would silently decide how much of the run got stopped.

**A second Enter mid-turn killed the first.** `delegateTask` opened with
`this.activeController?.abort()`, so a follow-up typed while work was running
ended that work with nothing said in the transcript, the activity log or the
voice. Both agent CLIs queue. The rules for what may join the queue are in
`utils/taskQueue.ts` — blank rejected, an exact duplicate rejected, a floor of
`QUEUE_LIMIT = 8` — and the bridge holds the array, drains it in its `finally`
and **clears it on a stop**, because draining after a stop would start the next
item the operator just asked not to happen. The returned promise still settles
with the run's own report whether the prompt ran now or waited; every caller
today passes `onCompleted` and discards it, but a promise resolving with
"Queued" is a trap for the first one that does not.

**`/` and `@` were built, tested and wired to nobody.** `ComposerMenu`,
`utils/composerTrigger.ts` and nine passing tests all pointed at
`chat/Composer.tsx`, which the voice stage replaced six sessions ago; the live
box's only key handler was Enter. This was a port, not a build — same menu, same
word-boundary rule, same "the menu owns the arrows while it is open".

**Up-arrow history did not exist anywhere.** The ring is `utils/promptHistory.ts`
so the DOM-free suite can reach it, and it is held by the *stage*, not the
composer: the composer is remounted when the empty screen becomes a
conversation, and a history emptied by the first prompt you send is worse than
none. Two rules carry the feel of it — the draft is put aside and handed back
when you walk past the newest entry, and Up is history only on the first line,
so a two-line draft still edits normally.

**Stop is drawn beside send, not instead of it.** `studio/README.md` had
promised exactly this and the old `chat/Composer.tsx` had done it; swapping one
control for the other would now mean choosing between stopping the run and
lining up the next thought, which is the choice the queue exists to remove.

23 tests: 11 for the history ring, 7 for the queue, and 5 source guards holding
the wiring — that Escape has exactly one owner per surface, that the stage stops
all three things a run is made of, that the live composer mounts the menu and
gives it the keyboard, and that `delegateTask` no longer opens by aborting.
Verified by driving the running app with CDP: both menus opening with real rows,
Escape closing the menu without stopping anything, the stop appearing beside
send with no overlap and disappearing when idle, Escape from inside the textarea
clearing `isTaskRunning`, and the ring walking back, stopping at the oldest, and
returning the half-written draft. Geometry was measured off
`getBoundingClientRect`, not eyeballed.

**Left open:** `onSend` is still declared by `TemiVoiceStage` and dropped. Wiring
it would route typed turns through `StudioChat.send` and change the whole lane;
it is a decision, not an oversight, and it is not this one.

### 6.44 The process line moves into the project tab (`components/voice/AgentActivityTicker.tsx`, `components/voice/TemiComposer.tsx`, `components/voice/TemiVoiceStage.tsx`, `services/voice/activityPhrase.ts`, 2026-09-10)

§6.0.1 gave the Teminali OS assistant one line and put it under Temi's orb, as a
bordered pill floating between the orb and the box. That placement was wrong for
three reasons, and only the third is aesthetic.

**It rented a row to say a short sentence.** The pill was its own object with its
own border, its own `mt-2`, and nothing beside it — roughly 32px of the stage
occupied by a strip that is empty most of the time and, when it is not, holds
about four words.

**The bar it belonged in was already drawn and already half empty.** The composer
has a project tab above it (§6.36) carrying a folder glyph and a workspace name,
and the rest of that bar was blank. Where the work is happening and what is
happening to it are the same question asked twice; they now read as one strip:

```
📁 teminaliCode │ ✳ Reading …/realtimeVoiceStatus.ts
```

**Three objects stacked over one box is a stack.** Orb, pill, composer read as
three things to look at. Orb and composer read as a face and a box.

The tab is a `<div>` of two controls now, not one control. It had to be: the
process line is itself clickable — it opens `TemiActivityDialog` — and a
`<button>` inside a `<button>` is not markup a browser honours. The project name
keeps the whole of its own hit area and both controls answer the pointer the
same way, a colour shift and nothing else, because two controls sharing one
strip that highlight differently look like two different kinds of thing.

The hairline belongs to the line, not to the bar. `AgentActivityTicker` renders
a fragment — separator, then the control — so when the assistant goes quiet the
separator goes with it. A divider owned by the tab would be left pointing at
nothing every time a run ended.

The orb's dock moved from `bottom-[172px]` to `bottom-[188px]`. 172 was measured
against a block that also held the pill; with the pill gone, half of the 32px it
occupied is returned as clearance so the orb does not sit on the box, and the
other half is the compaction this change was for.

**Three bugs found in the code being moved**, all pinned by
`tests/activity-phrase.test.mjs` and `tests/temi-composer.test.mjs`:

- **The strip named the wrong step.** `currentActivityPhrase` reversed the item
  list and took the first match, which is only correct for an oldest-first
  array — and `assistantActivityStore.logAction` *prepends*. With two steps in
  flight it named the older one and stayed there while the assistant moved on.
  It now sorts newest-first rather than trusting the caller's order, the same
  defence `runProgressFromActivity` already took. (That file's comment claimed
  the store appends; it does not, and the comment is corrected.)
- **`truncate` was doing nothing.** The target span is a flex item, and a flex
  item's `min-width` defaults to `auto`, so it would not shrink below its own
  text: a long path widened the strip instead of ellipsing. `min-w-0` is what
  makes the elision `activityPhrase.ts` computes actually visible.
- **The tooltip showed the elision back.** `title` hung off the shortened
  target, so hovering `…/realtimeVoiceStatus.ts` answered with
  `…/realtimeVoiceStatus.ts`. `ActivityPhrase` carries `full` now — the
  unshortened value, absent when nothing was lost — and the tooltip recovers the
  path the line had to cut.

Two smaller corrections while in there. The polite live region is now mounted
whether or not there is anything in it (`sr-only`, and therefore absolutely
positioned, so it is not a flex item and adds no gap): a live region inserted
*with* its first message is not reliably announced, and the old strip
unmounted itself completely whenever a run ended. And `disabled={!onClick}` is
gone — browsers suppress the tooltip on a disabled element, which is the one
thing this strip needs; with no click-through it renders as a `<span>` instead.

**Not verified visually.** The measurements above are read off the CSS, not off
a screenshot; the suite proves the wiring and the phrasing, not the pixels.

### 6.45 The acknowledgement was never the lie; the report was (`services/voice/progressNarration.ts`, `services/voice/teminaliAgentBridge.ts`, `components/voice/TemiVoiceStage.tsx`, 2026-09-10)

`machineAction.ts` classifies "did the tests pass" as `inspect` and Temi says
**"Checking now."** The module's docstring promises the truthful part "arrives
afterwards from the activity record", and the standing suspicion was that
nothing ever followed — that the acknowledgement was a promise of work she
could not do.

**The wire is whole.** `voiceTurnRouter` → `delegate` → `TeminaliAgentBridge.
delegateTask` → `onCompleted` → `sendAssistantDirective` → `server.py`'s
`assistant_directive` → `on_final` → spoken. Both exits of `runTask` call
`onCompleted`, the success one and the `catch`. Ten of ten realistic state
questions route to `delegate`/`inspect` and are acknowledged. So the phrases
are fine and were left alone.

**What arrived was the answer with its answer removed.** `summariseOutcome`
reads the assistant's own first sentence, and `firstSentence` strips markdown
so a work narration does not read punctuation aloud. On a question that strip
deletes the payload. Measured 2026-09-10, eight of eight realistic answers:

| The assistant wrote | The operator heard |
| --- | --- |
| ``The port is `8080`.`` | "The port is ." |
| ``There are `3` errors in the log.`` | "There are errors in the log." |
| ``You are on branch `master`.`` | "You are on branch ." |
| ``The tests passed: `2222 passed, 0 failed`.`` | "The tests passed: ." |
| "The answer is:" then a fence holding only `8080` | "The answer is:" |

The second row is the worst of them: a fluent, complete sentence with the
number taken out. It does not sound like a failure, so nothing about it invites
a second question — which is the same failure mode §6.0.4 named, arriving from
the other end of the turn.

Three changes, all deterministic, no second generation:

- **Code spans are unwrapped, not deleted.** Keep what was inside the
  backticks, lose only the backticks. A fenced block is still dropped — output
  read aloud is unbearable — *unless* its whole body is one line of ≤ 40
  characters, which is a value wearing a fence.
- **A silent `inspect` run admits it.** With no prose and no edits,
  `summariseOutcome` returned `"Done."` — the answer to "do this", standing
  where the answer to "did it pass" belongs. The turn's kind now travels with
  the prompt (`TaskDelegationOptions.action` → `RunProgress.kind`), and an
  `inspect` that came back with nothing says so. Work still reports as work.
- **A refused delegation is spoken.** The queue's "Already queued" and "Queue
  is full" reached `onProgress` only, which is a toast — on a screen the
  operator is not looking at, which is why they asked aloud. It reaches
  `onCompleted` now, like every other exit. **Silence after an acknowledgement
  is the lie the phrasing was suspected of.**

`tests/inspect-answer.test.mjs` (7) pins all three, the eight measured rows
included. Suite **2229**, `tsc` and `npm run build` clean.

**Not verified against the ear.** Nothing here was spoken aloud on this
machine; the tests prove the string that reaches `sendAssistantDirective`, not
what the synthesiser makes of it.

### 6.46 An audit for fixes the live path never reaches (`services/voice/activityPhrase.ts`, 2026-09-10)

Two defects on the same day shared a shape: the code was right and unreachable.
§6.45's report deleted the answer it was carrying; `history_window.py` spent a
context budget on a list `server.py` had already cut to twenty messages. Both
had passing tests, because both tests examined the module that had been fixed
rather than the path a turn actually takes. So the voice modules were swept for
the same thing — anything exported and referenced nowhere, in either language.

Most of what that turns up is noise: constants exported so a test can name
them, and helpers used only inside their own file. Discounting those leaves
**one** in the TypeScript:

**`speakActivityPhrase` is never called.** `activityPhrase.ts` builds two forms
of the same fact — `describeActivity` for the strip, which
`AgentActivityTicker.tsx` renders, and `speakActivityPhrase` for the ear
("Editing composer dot tsx."). The visual half is wired. The spoken half is
exported, tested, and reached by nothing, so **the activity phrase is shown and
never spoken**. Left as it is deliberately: wiring it is a product decision, not
a repair. This lane's own instinct is that a voice narrating every step becomes
a tic, and §6.45's finish-line report already covers the moment that matters.
Recorded here so the next reader does not mistake the tests for evidence it runs.
**That decision was taken in §6.47, and it did not go the way "wire it or not"
implies:** the function is deleted, because the question it answered already had
an answer. The instinct above survived; the diagnosis of a missing half did not.

Three others were checked and are **not** defects. `resetSpeechBus` is a test
fixture. `ephemeralTranscript.ts` is untracked and unwired — in flight, not
dead. `realtime-voice/code/filler_policy.py` is a complete, tested, undocumented
module that nothing imports, and it should stay that way for now: it selects
from a bank of pre-rendered breaths that **does not exist** — no
`render_filler_bank.py`, no audio — so it is unfinished rather than inert.

One real drift was found and closed on the Python side: the six-word floor is
written in both `temi_moves._TAIL_FLOOR_WORDS` and `second_beat.WORD_FLOOR`,
the spec says the two MUST agree, and nothing checked. They are reached by
different paths — `temi_moves` in the shipped pipeline, `second_beat` only in
`persona_eval.py` — so a change to one would have passed every test and every
live turn. `TheFloorIsWrittenTwice` now pins them. Python **208** (was 207).

**The lesson is about the tests, not the code.** A test that imports the fixed
module proves the fix. It says nothing about whether the conversation reaches
it, and on this codebase that has now been the actual defect three times.

### 6.47 Asked what was going on, she said something that was not (`services/voice/voiceTurnRouter.ts`, `services/voice/activityPhrase.ts`, 2026-09-10)

§6.46 left `speakActivityPhrase` unwired and called wiring it a product
decision. Here is the decision: **Temi never volunteers activity commentary, and
the question that function was written to answer already had an answer.**

Being asked what is going on is the `status` intent, and `voiceTurnRouter` has
answered it since §6.0.2 out of `summariseProgress` — which reads the very same
activity items, through `runProgressFromActivity`, and makes more of them than a
verb and a target can: elapsed time, the files read, the commands run, the call
in flight. So `speakActivityPhrase` was not a missing half. It was a second
answer to a question that had one, which is the shape drift arrives in, and it
is deleted. A comment stands where it was, because a plausible dead function
gets written again by the next reader who notices the gap.

**Deleting it surfaced the one sentence it had that the router did not, and that
sentence was a live defect.** The status branch answered *every* empty case with
`EMPTY_RUN_ANSWER` — "It's still going — nothing to report yet." But `status` is
reachable whenever `busy || speaking`, so it is also reached by talking over Temi
while nothing is running at all, and there that sentence is simply false. The
branch could always tell the two cases apart: it is handed `busy`. And the
emptiness was never ambiguous either, because `summariseProgress` opens with
elapsed time and therefore never returns `""`. **An empty answer never meant a
quiet run. It only ever meant no run.**

`IDLE_STATUS_ANSWER` — "Nothing is running right now." — answers that case now,
and `EMPTY_RUN_ANSWER` keeps the one it was written for: a run younger than its
first tool call. Two tests pin the pair, one for each side of `busy`.

**What §6.46's sweep could not see.** It found the dead export and stopped there,
because a function called by nothing reads as an unfinished feature. This one was
the opposite — a finished duplicate. So the reachability question it taught
("does a turn actually reach this?") has a mirror worth asking in the same
breath: **when something is unreachable, ask what is reaching that case
instead.** Here the answer was already handling it, and getting one case wrong.

A note on the evidence, in §6.46's own spirit: both test files covering this pair
were untracked until this commit. `9cbbc3a` landed `activityPhrase.ts` and
`voiceTurnRouter.ts` without their coverage, because that commit set was
converged by following missing *symbols*, and a test file exports none — so HEAD
held the code and not the proof. Twelve more TypeScript test files were measured
to be in that state; they are not this lane's to land unasked.

Measured in the shared tree when this landed: studio **2255/2255**, 0 skips,
exit 0; `tsc --noEmit` clean. (The count moved to 2261 the same night, from the
editor-cost work recorded in §3.)

### 6.48 She keeps what a person would keep (`services/voice/temiMemory.ts`, 2026-09-13)

Temi had no memory across sessions. Inside one conversation the Gemini Live
session *is* the history, so she follows everything said; when it ended, all of
it went. `ambientMemory.ts` and `speakerProfile.ts` look like a memory layer and
are not: the first is a ten-minute log of room speech she did not answer, the
second is voice enrolment, and both reach the lane only through
`conversation.ts`, which is mounted on the composer lane and not on hers.

The brief was bounded, forgetful, and one prohibition that turned out to be the
whole design: retention must **not** be ranked on importance alone, because
"importance can also be about fun things". The goal, stated plainly, was "what
memories humans will keep".

That prohibition is load-bearing. Rank by importance and the store converges on
a CRM record: his timezone, his stack, his deadlines. Every entry useful, and
not one of them being known. The fun things lose every comparison against a
deadline because they are not competing on the axis being measured.

**Five decisions, each a claim about people rather than about code.**

1. **Retention is the peak axis, not the sum.** Four axes scored at write time:
   `weight` (utilitarian), `warmth` (emotional charge, *unsigned*, so a laugh and
   a hurt both score high), `surprise`, `firstness`. Strength is
   `(max(axes) + 0.25 * mean(the rest)) / 1.25`. A memory that is 0.9 funny and
   nothing else scores 0.72; one that is 0.5 on all four scores 0.50 and loses.
   Summing would reverse that, and reversing it is exactly the failure named
   above. People do not keep well-rounded memories, they keep extremes.
   Normalised rather than clamped, because clamping piled every strong memory
   onto 1.0 and made the top of the store unrankable.
2. **Kinds hold reserved ground.** `anchor` / `fact` / `keepsake` / `thread`, with
   floors of 40/80/80/40 against a cap of 320. Scoring alone is not enough: in a
   heavy month forty genuine high-weight facts arrive and legitimately outscore
   the jokes. The reserve means they never compete for those slots at all.
3. **Rehearsal is what makes a memory permanent**, not its score at birth.
   `halfLife = base * (1 + rehearsals)^1.4`, so a thing brought back up three
   times lives about 7x longer. A running joke outlives the event that started
   it without anyone having judged it important. Base half-lives are
   `keepsake` 180 days against `fact` 60: people remember a joke from a decade
   ago and forget which timezone you were in last year. **If those two are ever
   reordered, the policy has quietly become the CRM it was written to avoid.**
4. **Detail dies before the memory does.** Below 0.35 an atom fades to its gist;
   below 0.12 it goes. Half-remembering is the honest failure mode and the one
   humans actually have. An atom with no gist keeps its detail and rides to the
   floor instead, because half a sentence she never wrote is worse than nothing.
5. **Anchors do not decay, they are superseded.** His name does not fade, but
   "lives in Arusha" must not sit beside "moved to Dodoma".

**Selection is not retention, and conflating them was a real bug.** The store is
what she knows; recall is what is on her mind today, on a much tighter budget
(~1400 chars). The first implementation ranked recall by retention alone, and
the eval caught it: keepsakes outrank facts by construction here, so she was
handed thirteen jokes and four facts to walk in with. A woman who remembers
every absurd thing he ever said and not his deadline is not being known, she is
being charming at him. Recall now allots per kind (6 facts, 4 keepsakes,
3 threads) plus every anchor and the most recent few.

The last recall slot is a **wander**: a weighted-random draw from the whole
store. Sometimes a person just remembers something old and odd for no reason and
says so. It costs one line of budget, and it is probably the single behaviour
that will make her feel like she has an interior life, because unprompted recall
is the thing nothing else in the system does.

**The reserve guards against competition, not against decay.** A keepsake that
has genuinely faded past the forget floor is gone like anything else. A test
written to prove the reserve picked an atom at retention 0.115 and proved that
instead; the distinction is now pinned by
`tests/temi-memory.test.mjs` ("the reserve is load-bearing, not decoration").

**Measured, not asserted.** `npm run eval:memory` simulates a year at two loads
against the exact design the brief rejected (rank by importance, keep the top N,
no decay), same event stream from the same seed. At 1 fact/day the cap never
binds and decay alone decides; at 4 facts/day, 1516 atoms against a cap of 320,
the reserve is the only thing holding.

| | policy | importance-only |
| --- | ---: | ---: |
| keepsakes kept, ordinary year | 30/30 | 0/30 |
| keepsakes kept, punishing year | 30/30 | 0/30 |
| of those, 9+ months old | 8/8 | 0/8 |
| anchors kept, punishing year | 8 | 0 |

The rejected design does not merely lose the fun. Under load it forgets who he
is: 320 slots, all facts, every anchor evicted.

Every function is pure and takes `now`, the contract `ambientMemory.ts` uses, so
the policy runs forward over a simulated year without touching a clock. No
constructor parameter properties, because `node --test` strips types rather than
compiling them (`ambientMemory.ts:167-169`).

**The latency contract, and it is a contract.** Being remembered is worth
nothing if she gets slower, so the layer is shaped around the turn rather than
fitted into it:

1. **Nothing runs during a turn. Not one function.** Consolidation happens
   between sessions; recall happens once at session start. The per-turn cost is
   not "small", it is structurally zero, and that is the reason consolidation was
   designed as a post-session pass rather than a tool the model can call. A
   remember-this tool would have put model-latency on the live path and handed
   the already over-triggering router another reason to fire.
2. **Session start pays CPU, never I/O.** The store is resident before
   `live.connect` is called, so connect never waits on disk or on the gateway.
3. **The only model-visible cost is the recall block**, and it is processed once
   at session setup, not per turn, because Gemini Live fixes the system
   instruction at setup (§6.0.x, `geminiLiveEngine.ts:1553-1557`).

Measured on Node v26.4.0 at a full 320-atom store:

| | cost | on the live path? |
| --- | ---: | --- |
| `selectForRecall`, session start | 0.18 ms | once per session |
| `consolidate`, at cap | 0.016 ms | no, between sessions |
| `consolidate`, 3x over cap | 1.44 ms | no |
| `consolidate`, 6400 atoms | 16.6 ms | no |
| recall block | 1379 chars, ~345 tokens | once at setup |

The first benchmark of `consolidate` reported 0.016 ms and was meaningless: a
store of exactly 320 against a cap of 320 returns before the capacity branch, so
it measured the early return. The same mistake the reserve made in the eval, in
the same session, twice. Three guard tests hold these bounds at roughly 25x the
measured cost, loose enough not to flake on a loaded machine and tight enough to
catch an accidental O(n^2) or a `retention()` call moved inside a sort
comparator.

#### The storage tier (`server/temi-memory.js`, 2026-09-13)

The policy decides what is worth keeping; this is where it is kept. One JSON file
at `<userData>/gateway/temi-memory.json`, the same shape as `server/browser-data.js`:
read whole, sanitise every entry, write back atomically through temp+rename.

In the gateway rather than the renderer for the reason the browser store is, plus
one more. The shared reason is the agent: a renderer-only store is one the agent
routes cannot read. The additional one is time. This is data meant to last years,
and `localStorage` is cleared by things that have nothing to do with wanting to be
forgotten, such as a profile reset, a cache purge or an Electron upgrade.

Three decisions worth not relitigating:

1. **Written `0600`**, unlike the browser store and like the provider keys.
   Bookmarks are a list of addresses; this is a record of what someone said and
   how it landed. The temp file is created `0600` and `rename` carries the mode
   across, so the store is never briefly world-readable.
2. **The storage ceiling is 512 against the policy cap of 320, deliberately not
   equal.** The server's job is to refuse an unbounded file, not to re-decide what
   is kept. Equal numbers would mean a later change to `MEMORY_MAX_ATOMS` silently
   truncated here instead of failing somewhere visible.
3. **The four kinds are copied into plain JS, not imported.** The server cannot
   import the renderer's TypeScript, and a sanitiser that accepted any string as a
   `kind` would let a typo become a fifth kind that holds no reserve and decays as
   nothing. `tests/temi-memory-store.test.mjs` reads both modules and asserts the
   lists are identical, so the copy cannot drift quietly.

**Four routes, and the absent fifth is the latency contract.**
`GET /api/workspace/temi-memory` reads, `POST .../save` replaces the whole store,
`POST .../forget` drops one atom by id, `POST .../clear` empties it. There is no
"remember this" route, and that absence is load-bearing: a route she could call
mid-turn would put a model round trip on the live path and hand the already
over-triggering router (§6.0.17) another trigger. The store is read once before
`live.connect` and written once after the session ends.

The renderer half (`src/services/voice/temiMemoryStore.ts`) is two calls rather
than one for the same reason: `primeTemiMemory()` is awaited before the session
opens and pays the I/O, `residentMemory()` is synchronous and cannot fetch. A
single async accessor would have been tidier and would have quietly allowed a
fetch at recall time, which is the thing the contract exists to prevent. Priming
never throws: an unreachable gateway means she starts the conversation without her
memory, which is how she has started every conversation until now.

#### The extraction tier (`services/voice/temiMemoryExtract.ts`, `temiMemoryPass.ts`, 2026-09-13)

The store was real, durable and empty, because nothing wrote an atom. This is
what writes them: a transcript goes to a text model, and out come memories with
the four axis scores already on them.

**It runs once, after the session, and never inside one.** That is the latency
contract above, and this tier is where it is kept or broken. The pass is started
from the voice screen's teardown, which is the first moment there is nobody left
to keep waiting. It is deliberately not awaited and deliberately not cancelled:
the screen is going away, the renderer is not, and the pass carries its own
120 s deadline for that reason, because handing it the abort signal that just
fired would kill the extraction before it read a word. What this does not cover
is quitting the app mid-conversation, which tears down the renderer without
running a cleanup and loses that session. The alternative is consolidating
partway through, which is the one thing the contract forbids.

**The model is local Flash, through the digest lane.** She talks over Gemini
Live, so the transcript has already left the machine and privacy is not the
argument. Cost and silence are: this runs after every conversation, forever, on
a growing transcript, and produces nothing anyone is waiting for. `streamDigest`
is already the right shape (one prompt, no agent system prompt, no history, no
tool loop) and reusing it means the pass reuses the runner Ollama already has
resident rather than forcing a `num_ctx` change, measured at 1.5 to 2.4 s of
reload. The model is injected as a `complete` function rather than imported, so
the prompt and the parser stay pure and testable without a model, which matters
more than it sounds: the parser is the only thing between a model's bad day and
a permanent record of it.

**The prompt argues against importance three times.** A model asked what is
worth remembering will rank by importance, because that is what every text ever
written about note-taking means by the question. So the prohibition is stated,
given an example, and then given the counter-example "if everything you write
down is useful, you have done this wrong". Telling it once did not hold. The cap
of 12 memories per session is a ceiling and not a quota, and the prompt says so
twice, because the failure worth guarding against is not a model that finds too
few: it is one that treats the instruction as a form and manufactures twelve
memories from a conversation about nothing, every session, until the store is
full of things that did not matter.

**Permissive about the envelope, strict about the contents.** A code fence, a
sentence of preamble, a trailing apology and quoted numbers are a small model
being conversational and cost nothing to tolerate. A fifth kind, a text long
enough to be a summary, or four axes all at zero are the model having done
something else, and letting those through writes a permanent record of it. An
over-long memory is refused rather than truncated, for the same reason a gistless
atom keeps its detail rather than being cut down: half a sentence she never wrote
is worse than nothing. One bad row never costs a session its good ones.

**Matching is deliberately conservative, and the two ways to be wrong are not
symmetric.** `sameMemory` counts shared content words over the SHORTER of the
two texts, not over their union, so "he is dreading the Thursday demo" and the
same sentence with a reason attached score 1.0 rather than 0.5. It needs 0.6
overlap and at least two shared words, so a one-word memory can never match. A
false match rehearses the wrong atom, overwrites its text with something that
never happened, and because rehearsal extends the half-life super-linearly it
makes that invention harder to lose than a true memory. A false miss lays down a
duplicate that decays on the same schedule and costs one slot out of 320. The
threshold is set so the failure runs towards duplicates.

**Anchors supersede on a subject, which is decision 5 finally implemented.**
Nothing removed "lives in Arusha" when he moved, because anchors do not decay,
and text similarity cannot catch that pair either: they share one content word
and mean opposite things. So anchors carry `subject`, a lowercase slug naming
the question they answer, and a new answer displaces the old one. Free-form
rather than an enum, and that is the load-bearing half: an enum would need a
`person` member, and then an anchor about his brother and one about his mother
would collide on it and delete each other. The cost is a model that writes
`person:brother` one week and `brother` the next supersedes nothing and leaves
two anchors where one should be. That direction is chosen, because a duplicate
is visible and fixable and a wrongly deleted anchor is neither. Rehearsal is
tested BEFORE supersession, or saying where he lives a second time would
supersede the anchor with an identical copy of itself, reset its rehearsal count
and quietly undo decision 3 for exactly the memories decision 5 protects.

**Every failure path writes nothing, and one of those is not the obvious
choice.** A failed READ could plausibly be read as an empty store, since this
might be the first run. It is not, because a save replaces the store wholesale,
so guessing wrong once destroys everything she has, silently, while reporting
success. `primeTemiMemory` swallows a failed read and `loadTemiMemory` throws on
one, and the pass uses the second: the cache is for the live path, where a
missing store costs her one conversation, and the write path cannot use it. A
failed EXTRACTION could plausibly still consolidate, since time has passed
whether or not a model answered. It does not, for a smaller reason: forgetting
deferred costs nothing, because `selectForRecall` ranks by retention and never
chooses a dead atom, so an expired memory is already invisible and merely
lingers on disk until the next good pass.

**The transcript is captured separately from the one on screen.**
`dialogueHistory` is derived from `frontierMessages`, which is persisted: it
holds what he said yesterday too, and `newChatSession` can empty it
mid-conversation. Either way a teardown reading it would consolidate something
other than the session that just ended. A spoken user turn is recorded with the
same replace-the-last-bubble rule the dialogue uses, because a voice transcript
refines itself, and without that one sentence lands four times and she remembers
him as someone who repeats himself. The accumulator is emptied by the pass that
consumes it, which is what makes a second run harmless: React strict mode tears
the screen down and rebuilds it on every mount in development.

#### The recall tier (`services/voice/temiPersona.ts`, 2026-09-13)

The store reaches the model as prose. `buildTemiPersona(atoms, now)` splices a
recall block into `TEMI_PERSONA`, and `geminiLiveEngine.ts:711` calls it with
`residentMemory()` while it composes `systemInstruction`: synchronous, pure, once
per session, nothing left to run on a turn. An empty or unprimed store returns
`TEMI_PERSONA` itself, the same object rather than a copy that matches, because
the persona measured 87% and two attempts to improve it by expanding it measured
worse, so a first run must get the prompt that was measured, and a woman with no
memories must not be handed an empty heading telling her to remember things.

Three decisions. **The block goes before the examples, not at the end**: the last
thing in a prompt is the strongest influence on the shape of what comes out, and
a run of terse dashed lines landing after `TEMI'S VOICE IN PRACTICE` is an
invitation to answer in terse dashed lines, which is the reciting failure the
framing spends a paragraph forbidding. **Kinds are not flattened into one list**,
because an undifferentiated list gives his mother's name and a joke from March
the same weight; each kind arrives under a heading saying what that kind is for,
and anchors additionally carry no date at all, which is policy decision 5 made
visible in the prompt. **Ages are coarse**, "a few weeks ago" and never "on 14
August", because a precise date she cannot verify is the exact shape of the three
fabrications recorded at the top of `temiPersona.ts`.

A second budget, `RECALL_BLOCK_BUDGET_CHARS` of 2200, bounds the rendered lines
and is spent in selection order so the wander goes before an anchor does.
Measured at today's constants a 320-atom store renders about 2000 characters of
lines and the selector's own 1400 is what binds, so this ceiling is not
load-bearing yet. That is exactly why it is written down: otherwise the bound is
an accident of two constants in a file this one does not own.

Measured: persona 18,478 characters; block 2,294 to 2,940 at a full 320-atom
store depending on how many anchors crowd the selection; composed 20,774 to
21,418. `tests/voice-handoff.test.mjs` now holds a ceiling of 3,200 on the block
and 22,000 on the whole instruction, which the system instruction had never had.

One wart, and it is the extraction tier's to fix. The engine binds
`residentMemory` through a dynamic import started at module load rather than a
static one, because `temiMemoryStore.ts` imports `../gatewayClient` with no file
extension and a static chain through it fails every test that loads
`GeminiLiveEngine` under `node --test`. Vite resolves both specifiers to the same
module, so there is no split `resident` state. Add the extension there and the
binding collapses to one import line.

**What is still not true.** All three tiers are built, so she now keeps
something from one conversation to the next. Three things are not yet true, and
each is a real gap rather than a caveat.

The prompt in `temiMemoryExtract.ts` **has never been run against the real
model.** Every test here proves the parser survives what a model might say, not
that the local Flash model says anything good: the axis scores it assigns, and
whether it can resist ranking by importance, are unmeasured. That is the next
thing worth measuring, and `evals/temi-memory.mjs` is the shape it should take.

**Quitting the app mid-conversation loses that session.** The pass runs from the
voice screen's teardown, and a quit kills the renderer without one. The fix
people reach for, consolidating partway through, is the one thing the latency
contract forbids.

And there is still **no honest mid-session update**: Gemini Live fixes the system
instruction at setup, so a memory laid down at the end of a conversation reaches
her at the start of the next one and not before. That is not a limitation to be
removed. It is the reason consolidation belongs between sessions rather than
during one.

Measured when the storage tier landed: studio **2870/2870**, 0 skips, exit 0.
Measured when extraction and recall landed: studio **2954/2954**, 0 skips, exit 0;
root **143/143**; `tsc --noEmit -p studio/tsconfig.json` exit 0.

### 6.49 A pane was listening, so she said the film had paused (`services/playerControl.ts`, 2026-09-13)

The player dispatch answers whether a pane acted, not whether one is listening.
`dispatchPlayerCommand` used to return `listeners.size > 0`, and every caller
reads that value as "the command landed": on false `aiService` tells the model no
player is mounted and `voice/playerActions` hands the turn back unhandled. A pane
subscribes to the whole action list while acting on part of it, so the two
questions come apart routinely. The episode gallery listens for `episode` and
`episodes` and drops the other eighteen, and `MediaPlayer.runCommand` has no
branch for `chapter` or `audio_track`; a `pause` said to the gallery therefore
came back true with nothing moved, and Temi reported a film paused over a grid of
thumbnails. `playerWillTake` now reads the answer out of the snapshot the pane
already publishes: `unsupported` is the pane's own per-file, per-engine refusal
list, and `view` and `series` say which of the two listeners is mounted. Nothing
there is a new contract, which is why no pane had to change. With no snapshot yet
published the old permissive answer stands, because a pane subscribes in one
effect and publishes in the next, and refusing on ignorance would invent a
failure.

**The part deliberately not fixed.** The module-level `Set` holding those
listeners is per renderer, and stays that way. A command sent in one window
cannot reach a listener registered in another, which `voice/temiMemoryStore.ts`
names in the comment on `resident` as the opposite of its own case, but it was
measured before it was fixed and it is latent rather than live: three documents
load this bundle and only `App` mounts anything that dispatches or subscribes,
while the overlay surface and the recorder bar do not import the module at all,
and every `createWindow()` caller checks first that the studio window is gone.
Fixing it by broadcasting over IPC would buy nothing and cost the invariant the
file is built on, that at most one player takes a command, since a broadcast
reaches every renderer and would one day drive two players from one sentence. The
app already has a road across a process for this and it is the one in the header:
the pane publishes to the gateway, and the gateway comes back down the run's own
stream. A second road would need a notion of "the active player" that nothing in
the app has. `tests/player-dispatch-honesty.test.mjs` ends with a source scan
pinning the seven files that call the dispatch, so if anyone ever dispatches from
the overlay or the recorder bar, the latent drop becomes live and the test says
so.

### 6.50 She answered "Right away." to a hello (`services/voice/acknowledgment.ts`, 2026-09-13)

The wake word has one home, `DEFAULT_VOICE_SETTINGS.wakeWords`, and
`acknowledgment.ts` was carrying a fourth copy of it inside the regex that strips
her name off the front of a greeting. That copy had drifted in both directions:
it knew "temy" but not "temi", the spelling the recogniser actually returns, and
it could not know about a word the operator typed into Settings. The cost was
audible, because `patterns.leading` only strips a name standing at the very
front. "um okay Temi, hello" reached the stripper as "okay temi hello", the
greeting test missed it, and the affirmation rule then matched the leading "okay"
and answered "Right away." to a hello. The stripper is now a third memoised
pattern built from the same merged list as the other two, so an operator's word is
honoured here as it already was there. "frontier" and "studio" lived only in that
copy and are kept, but kept apart in `LEGACY_ADDRESS_NAMES`: they are what people
call the app, not what they call her, and a wake word is the operator's contract
rather than a convenience, so widening that list with the product's own names
would widen every match in the file.

The three remaining copies are not this bug and were left: `hooks/useVoice.ts:33`
and `voice/turnIntent.ts:67` are filler-word sets, and `voice/voiceTurnRouter.ts`
is the dictation lane.

### 6.51 Vocal delivery directives, voice-assistant envelope framing, and full duplex cancellation (2026-09-13)

When the operator asked Temi to "sing the song longer" or "make it longer", the pre-model regex in `machineAction.ts` matched the causative "make" under code `edit`. The router intercepted the turn before Gemini Live could speak, announced "Making the change.", and forwarded the singing request to Claude Code via `TeminaliAgentBridge.delegateTask`. Claude Code, having no context that this was a vocal performance request directed at Temi, attempted to search files and hit Anthropic rate limits. Concurrently, post-speech breaths and sighs (RMS 0.018–0.030) triggered unpitched loud frames in `voiceActivity.ts`, repeatedly wiping `silenceRun` and driving pacing up to 2000ms, while extended silence caused Gemini Live ASR to hallucinate non-speech Japanese kana (`"はい。"`).

Four invariants were established:

1. **Vocal Performance & Delivery Protection (`services/voice/machineAction.ts`)**:
   Expanded `OPINION_FRAMES` and `PRONOUN_DELIVERY` to recognise performance and vocal delivery qualifiers (`longer`, `shorter`, `faster`, `slower`, `louder`, `quieter`, `softer`, `higher`, `lower`, `better`, `worse`, `sing longer`, `sing another one`). Utterances modifying vocal delivery remain strictly in `converse` and never route as engineering actions.

2. **Voice Assistant Context Envelope (`services/voice/assistantHandoff.ts`, `services/voice/teminaliAgentBridge.ts`)**:
   `frameVoiceDelegatedTask` wraps all prompts passed to `AIService.streamMessage` from the voice bridge. It identifies that the task was routed by Temi Voice and instructs the background assistant that conversational, vocal, or non-engineering tasks must not modify files or run shell commands, but must report back concisely to be spoken.

3. **Full Duplex Cancellation (`services/voice/turnIntent.ts`)**:
   Added `isAssistantStop` and assistant-directed phrases (`"stop the assistant"`, `"stop the other assistant"`, `"stop the agent"`, `"cancel the assistant"`, `"stop what you're doing"`) to `STOP_PHRASES`. Spoken cancellation during an active run immediately aborts `activeController`, drops queued delegations, and announces "Stopped."

4. **Breathing & Silence Resiliency (`turnTaking.ts`, `voiceActivity.ts`, `geminiLiveEngine.ts`)**:
   `turnTaking.ts` requires confirmed consecutive frames (`resumeRun >= 2`) to reset `silenceRun` during pauses, preventing isolated breath spikes from inflating `learnPause`. `voiceActivity.ts` raised unpitched loud thresholds (0.016, 3.2× noise floor). `geminiLiveEngine.ts` filters non-Latin script hallucinations and silence/breathing artifacts.

Measured: studio **2911/2911** tests pass; root **143/143** tests pass; `npm run studio:typecheck` clean.


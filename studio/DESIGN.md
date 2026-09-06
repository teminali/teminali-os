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

### Typography

- UI **and** chat: the platform face (`font-sans`). Cursor ships no custom UI
  font; rendering in the system face is what makes it feel like part of the OS.
- Code, telemetry, keycaps: `font-mono`.
- Scale: `text-2xs` 11 · `text-xs` 12 · `text-sm` 13 (sidebar and chrome) ·
  `text-md` 14 (chat body and headings).

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
   sitting 3 values above it), which is the whole structure of the shell.
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
  `EmptyState`, `StatusDot`, `SectionLabel`, **`SidebarRow`**
* **`BrandGlyph`** — the third-party and own app marks, used unmodified. Its
  `blend` prop drops the mark's own tile: these are *app icons*, and the
  Teminali one is a green figure on a pure black rounded tile (measured — `#000`
  at full alpha, only the corners transparent). Right in a Dock, wrong where the
  mark sits on the page rather than on a badge. `screen` is exact for that
  rather than approximate — screening pure black leaves the backdrop untouched —
  and it is for dark surfaces only.

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
StudioTitleBar    traffic lights · sidebar toggle · title · IDE · Video Editor · panel tab strip
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
limit is not fixable here. **The silence was.**

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

It is Chromium's player and nothing more: H.264 and VP9 video; AAC, MP3, Opus,
FLAC and WAV audio. The container list promises nothing about the codec inside,
and when the element fires `error` the pane names the codec — ProRes or HEVC in
a `.mov`, HEVC or AC-3 in an `.mp4` — and the ffmpeg line that converts it,
instead of leaving a control bar that never moves. Real-time transcoding is a
separate project; ffmpeg is already a dependency (`server/speech-local.js`) but
the pane does not pretend to it. No MKV, no subtitle tracks.

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

Tested in `tests/browser-view.test.mjs` (6): the scheme refusals on both sides,
the zoom scaling, the malformed-rectangle refusal, and the clamping; in
`tests/browser-data.test.mjs` (10): the store's refusals, the visit folding,
the caps, the history search, and which browser tools are pre-approved; and in
`tests/browser-panel.test.mjs` (8): what counts as a visit, the title in the
dedupe key, the cache's fold and cap, in-flight versus finished downloads, the
dropped `cancelled`, and the two halves of the reveal guard.

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
| Activity grouping | `services/activityGroups.ts` | Pure: folds tool calls into the rows the strip shows. |
| Turn | `chat/MessageBlock.tsx` | Prompt, reply, code cards, hover telemetry. |
| Code card | `chat/FileActionCard.tsx` | A 28px row that opens onto the code. |
| Waiting line | `chat/ThinkingIndicator.tsx` | The gap before the first token. Carries no stop. |
| Interruption | `services/interruption.ts` | Pure: what a stopped turn looks like, and when `Esc` means stop. |
| Review dock | `chat/ChangeReviewDock.tsx` | Accept / reject what was written to disk, by the chat pane or by an agent CLI. |
| Markdown | `chat/CursorMarkdownRenderer.tsx`, `services/markdown.ts` | Blocks and inline tokens. No `innerHTML`. |
| Composer | `chat/Composer.tsx`, `chat/AttachmentStrip.tsx` | The prompt field and what is attached to it. |
| Pending set | `store/changeStore.ts`, `services/changeSet.ts` | The changes, and the arithmetic behind them. |

**One line per thing that happened, not per event.** `groupActivity` collapses
consecutive tool calls of one kind into a single row — "Ran 6 commands",
"Explored 3 files, 1 search", "Edited main.cjs +5 −2" — which opens on click.
Consecutive, never global: the order in which the assistant read, ran and
edited is itself information, so two runs of commands either side of an edit
stay two rows. A group holding one call renders as that call's own row, because
"Ran ls -la" above an indented "ls -la" is the same sentence twice.

The strip is **open while the turn is live and closes when it settles**. During
the turn it is the only thing to look at; afterwards it is a footnote under the
answer. Verbs follow: "Running 5 commands" while it runs, "Ran 5 commands" when
it is done — the tense is in `services/activityGroups.ts`, not in the renderer.

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

Breath is a CSS animation on an outer layer and posture an inline transform on
an inner one, so the two never fight over `transform`.

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

**The dialog is what finally gives the layout its width.** The Cut's shape puts
the source grid beside a fixed 288px options rail, which needs 568px before
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

**The fourth group on the rail is the only one that is not final.** Camera,
Sound and Capture describe the FILE being written and are settled the moment the
take stops. Auto edit describes what the build makes of that file, which can be
turned off and rebuilt. That is why it is a separate group rather than more rows
under Capture.

What Review still cannot offer is everything decided from the WORDS: the camera
taking the whole frame during a spoken pause, opening on a spoken introduction,
and captions. All three read a TRANSCRIPT and this app ships no speech model, so
they are absent from `AssembleOptions` rather than pinned to `false` — the Cut's
`alignToSpeech` returns null on an empty transcript, so they would be inert, not
conservative. Tutorial skill and Go live are likewise absent from the rail.

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

### Dialogs

Every dialog goes through the `Modal` primitive — raised `--surface` behind the
brightest hairline, one close control, sentence-case title at body size. A
dialog that draws its own backdrop and its own header is how the Skills modal
ended up in uppercase mono with two close buttons and a broken template literal.

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

Three rules that a January audit had to enforce retroactively, so they are
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
for features that were never built: there is no rotating-tips surface, no
Electron `Notification` anywhere in the app, no completion-sound player, and no
notion of the three restoration modes. Rule 1 says remove, not fake.

The audit that found these is reproducible: build the import graph from
`main.tsx` and anything unreachable is dead; grep `<button` for tags with no
`onClick`; and diff the `/api/` strings in `src/` against the routes
`server/gateway.js` actually serves.

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

## 6. Voice (`studio/src/services/voice/`)

Two tiers: the browser engine (always available) and **VibeVoice** run locally
through a sidecar (see `studio/docs/VOICE_SIDECAR.md`). Two modes:
push-to-talk dictation, and hands-free conversation with barge-in.

**The default is `conversation`, with `requireWakeWord` off** (changed
2026-09-05; the 2026-09-03 default had it on). The assistant listens
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
36-word reply (13.4 s of speech): first audio at 1.1 s, where the whole-file
path delivered it at 6.2 s; the total render is unchanged. Verified in the
app's runtime on 2026-09-05 (Electron 44, the real `clausePlayer.ts` against
the relay and the sidecar) for a 50-word reply (18.5 s of speech): the first
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
sentences and then falls silent for the rest of the stream; the app passes
`STREAMED_SENTENCE_LIMIT` (3), the default is 4. `finish` flushes whatever was
never spoken as the final chunk. `curateSpeech` closes an unfinished fence and
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

Tests: `tests/voice-director.test.mjs` (8), `tests/voice-ack.test.mjs` (7).

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

**The defaults stay open.** `requireSpeakerMatch` and `requireWakeWord` both
remain `false` in `DEFAULT_VOICE_SETTINGS`. This was put to the operator
directly when the gates above landed, and the answer was to leave them off:
§6.13 and this section stop the reported failure without asking anyone to
enrol or to say a name before every turn, and turning speaker match on by
default would degrade the assistant for anyone with no profile while promoting
a matcher that §6.1 says must never pose as verification. Both remain
available as the operator's own hard rules.

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
weak verifier.


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

# Settings as a page, and platform-native window chrome

Status: **plan, not yet built.** Nothing in this document describes current
behaviour except §1, which is the measured state of the code today.

Goal, in the operator's words: turn the settings dialog into a page-based
surface the way Cursor did, upgrade the existing settings modules to match,
add the settings we are missing — *without* becoming a Cursor copy — and add
one capability Cursor does not have: **the window chrome adapts to the host
platform, and the operator can override it to any platform's style regardless
of the machine they are on.**

---

## 1. What exists today (measured, 2026-09-10)

`src/components/modals/CursorSettingsModal.tsx` (555 lines) is a fixed-size
centred modal — `w-[1040px] h-[680px]` over a `bg-black/70` backdrop — with a
240px category rail and a scrolling content pane. It is opened from
`App.tsx:443` off a `useState` in `App.tsx:57`; there is no route and no store
entry, so the settings surface cannot be linked to, restored, or deep-linked
into.

**The rail advertises 17 categories. Five render.** `activeCategory` is
switched on for `assistant`, `voice`, `git` and `models`; everything else
falls through the final `else` to the General screen. So Profile, Appearance,
Plan & Usage, Teminali OS/agents, Worktrees, Browser, Tab Autocomplete, AST
Indexing all present a rail entry that changes the selection highlight and
nothing else. Two rail entries (`customize`, `beta`) close settings and open a
different modal; two are inert external links (`cloud-agents`, `docs`).

Four of those categories have **no engine behind them at all** — confirmed by
grep over `src/` and `server/`:

| Category | Backing code |
| --- | --- |
| Worktrees | none (the string appears only in this modal, and in `server/arena.js` unrelated) |
| Tab Autocomplete | none |
| AST Indexing | none |
| LSP (Cursor has it; we never claimed it) | none |

That matters for scope: **a settings control for a capability we do not have
is a lie in the interface**, and this plan does not add one. Categories in §3
marked *defer* stay out of the rail until the capability lands.

The window chrome today is platform-blind. `electron/main.cjs:364` sets
`frame: false`, so the app draws every control itself on every OS; the only
thing it draws is `TrafficLights` in `src/components/ui/Primitives.tsx:66` —
three 13px discs on a 10px gap, hard-left in `StudioTitleBar.tsx:116`. A
Windows or Linux operator gets macOS traffic lights. `WindowControls.tsx`
holds a second, richer implementation (hover glyphs, focus dimming, maximize
state) that **is not rendered anywhere** — only its `isDesktopShell` helper and
its type exports are imported. Two implementations, one of them dead.

---

## 2. Settings becomes a page

### 2.1 Shape

Cursor's move is worth copying exactly once: settings stops being a dialog
floating over the workspace and becomes a full-surface page with a persistent
left rail, a `← Back` affordance at the rail's top, a search field under it,
and the account pill pinned to the rail's bottom. Content is one column,
max-width ~880px, centred in its pane, built from **section groups**: a
lowercase-tracking group label (`Startup`, `Notifications`, `Privacy`) over a
rounded card, rows inside the card divided by hairlines.

Concretely:

- A `settings` route/view in the shell, not a modal. `isSettingsOpen` in
  `App.tsx:57` moves to `studioStore` as `settingsView: { open, category }`,
  so the category is addressable and survives a reload.
- `⌘,` opens it; `Escape` and `← Back` return to the previous view, not to a
  blank workspace.
- The rail's search filters **rows**, not just category labels (today it
  filters `cat.label`). Typing "font" should surface the three Appearance font
  rows with their group headings, Cursor-style.
- The fixed `1040×680` box goes away. The page fills the workspace pane and
  reflows; on a narrow window the rail collapses to icons.

### 2.2 The row primitives (new, in `components/ui/`)

The single biggest reason the current screen looks less finished than Cursor's
is that every row is bespoke Tailwind. Four primitives cover every screenshot:

| Primitive | Row shape |
| --- | --- |
| `SettingRow` | label + description on the left, control slot on the right, hairline divider |
| `SettingGroup` | tracking-wide group label + rounded card that owns the dividers |
| `SettingToggle` | the pill switch — accent when on, `--surface-chip` when off |
| `SettingSelect` / `SettingStepper` / `SettingSlider` | the dropdown, the −/+ number, the labelled track |

These are **TDS primitives and must be built against `styles/tokens.css`** —
per the working agreement, adding them is a `studio/DESIGN.md` §0–§2 change,
not just a §3 one. No raw hex in the row components; the Windows and Linux
chrome in §4 is the only place new literal colours are justified, and they go
in as tokens.

---

## 3. Which of Cursor's settings we take

Adopt = build it. Adapt = the idea is right, our mechanism differs. Reject =
deliberately not ours, with the reason. Defer = needs a capability first.

### General

| Cursor | Us |
| --- | --- |
| Cursor Account / Upgrade to Pro | **Adapt** → Licence card off `licence/entitlements.js`. Our tiers, our wording, no upsell banner. |
| Startup › Tips | **Reject** — we have no rotating-tips surface to switch off. |
| Startup › Window Restoration | **Adopted, narrowed, renamed → Restore Last Session.** *Built 2026-09-10.* It restores editor tabs, not the window: the shell does not persist its own bounds, so size and position are the host's business either way, and the row says so. Chat transcripts are exempt — a layout preference that deletes work is not a layout preference. |
| Startup › Continue Interrupted Agents | **Deferred — the claim in this table was wrong.** There is no resume: `studioStore.onRehydrateStorage` runs `settleRestoredTurns` and comments "Nothing is running in this process yet, whatever the last one was doing." An interrupted turn is *settled*, not continued. The row arrives with the capability. |
| Notifications › System / Warning / Completion Sound | **Adopted all three, as Turn Complete / Turn Failed / Completion Sound.** *Built 2026-09-10.* The premise in this row was wrong too — there was no `new Notification` and no audio anywhere in `src/` outside the video engine — so `services/notifications.ts` is new capability, not a switch reconnected. Plus a fourth row Cursor lacks: the permission state, reported honestly. |
| Notifications › Menu Bar Icon | **Adopted.** *Built 2026-09-10.* The peer released `electron/main.cjs` and `preload.cjs`, so the owed row is here. macOS cannot hide a `Tray`, so off destroys the item and on builds a new one from the same rasterised glyph — there is no asset to reload, which is what makes a destroy affordable. `setVisible` returns the *settled* visibility rather than the request and the renderer writes that back, so a build that cannot construct a tray never leaves the switch reading true over an empty menu bar. The shortcut and the in-window panel are untouched by it, and the row says so. |
| Privacy › Data Sharing | **Reject as a toggle, keep as the statement.** We collect nothing; the existing honest privacy card (the one that replaced the false "Zero Telemetry" claim) stays, and a switch would imply there is something to switch. |

### Profile

| Cursor | Us |
| --- | --- |
| Email, name, avatar | **Adapt** — read from the GitHub identity `PlatformService` already fetches. Editable display name only. |
| Handle, public links, Public Profile | **Reject** — there is no `teminali.dev` profile page for them to point at. |

### Appearance — the richest adoption

| Cursor | Us |
| --- | --- |
| Theme: light / dark / high contrast / system | **Adopt** |
| Tool Call Density (compact ↔ detailed) | **Adopt** — maps directly onto how the chat renders tool calls today. |
| Code Block Word Wrap | **Adopt** |
| Themed Diff Backgrounds | **Adopt** — we have a diff view. |
| Colors › Hue + Intensity (accent tint) | **Adopt** — drives `--accent` and friends in `tokens.css`. |
| Reduce Transparency | **Adopt** — we lean on translucency and `lit` surfaces harder than Cursor does, so this is more valuable for us, and it is an accessibility control, not a preference. |
| UI Font Size / Code Font Size (steppers) | **Adopt** |
| UI Font Family / Code Font Family | **Adopt** |
| — | **New: Window Chrome.** See §4. This is ours, not Cursor's. |

### Licence & Usage (Cursor's "Plan & Usage")

**Adapt.** Cursor shows a metered percentage against a subscription. Ours
shows what is actually true for us: licence tier and entitlements from
`licence/entitlements.js`, plus local-lane facts an operator cares about —
which engine is active, model weights on disk, gateway address and health.
The gateway/health card currently on the General screen belongs here.

### Agents (our "Teminali OS")

**Five of seventeen, built 2026-09-10.** The verdicts below are measured
against the code, not judged from the row name — this is the screen that
decides how much runs unattended, so a row overstating its backing here is
worse than untidy.

| Cursor | Us |
| --- | --- |
| Submit with ⌘+Enter | **Built.** Swaps Return and ⌘/Ctrl+Return in both composers. Shift+Return never sends in either mode. |
| Default Environment / Default Model | **Deferred — the profile is already sticky.** `currentProfile` is persisted and restored, so a chat opens in the lane you left it in. A "default" row would be a second source of truth competing with the one that already works, and the first time the two disagreed the row would look broken. |
| New Messages while working (queue/interrupt) | **Deferred — there is no queue.** `Composer.tsx` sends mid-turn as "Interrupt and send", which is the only behaviour there is. The two rows would offer a choice between one behaviour and itself. They arrive with the queue. |
| Agent Autocomplete (contextual prompt suggestions) | **Defer** — no such surface yet. |
| Auto-Approve Mode Transitions | **Rejected — nothing transitions.** Run Mode is a preference the operator sets; no agent proposes moving between modes, so there is no transition to approve. |
| **Voice Submit Keywords** | **Built, as the thing we actually have.** There is no submit *keyword*: an utterance ends on endpointing or the `autoSendAfterMs` timer, never on a word. What exists is the wake-word list `services/voice/addressing.ts` matches against the front of an utterance — and it was *printed into* a row in Voice & Conversation without being editable, which made it read as a property of the build. It is now editable there, beside the toggle that turns it on. Doc: `studio/DESIGN.md` §6. |
| Third-Party Imports (plugins/skills, import Claude Code conversations) | **Reject** — importing a competitor's config is a migration funnel, not a capability we owe our operator. |
| Context & Tools › Web Search / Auto-Accept Web Search / Web Fetch | **Rejected — there are no such tools.** The local lane's tools are `frontier.inspect_images`, `patch_file`, `review_output`, `correct_protocol`, `review_investigation` and shell commands. Nothing searches the web, and a page is read by a shell fetch, which Run Mode already governs. Three rows over one absent tool. |
| Wait for MCP Authentication | **Rejected — there is no interactive auth to wait for.** `mcp-runtime/client.mjs` reaches the local gateway with a bearer token; a 401 is an error, not an OAuth handshake that could pause a turn. |
| Sync Skills for Cloud Agents | **Reject** — no cloud agent fleet to sync to. |
| Execution › Run Mode (sandbox / auto-review / ask) | **Built as three modes, and the fourth name is the point.** ask / review / auto, over the verdicts `classifyCommand` already produced. **There is no sandbox**, so there is no sandbox mode: commands run against the real filesystem with the app's own privileges, and a mode named for containment we do not have would be the most dangerous label on the screen. |
| File-Deletion Protection | **Built — and it is what makes `auto` offerable at all.** `isDestructiveCommand` keeps a delete-shaped line asking even when everything else is running unattended, because a bad edit is in the change dock and in git while a deleted file is in neither. |
| External-File Protection | **Built as a statement, not a switch.** `server/workspace.js` resolves every path against the workspace root and throws `WORKSPACE_PATH_ESCAPE` on read, write and delete alike, symlinks included, with no way to ask it not to. A toggle would either do nothing or offer to remove the guarantee. So the row states it — and states where the boundary stops, which is the half an operator actually needs: a shell command is handed to a shell and is bounded by nothing but Run Mode. |
| Allowlist Options (shell / MCP / fetch) | **Built as one list, not three.** The gate keys on `commandHead` — the executable for a command, the whole `mcp__server__tool` name for a tool — so a single list already covers shell and MCP, and there is no fetch tool to allowlist. What changed is that the list is now persisted and visible: "Always allow" used to be forgotten at window close and could never be taken back, which is not really an answer. |
| Terminal › Legacy Terminal Tool | **Reject** — no legacy tool to fall back to. |
| Auto-Parse Links | **Rejected — nothing parses a link for context.** `services/linkOpen.ts` decides where a *clicked* link opens (that is Git & PRs' Open Links In); no surface reads a pasted URL into the prompt. It arrives with a fetch tool. |

### Models

**Adopt** Cursor's "choose which models appear in the picker" toggle list and
the collapsible **API Keys** section; fold them into the existing
`ModelsPane`, which already does weights and downloads better than Cursor's
screen does. Reject "Explore Subagent Model" (no subagent tier of ours to
point it at).

*Built 2026-09-10.* The runtime switch is a `SettingRow` + `SettingSelect`
under **Where turns run**, and both adoptions above now sit beside it.
`ModelLibrary` and `ApiProviders` stay catalogues below the groups rather than
rows inside them.

**The picker list** is a second group, **In the model picker**: one
`SettingToggle` per Frontier profile, over `preferences.hiddenModelProfiles`.
It is edited from settings rather than from inside the menu, because a menu
that can hide its own rows has no row left to unhide them from.

Two rules make it safe, and they are the same rule seen from two sides. The
profile **in use** cannot be switched off — its toggle is disabled and the row
says `In use` — which is also what keeps the menu from emptying, since
`currentProfile` always names one of the four whether or not an agent holds the
selection instead. And `visibleModelProfiles` (in `services/preferences.ts`,
beside the preference, so a test can reach it without a DOM) offers the active
profile **even when the stored set hides it**: `CommandPaletteModal` selects
`auto` and `flash` and `GeminiKeyModal` selects `max`, none of them consulting
the list, so a hidden profile really can become the running one. A menu that
could not name what it was running would be a worse lie than one row too many.

What is stored is the **hidden** set, not the shown one, so a profile a later
build adds arrives on the menu of an operator who never saw it.

**The API Keys section** collapses inside `ApiProviders`: a disclosure header
carrying the connected count and, when folded, the provider names. It opens
itself while no key is configured — collapsing the only route to the capability
the screen exists for would be a shut door with no handle — and closes once one
is. The operator's own toggle outranks that rule from then on, which is what
the `null` third state of `keysChoice` means.

### Git & PRs

**One of five, and the four absences are the point** *(measured 2026-09-10)*.
The app makes no commits and opens no pull requests: there is no `git commit`,
no `gh pr create` and no review flow anywhere in `src/` or `server/` — GitHub
integration is sign-in, repository listing and clone. So Review Provider,
Commit Attribution, PR Attribution and Branch Prefix would each be a control
over something that never happens, which is the exact failure this document
exists to undo. They arrive with the capability.

The fifth row survived and grew. Cursor's **PR Link Destination** chooses where
a PR link opens; we have no PR links, but we do have an in-app browser and a
chat full of them, so ours is **Open Links In** and governs every link in the
app. `services/linkOpen.ts` is the single door they go through — which is also
the only sensible place to refuse a scheme, since a link in a chat answer is
text a model produced. Bigger than Cursor's row, not smaller.

### Code Intelligence

**Adopt only the indexing rows** — "Index repositories for instant grep",
hierarchical ignore-file handling, symlink handling — *if and only if* the
indexer lands. **Defer the LSP block entirely**; we have no language server.

### Deferred out of the rail until the capability exists

Worktrees, Tab Autocomplete, AST Indexing, LSP, Cloud Agents. Removing these
four dead rail entries is part of this work, not a separate cleanup.

---

## 4. Platform-native window chrome (the new capability)

### 4.1 Why it is cheap for us

`frame: false` means Electron draws nothing and we draw everything. So this is
**not** a native-integration problem — no `titleBarStyle`, no
`titleBarOverlay`, no per-platform `BrowserWindow` branch. It is one persisted
setting, one resolver, three presentation components, and a title-bar reflow.

### 4.2 The setting

In Appearance, a `Window Chrome` row:

- **Follow system** (default) — resolve from `window.teminali.platform`.
- **macOS** — traffic lights, left.
- **Windows** — close/maximise/minimise cluster, right.
- **Linux** — GNOME/Adwaita-style round symbolic buttons, right.

Persisted as `appearance.chromeStyle: "system" | "macos" | "windows" | "linux"`.
A macOS operator can choose the Windows bar and a Linux operator the traffic
lights; that is the explicit ask, and it is also the only way this is testable
on one machine.

### 4.3 What each style must actually look like

Measure these off a real window rather than guessing — the same discipline the
existing traffic-light comment records (13px discs, 10px gap, first centre at
x=17.5).

- **macOS** — what we have. Keep `TrafficLights`, but fold in the good parts
  of the dead `WindowControls.tsx`: hover-revealed glyphs, focus dimming,
  maximise/restore state. Then **delete `WindowControls.tsx`'s duplicate
  rendering** and keep it as the bridge-types module it is actually used as.
- **Windows 11** — three flat rectangular hit targets, 46×32 each, hard right,
  no gap, no rounding; 10px stroked glyphs (`✕`, `▢`, `─`); hover fills
  `rgba(255,255,255,.06)`, and **close hovers `#c42b1c`** with a white glyph.
  Restore glyph is the two-square overlap, not an arrow pair.
- **Linux (Adwaita)** — three 24px circles on a 6px gap, right-aligned with a
  ~6px inset; symbolic glyphs at rest (unlike macOS, GNOME always shows them);
  circle background `rgba(255,255,255,.10)`, hover `.15`; close is not red at
  rest. GNOME convention hides minimise on some setups — we always show all
  three rather than reproducing a distro-specific default.

New tokens in `tokens.css`: `--chrome-win-hover`, `--chrome-win-close`,
`--chrome-gnome-btn`, `--chrome-gnome-btn-hover`. No raw hex in components.

### 4.4 The part that is real work: the reflow

`StudioTitleBar` currently assumes the control cluster is on the **left** —
`railWidth` at line 127 reserves space for it, and the panel tab strip owns
the right edge. In Windows and Linux styles the cluster moves right and
**collides with the tab strip**. So the title bar needs a genuine
three-region layout whose left and right reservations come from the resolved
chrome style, not from a constant.

`RecorderBar.tsx:76` was listed here as needing the same and does not: the
floating pill has no minimise, maximise or close, so there is no cluster to
place. Its Mark / Pause / Stop are transport controls, and reflowing those by
host platform would reproduce a convention that does not govern them. What it
did need is what it already had — `drag` on the pill and `no-drag` on the
control group — and that is now stated in the file so the question is not
re-opened.

Also: the drag region must stay correct in every style
(`WebkitAppRegion: "drag"` on the bar, `"no-drag"` on every control), and the
resolved style must be readable outside React for the recorder window.

### 4.5 Verification that this actually works

A screenshot per style is the only honest proof — the reflow is exactly the
kind of thing that typechecks and still overlaps. Drive it the way this
session drove the app: launch dev, switch the setting, capture the window by
pid, and look at the frame.

```bash
# from studio/ — ELECTRON_RUN_AS_NODE is set in this shell and must be cleared
env -u ELECTRON_RUN_AS_NODE npm start
# a stale packaged instance may hold :4310 and :3899; quit it first or the
# dev api-server dies with EADDRINUSE and only the renderer is live
```

---

## 5. Build order

1. **Delete the lies.** Remove the four dead rail entries; make an
   unimplemented category impossible by deriving the rail from the same
   registry that renders the panes.
2. **Row primitives** + `tokens.css` additions → `DESIGN.md` §0–§2.
3. **Page shell**: route, store entry, `⌘,`, back, row-level search.
4. **Appearance** — the biggest win per unit of work, and it carries the
   chrome setting.
5. **Chrome resolver + three styles + title-bar reflow.** Screenshot each.
   *Done.* `layout/WindowChrome.tsx` draws all three; `CHROME_SIDE` and
   `CHROME_CLUSTER_WIDTH` moved into `services/appearance.ts` beside the
   resolver so the bar reserves from them and the tests can reach them.
   `WindowControls.tsx` is now the bridge-types module only. All three
   captured by CDP page-capture — the shell is frameless, so the page is the
   window and no Screen Recording grant is needed.
6. **General, Licence & Usage, Profile, Git & PRs.** *Done, 2026-09-10.*
   Four panes, rail from five screens to nine, all built out of the `Setting`
   row family and registered in the same `panes` registry. Two new services
   behind them: `services/preferences.ts` (the sibling of `appearance.ts`,
   publishing to module scope because a link handler has no store) and
   `services/notifications.ts` (the turn announcement, hung off the single
   falling edge of `setStreaming` rather than its eleven call sites).
   Two rows this table had marked Adopt are still **not** built, each with its
   reason recorded above: Continue Interrupted Agents (no resume exists) and
   the four Git rows (nothing commits or opens a PR). Menu Bar Icon was the
   third and was built on 2026-09-10, once the peer released the `electron/`
   files it had been waiting on — it was the one deferral in this table on
   ownership rather than on merit. Licence & Usage reuses
   `EntitlementSection` rather than reimplementing the plan catalogue.
7. **Agents.** *Done, 2026-09-10.* The rail goes from eight screens to nine.
   (The "nine to ten" written here first, and the "five to nine" in step 6, were
   each one out; nine panes is what the `panes` registry holds, counted.)
   Five rows of Cursor's seventeen, with the twelve absences and their measured
   reasons recorded in the table above. The blast radius was smaller than
   expected and in a different place: `store/approvalStore.ts` turned out to be
   the live *pending-prompt* slot spoken about by the voice lane, not a settings
   store, and it was not touched at all. The machinery that decides whether a
   command runs is `services/agentCommands.ts` — `classifyCommand`,
   `runAgentCommands` and `createApprovalGate` — and that is where Run Mode, the
   deletion guard and the persisted allowlist went. `runAgentCommands` already
   carried an `autoApproveAll` option that no caller ever set; it is now
   `runMode`, and both engine call sites spread `commandPolicy()` so a turn
   reads the mode at the moment it asks rather than the one it started under.

8. **The three screens the conversion had left behind.** *Done, 2026-09-10.*
   No new pane and no new row — this is the last of the shape debt.
   `AssistantSettingsPanel` (five bare `<section>`s, three `SegmentedTabs`, two
   raw checkboxes, a hand-built permission card, all at a type scale a step
   larger than its neighbours), `ModelsPane` (a private segmented `Option`) and
   `GitHubConnect` (a stack of `lit` cards that `GitPane` then wrapped in a card
   of its own) are all on `ui/Setting.tsx` now. Screen Assistant and Local
   Models declare their rows to the rail search for the first time, via
   `ASSISTANT_ROWS` and `MODELS_ROWS`.

   Three judgements worth keeping. **A segmented control is not a settings row**
   when each option needs a sentence of consequence — mode, autonomy, engine and
   runtime became `SettingSelect`s the way Run Mode did, and `SegmentedTabs`
   stays right where options are peers that explain themselves. **A catalogue is
   not a row family** — `ModelLibrary`, `ApiProviders` and the repository list
   stayed lists; the repositories moved inside a `SettingGroup` and draw the
   group's own divider, so a long list is one cell of a card rather than a card
   inside a card. And the assistant's **Frontier tier** row is worded from
   `gateway/frontier-runner.js` `MODEL_MODES`, the table the routing actually
   consults; it had no description at all before.

   Also dropped: `GitHubConnect`'s `compact` prop, which neither of its two
   callers ever passed. Also corrected: the Voice and Screen Assistant headers,
   the only two still a type step larger and fainter than the eight beside them.

## 6. Docs this work must update in the same turn

Per the root working agreement, all of these are doc-bearing:

- `studio/DESIGN.md` §0–§2 — new row primitives, chrome tokens.
- `studio/DESIGN.md` §3 — settings as a page, `⌘,`, the chrome setting.
- `studio/DESIGN.md` §6 — if voice submit keywords land.
- `studio/README.md` — new capability, and the Configuration table if any
  setting gains an env default.
- Both READMEs' Verification blocks — **run the suite and quote the real
  number**; the current figures are 143 root and 2043 studio.
